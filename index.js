import { spawn } from "node:child_process";
import fs from "node:fs";
import parser from "@babel/parser";
import traverse from "@babel/traverse";
import generate from "@babel/generator";
import t from "@babel/types";
import { inspect } from "./inspect.js";
// import {  resolveAliasPath } from './resolve-path.js'

const PARSER_PLUGINS = ["jsx", "typescript", "dynamicImport"];
/******************* Write and format ast to temp.json  *******************/
const customWriteFile = (path, data) => {
  fs.writeFile(path, data, "utf-8", (error) => {
    if (error) throw error;
    const child = spawn("yarn", ["prettier", "-w", path]);
    // child.stdout.on('data', (data) => {
    //   console.log(`stdout: ${data}`);
    // });
    //
    // child.stderr.on('data', (data) => {
    //   console.error(`stderr: ${data}`);
    // });
    //
    child.on("close", (code) => {
      console.log(
        `write file succussfully with path: ${path} and code: ${code} `,
      );
    });
  });
};

/******************* Get ast   *******************/
const TEMP_AST_FILE_PATH = "ast.json";
const getAst = (filePath, overwritten = false) => {
  let returned = {
    code: fs.readFileSync(filePath, "utf-8"),
    ast: undefined,
  };
  if (!overwritten && fs.existsSync(TEMP_AST_FILE_PATH)) {
    returned.ast = JSON.parse(fs.readFileSync(TEMP_AST_FILE_PATH, "utf-8"));
    customWriteFile(TEMP_AST_FILE_PATH, JSON.stringify(returned.ast));
  } else {
    returned.ast = parser.parse(returned.code, {
      sourceType: "module",
      plugins: PARSER_PLUGINS,
    });
  }
  return returned;
};

/******************* Traverse visitors   *******************/
let importSpecifierNameSet = new Set();

// NOTE:Refactoring usage for mui imports
let muiImportPath;
// import dayjs, { Dayjs } from 'dayjs'
const createMuiImoprtSpecifier = (local) => {
  const specifierLocalName = local.name.replace(
    "AdapterDateFns",
    "AdapterDayjs",
  );
  return t.importSpecifier(
    t.identifier(specifierLocalName),
    t.identifier(specifierLocalName),
  );
};
const visitors = {
  enter(path) {
    if (t.isImportDeclaration(path.node)) {
      path.node.specifiers.forEach((specifier) => {
        importSpecifierNameSet.add(
          specifier[
            t.isImportDefaultSpecifier(specifier) ? "local" : "imported"
          ].name,
        );
      });
    }
  },
  ImportDeclaration(path) {
    switch (path.node.source.value) {
      case "@loadable/component": {
        path.node.specifiers.forEach((specifier) => {
          if (!t.isImportDefaultSpecifier(specifier)) return;
          if (specifier.local.name === "loadable") {
            specifier.local = t.identifier("dynamic");
          }
        });
        path.node.source = t.stringLiteral("next/dynamic");
        break;
      }
      case "react-router-dom": {
        path.node.specifiers = path.node.specifiers
          .filter((specifier) => {
            return (
              specifier.imported.name !== "useParams" &&
              specifier.imported.name !== "Link"
            );
          })
          .map((specifier) => {
            if (specifier.imported.name === "useNavigate") {
              specifier.imported = specifier.local = t.identifier("useRouter");
            }
            return specifier;
          });
        path.node.source = t.stringLiteral("next/router");
        break;
      }
      case "react-i18next": {
        path.node.source = t.stringLiteral("next-i18next");
        return;
      }
      case "@mui/lab/DatePicker":
      case "@mui/lab/DateTimePicker":
      case "@mui/lab/LocalizationProvider":
      case "@mui/lab/AdapterDateFns": {
        if (!muiImportPath) {
          path.node.source = t.stringLiteral("@mui/x-date-pickers");
          path.node.specifiers = path.node.specifiers
            .filter(t.isImportDefaultSpecifier)
            .map((specifier) => createMuiImoprtSpecifier(specifier.local));
          muiImportPath = path;
          return;
        }

        muiImportPath.node.specifiers = [
          ...muiImportPath.node.specifiers,
          ...path.node.specifiers
            .filter(t.isImportDefaultSpecifier)
            .map((specifier) => createMuiImoprtSpecifier(specifier.local)),
        ];
        path.remove();
        break;
      }
      // TODO: Implement @libs/time and update format
      case "date-fns": {
        break;
      }
      default: {
        break;
      }
    }
  },
  CallExpression(path) {
    switch (path.node.callee.name) {
      case "loadable": {
        // Update Callee
        path.node.callee = t.identifier("dynamic");

        // Update dynamic options
        const loadingProperty =
          t.isObjectExpression(path.node.arguments[1]) &&
          path.node.arguments[1].properties.find(
            (p) => p.key.name === "fallback",
          );

        path.node.arguments[1] = t.objectExpression([
          t.objectProperty(t.identifier("ssr"), t.booleanLiteral(false)),
          ...(loadingProperty
            ? t.objectProperty(t.identifier("loading"), loadingProperty.value)
            : []),
        ]);
        break;
      }
      case "useNavigate": {
        /*
         * 1. Creata a new variableDeclaration with useRouter
         * 2. Unshift useRouter to first line of block
         */
        const useRouterVar = t.variableDeclarator(
          t.identifier("router"),
          t.callExpression(t.identifier("useRouter"), []),
        );
        const useRouterDeclaration = t.variableDeclaration("const", [
          useRouterVar,
        ]);
        path
          .findParent((p) => p.isBlockStatement())
          .unshiftContainer("body", useRouterDeclaration);

        // Replace original variableDeclaration reference paths from useNavigate() to router
        const navigatDeclarator = path.findParent((p) =>
          p.isVariableDeclarator(),
        );

        navigatDeclarator.scope.bindings[
          navigatDeclarator.node.id.name
        ]?.referencePaths?.forEach((path) => {
          const navigateCallExpressionNode = path.container;
          const method =
            t.isUnaryExpression(navigateCallExpressionNode.arguments[0]) &&
            navigateCallExpressionNode.arguments[0].operator === "-" &&
            navigateCallExpressionNode.arguments[0].argument.value === 1
              ? "back"
              : navigateCallExpressionNode.arguments[1]?.properties?.find(
                  (p) => p?.key?.name === "replace",
                ) || "push";

          navigateCallExpressionNode.callee = t.memberExpression(
            t.identifier("router"),
            t.identifier(method),
          );

          if (method === "back") {
            navigateCallExpressionNode.arguments = [];
          } else {
            // Update navigate() arguments
            const query =
              navigateCallExpressionNode.arguments[1]?.properties?.find(
                (p) => p?.key?.name === "state",
              )?.value;
            navigateCallExpressionNode.arguments = [
              t.objectExpression([
                t.objectProperty(
                  t.identifier("pathname"),
                  navigateCallExpressionNode.arguments[0],
                ),
              ]),
              ...(query
                ? [
                    t.callExpression(
                      t.memberExpression(
                        t.identifier("JSON"),
                        t.identifier("stringify"),
                      ),
                      [query],
                    ),
                  ]
                : []),
            ];
          }
        });

        // Finally remove original variableDeclaration from useNavigate()
        path.findParent((p) => p.isVariableDeclaration()).remove();
        break;
      }
      // TODO: Update searchParams to router.query
      // Example:
      //    const [searchParams] = useSearchParams()
      //    const test = searchParams.get('test')
      case "useSearchParams": {
        break;
      }
      case "useParams": {
        path.findParent((p) => p.isVariableDeclarator()).node.init =
          t.memberExpression(t.identifier("router"), t.identifier("query"));
        break;
      }
      default: {
        break;
      }
    }
  },
  JSXElement(path) {
    // TEST: Replace img tag with next/image correctly?
    // TODO: Check if the src, width, height, alt, attributes for next/image present then replace it
    // If required attributes are not present, add comment node with FIXME comment
    if (t.isJSXIdentifier(path.node.openingElement.name, { name: "img" })) {
      path.node.openingElement.name = t.jsxIdentifier("Image");
      if (!path.node.openingElement.selfClosing) {
        path.node.closingElement.name = t.jsxIdentifier("Image");
      }
      return;
    }

    // TEST: Replace a tag with next/link correctly?
    if (t.isJSXIdentifier(path.node.openingElement.name, { name: "a" })) {
      if (!importSpecifierNameSet.has("Link")) {
        path
          .get("program")
          .unshiftContainer(
            "body",
            t.importDeclaration(
              t.importDefaultSpecifier(t.identifier("Link")),
              t.stringLiteral("next/link"),
            ),
          );
      }
      path.node.openingElement.name = t.jsxIdentifier("Link");
      if (!path.node.openingElement.selfClosing) {
        path.node.closingElement.name = t.jsxIdentifier("Link");
      }
    }

    if (t.isJSXIdentifier(path.node.openingElement.name, { name: "Link" })) {
      if (!importSpecifierNameSet.has("Link")) {
        path
          .get("program")
          .unshiftContainer(
            "body",
            t.importDeclaration(
              t.importDefaultSpecifier(t.identifier("Link")),
              t.stringLiteral("next/link"),
            ),
          );
      }
      // TODO: Update `to` attribute to `href`
      // Example code:
      // <Link
      //   key={`${index}`}
      //   className={`flex items-center justify-between gap-3 p-4 ${className}`}
      //   to={'test'}
      // >
    }

    if (
      t.isJSXIdentifier(path.node.openingElement.name, {
        name: "LocalizationProvider",
      })
    ) {
      path.node.openingElement.attributes =
        path.node.openingElement.attributes.map((attribute) => {
          if (t.isJSXIdentifier(attribute.name, { name: "dateAdapter" })) {
            attribute.value = t.jsxExpressionContainer(
              t.identifier("AdapterDayjs"),
            );
          }
          return attribute;
        });
    }

    if (
      t.isJSXIdentifier(path.node.openingElement.name, {
        name: "DateTimePicker",
      }) ||
      t.isJSXIdentifier(path.node.openingElement.name, { name: "DatePicker" })
    ) {
      let extraAttributes = [];

      if (!importSpecifierNameSet.has("renderTimeViewClock")) {
        muiImportPath.node.specifiers.push(
          createMuiImoprtSpecifier(t.identifier("renderTimeViewClock")),
        );
        extraAttributes.push(
          t.jsxAttribute(
            t.jsxIdentifier("viewRenderers"),
            t.jsxExpressionContainer(
              t.objectExpression([
                t.objectProperty(
                  t.identifier("hours"),
                  t.identifier("renderTimeViewClock"),
                ),
                t.objectProperty(
                  t.identifier("minutes"),
                  t.identifier("renderTimeViewClock"),
                ),
                t.objectProperty(
                  t.identifier("seconds"),
                  t.identifier("renderTimeViewClock"),
                ),
              ]),
            ),
          ),
        );
        importSpecifierNameSet.add("renderTimeViewClock");
      }

      const isTruthyValue = (node) =>
        node &&
        !t.isNullLiteral(node) &&
        !(t.isIdentifier(node.init) && node.init.name === "undefined");

      path.node.openingElement.attributes = path.node.openingElement.attributes
        .filter(
          (attribute) =>
            attribute.name.name !== "inputFormat" &&
            attribute.name.name !== "mask",
        )
        .map((attribute) => {
          // Example: JSXAttribute, name.type is JSXIdentifier and value.type is JSXExpressionContainer
          inspect({
            message: "JSXAttribute",
            value: attribute,
            options: { depth: 2 },
          });
          if (!attribute.value) return attribute;

          const attributeExpression = attribute.value.expression;
          switch (attribute.name.name) {
            case "defaultValue":
            case "value": {
              switch (attributeExpression.type) {
                // Example: attributeExpression.left || attributeExpression.right
                // Wrap dayjs for value prop we added dayjs adapter at the top
                case "LogicalExpression": {
                  if (isTruthyValue(attributeExpression.left)) {
                    attributeExpression.left = t.callExpression(
                      t.identifier("dayjs"),
                      [attributeExpression.left],
                    );
                  }
                  if (isTruthyValue(attributeExpression.right)) {
                    attributeExpression.right = t.callExpression(
                      t.identifier("dayjs"),
                      [attributeExpression.right],
                    );
                  }
                  break;
                }
                // Example: attributeExpression.test ? attributeExpression.consequent : attributeExpression.alternate
                case "ConditionalExpression": {
                  if (isTruthyValue(attributeExpression.consequent)) {
                    attributeExpression.consequent = t.callExpression(
                      t.identifier("dayjs"),
                      [attributeExpression.consequent],
                    );
                  }
                  if (isTruthyValue(attributeExpression.alternate)) {
                    attributeExpression.alternate = t.callExpression(
                      t.identifier("dayjs"),
                      [attributeExpression.alternate],
                    );
                  }
                  break;
                }
                default: {
                  attribute.value.expression = t.callExpression(
                    t.identifier("dayjs"),
                    [attribute.value.expression],
                  );
                }
              }
              break;
            }
            case "renderInput": {
              // For check the arrayFunctionExpression return directly or BlockStatement return
              const inputJSXElement = t.isJSXElement(attributeExpression.body)
                ? attributeExpression.body
                : attributeExpression.body.body[0].argument; // For BlockStatement
              const ignoreProps = [
                "fullWidth",
                attributeExpression.params[0].name,
              ];
              let objectProperties = [];
              inputJSXElement.openingElement.attributes
                .filter(
                  (attribute) =>
                    t.isJSXAttribute(attribute) &&
                    !ignoreProps.some((name) =>
                      t.isJSXIdentifier(attribute.name, { name }),
                    ),
                )
                .forEach((attribute) => {
                  if (t.isObjectExpression(attribute.value.expression)) {
                    objectProperties.push(
                      ...attribute.value.expression.properties.filter(
                        (propertie) => !t.isSpreadElement(propertie),
                      ),
                    );
                  } else {
                    objectProperties.push(
                      t.objectProperty(
                        t.identifier(attribute.name.name),
                        attribute.value.expression,
                      ),
                    );
                  }
                });

              extraAttributes.push(
                t.jsxAttribute(
                  t.jsxIdentifier("slots"),
                  t.jsxExpressionContainer(
                    t.objectExpression([
                      t.objectProperty(
                        t.identifier("textField"),
                        t.identifier("Textfield"),
                      ),
                    ]),
                  ),
                ),
              );
              extraAttributes.push(
                t.jsxAttribute(
                  t.jsxIdentifier("slotProps"),
                  t.jsxExpressionContainer(
                    t.objectExpression([
                      t.objectProperty(
                        t.identifier("textField"),
                        t.objectExpression(objectProperties),
                      ),
                    ]),
                  ),
                ),
              );
              return;
            }
            default: {
              break;
            }
          }
          return attribute;
        })
        .filter(Boolean);

      path.node.openingElement.attributes.push(...extraAttributes);
    }

    // TODO: Update `HashLink` to `Link` from next/link
    // Example code:
    //  <HashLink
    //    to={`${location.pathname}${location.search ?? ''}#${
    //      id
    //    }`}
    //    replace={true}
    //    smooth
    //  >
    //    {some jsx}
    //  </HashLink>
    if (
      t.isJSXIdentifier(path.node.openingElement.name, { name: "HashLink" })
    ) {
    }
  },
};

/******************* Transform and traverse file  *******************/
const transformFile = (filePath) => {
  const { code, ast } = getAst(filePath, true);
  traverse.default(ast, visitors);
  customWriteFile(`traversed-${TEMP_AST_FILE_PATH}`, JSON.stringify(ast));
  customWriteFile(
    `parsed.tsx`,
    generate.default(ast, { retainLines: true }, code).code,
  );
};

// FIXME: add path to file
transformFile("");

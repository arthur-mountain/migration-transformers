import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import parser from "@babel/parser";
import traverse from "@babel/traverse";
import generate from "@babel/generator";
import t from "@babel/types";
import { inspect } from "./inspect.js";
import { resolveAliasPath, getPathInfo } from "./resolve-path.js";

const PARSER_PLUGINS = ["jsx", "typescript", "dynamicImport"];

let queue = [];
const handledFileNameSet = new Set();

/******************* Write and format ast to temp.json  *******************/
const customWriteFile = (filePath, data) => {
  const dirPath = path.dirname(filePath);
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }

  fs.writeFile(filePath, data, "utf-8", (error) => {
    if (error) throw error;
    const child = spawn("yarn", ["prettier", "-w", filePath]);
    // child.stderr.on('data', (data) => {
    //   console.error(`stderr: ${data}`);
    // });
    //
    child.on("close", () => {
      console.log(
        `writes file succussfully with path: \x1b[32m${filePath}\x1b[0m `,
      );
    });
  });
};

/******************* Get ast   *******************/
const getAst = (pathInfo, overwritten = false) => {
  const AST_PATH = `asts/${pathInfo.relativePathInCurrentDir}/${pathInfo.fileName}.json`;
  let returned = {
    code: fs.readFileSync(pathInfo.fullPath, "utf-8"),
    ast: undefined,
    isFileWritted: false,
  };
  if (!overwritten && fs.existsSync(AST_PATH)) {
    returned.ast = JSON.parse(fs.readFileSync(AST_PATH, "utf-8"));
  } else {
    returned.ast = parser.parse(returned.code, {
      sourceType: "module",
      plugins: PARSER_PLUGINS,
    });
    customWriteFile(AST_PATH, JSON.stringify(returned.ast));
    returned.isFileWritted = true;
  }
  return returned;
};
/******************* Traverse utils *******************/
let importSpecifierNameSet = new Set();
let variableDeclaratorNameSet = new Set();

// Create new import
const createNewImportDeclaration = (path, importDeclaration) => {
  importDeclaration.specifiers = importDeclaration.specifiers.filter(
    (specifier) => {
      return !importSpecifierNameSet.has(
        specifier[t.isImportDefaultSpecifier(specifier) ? "local" : "imported"]
          .name,
      );
    },
  );
  if (importDeclaration.specifiers?.length) {
    path
      .findParent((path) => path.isProgram())
      .unshiftContainer("body", importDeclaration);
    importDeclaration.specifiers.forEach((specifier) => {
      importSpecifierNameSet.add(
        specifier[t.isImportDefaultSpecifier(specifier) ? "local" : "imported"]
          .name,
      );
    });
  }
};

// JSON utils
const createJsonCallExpression = {
  stringify: (value) => {
    return t.callExpression(
      t.memberExpression(t.identifier("JSON"), t.identifier("stringify")),
      [value],
    );
  },
  parse: (value) => {
    return t.callExpression(
      t.memberExpression(t.identifier("JSON"), t.identifier("parse")),
      [value],
    );
  },
};

// Next router utils
const routerIdentifier = t.identifier("router");
const createUseRouterVariableDeclaration = (path) => {
  if (variableDeclaratorNameSet.has("router")) return routerIdentifier;
  if (!importSpecifierNameSet.has("useRouter")) {
    const useRouterIdentifier = t.identifier("useRouter");
    createNewImportDeclaration(
      path,
      t.importDeclaration(
        [t.importSpecifier(useRouterIdentifier, useRouterIdentifier)],
        t.stringLiteral("next/router"),
      ),
    );
  }
  const useRouterVar = t.variableDeclarator(
    routerIdentifier,
    t.callExpression(t.identifier("useRouter"), []),
  );
  const useRouterDeclaration = t.variableDeclaration("const", [useRouterVar]);
  path
    .findParent((p) => p.isBlockStatement())
    .unshiftContainer("body", useRouterDeclaration);
  variableDeclaratorNameSet.add("router");
};

let muiImportPath;
const createMuiImoprtSpecifier = (local) => {
  // import dayjs, { Dayjs } from 'dayjs'
  // Check this is necessary or not the mui also support AdapterDateFns directly
  const muiSpecifier = t.identifier(
    local.name.replace("AdapterDateFns", "AdapterDayjs"),
  );
  return t.importSpecifier(muiSpecifier, muiSpecifier);
};

/******************* Traverse visitor   *******************/
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
      return;
    }
    if (t.isVariableDeclaration(path.node)) {
      path.node.declarations?.forEach((declaration) => {
        if (t.isIdentifier(declaration.id)) {
          variableDeclaratorNameSet.add(declaration.id.name);
          return;
        }
        if (t.isArrayPattern(declaration.id)) {
          declaration.id.elements?.forEach((element) => {
            variableDeclaratorNameSet.add(element.name);
          });
          return;
        }
        if (t.isObjectPattern(declaration.id)) {
          declaration.id.properties?.forEach((property) => {
            variableDeclaratorNameSet.add(property.value.name);
          });
          return;
        }
      });
    }
  },
  ImportDeclaration(path) {
    switch (path.node.source.value) {
      case "@loadable/component": {
        path.node.specifiers.forEach((specifier) => {
          if (!t.isImportDefaultSpecifier(specifier)) return;
          if (t.isIdentifier(specifier.local, { name: "loadable" })) {
            specifier.local = t.identifier("dynamic");
          }
        });
        path.node.source = t.stringLiteral("next/dynamic");
        break;
      }
      case "react-router-dom":
      case "react-router-hash-link": {
        path.remove();
        break;
      }
      case "react-i18next": {
        path.node.source = t.stringLiteral("next-i18next");
        break;
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
        // NOTE: Comment temporary for testing visitor is working or not in single file.
        // if (t.isImport(path.node.arguments[0].body.callee)) {
        //   const importedPath = path.node.arguments[0].body.arguments[0].value
        //   importedPath && queue.push(importedPath)
        // }
        break;
      }
      case "useNavigate": {
        /*
         * 1. Creata a new variableDeclaration with useRouter
         * 2. Unshift useRouter to first line of block
         */

        // Replace original variableDeclaration reference paths from useNavigate() to router
        const navigatDeclaration = path.parentPath;

        navigatDeclaration.scope.bindings[
          navigatDeclaration.node.id.name
        ]?.referencePaths?.forEach((referencePath) => {
          const navigateCallExpressionNode = referencePath.container;
          const method =
            t.isUnaryExpression(navigateCallExpressionNode.arguments[0]) &&
            navigateCallExpressionNode.arguments[0].operator === "-" &&
            navigateCallExpressionNode.arguments[0].argument.value === 1
              ? "back"
              : navigateCallExpressionNode.arguments[1]?.properties?.find(
                  (p) => p?.key?.name === "replace",
                ) || "push";

          navigateCallExpressionNode.callee = t.memberExpression(
            routerIdentifier,
            t.identifier(method),
          );

          if (method === "back") {
            navigateCallExpressionNode.arguments = [];
          } else {
            // Update navigate() arguments
            const queryProperty =
              navigateCallExpressionNode.arguments[1]?.properties?.find(
                (arg) => arg?.key?.name === "state",
              );

            navigateCallExpressionNode.arguments = [
              t.objectExpression([
                t.objectProperty(
                  t.identifier("pathname"),
                  navigateCallExpressionNode.arguments[0],
                ),
                ...(queryProperty
                  ? [
                      t.objectProperty(
                        t.identifier("query"),
                        t.objectExpression([
                          t.objectProperty(
                            t.identifier(queryProperty.key.name),
                            createJsonCallExpression.stringify(
                              queryProperty.value,
                            ),
                          ),
                        ]),
                      ),
                    ]
                  : []),
              ]),
            ];
          }
        });

        createUseRouterVariableDeclaration(path);
        // Finally remove original variableDeclaration from useNavigate()
        path.parentPath.remove();
        break;
      }
      case "useSearchParams": {
        const searchParamsName = path.parentPath.node.id.elements[0].name;
        path.parentPath.scope.bindings[
          searchParamsName
        ].referencePaths?.forEach((referencePath) => {
          referencePath.parentPath.parentPath.replaceWith(
            t.optionalMemberExpression(
              t.memberExpression(routerIdentifier, t.identifier("query")),
              t.identifier(referencePath.parentPath.parent.arguments[0].value),
              false,
              true,
            ),
          );
        });
        createUseRouterVariableDeclaration(path);
        path.parentPath.remove();
        break;
      }
      case "useParams": {
        path.findParent((p) => p.isVariableDeclarator()).node.init =
          t.memberExpression(routerIdentifier, t.identifier("query"));
        createUseRouterVariableDeclaration(path);
        break;
      }
      case "useLocation": {
        const componentBlock = path.findParent((p) => p.isBlockStatement());
        // Below has two pattern both of should be handled with
        // location.search replace to router.query, unshift to first line of block as new variableDeclaration
        // location.pathname replace to router.pathname,  unshift to first line of block as new variableDeclaration
        // If location.hash be used, replace to window.location.hash , unshift to first line of block as new variableDeclaration
        // If location.state be used, replace to JSON.parse(router.query?.state), unshift to first line of block as new variableDeclaration

        // Values that be destructured from useLocation()
        if (t.isObjectPattern(path.parent.id)) {
          const properties = path.parent.id.properties?.filter(
            (property) =>
              t.isIdentifier(property.key, { name: "state" }) ||
              t.isIdentifier(property.key, { name: "search" }) ||
              t.isIdentifier(property.key, { name: "pathname" }) ||
              t.isIdentifier(property.key, { name: "hash" }),
          );

          if (properties?.length) {
            properties.forEach((property) => {
              let init;
              switch (property.key.name) {
                case "search": {
                  init = t.memberExpression(
                    routerIdentifier,
                    t.identifier("query"),
                  );
                  break;
                }
                case "pathname": {
                  init = t.memberExpression(
                    routerIdentifier,
                    t.identifier("pathname"),
                  );
                  break;
                }
                case "hash": {
                  init = t.memberExpression(
                    t.memberExpression(
                      t.identifier("window"),
                      t.identifier("location"),
                    ),
                    t.identifier("hash"),
                  );
                  break;
                }
                case "state": {
                  const state = t.optionalMemberExpression(
                    t.memberExpression(routerIdentifier, t.identifier("query")),
                    t.identifier("state"),
                    false,
                    true,
                  );
                  init = t.conditionalExpression(
                    state,
                    createJsonCallExpression.parse(state),
                    t.objectExpression([]),
                  );
                  break;
                }
                default: {
                  break;
                }
              }
              if (init) {
                componentBlock.unshiftContainer(
                  "body",
                  t.variableDeclaration("const", [
                    t.variableDeclarator(property.value, init),
                  ]),
                );
                createUseRouterVariableDeclaration(path);
              }
            });
          }
        } else {
          componentBlock.unshiftContainer(
            "body",
            t.variableDeclaration("const", [
              t.variableDeclarator(
                path.parent.id,
                t.memberExpression(
                  t.identifier("window"),
                  t.identifier("location"),
                ),
              ),
            ]),
          );
        }
        path.parentPath.remove();
        break;
      }
      case "useMatch": {
        path.node.callee = t.memberExpression(
          t.memberExpression(routerIdentifier, t.identifier("asPath")),
          t.identifier("match"),
        );
        createUseRouterVariableDeclaration(path);
        break;
      }
      default: {
        break;
      }
    }
  },
  JSXElement(path) {
    // TEST: Replace img tag with next/image correctly?
    if (t.isJSXIdentifier(path.node.openingElement.name, { name: "img" })) {
      createNewImportDeclaration(
        path,
        t.importDeclaration(
          [t.importDefaultSpecifier(t.identifier("Image"))],
          t.stringLiteral("next/image"),
        ),
      );
      const hasAllRequiredAttributes = ["src", "width", "height", "alt"].every(
        (attr) =>
          path.node.openingElement.attributes.some((attribute) =>
            t.isJSXIdentifier(attribute.name, { name: attr }),
          ),
      );
      if (hasAllRequiredAttributes) {
        path.node.openingElement.name = t.jsxIdentifier("Image");
        if (!path.node.openingElement.selfClosing) {
          path.node.closingElement.name = t.jsxIdentifier("Image");
        }
      } else {
        // TODO: Add comment if possible
        // path.insertBefore(t.jsxComment('replaces to next/image in the future'))
      }
      return;
    }

    // TEST: Replace a tag with next/link correctly?
    if (t.isJSXIdentifier(path.node.openingElement.name, { name: "a" })) {
      createNewImportDeclaration(
        path,
        t.importDeclaration(
          [t.importDefaultSpecifier(t.identifier("Link"))],
          t.stringLiteral("next/link"),
        ),
      );
      path.node.openingElement.name = t.jsxIdentifier("Link");
      if (!path.node.openingElement.selfClosing) {
        path.node.closingElement.name = t.jsxIdentifier("Link");
      }
    }

    // TEST: Replace Link tag from react-router-dom with next/link correctly?
    if (t.isJSXIdentifier(path.node.openingElement.name, { name: "Link" })) {
      createNewImportDeclaration(
        path,
        t.importDeclaration(
          [t.importDefaultSpecifier(t.identifier("Link"))],
          t.stringLiteral("next/link"),
        ),
      );

      let isFoundState = false;
      path.node.openingElement.attributes =
        path.node.openingElement.attributes.map((attribute) => {
          if (t.isJSXIdentifier(attribute.name, { name: "to" })) {
            attribute.name = t.jsxIdentifier("href");
          }
          if (
            t.isJSXIdentifier(attribute.name, { name: "state" }) &&
            !isFoundState
          ) {
            // TODO: Handle state in Link component
            isFoundState = true;
            inspect({ message: "state", value: attribute });
          }
          return attribute;
        });
      if (isFoundState) {
        // TODO: Add comment if possible
        // path.insertBefore(t.jsxComment('replaces to next/image in the future'))
      }
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
          if (!attribute.value) return attribute;

          const attributeExpression = attribute.value.expression;
          switch (attribute.name.name) {
            case "value": {
              switch (attributeExpression.type) {
                // Example: attributeExpression.left || attributeExpression.right
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
              const inputJSXElement = t.isJSXElement(attributeExpression.body)
                ? attributeExpression.body
                : attributeExpression.body.body[0].argument;
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

    if (
      t.isJSXIdentifier(path.node.openingElement.name, { name: "HashLink" })
    ) {
      createNewImportDeclaration(
        path,
        t.importDeclaration(
          [t.importDefaultSpecifier(t.identifier("Link"))],
          t.stringLiteral("next/link"),
        ),
      );
      path.node.openingElement.attributes = path.node.openingElement.attributes
        .filter((attribute) => {
          return !t.isJSXIdentifier(attribute.name, { name: "smooth" });
        })
        .map((attribute) => {
          if (t.isJSXIdentifier(attribute.name, { name: "to" })) {
            attribute.name = t.jsxIdentifier("href");
          }
          return attribute;
        });
      path.node.openingElement.name = t.jsxIdentifier("Link");
      if (!path.node.openingElement.selfClosing) {
        path.node.closingElement.name = t.jsxIdentifier("Link");
      }
    }
  },
};

/******************* Transform and traverse file  *******************/
// FIXME: add ts config path
const getPath = resolveAliasPath("");
const transformFile = (filePath) => {
  queue.push(filePath);

  while (queue.length) {
    const fullPath = getPath(queue.pop());
    if (!fullPath || handledFileNameSet.has(fullPath)) continue;
    handledFileNameSet.add(fullPath);

    // Get file path info, and traverse ast
    const pathInfo = getPathInfo(fullPath);
    const { code, ast, isFileWritted } = getAst(pathInfo);
    traverse.default(ast, visitors);

    if (isFileWritted) {
      // Write transformed ast
      customWriteFile(
        `traversed-asts/${pathInfo.relativePathInCurrentDir}/${pathInfo.fileName}.json`,
        JSON.stringify(ast),
      );
      // Write transformed code
      customWriteFile(
        `parsed/${pathInfo.relativePathInCurrentDir}/${pathInfo.fullName}`,
        generate.default(ast, { retainLines: true }, code).code,
      );
    }
  }
};

// FIXME: add entry path to file
transformFile("");

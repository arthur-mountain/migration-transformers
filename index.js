import { spawn } from "node:child_process";
import fs from "node:fs";
import nodeJsPath from "node:path";
import parser from "@babel/parser";
import traverse from "@babel/traverse";
import generate from "@babel/generator";
import t from "@babel/types";
import { inspect } from "./inspect.js";
import { resolveAliasPath, getPathInfo } from "./resolve-path.js";

const PARSER_PLUGINS = ["jsx", "typescript", "dynamicImport"];

let workInProgressingPath = "";
const handledFileNameSet = fs.existsSync("handled.json")
  ? new Set(...JSON.parse(fs.readFileSync("handled.json", "utf-8")))
  : new Set();
const Stack = {
  stack: [],
  push: (...paths) => Stack.stack.push(...paths),
  pop: () => Stack.stack.pop(),
  size: () => Stack.stack.length,
  peek: () => Stack.stack.at(-1),
};
const addDependencyPath = (path) => {
  if (/^\./.test(path)) {
    Stack.push(
      nodeJsPath.join(nodeJsPath.dirname(workInProgressingPath), path),
    );
  } else if (/^@\//.test(path)) {
    Stack.push(path);
  }
};

/******************* Write and format ast to temp.json  *******************/
const customWriteFile = (filePath, data) => {
  const dirPath = nodeJsPath.dirname(filePath);
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
  fs.writeFile(filePath, data, "utf-8", (error) => {
    if (error) throw error;
    const child = spawn("yarn", ["prettier", "-w", filePath]);
    child.on("close", () => {
      console.log(
        `writes file succussfully with path: \x1b[32m${filePath}\x1b[0m`,
      );
    });
  });
};

/******************* Get ast   *******************/
const getAst = (pathInfo, overwritten = false) => {
  const readedPath = pathInfo.fullPath;
  // ignore files
  if (
    !fs.existsSync(pathInfo.fullPath) ||
    [".d.ts", ".png", ".scss", ".css"].some((ext) => readedPath.endsWith(ext))
  ) {
    fs.appendFileSync("un-handled-files.txt", `${readedPath}\n`);
    return;
  }

  const AST_PATH = `asts/${pathInfo.outputPath}/${pathInfo.fileName}.json`;
  let returned = {
    code: fs.readFileSync(readedPath, "utf-8"),
    ast: undefined,
    isFileWritted: false,
  };
  try {
    if (overwritten) throw new Error("Overwritten");
    if (fs.existsSync(AST_PATH)) {
      returned.ast = JSON.parse(fs.readFileSync(AST_PATH, "utf-8"));
    }
  } catch {
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

const createJSXComments = ({
  leadingComments,
  innerComments,
  trailingComments,
}) => {
  const emptyJSXExpression = t.jsxEmptyExpression();
  leadingComments && (emptyJSXExpression.leadingComments = leadingComments);
  innerComments && (emptyJSXExpression.innerComments = innerComments);
  trailingComments && (emptyJSXExpression.trailingComments = trailingComments);
  return t.jsxExpressionContainer(emptyJSXExpression);
};

const isTruthyValue = (node) =>
  node &&
  !t.isNullLiteral(node) &&
  !(t.isIdentifier(node.init) && node.init.name === "undefined");

let muiDatePickersImportPath;
let dateFnsImportPath;

// FIXME: Dynamic ts config path
const getPath = resolveAliasPath();

/******************* Traverse visitor   *******************/
const visitors = {
  Program: {
    enter: () => {
      console.log(`strated path: \x1b[32m${workInProgressingPath}\x1b[0m`);
    },
  },
  enter(path) {
    if (t.isImportDeclaration(path.node)) {
      path.node.specifiers.forEach((specifier) => {
        importSpecifierNameSet.add(
          specifier[
            t.isImportDefaultSpecifier(specifier) ||
            t.isImportNamespaceSpecifier(specifier)
              ? "local"
              : "imported"
          ].name,
        );
      });

      addDependencyPath(path.node.source.value);
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
            if (element?.name) variableDeclaratorNameSet.add(element.name);
          });
          return;
        }
        if (t.isObjectPattern(declaration.id)) {
          declaration.properties?.forEach((property) => {
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
      case "@mui/lab/AdapterDateFns": {
        // TODO: handling date-fn v3 , but there're different adapter
        path.replaceWith(
          t.importDeclaration(
            [t.importDefaultSpecifier(t.identifier("AdapterDateFnsV3"))],
            t.stringLiteral("@mui/x-date-pickers/AdapterDateFnsV3"),
          ),
        );
        break;
      }
      case "@mui/lab":
      case "@mui/lab/DatePicker":
      case "@mui/lab/DateTimePicker":
      case "@mui/lab/LocalizationProvider": {
        if (!muiDatePickersImportPath) {
          path.node.source = t.stringLiteral("@mui/x-date-pickers");
          path.node.specifiers = path.node.specifiers.map((specifier) =>
            t.importSpecifier(
              specifier.local,
              t.isImportDefaultSpecifier(specifier)
                ? specifier.local
                : specifier.imported,
            ),
          );
          muiDatePickersImportPath = path;
          return;
        }
        muiDatePickersImportPath.node.specifiers = [
          ...muiDatePickersImportPath.node.specifiers,
          ...path.node.specifiers.map((specifier) =>
            t.importSpecifier(
              specifier.local,
              t.isImportDefaultSpecifier(specifier)
                ? specifier.local
                : specifier.imported,
            ),
          ),
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
        // NOTE: If we need recursive traverse
        if (t.isImport(path.node.arguments[0].body.callee)) {
          addDependencyPath(path.node.arguments[0].body.arguments[0].value);
        }
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
                  )
                ? "replace"
                : "push";

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
                          t.spreadElement(queryProperty.key),
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
          if (
            referencePath.key !== "object" &&
            !t.isMemberExpression(referencePath.parent)
          ) {
            return;
          }

          const callExpression = referencePath.findParent((p) =>
            p.isCallExpression(),
          );
          const isIdentifierArgument = t.isIdentifier(
            callExpression.node.arguments[0],
          );
          const searchParamsKeyIdentifier = isIdentifierArgument
            ? t.identifier(callExpression.node.arguments[0].name)
            : t.identifier(callExpression.node.arguments[0].value);

          switch (callExpression.node.callee.property.name) {
            case "get": {
              referencePath.parentPath.parentPath.replaceWith(
                t.memberExpression(
                  t.memberExpression(routerIdentifier, t.identifier("query")),
                  searchParamsKeyIdentifier,
                  isIdentifierArgument,
                ),
              );
              break;
            }
            case "delete": {
              callExpression.replaceWith(
                t.unaryExpression(
                  "delete",
                  t.memberExpression(
                    t.memberExpression(routerIdentifier, t.identifier("query")),
                    searchParamsKeyIdentifier,
                    isIdentifierArgument,
                  ),
                  true,
                ),
              );
              break;
            }
            default: {
              break;
            }
          }
        });

        if (path.parentPath.node.id.elements[1]) {
          const referencePaths =
            path.scope.getBinding(path.parentPath.node.id.elements[1].name)
              ?.referencePaths || [];
          referencePaths.forEach((referencePath) => {
            referencePath.parentPath.replaceWith(
              t.callExpression(
                t.memberExpression(routerIdentifier, t.identifier("replace")),
                [routerIdentifier],
              ),
            );
          });
        }
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
                  init = t.memberExpression(
                    routerIdentifier,
                    t.identifier("query"),
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
        path.insertBefore(
          createJSXComments({
            innerComments: [
              {
                type: "CommentBlock",
                value: " Migration: replaces with next/image in the future. ",
              },
            ],
          }),
        );
      }
      return;
    }

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

    if (t.isJSXIdentifier(path.node.openingElement.name, { name: "Link" })) {
      createNewImportDeclaration(
        path,
        t.importDeclaration(
          [t.importDefaultSpecifier(t.identifier("Link"))],
          t.stringLiteral("next/link"),
        ),
      );

      let lastStateAttribute;
      path.node.openingElement.attributes = path.node.openingElement.attributes
        .filter((attribute) => {
          const isStateAttribute = t.isJSXIdentifier(attribute.name, {
            name: "state",
          });
          if (isStateAttribute) lastStateAttribute = attribute;
          return !isStateAttribute;
        })
        .map((attribute) => {
          if (t.isJSXIdentifier(attribute.name, { name: "to" })) {
            if (
              lastStateAttribute &&
              lastStateAttribute.value.expression.properties?.length
            ) {
              attribute.value = t.stringLiteral(
                `${attribute.value.value}?${lastStateAttribute.value.expression.properties
                  .map((property) => {
                    return `${property.key.name}=${property.value.value}`;
                  })
                  .join("&")}`,
              );
            }
            attribute.name = t.jsxIdentifier("href");
          }
          return attribute;
        });
    }

    if (
      t.isJSXIdentifier(path.node.openingElement.name, {
        name: "LocalizationProvider",
      })
    ) {
      path.node.openingElement.attributes =
        // TODO: There're different adapters
        path.node.openingElement.attributes.map((attribute) => {
          if (t.isJSXIdentifier(attribute.name, { name: "dateAdapter" })) {
            attribute.value = t.jsxExpressionContainer(
              t.identifier("AdapterDateFnsV3"),
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
        const muiRenderTimeViewSpecifier = t.identifier("renderTimeViewClock");
        muiDatePickersImportPath.node.specifiers.push(
          t.importSpecifier(
            muiRenderTimeViewSpecifier,
            muiRenderTimeViewSpecifier,
          ),
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
            // TODO: There're different adapters
            case "value": {
              switch (attributeExpression.type) {
                // Example: attributeExpression.left || attributeExpression.right
                case "LogicalExpression": {
                  if (isTruthyValue(attributeExpression.left)) {
                    attributeExpression.left = t.callExpression(
                      t.identifier("toDate"),
                      [attributeExpression.left],
                    );
                  }
                  if (isTruthyValue(attributeExpression.right)) {
                    attributeExpression.right = t.callExpression(
                      t.identifier("toDate"),
                      [attributeExpression.right],
                    );
                  }
                  break;
                }
                // Example: attributeExpression.test ? attributeExpression.consequent : attributeExpression.alternate
                case "ConditionalExpression": {
                  if (isTruthyValue(attributeExpression.consequent)) {
                    attributeExpression.consequent = t.callExpression(
                      t.identifier("toDate"),
                      [attributeExpression.consequent],
                    );
                  }
                  if (isTruthyValue(attributeExpression.alternate)) {
                    attributeExpression.alternate = t.callExpression(
                      t.identifier("toDate"),
                      [attributeExpression.alternate],
                    );
                  }
                  break;
                }
                default: {
                  attribute.value.expression = t.callExpression(
                    t.identifier("toDate"),
                    [attribute.value.expression],
                  );
                }
              }
              if (!importSpecifierNameSet.has("toDate")) {
                const toDateIdentifier = t.identifier("toDate");
                const toDateSpecifier = t.importSpecifier(
                  toDateIdentifier,
                  toDateIdentifier,
                );
                if (dateFnsImportPath) {
                  dateFnsImportPath.node.specifiers.push(toDateSpecifier);
                } else {
                  createNewImportDeclaration(
                    path,
                    t.importDeclaration(
                      [toDateSpecifier],
                      t.stringLiteral("date-fns"),
                    ),
                  );
                }
              }
              break;
            }
            case "renderInput": {
              const inputJSXElement = t.isJSXElement(attributeExpression.body)
                ? attributeExpression.body
                : attributeExpression.body.body[0].argument;
              const ignoreProps = [attributeExpression.params[0].name];
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

              // TODO: Dynamic reorg pros an names
              const TEST_INPUT = {
                name: "testField",
                componentName: "testTextField",
              };

              extraAttributes.push(
                t.jsxAttribute(
                  t.jsxIdentifier("slots"),
                  t.jsxExpressionContainer(
                    t.objectExpression([
                      t.objectProperty(
                        t.identifier(TEST_INPUT.name),
                        t.identifier(TEST_INPUT.componentName),
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
                        t.identifier(TEST_INPUT.name),
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
const transformFile = (filePaths = []) => {
  Stack.push(...filePaths);

  while (Stack.size()) {
    const fullPaths = getPath(Stack.pop());
    if (!fullPaths?.length) continue;

    workInProgressingPath = fullPaths.shift();

    if (fullPaths.length) Stack.push(...fullPaths);

    if (handledFileNameSet.has(workInProgressingPath)) continue;
    handledFileNameSet.add(workInProgressingPath);

    // Get file path info, and traverse ast
    const pathInfo = getPathInfo(workInProgressingPath);
    const { code, ast, isFileWritted } = getAst(pathInfo, true) || {};
    if (!ast) continue;
    traverse.default(ast, visitors);

    if (isFileWritted) {
      // Write transformed ast
      customWriteFile(
        `traversed-asts/${pathInfo.outputPath}/${pathInfo.fileName}.json`,
        JSON.stringify(ast),
      );
      // Write transformed code
      customWriteFile(
        `parsed/${pathInfo.outputPath}/${pathInfo.fullName}`,
        generate.default(ast, { retainLines: true, comments: true }, code).code,
      );
    }
  }
};

try {
  transformFile([]);
  if (handledFileNameSet.size) {
    customWriteFile(
      "handled-files.json",
      JSON.stringify([...handledFileNameSet]),
    );
  }
} catch (error) {
  console.error(error);
}

// Improvements five of babel type concept for babel ast traverse:
// 1. NodePath
// 2. Node
// 3. Scope
// 4. Hub
// 5. Context(optional)

// Improvements with babel ast actions in the future :
//   1. Using pre/post hook in traverse.
//   2. Using enter/exit in traverse.
//   3. Using state in traverse.
//   4. Using more @babel/types for validation and creation.
//   5. CRUD using Path, but the static data saving in Node.
//   6. CRUD scope using scope methods, such as `binding`, `getBlockParent`, `push`, `rename`, `remove`, `register`, ...etc.
//   7. Consistent saving variable with path.
//   8. Accessing the static data using `path.node` or `path.parent` or `path.container`, ...etc.
//   9. Accessing the path using `path` or `path.parentPath` ...etc.
//   10. Check `path.key` and `path.type` and `path.listKey` for current path seems more directly.
//   11. Using state commonly that sharing global data in traverse journey.
//   12. Using Hub build error, ...etc.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import nodeJsPath from "node:path";
// import prettier from 'prettier'
import parser from "@babel/parser";
import traverse from "@babel/traverse";
import generate from "@babel/generator";
import t from "@babel/types";
import { inspect } from "./inspect.js";
import { resolveAliasPath, getPathInfo } from "./resolve-path.js";

const Stack = {
  stack: [],
  push: (...paths) => Stack.stack.push(...paths),
  pop: () => Stack.stack.pop(),
  size: () => Stack.stack.length,
  peek: () => Stack.stack.at(-1),
};

const mediator = {
  // FIXME: 👇dynamic👇
  __DEBUG__: 1, // always write local project
  __DESTINATION_PATH__: "", // destination path;
  __START_PATHS__: [],
  // FIXME: 👆dynamic👆
  __IS_PROD__: 0, // write file or not
  __IS_RECURSIVE__: 0, // recursive or not
  __IS_PRINT_CODE__: 0, // print code or not
  __IS_COPY_TO_CLIPBOARD__: 0, // copy to clipboard or not
  __AST_DESTINATION__: 0, // save ast or not
  __TRANSFORMED_AST_DESTINATION__: 0, // save transformed ast or not
  __PARSER_PLUGINS__: ["jsx", "typescript", "dynamicImport"], // parser plugins
  _generateMessage: function (...args) {
    return [
      this.__IS_PROD__ ? (this.__DEBUG__ ? "(debug)" : "") : "(dev)",
      ...args,
    ].join(" ");
  },
  _generateUUID: function () {
    let id = 0;
    return () => id++;
  },

  // states
  workinProgrssPath: "",
  successFileMessages: new Set(),
  failurePaths: new Set(),
  importSpecifierNameSet: new Set(),
  handledFilePathSet: new Set(),
  initialHandledFilePathSet: null,
  cachedProgramPath: null,

  // methods
  init: function () {
    this._generateUUID = this._generateUUID();
    if (!this.__IS_PROD__) {
      this.initialHandledFilePathSet = new Set(
        JSON.parse(this.customReadFile("ignore-files.json")),
      );
      return;
    }
    this.initialHandledFilePathSet = fs.existsSync("handled-files.json")
      ? new Set([
          ...JSON.parse(this.customReadFile("handled-files.json")),
          ...JSON.parse(this.customReadFile("ignore-files.json")),
        ])
      : new Set(JSON.parse(this.customReadFile("ignore-files.json")));
  },
  getProgramPath: function (path) {
    // path.scope.getProgramParent().path
    return (
      this.cachedProgramPath ||
      (this.cachedProgramPath = path.findParent((p) => p.isProgram()))
    );
  },
  printResults: function () {
    if (this.successFileMessages.size) {
      console.log(
        [...this.successFileMessages]
          .map((file) => `\x1b[32m✔ \x1b[0m${file}`)
          .join("\n"),
      );
    }
    if (this.failurePaths.size) {
      console.log(
        [...this.successFileMessages]
          .map((file) => `\x1b[31m✖\x1b[0m${file}`)
          .join("\n"),
      );
    }
  },
  printDivider: function () {
    console.log();
    console.log(Array.from({ length: 106 }, () => "#").join(""));
    console.log();
  },
  printTransformed: function (ast, code) {
    if (!this.__IS_PRINT_CODE__) return;
    const formtedCode = this.fortmatCode(
      generate.default(ast, { retainLines: true, comments: true }, code).code,
    );
    console.log("current path is: ", this.workinProgrssPath, formtedCode);
    if (this.__IS_COPY_TO_CLIPBOARD__) {
      spawnSync("pbcopy", { input: formtedCode, encoding: "utf8" });
    }
  },
  addDependencyPath: function (path) {
    if (!this.__IS_RECURSIVE__) return;
    if (/^\./.test(path)) {
      Stack.push([nodeJsPath.dirname(this.workinProgrssPath), path]);
    } else if (/^@\//.test(path)) {
      Stack.push(path);
    }
  },
  fortmatCode: function (code) {
    // prettier.resolveConfigFile().then(filePath => {
    //   prettier.resolveConfig(filePath).then(options => {
    //     console.log(
    //       prettier.format(code, {
    //         ...options,
    //         parser: 'typescript',
    //       }),
    //     )
    //   })
    // })
    // return code
    const { stdout, stderr, status } = spawnSync(
      "yarn",
      ["prettier", "--parser", "typescript"],
      {
        input: code,
        encoding: "utf-8",
      },
    );
    const isFailed = status !== 0;
    if (isFailed) {
      this.failurePaths.add(
        this._generateMessage(
          "failed format file with path:",
          `\x1b[31m${this.workinProgrssPath}\x1b[0m`,
        ),
      );
      console.error("stderr", stderr);
    }
    return isFailed ? code : stdout;
  },
  // IO
  customReadFile: function (filePath) {
    return fs.readFileSync(filePath, "utf-8");
  },
  writeHandledPaths: function () {
    if (!this.__DEBUG__ && this.handledFilePathSet.size) {
      this.customWriteFile(
        "handled-files.json",
        JSON.stringify([
          ...this.initialHandledFilePathSet,
          ...this.handledFilePathSet,
        ]),
      );
    }
  },
  writeASTJson: function (type, path, ast) {
    let filePath;
    if (type === "pre" && this.__AST_DESTINATION__) {
      filePath =
        typeof this.__AST_DESTINATION__ === "string"
          ? this.__AST_DESTINATION__
          : path;
    } else if (type === "post" && this.__TRANSFORMED_AST_DESTINATION__) {
      filePath =
        typeof this.__TRANSFORMED_AST_DESTINATION__ === "string"
          ? this.__TRANSFORMED_AST_DESTINATION__
          : path;
    }
    if (filePath) {
      this.customWriteFile(filePath, JSON.stringify(ast), true);
    }
  },
  customWriteFile: function (filePath, data, forceWrite = false) {
    const isWriteable = forceWrite || this.__IS_PROD__;
    let dirname;
    let outputPath = filePath;
    if (isWriteable) {
      if (this.__DEBUG__) {
        dirname = new Date()
          .toLocaleDateString()
          .split("/")
          .reverse()
          .join("-");
        outputPath = `${dirname}/${this._generateUUID()}-${filePath.split("/").at(-1)}`;
      } else {
        dirname = nodeJsPath.dirname(outputPath);
      }
      if (!fs.existsSync(dirname)) {
        fs.mkdirSync(dirname, { recursive: true });
      }

      fs.writeFileSync(outputPath, data, "utf-8");
      spawnSync("yarn", ["prettier", "-w", outputPath]);
    }
    this.successFileMessages.add(
      this._generateMessage(
        "writes file succussfully with path:",
        `\x1b[32m${outputPath}\x1b[0m`,
      ),
    );
  },
  customCopyFile: function (
    from,
    destionation,
    flags = fs.constants.COPYFILE_FICLONE,
  ) {
    if (!this.__IS_PROD__) return;
    if (!fs.existsSync(from)) return;

    let dirname;
    let outputPath = destionation;
    if (this.__DEBUG__) {
      dirname = new Date().toLocaleDateString().split("/").reverse().join("-");
      outputPath = `${dirname}/${this._generateUUID()}-${destionation.split("/").at(-1)}`;
    } else {
      dirname = nodeJsPath.dirname(outputPath);
    }
    if (!fs.existsSync(dirname)) fs.mkdirSync(dirname, { recursive: true });

    fs.copyFileSync(from, outputPath, flags);
    this.successFileMessages.add(
      this._generateMessage(
        "copy file succussfully with path:",
        `\x1b[32m${outputPath}\x1b[0m`,
      ),
    );
  },
};

/******************* Get ast   *******************/
const getAst = (pathInfo, overwritten = false) => {
  const readedPath = pathInfo.fullPath;
  if (
    !fs.existsSync(pathInfo.fullPath) ||
    [".d.ts", ".png", ".scss"].some((ext) => readedPath.endsWith(ext))
  ) {
    if (mediator.__IS_PROD__)
      fs.appendFileSync("un-handled-files.txt", `${readedPath}\n`);
    return;
  }

  const AST_PATH = `asts/${pathInfo.outputPath}/${pathInfo.fileName}.json`;
  let returned = {
    code: mediator.customReadFile(readedPath),
    ast: undefined,
    isASTReParsed: false,
  };
  try {
    if (overwritten) throw new Error("Overwritten");
    if (fs.existsSync(AST_PATH)) {
      returned.ast = JSON.parse(mediator.customReadFile(AST_PATH));
    }
  } catch {
    returned.ast = parser.parse(returned.code, {
      sourceType: "module",
      plugins: mediator.__PARSER_PLUGINS__,
    });
    mediator.writeASTJson("pre", AST_PATH, returned.ast);
    returned.isASTReParsed = true;
  }
  return returned;
};

/******************* Traverse utils *******************/
// Check the identifier is exist but we should check the scope instead of this
// let variableDeclaratorNameSet = new Set()
let muiDatePickersImportPath;
let dateFnsImportPath;

// Create new import
const createNewImportDeclaration = (path, importDeclaration) => {
  importDeclaration.specifiers = importDeclaration.specifiers.filter(
    (specifier) => {
      return !path.scope.hasBinding(
        specifier[t.isImportDefaultSpecifier(specifier) ? "local" : "imported"]
          .name,
      );
    },
  );
  if (importDeclaration.specifiers?.length) {
    mediator.getProgramPath(path).unshiftContainer("body", importDeclaration);
    importDeclaration.specifiers.forEach((specifier) => {
      mediator.importSpecifierNameSet.add(
        specifier[t.isImportDefaultSpecifier(specifier) ? "local" : "imported"]
          .name,
      );
    });
  }
};

// Next router utils
const routerIdentifier = t.identifier("router");
const createUseRouterVariableDeclaration = (path) => {
  if (path.scope.hasBinding("router")) return routerIdentifier;
  if (!mediator.importSpecifierNameSet.has("useRouter")) {
    const useRouterIdentifier = t.identifier("useRouter");
    createNewImportDeclaration(
      path,
      t.importDeclaration(
        [t.importSpecifier(useRouterIdentifier, useRouterIdentifier)],
        t.stringLiteral("next/router"),
      ),
    );
  }
  path.scope.push({
    kind: "const",
    id: routerIdentifier,
    init: t.callExpression(t.identifier("useRouter"), []),
  });
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

const insertCommentsBefore = (path, comments) => {
  let maxDepth = 2;
  let current = path;
  while (current) {
    try {
      path.insertBefore(comments);
      return;
    } catch {
      if (--maxDepth < 0) return;
      current = current.parentPath;
    }
  }
};

const isTruthyValue = (node) =>
  node &&
  !t.isNullLiteral(node) &&
  !(t.isIdentifier(node.init) && node.init.name === "undefined");

/******************* Traverse visitor   *******************/
const visitor = {
  Program: {
    enter: () => {
      console.log(
        `🚀 strated path: \x1b[32m${mediator.workInProgrssingPath}\x1b[0m`,
      );
    },
  },
  enter(path) {
    if (t.isImportDeclaration(path.node)) {
      path.node.specifiers.forEach((specifier) => {
        mediator.importSpecifierNameSet.add(
          specifier[
            t.isImportDefaultSpecifier(specifier) ||
            t.isImportNamespaceSpecifier(specifier)
              ? "local"
              : "imported"
          ].name,
        );
      });
      mediator.addDependencyPath(path.node.source.value);
      return;
    }
    // if (t.isVariableDeclaration(path.node)) {
    //   path.node.declarations?.forEach(declaration => {
    //     if (t.isIdentifier(declaration.id)) {
    //       variableDeclaratorNameSet.add(declaration.id.name)
    //       return
    //     }
    //     if (t.isArrayPattern(declaration.id)) {
    //       declaration.id.elements?.forEach(element => {
    //         if (element?.name) variableDeclaratorNameSet.add(element.name)
    //       })
    //       return
    //     }
    //     if (t.isObjectPattern(declaration.id)) {
    //       declaration.properties?.forEach(property => {
    //         variableDeclaratorNameSet.add(property.value.name)
    //       })
    //       return
    //     }
    //   })
    // }
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
      case "@mui/lab/AdapterDateFns": {
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
        const getSpecifierKey = (specifier) =>
          t.isImportDefaultSpecifier(specifier) ? "local" : "imported";
        if (!muiDatePickersImportPath) {
          path.node.source = t.stringLiteral("@mui/x-date-pickers");
          path.node.specifiers = path.node.specifiers.map((specifier) =>
            t.importSpecifier(
              specifier.local,
              specifier[getSpecifierKey(specifier)],
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
              specifier[getSpecifierKey(specifier)],
            ),
          ),
        ];
        path.remove();
        break;
      }
      case "date-fns": {
        if (!dateFnsImportPath) dateFnsImportPath = path;
        break;
      }
      case "react-i18next": {
        path.node.source = t.stringLiteral("next-i18next");
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

        if (t.isImport(path.node.arguments[0].body.callee)) {
          mediator.addDependencyPath(
            path.node.arguments[0].body.arguments[0].value,
          );
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
        const componentBlock = path.scope.getFunctionParent().path.get("body");

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
        createNewImportDeclaration(
          path,
          t.importDeclaration(
            [t.importDefaultSpecifier(t.identifier("Image"))],
            t.stringLiteral("next/image"),
          ),
        );
      } else {
        insertCommentsBefore(
          path,
          createJSXComments({
            innerComments: [
              {
                type: "CommentBlock",
                value: "FIXME: replaces with next/image in the future. ",
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
        path.node.openingElement.attributes.map((attribute) => {
          // TODO: differences adapter
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

      if (!mediator.importSpecifierNameSet.has("renderTimeViewClock")) {
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
        mediator.importSpecifierNameSet.add("renderTimeViewClock");
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
            // TODO: differences adapter
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
              if (!mediator.importSpecifierNameSet.has("toDate")) {
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

              // TODO: make TEXT_INPUT be an option
              const TEXT_INPUT = {
                name: "testFieldA",
                componentName: "testFieldB",
              };
              extraAttributes.push(
                t.jsxAttribute(
                  t.jsxIdentifier("slots"),
                  t.jsxExpressionContainer(
                    t.objectExpression([
                      t.objectProperty(
                        t.identifier(TEXT_INPUT.name),
                        t.identifier(TEXT_INPUT.componentName),
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
                        t.identifier(TEXT_INPUT.name),
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
  MemberExpression: {
    enter: (path) => {
      if (
        t.isIdentifier(path.node.object, { name: "process" }) &&
        t.isIdentifier(path.node.property, { name: "env" }) &&
        path.parent.property.name.startsWith("REACT_APP")
      ) {
        path.parent.property = t.identifier(
          path.parent.property.name.replace("REACT_APP", "NEXT_PUBLIC"),
        );
      }
    },
  },
};

/******************* Transform and traverse file  *******************/
const transformFile = (filePaths = []) => {
  Stack.push(...filePaths);

  while (Stack.size()) {
    const fullPaths = mediator.getPaths(Stack.pop());
    if (!fullPaths?.length) continue;

    mediator.workInProgrssingPath = fullPaths.shift();

    if (fullPaths.length) Stack.push(...fullPaths);

    if (mediator.initialHandledFilePathSet.has(mediator.workInProgrssingPath))
      continue;
    mediator.handledFilePathSet.add(mediator.workInProgrssingPath);

    // Get file path info, and traverse ast
    const pathInfo = getPathInfo(mediator.workInProgrssingPath);
    const { code, ast, isASTReParsed } = getAst(pathInfo, true) || {};
    if (!ast) continue;
    traverse.default(ast, visitor);
    mediator.printTransformed(ast, code);
    mediator.writeASTJson(
      "post",
      `traversed-asts/${pathInfo.outputPath}/${pathInfo.fileName}.json`,
      ast,
    );

    if (isASTReParsed) {
      mediator.customWriteFile(
        `${mediator.__DESTINATION_PATH__}/${pathInfo.outputPath}/${pathInfo.fullName}`,
        generate.default(ast, { retainLines: true, comments: true }, code).code,
      );
      mediator.customCopyFile(
        pathInfo.testFilePath,
        `${mediator.__DESTINATION_PATH__}/${pathInfo.outputPath}/${pathInfo.testFileFullName}`,
      );
    }
  }
};

try {
  mediator.init();
  transformFile(mediator.__START_PATHS__);
  mediator.writeHandledPaths();
  mediator.printDivider();
  mediator.printResults();
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
//   13. Using '|' could processing multiple Node in a visitor key, such as 'VariableDeclaration|FunctionDeclaration'

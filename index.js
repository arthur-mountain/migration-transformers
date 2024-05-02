import { spawn } from "node:child_process";
import { inspect as _inspect } from "node:util";
import fs from "node:fs";
import parser from "@babel/parser";
import traverse from "@babel/traverse";
import generate from "@babel/generator";
import t from "@babel/types";

const PARSER_PLUGINS = ["jsx", "typescript", "dynamicImport"];
/******************* Get path alias *******************/
const pathAliases = Object.entries(
  // FIXME: ts config path later on
  JSON.parse(fs.readFileSync("", "utf8")).compilerOptions.paths,
).map(([alias, realPath]) => [
  alias.replace("/*", ""),
  realPath[0].replace("/*", ""),
]);
console.log("=========");
console.log("pathAliases: \n", pathAliases);
console.log("=========");

/******************* inspect ast *******************/
const inspect = ({ message = "", value, options = {} }) => {
  console.log("=========");
  console.log(
    message,
    "\n",
    _inspect(value, {
      showHidden: false,
      depth: null,
      colors: true,
      ...options,
    }),
  );
  console.log("=========");
};

/******************* resolve alias path  *******************/
const resolveAliasPath = (path) => {
  let lastFoundedAlias;
  pathAliases.forEach(([alias, mappingPath]) => {
    if (path.startsWith(alias)) lastFoundedAlias = [alias, mappingPath];
  });
  return lastFoundedAlias
    ? path.replace(lastFoundedAlias[0], lastFoundedAlias[1])
    : path;
};
// console.log('transformed: ', resolveAliasPath('@libs-components/components/text'))

/******************* Write and format ast to temp.json  *******************/
const customWriteFile = (path, data) => {
  fs.writeFile(path, data, "utf-8", () => {});
  const child = spawn("pnpm", ["prettier", path, "--write"]);
  // child.stdout.on('data', (data) => {
  //   console.log(`stdout: ${data}`);
  // });
  //
  // child.stderr.on('data', (data) => {
  //   console.error(`stderr: ${data}`);
  // });
  //
  // child.on('close', (code) => {
  //   console.log(`child process exited with code ${code}`);
  // });
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
  } else {
    returned.ast = parser.parse(returned.code, {
      sourceType: "module",
      plugins: PARSER_PLUGINS,
    });
  }
  customWriteFile(TEMP_AST_FILE_PATH, JSON.stringify(returned.ast));
  return returned;
};

/******************* Traverse visitors   *******************/
const visitors = {
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
        let shouldInsertNextLink = false;
        path.node.specifiers = path.node.specifiers
          .filter((specifier) => {
            shouldInsertNextLink = specifier.imported.name === "Link";
            return (
              specifier.imported.name !== "useParams" &&
              specifier.imported.name !== "Link"
            );
          })
          .map((specifier) => {
            inspect({
              message: "specifier",
              value: specifier,
              options: { depth: 1 },
            });
            if (specifier.imported.name === "useNavigate") {
              specifier.imported = specifier.local = t.identifier("useRouter");
            }
            return specifier;
          });
        path.node.source = t.stringLiteral("next/router");
        if (shouldInsertNextLink) {
          path.insertBefore(
            t.importDeclaration(
              t.importDefaultSpecifier(t.identifier("Link")),
              t.stringLiteral("next/link"),
            ),
          );
        }

        break;
      }
      case "react-i18next": {
        path.node.source = t.stringLiteral("next-i18next");
        return;
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
    // TODO: Check the src, width, height, alt, attributes that are required for next/image
    if (
      path.node.openingElement?.name?.name === "img" ||
      path.node.closingElement?.name?.name === "img"
    ) {
      if (path.node.openingElement?.name) {
        path.node.openingElement.name = t.identifier("Image");
      }
      if (path.node.closingElement?.name) {
        path.node.closingElement.name = t.identifier("Image");
      }
      return;
    }

    // TEST: Replace a tag with next/link correctly?
    if (
      path.node.openingElement?.name?.name === "a" ||
      path.node.closingElement?.name?.name === "a"
    ) {
      if (path.node.openingElement?.name) {
        path.node.openingElement.name = t.identifier("Link");
      }
      if (path.node.closingElement?.name) {
        path.node.closingElement.name = t.identifier("Link");
      }
    }
  },
};

/******************* Transform and traverse file  *******************/
const transformFile = (filePath) => {
  const { code, ast } = getAst(filePath, true);
  traverse.default(ast, visitors);
  customWriteFile(`traversed-${TEMP_AST_FILE_PATH}`, JSON.stringify(ast));
  fs.writeFileSync("parsed.tsx", generate.default(ast, undefined, code).code);
};

// FIXME:args later finished
transformFile();

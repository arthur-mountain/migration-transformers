#!/usr/bin/env node
import fs from "node:fs";
import pc from "picocolors";
import { Command } from "commander";
import PACKAGE_JSON from "./package.json" assert { type: "json" };

// NOTE::
// Add validation for `from` and `to`,
// that depend which transformer will be used if implemented
// and also needs to update messages
const validate = (from, to, paths, option, command) => {
  try {
    // TODO: Check the transformer is implemented
    // throw new Error("Invalid transformer from/to self was not implemented");
    // or
    // throw new Error("Invalid transform, cause the from -> to was not implemented");

    if (!paths.length) {
      throw new Error("Invalid paths, at last one path is required");
    } else {
      paths.forEach((path) => {
        if (!fs.existsSync(path)) {
          throw new Error(`The provided path is not exists: ${pc.bold(path)}`);
        }
      });
    }

    if (
      option.mode &&
      !["prod", "production", "dev", "development"].includes(option.mode)
    ) {
      throw new Error(
        `Invalid mode, must be [${pc.bold("prod|production")}] or [${pc.bold("dev|development")}] currently`,
      );
    }
  } catch (error) {
    console.error(pc.red(error.message) + "\n");
    process.exit(1);
    command.outputHelp();
  }
};

const initProgramCommand = (context) => {
  const program = new Command(PACKAGE_JSON.name)
    .version(PACKAGE_JSON.version)
    .description(PACKAGE_JSON.description)
    .usage(
      `${pc.yellow("[options]")} ${pc.blue("<from>")} ${pc.blue("<to>")} ${pc.green("<paths>")}`,
    )
    .argument("<from>", "from source")
    .argument("<to>", "to source")
    .argument("<paths...>", "the file pahts needs to be transformed")
    .option("-m, --mode <type>", "set mode")
    .option("-w, --write", "write to file")
    .option("-c, --copy", "copy to clipboard")
    .option("-p, --print", "print code")
    .option("-r, --recursive", "recursive operation")
    .option("--ast", "write to destination before/after AST be traversed")
    .option("--ast-before", "write to destination before AST be traversed")
    .option("--ast-after", "write to destination after AST be traversed")
    .option("--ignore-cache", "ignore the traversed files from cache")
    // TODO: Add more options
    // .option("-ext, --extension <ext...>", "the extensions of files")
    // .option("-iext, --igore-extension <iext...>", "the extensions of ignore files")
    .allowUnknownOption()
    .action(validate)
    .parse(process.argv);

  const COMMAND_MAPPING = new Map([
    ["mode", ["__DEBUG__"]],
    ["write", ["__IS_WRITE_FILE__"]],
    ["copy", ["__IS_COPY_TO_CLIPBOARD__"]],
    ["print", ["__IS_PRINT_CODE__"]],
    ["recursive", ["__IS_RECURSIVE__"]],
    ["ast", ["__AST_DESTINATION__", "__TRANSFORMED_AST_DESTINATION__"]],
    ["astBefore", ["__AST_DESTINATION__"]],
    ["astAfter", ["__TRANSFORMED_AST_DESTINATION__"]],
    ["ignoreCache", ["__IGNORE_CACHE__"]],
  ]);

  let hasModeCommand = 0;
  Object.entries(program.opts()).forEach(([key, value]) => {
    const contextKeys = COMMAND_MAPPING.get(key);
    if (!contextKeys || !value) return;
    contextKeys.forEach((contextKey) => {
      switch (contextKey) {
        case "__DEBUG__": {
          const isProd = ["prod", "production"].includes(value);
          context[contextKey] = isProd ? 0 : 1;
          if (isProd) context.__IS_WRITE_FILE__ = 1;
          hasModeCommand = 1;
          break;
        }
        default:
          context[contextKey] = 1;
          break;
      }
    });
  });

  if (!hasModeCommand) context.__DEBUG__ = 1;

  const pathsArgIndex = program.registeredArguments.findIndex(
    (registeredArg) => registeredArg.name() === "paths",
  );
  if (pathsArgIndex > -1) {
    context.__START_PATHS__ = program.processedArgs[pathsArgIndex];
  }

  return program;
};

export { initProgramCommand };

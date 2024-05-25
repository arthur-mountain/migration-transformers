let ARGS_MAPPING = new Map([
  ["--mode", ["__DEBUG__"]],
  ["--write", ["__IS_WRITE_FILE__"]],
  ["--copy", ["__IS_COPY_TO_CLIPBOARD__"]],
  ["--print", ["__IS_PRINT_CODE__"]],
  ["--recursive", ["__IS_RECURSIVE__"]],
  ["--ast", ["__AST_DESTINATION__", "__TRANSFORMED_AST_DESTINATION__"]],
  ["--ast-before", ["__AST_DESTINATION__"]],
  ["--ast-after", ["__TRANSFORMED_AST_DESTINATION__"]],
]);

const parseArgs = () => {
  try {
    const args = process.argv.slice(2);
    const argLen = args.length;
    let current = -1;
    let temp = { __DEBUG__: 1 };

    while (1) {
      if (current > argLen) break;
      const contextKey = ARGS_MAPPING.get(args[++current]);
      if (!contextKey) continue;
      contextKey.forEach((key) => {
        switch (key) {
          case "__DEBUG__": {
            const isProd = ["prod", "production"].includes(args[++current]);
            temp[key] = isProd ? 0 : 1;
            if (isProd) temp.__IS_WRITE_FILE__ = 1;
            break;
          }
          default:
            temp[key] = 1;
            break;
        }
      });
    }

    // parses once, free memory before returns
    ARGS_MAPPING.clear();
    ARGS_MAPPING = null;

    return temp;
  } catch {
    return {};
  }
};

export { parseArgs };

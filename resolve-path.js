import fs from "node:fs";
import path from "node:path";

// FIXME: Base path should be dynamic, and also avoid using dangerous path.
const BASE_PATH = "";

const resolveAliasPath = (tsConfigPath) => {
  if (!fs.existsSync(tsConfigPath)) {
    throw new Error(
      "tsconfig.json not found, received path is: ",
      tsConfigPath,
    );
  }

  const isArray = Array.isArray;
  const extensions = ["tsx", ".test.tsx", "ts", ".test.ts"];

  const aliasPath = Object.entries(
    JSON.parse(fs.readFileSync(tsConfigPath, "utf8")).compilerOptions.paths,
  ).map(([alias, realPath]) => [
    alias.replace("*", ""),
    realPath[0].replace("*", ""),
  ]);

  return (inputPath) => {
    let lastFoundedAlias;
    if (typeof inputPath === "string") {
      aliasPath.forEach(([alias, mappingPath]) => {
        if (inputPath.startsWith(alias))
          lastFoundedAlias = [alias, mappingPath];
      });
    }

    // Replace path with alias
    const filePath = lastFoundedAlias
      ? path.join(
          BASE_PATH,
          inputPath.replace(lastFoundedAlias[0], lastFoundedAlias[1]),
        )
      : isArray(inputPath)
        ? path.join(...inputPath)
        : path.join(BASE_PATH, "src", inputPath);

    // Returns the path if it has an extension
    if (path.extname(filePath) && fs.existsSync(filePath)) return [filePath];

    let paths = [];

    // File path with extension
    extensions.forEach((ext) => {
      const p = `${filePath}${ext}`;
      if (fs.existsSync(p)) paths.push(p);
    });

    // Auto complete path with index.ts(x)
    extensions.forEach((ext) => {
      const p = path.join(filePath, `index${ext}`);
      if (fs.existsSync(p)) paths.push(p);
    });

    // Ignore third party packages that may not exist after we're processing at the above steps
    // FIXME: this is workaround for removed the path that replaced with alias or base path
    // otherwise the base path add twice at beginning of the path
    return paths.length
      ? paths.map((p, i) => (i ? p.replace(BASE_PATH + "/src/", "") : p))
      : null;
  };
};

const getPathInfo = (fullPath) => {
  const fullName = path.basename(fullPath);
  const extension = path.extname(fullName);
  const fileName = fullName.slice(0, -extension.length);
  // Just for write file in current directory
  const outputPath = path
    .dirname(fullPath.replace(`${BASE_PATH}/src/`, ""))
    .split("/")
    .map((p, i, o) => {
      if (p.startsWith(":")) {
        const key = o[i - 1].endsWith("s") ? o[i - 1].slice(0, -1) : "id";
        return `[${key}]`;
      }
    })
    .join("/");

  const testFileName = `${fileName}.test`;
  const testFileFullName = `${testFileName}${extension}`;
  const testFilePath = fullPath.replace(fullName, testFileFullName);

  return {
    fullPath,
    fileName,
    fullName,
    testFilePath,
    testFileName,
    testFileFullName,
    extension,
    outputPath,
  };
};

export { resolveAliasPath, getPathInfo };

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

  const aliasPath = Object.entries(
    JSON.parse(fs.readFileSync(tsConfigPath, "utf8")).compilerOptions.paths,
  ).map(([alias, realPath]) => [
    alias.replace("*", ""),
    realPath[0].replace("*", ""),
  ]);

  return (inputPath) => {
    let lastFoundedAlias;
    aliasPath.forEach(([alias, mappingPath]) => {
      if (inputPath.startsWith(alias)) lastFoundedAlias = [alias, mappingPath];
    });

    // Replace path with alias
    const filePath = lastFoundedAlias
      ? path.join(
          BASE_PATH,
          inputPath.replace(lastFoundedAlias[0], lastFoundedAlias[1]),
        )
      : path.join(BASE_PATH, "src", inputPath);

    // Returns the path if it has an extension
    if (path.extname(filePath) && fs.existsSync(filePath)) return [filePath];

    let paths = [];

    if (fs.existsSync(`${filePath}.tsx`)) paths.push(`${filePath}.tsx`);

    // Auto complete path with index.tsx
    const autoCompletedPath = path.join(filePath, "index.tsx");
    if (fs.existsSync(autoCompletedPath)) paths.push(autoCompletedPath);

    // Ignore third party packages that may not exist after we're processing at the above steps
    return paths.length ? paths : null;
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
    .map((p) => {
      if (p.startsWith(":")) return `[${p.slice(1)}]`;
      return p;
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

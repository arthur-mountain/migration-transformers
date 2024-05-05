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
    alias.replace("/*", ""),
    realPath[0].replace("/*", ""),
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
    if (path.extname(filePath)) return filePath;

    // Returns the path if file exists
    if (fs.existsSync(`${filePath}.tsx`)) return `${filePath}.tsx`;

    // Auto complete shortcut path with index.tsx
    const autoCompletedPath = path.join(filePath, "index.tsx");

    // Check again ignore third party packages that may not exist after we're processing at the above steps
    return fs.existsSync(autoCompletedPath) ? autoCompletedPath : "";
  };
};

const getPathInfo = (fullPath) => {
  const fullName = path.basename(fullPath);
  const extension = path.extname(fullName);
  // Write file into current directory for testing.
  const relativePathInCurrentDir = path.dirname(
    fullPath.replace(`${BASE_PATH}/src/`, ""),
  );

  return {
    fullPath,
    fullName,
    extension,
    fileName: fullName.slice(0, -extension.length),
    relativePathInCurrentDir,
  };
};

export { resolveAliasPath, getPathInfo };

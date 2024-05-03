const resolveAliasPathConfig = (pathToAliasesConfig) => {
  const pathAliases = Object.entries(
    JSON.parse(fs.readFileSync(pathToAliasesConfig, "utf8")).compilerOptions
      .paths,
  ).map(([alias, realPath]) => [
    alias.replace("/*", ""),
    realPath[0].replace("/*", ""),
  ]);

  return (path) => {
    let lastFoundedAlias;
    pathAliases.forEach(([alias, mappingPath]) => {
      if (path.startsWith(alias)) lastFoundedAlias = [alias, mappingPath];
    });
    return lastFoundedAlias
      ? path.replace(lastFoundedAlias[0], lastFoundedAlias[1])
      : path;
  };
};

export { resolveAliasPath };

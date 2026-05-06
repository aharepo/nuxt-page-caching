import path from "node:path";

function normalizeImportRef(ref) {
  if (!ref || typeof ref !== "string") return null;
  const [importPath, exportName = "default"] = ref.split("#");
  return { importPath, exportName };
}

function resolveNuxtImportPath(importPath, nuxt) {
  if (!importPath) return importPath;

  if (importPath.startsWith("@/") || importPath.startsWith("~/")) {
    return importPath;
  }

  if (importPath.startsWith("./")) {
    const rootRelativePath = path.relative(
      nuxt.options.rootDir,
      path.resolve(nuxt.options.rootDir, importPath)
    );

    return `~/${rootRelativePath.split(path.sep).join("/")}`;
  }

  if (path.isAbsolute(importPath)) {
    const srcRelativePath = path.relative(nuxt.options.srcDir, importPath);

    if (
      !srcRelativePath.startsWith("..") &&
      !path.isAbsolute(srcRelativePath)
    ) {
      return `@/${srcRelativePath.split(path.sep).join("/")}`;
    }

    const rootRelativePath = path.relative(nuxt.options.rootDir, importPath);
    if (
      !rootRelativePath.startsWith("..") &&
      !path.isAbsolute(rootRelativePath)
    ) {
      return `~/${rootRelativePath.split(path.sep).join("/")}`;
    }
  }

  return importPath;
}

function buildNamedImport(ref, localName, nuxt) {
  const importedName =
    ref.exportName === "default"
      ? `default as ${localName}`
      : `${ref.exportName} as ${localName}`;

  return `import { ${importedName} } from ${JSON.stringify(
    resolveNuxtImportPath(ref.importPath, nuxt)
  )};`;
}

function buildFunctionExpression(fn, importedName) {
  if (typeof fn === "function") {
    const fnSource = fn.toString();
    if (/^(async\s+)?function\b/.test(fnSource) || fnSource.startsWith("(")) {
      return `(${fnSource})`;
    }
    return `(function ${fnSource})`;
  }
  if (typeof fn === "string") return importedName;
  return "undefined";
}

export function buildNuxt3RuntimePlugin({ nuxt, moduleOptions }) {
  const nuxt3Options = moduleOptions.nuxt3 || {};
  const useRuntimeConfigForCache = Boolean(nuxt3Options.useRuntimeConfig);
  const useRuntimeRedisUrl = Boolean(nuxt3Options.useRuntimeRedisUrl);
  const getCacheDataRef = normalizeImportRef(nuxt3Options.getCacheData);
  const modifyHtmlRef = normalizeImportRef(nuxt3Options.modifyHtmlBeforeRender);

  const imports = [
    `import RedisStore from "nuxt-page-caching/redis-store";`,
    `import getKey from "nuxt-page-caching/get-key";`,
    `import serializer from "nuxt-page-caching/serializer";`,
    `import { createPageCachingHooks } from "nuxt-page-caching/runtime";`,
  ];

  if (getCacheDataRef) {
    imports.push(buildNamedImport(getCacheDataRef, "__getCacheData", nuxt));
  }
  if (modifyHtmlRef) {
    imports.push(
      buildNamedImport(modifyHtmlRef, "__modifyHtmlBeforeRender", nuxt)
    );
  }

  const serializableOptions = {
    disable: moduleOptions.disable,
    appendHost: moduleOptions.appendHost,
    ignoreConnectionErrors: moduleOptions.ignoreConnectionErrors,
    operationTimeout: moduleOptions.operationTimeout,
    prefix: moduleOptions.prefix,
    url: useRuntimeRedisUrl ? null : moduleOptions.url,
    nuxt3: {
      cacheData: nuxt3Options.cacheData || {},
      useRuntimeConfig: useRuntimeConfigForCache,
      useRuntimeRedisUrl,
    },
  };

  const getCacheDataExpression = getCacheDataRef
    ? "__getCacheData"
    : buildFunctionExpression(moduleOptions.getCacheData, "__getCacheData");
  const modifyHtmlExpression = modifyHtmlRef
    ? "__modifyHtmlBeforeRender"
    : buildFunctionExpression(
        moduleOptions.modifyHtmlBeforeRender,
        "__modifyHtmlBeforeRender"
      );

  return `${imports.join("\n")}

const { serialize, deserialize } = serializer;
const options = ${JSON.stringify(serializableOptions, null, 2)};
const getCacheData = ${getCacheDataExpression};
const modifyHtmlBeforeRender = ${modifyHtmlExpression};

export default (nitroApp) => {
  createPageCachingHooks(nitroApp, {
    options,
    RedisStore,
    getKey,
    serialize,
    deserialize,
    getCacheData,
    modifyHtmlBeforeRender,
  });
};
`;
}

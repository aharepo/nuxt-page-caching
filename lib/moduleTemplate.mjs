import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

function normalizeImportRef(ref) {
  if (!ref || typeof ref !== "string") return null;
  const [importPath, exportName = "default"] = ref.split("#");
  return { importPath, exportName };
}

function resolveExistingExtensionlessPath(filePath) {
  if (path.extname(filePath)) return filePath;

  for (const extension of [".mjs", ".js", ".ts"]) {
    const candidate = `${filePath}${extension}`;
    if (fs.existsSync(candidate)) return candidate;
  }

  return filePath;
}

function resolveNuxtImportPath(importPath, nuxt) {
  if (!importPath) return importPath;

  const toFileUrl = (filePath) =>
    pathToFileURL(resolveExistingExtensionlessPath(filePath)).href;

  if (importPath.startsWith("@/") || importPath.startsWith("~/")) {
    return toFileUrl(path.resolve(nuxt.options.srcDir, importPath.slice(2)));
  }
  if (importPath.startsWith("./")) {
    return toFileUrl(path.resolve(nuxt.options.rootDir, importPath));
  }
  if (path.isAbsolute(importPath)) {
    return toFileUrl(importPath);
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

export function buildNuxt3RuntimePlugin({ nuxt, moduleOptions, moduleDir }) {
  const nuxt3Options = moduleOptions.nuxt3 || {};
  const useRuntimeConfigForCache = Boolean(nuxt3Options.useRuntimeConfig);
  const useRuntimeRedisUrl = Boolean(nuxt3Options.useRuntimeRedisUrl);
  const getCacheDataRef = normalizeImportRef(nuxt3Options.getCacheData);
  const modifyHtmlRef = normalizeImportRef(nuxt3Options.modifyHtmlBeforeRender);

  const imports = [
    `import RedisStore from ${JSON.stringify(
      pathToFileURL(path.resolve(moduleDir, "lib/RedisStore.js")).href
    )};`,
    `import getKey from ${JSON.stringify(
      pathToFileURL(path.resolve(moduleDir, "lib/getKey.js")).href
    )};`,
    `import serializer from ${JSON.stringify(
      pathToFileURL(path.resolve(moduleDir, "lib/serializer.js")).href
    )};`,
    `import { createPageCachingHooks } from ${JSON.stringify(
      pathToFileURL(path.resolve(moduleDir, "lib/runtime.mjs")).href
    )};`,
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

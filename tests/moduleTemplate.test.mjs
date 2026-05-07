import assert from "node:assert/strict";
import test from "node:test";

import { buildNuxt3RuntimePlugin } from "../lib/moduleTemplate.mjs";

const nuxt = {
  options: {
    rootDir: "/app",
    srcDir: "/app/src",
    buildDir: "/app/.nuxt",
  },
};

test("buildNuxt3RuntimePlugin generates a Nuxt 3 Nitro plugin", () => {
  const code = buildNuxt3RuntimePlugin({
    nuxt,
    moduleDir: "/pkg",
    moduleOptions: {
      disable: false,
      appendHost: false,
      ignoreConnectionErrors: true,
      operationTimeout: 500,
      prefix: "",
      url: "redis://cache",
      nuxt3: {
        getCacheData: "@/configs/pageCache.runtime.mjs#getCacheData",
        modifyHtmlBeforeRender:
          "@/configs/pageCache.runtime.mjs#modifyHtmlBeforeRender",
        useRuntimeConfig: true,
        useRuntimeRedisUrl: true,
        cacheData: {
          buildVersion: "1.0.0",
        },
      },
    },
  });

  assert.match(code, /createPageCachingHooks/);
  assert.doesNotMatch(code, /#imports/);
  assert.doesNotMatch(code, /file:\/\//);
  assert.match(code, /"nuxt-page-caching\/runtime"/);
  assert.match(code, /"nuxt-page-caching\/redis-store"/);
  assert.match(code, /"\.\.\/\.\.\/src\/configs\/pageCache\.runtime\.mjs"/);
  assert.doesNotMatch(code, /"@\/configs\/pageCache\.runtime\.mjs"/);
  assert.match(code, /const getCacheData = __getCacheData;/);
  assert.match(
    code,
    /const modifyHtmlBeforeRender = __modifyHtmlBeforeRender;/
  );
  assert.match(code, /"appendHost": false/);
  assert.match(code, /"url": null/);
  assert.match(code, /"useRuntimeConfig": true/);
  assert.match(code, /"useRuntimeRedisUrl": true/);
  assert.match(code, /"operationTimeout": 500/);
  assert.match(code, /"buildVersion": "1.0.0"/);
  assert.doesNotMatch(code, /useRuntimeConfig,/);
});

test("buildNuxt3RuntimePlugin supports inline function options", () => {
  const code = buildNuxt3RuntimePlugin({
    nuxt,
    moduleDir: "/pkg",
    moduleOptions: {
      getCacheData(route) {
        return { key: route, expire: 60 };
      },
      modifyHtmlBeforeRender({ cachedObject }) {
        return cachedObject;
      },
    },
  });

  assert.match(code, /const getCacheData = \(function getCacheData\(route\)/);
  assert.match(
    code,
    /const modifyHtmlBeforeRender = \(function modifyHtmlBeforeRender\(\{ cachedObject \}\)/
  );
});

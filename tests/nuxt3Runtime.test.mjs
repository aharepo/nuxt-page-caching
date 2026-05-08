import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  handleRenderBefore,
  handleRenderResponse,
  serializeNuxtDataPayload,
  substituteNuxtDataUrl,
} from "../lib/runtime.mjs";

const validHtml =
  '<div id="webpage-main-layout"><main id="webpage-main-content">ok</main></div>';
const nuxtDataFixture = fs.readFileSync(
  new URL("./fixtures/nuxt-data-veitingar.json", import.meta.url),
  "utf8"
);

function getPayloadRoot(payload) {
  return payload[payload[0][1]];
}

function getPayloadPath(payload) {
  const root = getPayloadRoot(payload);
  return payload[root.path];
}

function setPayloadPath(payloadBody, path) {
  const payload = JSON.parse(payloadBody);
  const root = getPayloadRoot(payload);
  payload[root.path] = path;
  return serializeNuxtDataPayload(payload);
}

function createNuxtDataHtml({
  path = "/veitingar?utm_source=fb",
  extraBody = "",
} = {}) {
  const payloadBody = setPayloadPath(nuxtDataFixture, path);
  return [
    '<html><head>',
    `<meta property="og:url" content="${path}">`,
    `<link rel="canonical" href="/veitingar">`,
    "</head><body>",
    '<div id="webpage-main-layout"><main id="webpage-main-content">',
    '<a href="/veitingar">Food</a>',
    extraBody,
    "</main></div>",
    `<script type="application/json" data-nuxt-data="nuxt-app" data-ssr="true" id="__NUXT_DATA__">${payloadBody}</script>`,
    "</body></html>",
  ].join("");
}

function extractNuxtDataPayload(html) {
  const match = html.match(
    /<script\b[^>]*\bid=["']__NUXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i
  );
  assert.ok(match);
  return JSON.parse(match[1]);
}

function createEvent(url = "/?x=1", method = "GET") {
  return {
    method,
    path: url,
    node: {
      req: {
        url,
        headers: {
          host: "www.aha.is",
        },
      },
    },
    context: {},
  };
}

function createDeps({
  cachedValue,
  getCacheData = () => ({ key: "page-key", expire: 60 }),
  readError,
  writeError,
  modifyHtmlBeforeRender,
  operationTimeout,
} = {}) {
  const operations = [];

  class MockRedisStore {
    constructor(url, jsonEncode, prefix, active, ignoreConnectionErrors) {
      operations.push({
        action: "construct",
        url,
        jsonEncode,
        prefix,
        active,
        ignoreConnectionErrors,
      });
    }

    async read(key) {
      operations.push({ action: "read", key });
      if (readError) throw readError;
      return cachedValue;
    }

    async write(key, value, expire) {
      operations.push({ action: "write", key, value, expire });
      if (writeError) throw writeError;
      return true;
    }

    disconnect() {
      operations.push({ action: "disconnect" });
    }
  }

  return {
    operations,
    deps: {
      options: {
        disable: false,
        appendHost: false,
        ignoreConnectionErrors: true,
        operationTimeout,
        prefix: "",
        url: "redis://cache",
        nuxt3: {
          cacheData: {
            buildVersion: "1.2.3",
          },
        },
      },
      RedisStore: MockRedisStore,
      getKey: ({ key }) => key,
      serialize: JSON.stringify,
      deserialize: JSON.parse,
      getCacheData,
      modifyHtmlBeforeRender,
    },
  };
}

test("cache hit returns cached HTML before render", async () => {
  const { deps, operations } = createDeps({
    cachedValue: JSON.stringify({ html: validHtml, headers: { "x-test": "1" } }),
  });
  const ctx = { event: createEvent(), response: undefined };

  await handleRenderBefore(ctx, deps);

  assert.equal(ctx.response.body, validHtml);
  assert.equal(ctx.response.headers["x-test"], "1");
  assert.deepEqual(
    operations.filter((op) => op.action === "read").map((op) => op.key),
    ["page-key"]
  );
});

test("cache miss writes the fresh rendered HTML", async () => {
  const { deps, operations } = createDeps();
  const ctx = { event: createEvent(), response: undefined };

  await handleRenderBefore(ctx, deps);
  await handleRenderResponse(
    { body: validHtml, statusCode: 200, headers: { "content-type": "text/html" } },
    ctx,
    deps
  );

  const write = operations.find((op) => op.action === "write");
  assert.equal(write.key, "page-key");
  assert.equal(write.expire, 60);
  assert.equal(JSON.parse(write.value).html, validHtml);
});

test("cacheData url is used as the runtime Redis URL", async () => {
  const { deps, operations } = createDeps({
    getCacheData: () => ({
      key: "page-key",
      expire: 60,
      url: "redis://runtime-cache",
    }),
  });
  const ctx = { event: createEvent(), response: undefined };

  await handleRenderBefore(ctx, deps);

  const construct = operations.find((op) => op.action === "construct");
  assert.equal(construct.url, "redis://runtime-cache");
});

test("runtimeConfig is passed to getCacheData context", async () => {
  const calls = [];
  const { deps } = createDeps({
    getCacheData(route, context) {
      calls.push({ route, context });
      return { key: "page-key", expire: 60, url: "redis://runtime-cache" };
    },
  });
  deps.options.disable = true;
  deps.options.nuxt3.useRuntimeConfig = true;
  deps.options.nuxt3.useRuntimeRedisUrl = true;
  const ctx = { event: createEvent(), response: undefined };
  ctx.event.context.nitro = {
    runtimeConfig: {
      pageCache: {
        VUE_APP_PUBLIC_REDIS_URL: "redis://runtime-cache",
      },
    },
  };

  await handleRenderBefore(ctx, deps);

  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].context.runtimeConfig.pageCache.VUE_APP_PUBLIC_REDIS_URL,
    "redis://runtime-cache"
  );
});

test("useRuntimeRedisUrl skips caching when getCacheData does not return url", async () => {
  const { deps, operations } = createDeps({
    getCacheData: () => ({ key: "page-key", expire: 60 }),
  });
  deps.options.nuxt3.useRuntimeConfig = true;
  deps.options.nuxt3.useRuntimeRedisUrl = true;
  const ctx = { event: createEvent(), response: undefined };

  await handleRenderBefore(ctx, deps);
  await handleRenderResponse({ body: validHtml, statusCode: 200 }, ctx, deps);

  assert.equal(operations.some((op) => op.action === "construct"), false);
  assert.equal(operations.some((op) => op.action === "write"), false);
});

test("renewCache bypasses cached value and writes fresh HTML", async () => {
  const { deps, operations } = createDeps({
    cachedValue: JSON.stringify({ html: validHtml }),
    getCacheData: () => ({ key: "page-key", expire: 90, renewCache: true }),
  });
  const ctx = { event: createEvent("/?nocache=1"), response: undefined };

  await handleRenderBefore(ctx, deps);
  const response = { body: validHtml, statusCode: 200 };
  await handleRenderResponse(response, ctx, deps);

  assert.equal(ctx.response, undefined);
  assert.equal(response.body, validHtml);
  assert.equal(operations.some((op) => op.action === "read"), false);
  assert.equal(operations.find((op) => op.action === "write").expire, 90);
});

test("invalid cached HTML falls through to render", async () => {
  const { deps } = createDeps({
    cachedValue: JSON.stringify({ html: "" }),
  });
  const ctx = { event: createEvent(), response: undefined };

  await handleRenderBefore(ctx, deps);

  assert.equal(ctx.response, undefined);
});

test("invalid fresh HTML is not written", async () => {
  const { deps, operations } = createDeps();
  const ctx = { event: createEvent(), response: undefined };

  await handleRenderBefore(ctx, deps);
  await handleRenderResponse({ body: "", statusCode: 200 }, ctx, deps);

  assert.equal(operations.some((op) => op.action === "write"), false);
});

test("redis read errors fall through when connection errors are ignored", async () => {
  const { deps, operations } = createDeps({
    readError: new Error("redis down"),
  });
  const ctx = { event: createEvent(), response: undefined };

  await handleRenderBefore(ctx, deps);
  await handleRenderResponse({ body: validHtml, statusCode: 200 }, ctx, deps);

  assert.equal(ctx.response, undefined);
  assert.equal(operations.some((op) => op.action === "write"), false);
});

test("modifyHtmlBeforeRender is called for cached responses", async () => {
  const calls = [];
  const { deps } = createDeps({
    cachedValue: JSON.stringify({ html: validHtml }),
    modifyHtmlBeforeRender(args) {
      calls.push(args);
      return {
        ...args.cachedObject,
        html: args.cachedObject.html.replace("ok", "modified"),
      };
    },
  });
  const ctx = { event: createEvent(), response: undefined };

  await handleRenderBefore(ctx, deps);

  assert.equal(ctx.response.body.includes("modified"), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].req, ctx.event.node.req);
  assert.equal(calls[0].cachedObject.html, validHtml);
});

test("substituteNuxtDataUrl leaves unchanged input untouched", () => {
  const html = createNuxtDataHtml({ path: "/veitingar" });

  assert.equal(substituteNuxtDataUrl(html, "/veitingar", "/veitingar"), html);
  assert.equal(substituteNuxtDataUrl(html, "", "/veitingar"), html);
});

test("substituteNuxtDataUrl updates only the Nuxt payload root path", () => {
  const html = createNuxtDataHtml({
    path: "/veitingar?utm_source=fb",
    extraBody: '<span data-path="/veitingar?utm_source=fb"></span>',
  });

  const result = substituteNuxtDataUrl(
    html,
    "/veitingar?utm_source=fb",
    "/veitingar"
  );
  const payload = extractNuxtDataPayload(result);

  assert.equal(getPayloadPath(payload), "/veitingar");
  assert.match(result, /<meta property="og:url" content="\/veitingar\?utm_source=fb">/);
  assert.match(result, /<span data-path="\/veitingar\?utm_source=fb"><\/span>/);
  assert.match(result, /<a href="\/veitingar">Food<\/a>/);
});

test("substituteNuxtDataUrl does not touch sub-path payload values", () => {
  const html = createNuxtDataHtml({ path: "/veitingar" });
  const result = substituteNuxtDataUrl(
    html,
    "/veitingar",
    "/veitingar?utm_source=google"
  );
  const payload = extractNuxtDataPayload(result);

  assert.equal(getPayloadPath(payload), "/veitingar?utm_source=google");
  assert.ok(
    payload.some(
      (value) => typeof value === "string" && value === "veitingar/biryani"
    )
  );
});

test("substituteNuxtDataUrl returns malformed payloads unchanged", () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    const html =
      '<script id="__NUXT_DATA__" type="application/json">not-json</script>';
    assert.equal(substituteNuxtDataUrl(html, "/a", "/b"), html);
  } finally {
    console.warn = warn;
  }
});

test("modifyHtmlBeforeRender is called for fresh SSR responses after cache write", async () => {
  const calls = [];
  const { deps, operations } = createDeps({
    modifyHtmlBeforeRender(args) {
      calls.push(args);
      return {
        ...args.cachedObject,
        html: args.cachedObject.html.replace("ok", "fresh-modified"),
      };
    },
  });
  const ctx = { event: createEvent(), response: undefined };
  const response = {
    body: validHtml,
    statusCode: 200,
    headers: { "content-type": "text/html" },
  };

  await handleRenderBefore(ctx, deps);
  await handleRenderResponse(response, ctx, deps);

  const write = operations.find((op) => op.action === "write");
  assert.equal(JSON.parse(write.value).html, validHtml);
  assert.equal(response.body.includes("fresh-modified"), true);
  assert.equal(response.html.includes("fresh-modified"), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].req, ctx.event.node.req);
  assert.equal(calls[0].cachedObject.html, validHtml);
});

test("canonicalUrl stores canonical HTML but serves the cold request HTML", async () => {
  const html = createNuxtDataHtml({ path: "/veitingar?utm_source=fb" });
  const { deps, operations } = createDeps({
    getCacheData: () => ({
      key: "page-key",
      expire: 60,
      canonicalUrl: "/veitingar",
    }),
  });
  const ctx = {
    event: createEvent("/veitingar?utm_source=fb"),
    response: undefined,
  };
  const response = { body: html, statusCode: 200 };

  await handleRenderBefore(ctx, deps);
  await handleRenderResponse(response, ctx, deps);

  const write = operations.find((op) => op.action === "write");
  const stored = JSON.parse(write.value);
  assert.equal(getPayloadPath(extractNuxtDataPayload(stored.html)), "/veitingar");
  assert.equal(
    getPayloadPath(extractNuxtDataPayload(response.html)),
    "/veitingar?utm_source=fb"
  );
});

test("canonicalUrl substitutes cached canonical HTML back to request URL", async () => {
  const canonicalHtml = createNuxtDataHtml({ path: "/veitingar" });
  const { deps } = createDeps({
    cachedValue: JSON.stringify({ html: canonicalHtml }),
    getCacheData: () => ({
      key: "page-key",
      expire: 60,
      canonicalUrl: "/veitingar",
    }),
  });
  const ctx = {
    event: createEvent("/veitingar?utm_source=google"),
    response: undefined,
  };

  await handleRenderBefore(ctx, deps);

  assert.equal(
    getPayloadPath(extractNuxtDataPayload(ctx.response.body)),
    "/veitingar?utm_source=google"
  );
  assert.doesNotMatch(ctx.response.body, /utm_source=fb/);
});

test("fresh responses with error or redirect markers are not written", async () => {
  const testCases = [
    { desc: "error", response: { body: validHtml, statusCode: 200, error: true } },
    {
      desc: "redirected",
      response: { body: validHtml, statusCode: 200, redirected: true },
    },
  ];

  for (const { response } of testCases) {
    const { deps, operations } = createDeps();
    const ctx = { event: createEvent(), response: undefined };

    await handleRenderBefore(ctx, deps);
    await handleRenderResponse(response, ctx, deps);

    assert.equal(operations.some((op) => op.action === "write"), false);
  }
});

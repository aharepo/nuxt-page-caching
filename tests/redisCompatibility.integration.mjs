import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

import * as currentRuntime from "../lib/runtime.mjs";
import RedisStore from "../lib/RedisStore.js";
import serializer from "../lib/serializer.js";

// Run only against a disposable local Redis, never an application cache.
const redisUrl = process.env.REDIS_TEST_URL || "redis://127.0.0.1:16389";
assert.ok(["localhost", "127.0.0.1", "::1"].includes(new URL(redisUrl).hostname));

const runtimes = [["current", currentRuntime]];
for (const tag of ["v1.1.2", "v1.1.3"]) {
  const source = execFileSync("git", ["show", `${tag}:lib/runtime.mjs`]);
  runtimes.push([tag, await import(`data:text/javascript;base64,${source.toString("base64")}`)]);
}

const html = '<html><main id="webpage-main-content">AHA_THEME_COLOR</main></html>';
function createContext() {
  return {
    event: {
      method: "GET",
      path: "/cache-compatibility-test",
      node: { req: { headers: { host: "localhost" } } },
      context: {},
    },
  };
}

for (const [writerName, writer] of runtimes) {
  for (const [readerName, reader] of runtimes) {
    test(`${writerName} writer -> ${readerName} reader over Redis`, async () => {
      const key = `compat-${process.pid}-${writerName}-${readerName}`;
      const deps = {
        options: { appendHost: false, ignoreConnectionErrors: false, prefix: "", url: redisUrl },
        RedisStore,
        getKey: ({ key }) => key,
        ...serializer,
        getCacheData: () => ({ key, expire: 60 }),
        modifyHtmlBeforeRender({ cachedObject }) {
          return {
            ...cachedObject,
            html: cachedObject.html.replace("AHA_THEME_COLOR", "request-theme"),
          };
        },
      };
      const store = new RedisStore(redisUrl, false, "", true, false);
      try {
        const cold = createContext();
        await writer.handleRenderBefore(cold, deps);
        const response = { body: html, statusCode: 203, headers: { "x-test": "preserved" } };
        await writer.handleRenderResponse(response, cold, deps);
        assert.match(response.body, /request-theme/);

        const value = await store.read(key);
        const cached = serializer.deserialize(value);
        assert.equal(cached.html, html);
        assert.equal(Object.hasOwn(cached, "body"), writerName !== "current");
        const ttl = await promisify(store.store.ttl).call(store.store, key);
        assert.ok(ttl > 0 && ttl <= 60);

        const warm = createContext();
        await reader.handleRenderBefore(warm, deps);
        assert.equal(warm.event.context.nuxtPageCaching.hit, true);
        assert.equal(warm.response.body, html.replace("AHA_THEME_COLOR", "request-theme"));
        assert.equal(warm.response.statusCode, 203);
        assert.deepEqual(warm.response.headers, { "x-test": "preserved" });
        assert.equal(await store.read(key), value);
      } finally {
        await promisify(store.store.del).call(store.store, key);
        store.disconnect();
        writer.__test__.clearInFlightRenderMap?.();
        reader.__test__.clearInFlightRenderMap?.();
      }
    });
  }
}

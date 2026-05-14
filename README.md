# nuxt-page-caching

Nuxt 3 / Vue 3 page caching for SSR HTML responses using Redis.

The module registers a Nitro runtime plugin and hooks into:

- `render:before` to read Redis and short-circuit SSR on a valid cache hit.
- `render:response` to write fresh SSR HTML after a miss or `renewCache`.

It keeps the old Nuxt 2 module style where options can be passed directly in
the `modules` array.

## Install

```bash
yarn install https://github.com/aharepo/nuxt-page-caching
```

For local package testing:

```js
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCAL_NUXT_PAGE_CACHING_MODULE = path.resolve(
  __dirname,
  "../nuxt-page-caching/nuxt3.mjs"
);
```

## Basic Usage

Use this when all cache values are known at build/start config time.

```js
export default defineNuxtConfig({
  modules: [
    [
      "nuxt-page-caching",
      {
        disable: false,
        appendHost: false,
        ignoreConnectionErrors: true,
        operationTimeout: 1000,
        prefix: "",
        url: "redis://127.0.0.1:6379",
        getCacheData(route, context) {
          return {
            key: `page:${context.req.headers.host}:${route}`,
            expire: 60,
            renewCache: route.includes("nocache=1"),
          };
        },
        modifyHtmlBeforeRender({ cachedObject }) {
          return cachedObject;
        },
      },
    ],
  ],
});
```

## Runtime Env Setup

Use runtime config when Redis URL, TTL, or cache key inputs are only available
when the server starts, such as inside Kubernetes.

Define a private runtime config object in your Nuxt app:

```js
export default defineNuxtConfig({
  runtimeConfig: {
    pageCache: {
      redisUrl: process.env.REDIS_URL || "",
      cacheTime: Number(process.env.PAGE_CACHE_TTL) || 1,
      cacheKeyPrefix: process.env.PAGE_CACHE_KEY_PREFIX || "NC",
      commitHash: process.env.COMMIT_HASH || "not available",
    },
  },
  modules: [
    [
      "nuxt-page-caching",
      {
        appendHost: false,
        ignoreConnectionErrors: true,
        prefix: "",
        nuxt3: {
          getCacheData: "@/configs/pageCache.runtime.mjs#getCacheData",
          modifyHtmlBeforeRender:
            "@/configs/pageCache.runtime.mjs#modifyHtmlBeforeRender",
          useRuntimeConfig: true,
          useRuntimeRedisUrl: true,
          cacheData: {
            buildVersion: process.env.npm_package_version,
          },
        },
      },
    ],
  ],
});
```

Then read `context.runtimeConfig` inside your runtime hook:

```js
// src/configs/pageCache.runtime.mjs
export function getCacheData(route, context) {
  const pageCache = context.runtimeConfig.pageCache || {};
  const cacheTime = Number(pageCache.cacheTime) || 1;

  if (!pageCache.redisUrl || cacheTime <= 1) return null;

  return {
    key: [
      pageCache.cacheKeyPrefix || "NC",
      context.pageCacheOptions.buildVersion,
      String(pageCache.commitHash || "").slice(0, 7),
      route,
    ].join("_"),
    expire: cacheTime,
    renewCache: route.includes("nocache=1"),
    url: pageCache.redisUrl,
  };
}

export function modifyHtmlBeforeRender({ cachedObject }) {
  return cachedObject;
}
```

### Kubernetes Env Names

Nuxt can override private `runtimeConfig.pageCache` values at runtime with the
`NUXT_` prefix. For the example above:

```yaml
env:
  - name: NUXT_PAGE_CACHE_REDIS_URL
    value: "redis://:password@redis:6379"
  - name: NUXT_PAGE_CACHE_CACHE_TIME
    value: "60"
  - name: NUXT_PAGE_CACHE_CACHE_KEY_PREFIX
    value: "NC"
  - name: NUXT_PAGE_CACHE_COMMIT_HASH
    value: "abcdef123"
```

For legacy env names, keep those names inside the runtime config object:

```js
runtimeConfig: {
  pageCache: {
    VUE_APP_PUBLIC_REDIS_URL: process.env.VUE_APP_PUBLIC_REDIS_URL || "",
    VUE_APP_CACHE_KEY_PREFIX: process.env.VUE_APP_CACHE_KEY_PREFIX || "NC",
    VUE_APP_CACHE_TIME_IN_SEC:
      Number(process.env.VUE_APP_CACHE_TIME_IN_SEC) || 1,
    VUE_APP_COMMIT_HASH: process.env.VUE_APP_COMMIT_HASH || "not available",
  },
}
```

Then Kubernetes can override them with:

```yaml
env:
  - name: NUXT_PAGE_CACHE_VUE_APP_PUBLIC_REDIS_URL
    value: "redis://:password@redis:6379"
  - name: NUXT_PAGE_CACHE_VUE_APP_CACHE_KEY_PREFIX
    value: "NC"
  - name: NUXT_PAGE_CACHE_VUE_APP_CACHE_TIME_IN_SEC
    value: "60"
  - name: NUXT_PAGE_CACHE_VUE_APP_COMMIT_HASH
    value: "abcdef123"
```

Even if the legacy name contains `PUBLIC`, it stays private as long as it is
under `runtimeConfig.pageCache`, not `runtimeConfig.public`.

## Build-Time Values Plus Runtime Fallback

You can still pass values directly in module options:

```js
modules: [
  [
    "nuxt-page-caching",
    {
      disable: false,
      appendHost: false,
      ignoreConnectionErrors: true,
      prefix: "",
      url: process.env.REDIS_URL,
      nuxt3: {
        getCacheData: "@/configs/pageCache.runtime.mjs#getCacheData",
        useRuntimeConfig: true,
        useRuntimeRedisUrl: true,
        cacheData: {
          buildVersion: process.env.npm_package_version,
          cacheTime: Number(process.env.PAGE_CACHE_TTL) || 1,
          commitHash: process.env.COMMIT_HASH || "not available",
          redisUrl: process.env.REDIS_URL,
        },
      },
    },
  ],
];
```

In your runtime hook, choose precedence:

```js
const fallback = context.pageCacheOptions || {};
const pageCache = context.runtimeConfig.pageCache || {};

const redisUrl = fallback.redisUrl || pageCache.redisUrl || "";
const cacheTime = Number(fallback.cacheTime ?? pageCache.cacheTime);
```

## Runtime Import Files

For small rules, inline `getCacheData` in `nuxt.config.js` is fine.

For production apps, prefer runtime import references:

```js
nuxt3: {
  getCacheData: "@/configs/pageCache.runtime.mjs#getCacheData",
  modifyHtmlBeforeRender: "@/configs/pageCache.runtime.mjs#modifyHtmlBeforeRender",
}
```

The file name does not have to end with `.runtime.mjs`; that is only a
convention. The important requirement is that Nitro can import the file at
server runtime.

Practical rules:

- `.mjs` files are safe because Node treats them as ESM.
- `.js` files are fine if your project uses `"type": "module"` or the file is
  otherwise native-ESM-safe.
- Avoid extensionless imports inside runtime files, such as
  `../utils/cacheKey`; prefer `../utils/cacheKey.js`.
- Do not import browser-only modules from runtime hook files.

## Options

| Property | Type | Default | Description |
| :-- | :-- | :-- | :-- |
| `disable` | boolean | `false` | Disable page caching. When `nuxt3.useRuntimeConfig` is true, runtime `getCacheData()` may still decide whether to cache. |
| `appendHost` | boolean | `true` | Append `req.headers.host` to Redis keys through package `getKey()`. |
| `ignoreConnectionErrors` | boolean | `false` | Fall back to normal SSR when Redis read/write fails. |
| `operationTimeout` | number | `1000` | Redis read/write timeout in milliseconds. Set `0` to disable. |
| `prefix` | string | `"r-"` | Redis key prefix passed to `RedisStore`. |
| `url` | string | `"redis://127.0.0.1:6379"` | Redis connection URL for build-time/config-time setup. |
| `getCacheData` | function | `undefined` | Inline cache metadata function. |
| `modifyHtmlBeforeRender` | function | `undefined` | Mutate cached/fresh HTML before it is sent. |
| `nuxt3.getCacheData` | string | `undefined` | Runtime import reference: `"path#exportName"`. |
| `nuxt3.modifyHtmlBeforeRender` | string | `undefined` | Runtime import reference: `"path#exportName"`. |
| `nuxt3.cacheData` | object | `{}` | Serializable data passed as `context.pageCacheOptions`. |
| `nuxt3.useRuntimeConfig` | boolean | `false` | Pass Nitro runtime config as `context.runtimeConfig`. |
| `nuxt3.useRuntimeRedisUrl` | boolean | `false` | Set generated option `url` to `null` and require `getCacheData()` to return `url`. |

## `getCacheData(route, context)`

`route` is built from `event.path`.

```js
{
  req: event.node.req,
  event,
  pageCacheOptions: options.nuxt3.cacheData,
  runtimeConfig: event.context.nitro.runtimeConfig || {}
}
```

Return `null`, `false`, or an object without `key` to skip caching.

Return shape:

```js
{
  key: "redis-key",
  expire: 60,
  renewCache: false,
  url: "redis://runtime-cache:6379",
  canonicalUrl: "/clean-route"
}
```

`renewCache: true` skips the cached read, renders fresh HTML, and writes the new
cache value.

### Canonical URL substitution

Set `canonicalUrl` when your Redis cache key deliberately ignores some request
query params, but Nuxt's SSR payload still serializes the full request URL into
`__NUXT_DATA__`.

On a cold render, the module stores the canonical payload in Redis but still
sends the user's original payload back to that first request. On a cache hit,
the module substitutes the cached canonical payload path back to the current
request route before sending the HTML. This keeps Vue Router hydration aligned
with the browser URL while keeping one shared Redis entry for equivalent routes.

The project owns the canonical policy. The canonical URL should be a clean route
URL, not a Redis key: no leading `&`, no empty `?`, deterministic query order,
and only query params that are safe for the cached SSR HTML identity.

The substitution is scoped to Nuxt's root payload `path` field inside
`__NUXT_DATA__`. It does not rewrite CMS HTML, anchors, canonical links, or
Open Graph URLs that happen to contain the same string.

## Cached Shape

Cached values are serialized render response objects with an `html` field:

```js
{
  html: "<!DOCTYPE html>...",
  body: "<!DOCTYPE html>...",
  statusCode: 200,
  headers: {}
}
```

`modifyHtmlBeforeRender()` runs before sending cached HTML and after the fresh
SSR response is written to Redis. When `canonicalUrl` is provided, Redis stores
the canonicalized copy while the current request still receives the original
request-shaped payload.

## Security

Only cache pages that are safe to share between users. Do not cache pages whose
HTML contains user-specific secrets, account data, or private checkout data.

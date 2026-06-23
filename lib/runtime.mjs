function isValidResult({ html, body } = {}) {
  const htmlToCheck = html || body || "";
  if (htmlToCheck.includes('id="webpage-main-layout"')) {
    return htmlToCheck.includes('id="webpage-main-content"');
  }
  return htmlToCheck.length > 0;
}

function getResponseBody(response) {
  return response && (response.html || response.body || "");
}

function createCachedObjectFromResponse(response) {
  const body = getResponseBody(response);
  return {
    ...response,
    html: body,
    body,
    headers: response.headers || {
      "content-type": "text/html;charset=utf-8",
      "x-powered-by": "Nuxt",
    },
  };
}

function createResponseFromCachedObject(cachedObject) {
  return {
    body: getResponseBody(cachedObject),
    statusCode: cachedObject.statusCode || 200,
    statusMessage: cachedObject.statusMessage,
    headers: cachedObject.headers || {
      "content-type": "text/html;charset=utf-8",
      "x-powered-by": "Nuxt",
    },
  };
}

function getNuxtDataScriptPattern() {
  return /(<script\b[^>]*\bid=["']__NUXT_DATA__["'][^>]*>)([\s\S]*?)(<\/script>)/i;
}

function getFlattenedPayloadRoot(payload) {
  if (Array.isArray(payload[0])) {
    const [type, rootIndex] = payload[0];
    if (type === "ShallowReactive" && Number.isInteger(rootIndex)) {
      return payload[rootIndex];
    }
  }

  return payload[0];
}

function setFlattenedPayloadString(payload, object, key, nextValue) {
  const currentRef = object[key];
  if (typeof currentRef === "number" && typeof payload[currentRef] === "string") {
    payload[currentRef] = nextValue;
    return true;
  }

  if (typeof currentRef === "string") {
    object[key] = nextValue;
    return true;
  }

  return false;
}

function updateFlattenedPayloadPath(payload, fromUrl, toUrl) {
  if (!Array.isArray(payload)) return false;

  const root = getFlattenedPayloadRoot(payload);
  if (!root || typeof root !== "object") return false;

  const pathRef = root.path;
  const currentPath =
    typeof pathRef === "number" ? payload[pathRef] : pathRef;
  if (currentPath !== fromUrl) return false;

  // Nuxt 3.14 inline __NUXT_DATA__ is emitted as a devalue flattened JSON
  // array. The client revives it with devalue.parse plus Nuxt's payload
  // revivers; mutating the flattened root path reference avoids broad string
  // replacement and does not require importing app-specific revivers here.
  return setFlattenedPayloadString(payload, root, "path", toUrl);
}

export function serializeNuxtDataPayload(payload) {
  return JSON.stringify(payload)
    .replace(/</g, "\\u003C")
    .replace(/\//g, "\\u002F");
}

export function substituteNuxtDataUrl(html, fromUrl, toUrl) {
  if (!html || !fromUrl || !toUrl || fromUrl === toUrl) return html;

  return html.replace(
    getNuxtDataScriptPattern(),
    (match, openTag, payloadBody, closeTag) => {
      try {
        const payload = JSON.parse(payloadBody.trim());
        const didUpdate = updateFlattenedPayloadPath(payload, fromUrl, toUrl);
        if (!didUpdate) return match;

        return `${openTag}${serializeNuxtDataPayload(payload)}${closeTag}`;
      } catch (error) {
        console.warn("[nuxt-page-caching] failed to substitute Nuxt payload URL", error);
        return match;
      }
    }
  );
}

function substituteCachedObjectUrl({ cachedObject, fromUrl, toUrl }) {
  if (!fromUrl || !toUrl || fromUrl === toUrl) return cachedObject;

  const nextCachedObject = { ...cachedObject };
  if (typeof nextCachedObject.html === "string") {
    nextCachedObject.html = substituteNuxtDataUrl(
      nextCachedObject.html,
      fromUrl,
      toUrl
    );
  }
  if (typeof nextCachedObject.body === "string") {
    nextCachedObject.body = substituteNuxtDataUrl(
      nextCachedObject.body,
      fromUrl,
      toUrl
    );
  }

  return nextCachedObject;
}

function createStore({ RedisStore, options, cacheData }) {
  return new RedisStore(
    cacheData.url || options.url,
    false,
    options.prefix,
    true,
    options.ignoreConnectionErrors,
    options.operationTimeout
  );
}

async function disconnectStore(store) {
  if (store && typeof store.disconnect === "function") {
    store.disconnect();
  }
}

function getRoute(event) {
  return event.path || event.node?.req?.url || "/";
}

function readRuntimeConfig(event) {
  if (event.context?.runtimeConfig) {
    return event.context.runtimeConfig;
  }

  if (event.context?.nitro?.runtimeConfig) {
    return event.context.nitro.runtimeConfig;
  }

  return {};
}

async function resolveCacheData({
  event,
  options,
  getCacheData,
}) {
  if (!getCacheData) return null;
  if (options.disable && !options.nuxt3?.useRuntimeConfig) return null;
  if (!["GET", "HEAD"].includes(event.method)) return null;

  const route = getRoute(event);
  const context = {
    req: event.node.req,
    event,
    pageCacheOptions: options.nuxt3?.cacheData || {},
    runtimeConfig: readRuntimeConfig(event),
  };
  const cacheData = await getCacheData(route, context);

  if (!cacheData || !cacheData.key) return null;
  if (options.nuxt3?.useRuntimeRedisUrl && !cacheData.url) return null;

  return { cacheData, route, context };
}

function getFinalCachedObject({ cachedObject, req, modifyHtmlBeforeRender }) {
  if (!modifyHtmlBeforeRender) return cachedObject;
  return modifyHtmlBeforeRender({ cachedObject, req });
}

function applyCachedObjectToResponse(response, cachedObject) {
  const body = getResponseBody(cachedObject);
  response.html = body;
  response.body = body;
  response.headers = cachedObject.headers || response.headers;
  response.statusCode = cachedObject.statusCode || response.statusCode;
  response.statusMessage = cachedObject.statusMessage || response.statusMessage;
}

const inFlightRenderMap = new Map();

function createInFlightRender(redisKey) {
  let resolvePromise;
  const inFlightRender = {
    redisKey,
    promise: new Promise((resolve) => {
      resolvePromise = resolve;
    }),
    resolve() {
      resolvePromise();
    },
  };

  inFlightRenderMap.set(redisKey, inFlightRender);
  return inFlightRender;
}

function settleInFlightRender(inFlightRender) {
  if (!inFlightRender) return;

  if (inFlightRenderMap.get(inFlightRender.redisKey) === inFlightRender) {
    inFlightRenderMap.delete(inFlightRender.redisKey);
  }

  inFlightRender.resolve();
}

function clearInFlightRenderMap() {
  for (const inFlightRender of inFlightRenderMap.values()) {
    inFlightRender.resolve();
  }
  inFlightRenderMap.clear();
}

function registerInFlightCleanup(ctx, inFlightRender) {
  const res = ctx.event.node?.res;
  if (!res || typeof res.once !== "function") return;

  res.once("close", () => settleInFlightRender(inFlightRender));
}

async function readCachedObject({
  options,
  RedisStore,
  deserialize,
  cacheData,
  redisKey,
  route,
  req,
  modifyHtmlBeforeRender,
}) {
  const store = createStore({ RedisStore, options, cacheData });
  try {
    const cachedResult = await store.read(redisKey);
    if (!cachedResult) return null;

    const cachedObject = deserialize(cachedResult);
    if (!isValidResult(cachedObject)) return null;

    const requestCachedObject = substituteCachedObjectUrl({
      cachedObject,
      fromUrl: cacheData.canonicalUrl,
      toUrl: route,
    });
    return getFinalCachedObject({
      cachedObject: requestCachedObject,
      req,
      modifyHtmlBeforeRender,
    });
  } finally {
    await disconnectStore(store);
  }
}

function applyCacheHit(ctx, cachedObject) {
  ctx.event.context.nuxtPageCaching.hit = true;
  ctx.response = createResponseFromCachedObject(cachedObject);
}

export async function handleRenderBefore(ctx, deps) {
  const {
    options,
    RedisStore,
    getKey,
    deserialize,
    getCacheData,
    modifyHtmlBeforeRender,
  } = deps;

  const resolved = await resolveCacheData({
    event: ctx.event,
    options,
    getCacheData,
  });
  if (!resolved) return;

  const { cacheData } = resolved;
  const redisKey = getKey({
    appendHost: options.appendHost,
    req: ctx.event.node.req,
    key: cacheData.key,
  });

  ctx.event.context.nuxtPageCaching = {
    ...resolved,
    redisKey,
  };

  if (cacheData.renewCache) return;

  try {
    const finalCachedObject = await readCachedObject({
      options,
      RedisStore,
      deserialize,
      cacheData,
      redisKey,
      route: resolved.route,
      req: ctx.event.node.req,
      modifyHtmlBeforeRender,
    });
    if (finalCachedObject) {
      applyCacheHit(ctx, finalCachedObject);
      return;
    }

    const pendingRender = inFlightRenderMap.get(redisKey);
    if (pendingRender) {
      await pendingRender.promise;

      const cachedObjectAfterPendingRender = await readCachedObject({
        options,
        RedisStore,
        deserialize,
        cacheData,
        redisKey,
        route: resolved.route,
        req: ctx.event.node.req,
        modifyHtmlBeforeRender,
      });
      if (cachedObjectAfterPendingRender) {
        applyCacheHit(ctx, cachedObjectAfterPendingRender);
        return;
      }
    }

    const inFlightRender = createInFlightRender(redisKey);
    ctx.event.context.nuxtPageCaching.inFlightRender = inFlightRender;
    registerInFlightCleanup(ctx, inFlightRender);
  } catch (error) {
    delete ctx.event.context.nuxtPageCaching;
    if (!options.ignoreConnectionErrors) {
      console.error("[nuxt-page-caching] cache read failed", error);
    }
  }
}

export async function handleRenderResponse(response, ctx, deps) {
  const { options, RedisStore, serialize } = deps;
  const state = ctx.event.context.nuxtPageCaching;
  if (!state || state.hit) return;

  let store;
  try {
    const cachedObject = createCachedObjectFromResponse(response);
    if (
      cachedObject.statusCode >= 400 ||
      cachedObject.error ||
      cachedObject.redirected ||
      !isValidResult(cachedObject)
    ) {
      return;
    }

    store = createStore({
      RedisStore,
      options,
      cacheData: state.cacheData,
    });

    const cacheObjectToStore = substituteCachedObjectUrl({
      cachedObject,
      fromUrl: state.route,
      toUrl: state.cacheData.canonicalUrl,
    });

    await store.write(
      state.redisKey,
      serialize(cacheObjectToStore),
      state.cacheData.expire
    );

    const finalCachedObject = getFinalCachedObject({
      cachedObject,
      req: ctx.event.node.req,
      modifyHtmlBeforeRender: deps.modifyHtmlBeforeRender,
    });
    applyCachedObjectToResponse(response, finalCachedObject);
  } catch (error) {
    if (!options.ignoreConnectionErrors) {
      console.error("[nuxt-page-caching] cache write failed", error);
    }
  } finally {
    await disconnectStore(store);
    settleInFlightRender(state.inFlightRender);
  }
}

export function createPageCachingHooks(nitroApp, deps) {
  nitroApp.hooks.hook("render:before", (ctx) => handleRenderBefore(ctx, deps));
  nitroApp.hooks.hook("render:response", (response, ctx) =>
    handleRenderResponse(response, ctx, deps)
  );
}

export const __test__ = {
  createCachedObjectFromResponse,
  createResponseFromCachedObject,
  isValidResult,
  resolveCacheData,
  applyCachedObjectToResponse,
  substituteCachedObjectUrl,
  updateFlattenedPayloadPath,
  serializeNuxtDataPayload,
  clearInFlightRenderMap,
};

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

  const store = createStore({ RedisStore, options, cacheData });
  try {
    const cachedResult = await store.read(redisKey);
    if (!cachedResult) return;

    const cachedObject = deserialize(cachedResult);
    if (!isValidResult(cachedObject)) return;

    const finalCachedObject = getFinalCachedObject({
      cachedObject,
      req: ctx.event.node.req,
      modifyHtmlBeforeRender,
    });

    ctx.event.context.nuxtPageCaching.hit = true;
    ctx.response = createResponseFromCachedObject(finalCachedObject);
  } catch (error) {
    delete ctx.event.context.nuxtPageCaching;
    if (!options.ignoreConnectionErrors) {
      console.error("[nuxt-page-caching] cache read failed", error);
    }
  } finally {
    await disconnectStore(store);
  }
}

export async function handleRenderResponse(response, ctx, deps) {
  const { options, RedisStore, serialize } = deps;
  const state = ctx.event.context.nuxtPageCaching;
  if (!state || state.hit) return;

  const cachedObject = createCachedObjectFromResponse(response);
  if (
    cachedObject.statusCode >= 400 ||
    cachedObject.error ||
    cachedObject.redirected ||
    !isValidResult(cachedObject)
  ) {
    return;
  }

  const store = createStore({
    RedisStore,
    options,
    cacheData: state.cacheData,
  });
  try {
    await store.write(
      state.redisKey,
      serialize(cachedObject),
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
};

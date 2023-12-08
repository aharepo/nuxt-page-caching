import path from "path";

import RedisStore from "./lib/RedisStore";
import { serialize, deserialize } from "./lib/serializer";
import getKey from "./lib/getKey";

function isValidResult({ html }) {
  // Nuxt generated valid layout
  const htmlToCheck = html || "";
  if (htmlToCheck.includes('id="webpage-main-layout"')) {
    return htmlToCheck.includes('id="webpage-main-content"');
  }
  return htmlToCheck.length > 0;
}

export default function index({
  getCacheData,
  url = "redis://127.0.0.1:6379",
  prefix = "r-",
  appendHost = true,
  disable = false,
  ignoreConnectionErrors = false,
  modifyHtmlBeforeRender,
}) {
  const { nuxt } = this;

  nuxt.hook("render:before", (renderer) => {
    const renderRoute = renderer.renderRoute.bind(renderer);

    renderer.renderRoute = function (route, context) {
      const cacheData = getCacheData ? getCacheData(route, context) : null;
      if (!cacheData || disable) return renderRoute(route, context);

      // eslint-disable-next-line prefer-const
      let { key, expire, renewCache } = cacheData;

      const useRedisStore = () =>
        new RedisStore(
          cacheData.url || url,
          false,
          prefix,
          true,
          ignoreConnectionErrors
        );

      const getFinalHtmlToSend = (result) => {
        const finalHtml = modifyHtmlBeforeRender
          ? modifyHtmlBeforeRender({
              cachedObject: result,
              req: context.req,
            })
          : result;
        return finalHtml;
      };

      function renderAndSetCacheKey() {
        return renderRoute(route, context).then(async function (result) {
          if (isValidResult(result) && !result.error && !result.redirected) {
            const redisKey = getKey({ appendHost, req: context.req, key });
            const value = serialize(result);
            await useRedisStore().write(redisKey, value, expire, true);
          }
          return getFinalHtmlToSend(result);
        });
      }

      return new Promise(async (resolve) => {
        try {
          const cachedResult = await useRedisStore().read(key, true);
          if (cachedResult && !renewCache) {
            const deserialized = deserialize(cachedResult);
            if (isValidResult(deserialized)) {
              return resolve(getFinalHtmlToSend(deserialized));
            }
          }
          resolve(renderAndSetCacheKey());
        } catch {
          resolve(renderRoute(route, context));
        }
      });
    };
  });

  this.addPlugin({
    fileName: "nuxt-page-caching/plugin.js",
    src: path.resolve(__dirname, "plugin.js"),
    options: {
      url,
      prefix,
      appendHost,
      disable,
      ignoreConnectionErrors,
    },
  });
}

module.exports.meta = require("./package.json");

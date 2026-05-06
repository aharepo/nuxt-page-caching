import { createRequire } from "node:module";
import path from "node:path";

import { buildNuxt3RuntimePlugin } from "./lib/moduleTemplate.mjs";

const projectRequire = createRequire(path.resolve(process.cwd(), "package.json"));
const { addServerPlugin, addTemplate, defineNuxtModule } = await import(
  projectRequire.resolve("@nuxt/kit")
);

const moduleDefaults = {
  disable: false,
  appendHost: true,
  ignoreConnectionErrors: false,
  operationTimeout: 1000,
  prefix: "r-",
  url: "redis://127.0.0.1:6379",
};

export default defineNuxtModule({
  meta: {
    name: "nuxt-page-caching",
    configKey: "nuxtPageCaching",
    compatibility: {
      nuxt: "^3.0.0",
    },
  },
  defaults: moduleDefaults,
  setup(options, nuxt) {
    const moduleOptions = {
      ...moduleDefaults,
      ...options,
    };
    const template = addTemplate({
      filename: "nuxt-page-caching/nitro-plugin.mjs",
      write: true,
      getContents: () =>
        buildNuxt3RuntimePlugin({
          nuxt,
          moduleOptions,
          moduleDir: new URL(".", import.meta.url).pathname,
        }),
    });

    addServerPlugin(path.resolve(nuxt.options.buildDir, template.dst));
  },
});

const assert = require("assert/strict");
const test = require("node:test");

const getKey = require("../lib/getKey");
const RedisStore = require("../lib/RedisStore");
const { serialize, deserialize } = require("../lib/serializer");

test("getKey preserves the exact key when appendHost is false", () => {
  assert.equal(
    getKey({
      appendHost: false,
      req: { headers: { host: "www.aha.is" } },
      key: "NC_1.0.0_abcdef_is__https://www.aha.is/",
    }),
    "NC_1.0.0_abcdef_is__https://www.aha.is/"
  );
});

test("getKey appends host when appendHost is true", () => {
  assert.equal(
    getKey({
      appendHost: true,
      req: { headers: { host: "www.aha.is" } },
      key: "home",
    }),
    "home-www.aha.is"
  );
});

test("serializer round-trips sets and functions from cached render objects", () => {
  const cached = {
    html: "<main>ok</main>",
    modules: new Set(["a.vue", "b.vue"]),
    getValue: () => "value",
  };

  const result = deserialize(serialize(cached));

  assert.equal(result.html, cached.html);
  assert.deepEqual([...result.modules], ["a.vue", "b.vue"]);
  assert.equal(result.getValue(), "value");
});

test("RedisStore operation timeout rejects and absorbs late command rejection", async () => {
  const store = Object.create(RedisStore.prototype);
  store.operationTimeout = 5;

  let rejectCommand;
  const command = new Promise((resolve, reject) => {
    rejectCommand = reject;
  });

  await assert.rejects(
    store.withOperationTimeout(command, "read", "page-key"),
    /Redis read timed out after 5ms/
  );

  rejectCommand(new Error("late redis abort"));
  await new Promise((resolve) => setTimeout(resolve, 0));
});

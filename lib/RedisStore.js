const environment = process.env;
const NODE_ENV = environment.NODE_ENV;
const isDevMode = Object.is(NODE_ENV, "development");

const { promisify } = require("util");
const Redis = require("redis");
const DEFAULT_URL = "redis://127.0.0.1:6379";
const PREFIX = "r-";
const DEFAULT_EXPIRES = 60 * 60;
const DEFAULT_OPERATION_TIMEOUT = 1000;

function getOperationTimeout(timeout) {
  const normalizedTimeout = Number(timeout ?? DEFAULT_OPERATION_TIMEOUT);
  return Number.isFinite(normalizedTimeout) && normalizedTimeout > 0
    ? normalizedTimeout
    : 0;
}

function getElapsedMs(start) {
  return `${Date.now() - start.getTime()}ms`;
}

class RedisStore {
  constructor(
    url = DEFAULT_URL,
    jsonEncode = true,
    prefix = PREFIX,
    active = process && process.server,
    ignoreConnectionErrors,
    operationTimeout = DEFAULT_OPERATION_TIMEOUT
  ) {
    this.isActive = active;
    if (this.isActive) {
      this.jsonEncode = jsonEncode;
      this.operationTimeout = getOperationTimeout(operationTimeout);
      isDevMode && console.log("**create client called**");
      this.store = Redis.createClient({
        url,
        prefix,
        retry_strategy: undefined,
      });
      if (ignoreConnectionErrors) {
        this.store.on("error", (err) => {
          this.onError(err);
        });
      }
      this.client = {
        get: async (key) => {
          const start = new Date();
          const getAsync = promisify(this.store.get).bind(this.store);
          try {
            const value = await this.withOperationTimeout(
              getAsync(key),
              "read",
              key
            );
            isDevMode &&
              console.log({
                action: "READ",
                status: value ? "HIT" : "MISS",
                key,
                start,
                elapsed: getElapsedMs(start),
              });
            return value;
          } catch (error) {
            isDevMode &&
              console.log({
                action: "READ",
                status: "ERROR",
                key,
                start,
                elapsed: getElapsedMs(start),
                error: error.message,
              });
            throw error;
          }
        },
        set: async (key, val) => {
          const start = new Date();
          const setAsync = promisify(this.store.set).bind(this.store);
          try {
            const result = await this.withOperationTimeout(
              setAsync(key, val),
              "write",
              key
            );
            isDevMode &&
              console.log({
                action: "WRITE",
                status: "OK",
                key,
                start,
                elapsed: getElapsedMs(start),
              });
            return result;
          } catch (error) {
            isDevMode &&
              console.log({
                action: "WRITE",
                status: "ERROR",
                key,
                start,
                elapsed: getElapsedMs(start),
                error: error.message,
              });
            throw error;
          }
        },
        setex: async (key, expires, val) => {
          const start = new Date();
          const setexAsync = promisify(this.store.setex).bind(this.store);
          try {
            const result = await this.withOperationTimeout(
              setexAsync(key, expires, val),
              "write",
              key
            );
            isDevMode &&
              console.log({
                action: "WRITE",
                status: "OK",
                key,
                start,
                elapsed: getElapsedMs(start),
                expires,
              });
            return result;
          } catch (error) {
            isDevMode &&
              console.log({
                action: "WRITE",
                status: "ERROR",
                key,
                start,
                elapsed: getElapsedMs(start),
                expires,
                error: error.message,
              });
            throw error;
          }
        },
      };
    }
  }

  withOperationTimeout(promise, action, key) {
    promise.catch(() => {});
    if (!this.operationTimeout) return promise;

    return Promise.race([
      promise,
      new Promise((resolve, reject) => {
        setTimeout(() => {
          reject(
            new Error(
              `[nuxt-page-caching] Redis ${action} timed out after ${this.operationTimeout}ms for key ${key}`
            )
          );
        }, this.operationTimeout);
      }),
    ]);
  }

  onError(err) {
    console.error("Error connecting to redis", err);
  }
  disconnect() {
    if (this.isActive) {
      isDevMode && console.log("**disconnect called**");
    } else {
      isDevMode && console.log("disconnect not working********", this.isActive);
    }
    if (this.isActive && this.store) {
      this.store.quit((error) => {
        if (error && !String(error.message || "").includes("aborted")) {
          this.onError(error);
        }
      });
    }
  }

  async read(key, disconnect = false) {
    try {
      this.onError = () => {};
      const res = await this.client.get(key);
      if (!res) {
        return null;
      }
      try {
        return this.decode(res);
      } catch (e) {
        console.error("read from redis json parse error", e);
        return null;
      }
    } finally {
      disconnect && this.disconnect();
    }
  }

  encode(value) {
    return this.jsonEncode ? JSON.stringify(value) : value;
  }

  decode(value) {
    return this.jsonEncode ? JSON.parse(value) : value;
  }

  async write(key, value, expires = DEFAULT_EXPIRES, disconnect = false) {
    try {
      this.onError = () => {};
      await this.client.setex(key, expires, this.encode(value));
      return true;
    } finally {
      disconnect && this.disconnect();
    }
  }

  async fetch(key, expires, callback, disconnect = true) {
    if (!this.isActive) {
      return callback();
    }
    let obj;
    try {
      obj = await this.read(key);
      // console.log('obj from redis', obj)
      if (obj) {
        return obj;
      }

      obj = await callback();
      if (obj) {
        await this.write(key, obj, expires);
      }
    } catch (e) {
      return callback();
    } finally {
      disconnect && this.disconnect();
    }
    return obj;
  }

  // async fetch(key, expires, callback, disconnect = true) {
  //   if (!this.isActive) {
  //     return callback()
  //   }
  //   return new Promise(async (resolve)=>{
  //     let error=false;
  //     this.onError=async ()=>{
  //       if(!error){
  //         isDevMode && console.error("error to connect back to normal")
  //         resolve(callback())
  //       }
  //       error=true
  //     }
  //     try {
  //       let temp = await this.read(key)
  //       // console.log('obj from redis', obj)
  //       if (temp) {
  //         return resolve(temp)
  //       }
  //
  //       temp = await callback()
  //       if (temp) {
  //         await this.write(key, temp, expires)
  //         resolve(temp)
  //       }
  //     } finally {
  //       disconnect && this.disconnect()
  //     }
  //   })
  //   }
}

module.exports = RedisStore;
module.exports.default = RedisStore;

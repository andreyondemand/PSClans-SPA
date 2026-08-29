import assert from "node:assert/strict";
import test from "node:test";

import worker from "./spa-api.js";

function createEmptyD1() {
  return {
    prepare(query) {
      return {
        bind() {
          return {
            async first() {
              return null;
            },
            async all() {
              return { results: [] };
            },
            async run() {
              throw new Error(`Unexpected write: ${query}`);
            },
          };
        },
      };
    },
  };
}

function createD1WithTrackedClan(clanName) {
  return {
    prepare() {
      return {
        bind() {
          return {
            async first() {
              return null;
            },
            async all() {
              return { results: [{ clan_name: clanName }] };
            },
            async run() {
              return { success: true };
            },
          };
        },
      };
    },
  };
}

function createD1WithOrphanedExpiredData(writes) {
  return {
    prepare(query) {
      return {
        bind() {
          return {
            async first() {
              if (query.includes("EXISTS(SELECT 1 FROM clan_snapshots")) {
                return { has_snapshots: 1, has_changes: 1, has_tracked: 0, has_state: 0 };
              }
              return null;
            },
            async all() {
              return { results: [] };
            },
            async run() {
              writes.push(query);
              return { success: true };
            },
          };
        },
      };
    },
  };
}

test("an already-cleaned expired battle is not repopulated", async () => {
  const originalFetch = globalThis.fetch;
  const requestedUrls = [];
  const finishTime = Math.floor(Date.now() / 1000) - 86401;

  globalThis.fetch = async (url) => {
    requestedUrls.push(String(url));
    return Response.json({
      data: {
        configName: "ExpiredBattle",
        configData: { FinishTime: finishTime },
      },
    });
  };

  try {
    let scheduledWork;
    await worker.scheduled(null, { D1_DB: createEmptyD1() }, {
      waitUntil(promise) {
        scheduledWork = promise;
      },
    });
    await scheduledWork;

    assert.deepEqual(requestedUrls, ["https://ps99.biggamesapi.io/api/activeClanBattle"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an expired battle removes orphaned rows without repopulating", async () => {
  const originalFetch = globalThis.fetch;
  const requestedUrls = [];
  const writes = [];
  const finishTime = Math.floor(Date.now() / 1000) - 86401;

  globalThis.fetch = async (url) => {
    requestedUrls.push(String(url));
    return Response.json({
      data: {
        configName: "ExpiredBattle",
        configData: { FinishTime: finishTime },
      },
    });
  };

  try {
    let scheduledWork;
    await worker.scheduled(null, { D1_DB: createD1WithOrphanedExpiredData(writes) }, {
      waitUntil(promise) {
        scheduledWork = promise;
      },
    });
    await scheduledWork;

    assert.deepEqual(requestedUrls, ["https://ps99.biggamesapi.io/api/activeClanBattle"]);
    assert.equal(writes.length, 4);
    assert.ok(writes.every((query) => query.startsWith("DELETE FROM")));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("the public API accepts only GET and OPTIONS", async () => {
  const env = { D1_DB: createEmptyD1() };
  const postResponse = await worker.fetch(new Request("https://worker.example/message", { method: "POST" }), env);
  const optionsResponse = await worker.fetch(new Request("https://worker.example/message", { method: "OPTIONS" }), env);

  assert.equal(postResponse.status, 405);
  assert.equal(optionsResponse.status, 204);
  assert.equal(optionsResponse.headers.get("Access-Control-Allow-Methods"), "GET, OPTIONS");
});

test("concurrent requests keep their D1 bindings isolated", async () => {
  const originalFetch = globalThis.fetch;
  let upstreamRequest = 0;
  globalThis.fetch = async () => {
    upstreamRequest += 1;
    return Response.json({
      data: {
        configName: `Battle${upstreamRequest}`,
        configData: { FinishTime: Math.floor(Date.now() / 1000) + 3600 },
      },
    });
  };

  try {
    const [first, second] = await Promise.all([
      worker.fetch(new Request("https://worker.example/clans"), { D1_DB: createD1WithTrackedClan("alpha") }),
      worker.fetch(new Request("https://worker.example/clans"), { D1_DB: createD1WithTrackedClan("beta") }),
    ]);

    assert.deepEqual(await first.json(), ["alpha"]);
    assert.deepEqual(await second.json(), ["beta"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

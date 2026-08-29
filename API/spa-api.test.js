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
              if (query.includes("INSERT INTO scheduler_status") || query.includes("DELETE FROM username_cache")) {
                return { success: true };
              }
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
              if (query.includes("INSERT INTO scheduler_status") || query.includes("DELETE FROM username_cache")) {
                return { success: true };
              }
              writes.push(query);
              return { success: true };
            },
          };
        },
      };
    },
  };
}

function createD1WithSchedulerStatus(statusRow) {
  return {
    prepare(query) {
      return {
        bind() {
          return {
            async first() {
              if (query.includes("FROM scheduler_status")) {
                return statusRow;
              }
              return null;
            },
            async all() {
              return { results: [] };
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

function createD1WithSnapshots(rows, captures) {
  return {
    prepare(query) {
      return {
        bind(...params) {
          captures.push({ query, params });
          return {
            async first() {
              return null;
            },
            async all() {
              return { results: rows };
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

function createD1WithRecordedWrites(writes) {
  return {
    prepare(query) {
      return {
        bind(...params) {
          return {
            async first() {
              return null;
            },
            async all() {
              return { results: [] };
            },
            async run() {
              writes.push({ query, params });
              return { success: true };
            },
          };
        },
      };
    },
  };
}

function createD1ForFailedScheduledRun(state) {
  return {
    prepare(query) {
      return {
        bind(...params) {
          return {
            async first() {
              if (query.includes("FROM scheduler_status")) {
                return state.row;
              }
              return null;
            },
            async all() {
              return { results: [] };
            },
            async run() {
              if (query.includes("INSERT INTO scheduler_status")) {
                const [runState, battleId, lastStartedAt, lastSuccessAt, lastError, updatedAt] = params;
                state.row = {
                  state: runState,
                  battle_id: battleId || state.row?.battle_id || null,
                  last_started_at: lastStartedAt || state.row?.last_started_at || null,
                  last_success_at: lastSuccessAt || state.row?.last_success_at || null,
                  last_error: lastError,
                  updated_at: updatedAt,
                };
              }
              state.writes.push({ query, params });
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

test("the public rate limiter blocks expensive routes before upstream work", async () => {
  const originalFetch = globalThis.fetch;
  let upstreamCalls = 0;
  const limiterKeys = [];
  globalThis.fetch = async () => {
    upstreamCalls += 1;
    return Response.json({ data: [] });
  };

  try {
    const response = await worker.fetch(
      new Request("https://worker.example/usernames?ids=1", {
        headers: { "CF-Connecting-IP": "203.0.113.8" },
      }),
      {
        D1_DB: createEmptyD1(),
        API_RATE_LIMITER: {
          async limit({ key }) {
            limiterKeys.push(key);
            return { success: false };
          },
        },
      }
    );

    assert.equal(response.status, 429);
    assert.equal(response.headers.get("Retry-After"), "60");
    assert.deepEqual(limiterKeys, ["/usernames:203.0.113.8"]);
    assert.equal(upstreamCalls, 0);

    let healthDbCalls = 0;
    const healthResponse = await worker.fetch(
      new Request("https://worker.example/health", {
        headers: { "CF-Connecting-IP": "203.0.113.8" },
      }),
      {
        D1_DB: {
          prepare() {
            healthDbCalls += 1;
            throw new Error("Health D1 should not be reached after rate limiting");
          },
        },
        API_RATE_LIMITER: {
          async limit({ key }) {
            limiterKeys.push(key);
            return { success: false };
          },
        },
      }
    );
    assert.equal(healthResponse.status, 429);
    assert.equal(healthDbCalls, 0);
    assert.deepEqual(limiterKeys, ["/usernames:203.0.113.8", "/health:203.0.113.8"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("malformed or oversized username batches are rejected without an upstream call", async () => {
  const originalFetch = globalThis.fetch;
  let upstreamCalls = 0;
  globalThis.fetch = async () => {
    upstreamCalls += 1;
    return Response.json({ data: [] });
  };

  const invalidQueries = [
    "abc",
    "-1",
    "1x",
    "9007199254740992",
    Array.from({ length: 201 }, () => "1").join(","),
  ];

  try {
    for (const ids of invalidQueries) {
      const response = await worker.fetch(
        new Request(`https://worker.example/usernames?ids=${encodeURIComponent(ids)}`),
        { D1_DB: createEmptyD1() }
      );
      assert.equal(response.status, 400, ids);
    }
    assert.equal(upstreamCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("oversized raw clan batches are rejected before deduplication or upstream work", async () => {
  const originalFetch = globalThis.fetch;
  let upstreamCalls = 0;
  globalThis.fetch = async () => {
    upstreamCalls += 1;
    return Response.json({ data: [] });
  };

  try {
    const clans = Array.from({ length: 31 }, () => "UN0").join(",");
    const response = await worker.fetch(
      new Request(`https://worker.example/changes?clans=${encodeURIComponent(clans)}`),
      { D1_DB: createEmptyD1() }
    );
    assert.equal(response.status, 400);
    assert.equal(upstreamCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("out-of-range history timestamps are rejected before upstream work", async () => {
  const originalFetch = globalThis.fetch;
  let upstreamCalls = 0;
  globalThis.fetch = async () => {
    upstreamCalls += 1;
    return Response.json({ data: {} });
  };

  try {
    const response = await worker.fetch(
      new Request("https://worker.example/clan?clan=UN0&before=9007199254740991"),
      { D1_DB: createEmptyD1() }
    );
    assert.equal(response.status, 400);
    assert.equal(upstreamCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("valid duplicate username ids are deduplicated and sent with a timeout signal", async () => {
  const originalFetch = globalThis.fetch;
  const requestBodies = [];
  globalThis.fetch = async (_url, options) => {
    requestBodies.push(JSON.parse(options.body));
    assert.ok(options.signal instanceof AbortSignal);
    return Response.json({ data: [{ id: 1, name: "Roblox" }] });
  };

  try {
    const response = await worker.fetch(
      new Request("https://worker.example/usernames?ids=1,1"),
      { D1_DB: createEmptyD1() }
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), [{ id: 1, name: "Roblox" }]);
    assert.deepEqual(requestBodies, [{ userIds: [1], excludeBannedUsers: true }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an upstream username failure is reported as 502 instead of a successful empty list", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("denied", { status: 401 });

  try {
    const response = await worker.fetch(
      new Request("https://worker.example/usernames?ids=1"),
      { D1_DB: createEmptyD1() }
    );
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: "upstream_failure" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("successful clan username caching evicts expired and over-cap rows", async () => {
  const originalFetch = globalThis.fetch;
  const writes = [];
  globalThis.fetch = async (url) => {
    if (String(url).includes("ps99.biggamesapi.io/api/clan/")) {
      return Response.json({ data: { Owner: 1, Members: [] } });
    }
    return Response.json({ data: [{ id: 1, name: "Roblox" }] });
  };

  try {
    const response = await worker.fetch(
      new Request("https://worker.example/usernames?clan=UN0"),
      { D1_DB: createD1WithRecordedWrites(writes) }
    );
    assert.equal(response.status, 200);
    assert.ok(writes.some(({ query }) => query.includes("INSERT INTO username_cache")));
    assert.ok(writes.some(({ query }) => query.includes("DELETE FROM username_cache WHERE expires_at")));
    const capWrite = writes.find(({ query }) => query.includes("ORDER BY updated_at DESC"));
    assert.ok(capWrite);
    assert.deepEqual(capWrite.params, [5000]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an upstream username timeout is reported as 504 after the bounded retry policy", async () => {
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    throw new DOMException("timed out", "TimeoutError");
  };

  try {
    const response = await worker.fetch(
      new Request("https://worker.example/usernames?ids=1"),
      { D1_DB: createEmptyD1() }
    );
    assert.equal(response.status, 504);
    assert.deepEqual(await response.json(), { error: "upstream_timeout" });
    assert.equal(attempts, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("clan history is bounded in SQL and remains chronological", async () => {
  const originalFetch = globalThis.fetch;
  const captures = [];
  const rows = [
    { timestamp: "2026-08-29T03:00:00.000Z", data_json: JSON.stringify({ Points: 3 }) },
    { timestamp: "2026-08-29T02:00:00.000Z", data_json: JSON.stringify({ Points: 2 }) },
    { timestamp: "2026-08-29T01:00:00.000Z", data_json: JSON.stringify({ Points: 1 }) },
  ];
  globalThis.fetch = async () => Response.json({
    data: {
      configName: "ActiveBattle",
      configData: { FinishTime: Math.floor(Date.now() / 1000) + 3600 },
    },
  });

  try {
    const response = await worker.fetch(
      new Request("https://worker.example/clan?clan=UN0&limit=2"),
      { D1_DB: createD1WithSnapshots(rows, captures) }
    );
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.deepEqual(payload.history.map((entry) => entry.timestamp), [
      "2026-08-29T02:00:00.000Z",
      "2026-08-29T03:00:00.000Z",
    ]);
    assert.equal(payload.meta.hasMore, true);
    assert.equal(payload.meta.oldestTimestamp, "2026-08-29T02:00:00.000Z");
    assert.match(captures[0].query, /ORDER BY timestamp DESC\s+LIMIT \?/);
    assert.deepEqual(captures[0].params, ["ActiveBattle", "un0", 3]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("user history pagination advances by the raw snapshot boundary", async () => {
  const originalFetch = globalThis.fetch;
  const captures = [];
  const rows = [
    {
      timestamp: "2026-08-29T03:00:00.000Z",
      data_json: JSON.stringify({ PointContributions: [{ UserID: 1, Points: 30 }] }),
    },
    {
      timestamp: "2026-08-29T02:00:00.000Z",
      data_json: JSON.stringify({ PointContributions: [{ UserID: 2, Points: 20 }] }),
    },
    {
      timestamp: "2026-08-29T01:00:00.000Z",
      data_json: JSON.stringify({ PointContributions: [{ UserID: 1, Points: 10 }] }),
    },
  ];
  globalThis.fetch = async () => Response.json({
    data: {
      configName: "ActiveBattle",
      configData: { FinishTime: Math.floor(Date.now() / 1000) + 3600 },
    },
  });

  try {
    const response = await worker.fetch(
      new Request("https://worker.example/clan?clan=UN0&userId=1&limit=2"),
      { D1_DB: createD1WithSnapshots(rows, captures) }
    );
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.deepEqual(payload.history, [{
      timestamp: "2026-08-29T03:00:00.000Z",
      UserID: 1,
      Points: 30,
    }]);
    assert.equal(payload.meta.hasMore, true);
    assert.equal(payload.meta.oldestTimestamp, "2026-08-29T02:00:00.000Z");
    assert.deepEqual(captures[0].params, ["ActiveBattle", "un0", 3]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a scheduled batch with no usable clan updates records degraded health", async () => {
  const originalFetch = globalThis.fetch;
  const originalConsoleError = console.error;
  const state = { row: null, writes: [] };
  let clanDetailCalls = 0;
  globalThis.fetch = async (url) => {
    const requestUrl = String(url);
    if (requestUrl.endsWith("/activeClanBattle")) {
      return Response.json({
        data: {
          configName: "ActiveBattle",
          configData: { FinishTime: Math.floor(Date.now() / 1000) + 3600 },
        },
      });
    }
    if (requestUrl.includes("/api/clans?")) {
      return Response.json({ data: [] });
    }
    clanDetailCalls += 1;
    return new Response("missing", { status: 404 });
  };
  console.error = () => {};

  try {
    const db = createD1ForFailedScheduledRun(state);
    let scheduledWork;
    await worker.scheduled(null, { D1_DB: db }, {
      waitUntil(promise) {
        scheduledWork = promise;
      },
    });
    await scheduledWork;

    assert.equal(clanDetailCalls, 30);
    assert.equal(state.row.state, "error");
    assert.equal(state.row.last_success_at, null);
    assert.ok(state.writes.some(({ query }) => query.includes("DELETE FROM username_cache WHERE expires_at")));
    assert.ok(!state.writes.some(({ query }) => query.includes("INSERT INTO battle_state")));

    const healthResponse = await worker.fetch(
      new Request("https://worker.example/health"),
      { D1_DB: db }
    );
    assert.equal(healthResponse.status, 503);
    assert.equal((await healthResponse.json()).scheduler.state, "error");
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalConsoleError;
  }
});

test("health distinguishes a fresh idle scheduler from a stale scheduler", async () => {
  const now = Math.floor(Date.now() / 1000);
  const freshResponse = await worker.fetch(
    new Request("https://worker.example/health"),
    {
      D1_DB: createD1WithSchedulerStatus({
        state: "idle",
        battle_id: "FinishedBattle",
        last_started_at: now,
        last_success_at: now,
        updated_at: now,
      }),
    }
  );
  assert.equal(freshResponse.status, 200);
  assert.equal((await freshResponse.json()).status, "ok");

  const staleResponse = await worker.fetch(
    new Request("https://worker.example/health"),
    {
      D1_DB: createD1WithSchedulerStatus({
        state: "ok",
        battle_id: "ActiveBattle",
        last_started_at: now - 3600,
        last_success_at: now - 3600,
        updated_at: now - 3600,
      }),
    }
  );
  assert.equal(staleResponse.status, 503);
  assert.equal((await staleResponse.json()).status, "degraded");
});

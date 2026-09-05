import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import worker from "./spa-api.js";

// Run the actual migrations/SQL, with D1's transactional batch semantics.
function fixture(t, clans = ["a", "b", "c", "d", "e", "f", "g"]) {
  const sql = new DatabaseSync(":memory:");
  const migrations = new URL("../migrations/", import.meta.url);
  for (const file of readdirSync(migrations).filter((name) => name.endsWith(".sql")).sort()) {
    sql.exec(readFileSync(new URL(file, migrations), "utf8"));
  }
  const battle = "TestBattle";
  const finish = Math.floor(Date.now() / 1000) + 3600;
  for (const clan of clans) sql.prepare("INSERT INTO tracked_clans VALUES (?, ?, ?)").run(battle, clan, 1);
  sql.prepare("INSERT INTO battle_state VALUES (?, 0, ?, ?)").run(battle, finish, 1);
  const requests = [];
  const writes = [];
  let failQuery = null;
  const db = {
    prepare(query) {
      return { bind(...params) {
        return {
          async first() { return sql.prepare(query).get(...params) ?? null; },
          async all() { return { results: sql.prepare(query).all(...params) }; },
          async run() {
            if (failQuery?.(query, params)) throw new Error("Injected database failure");
            writes.push(query);
            sql.prepare(query).run(...params);
            return { success: true };
          },
        };
      } };
    },
    async batch(statements) {
      sql.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        sql.exec("COMMIT");
        return results;
      } catch (error) { sql.exec("ROLLBACK"); throw error; }
    },
  };
  const points = { BattleID: battle, Points: 100, Place: 1, PointContributions: [{ UserID: 1, Points: 100 }] };
  let detail = () => Response.json({ data: { Battles: { [battle]: points } } });
  t.mock.method(globalThis, "fetch", async (url) => {
    requests.push(String(url));
    if (String(url).endsWith("/activeClanBattle")) return Response.json({ data: { configName: battle, configData: { FinishTime: finish } } });
    if (String(url).includes("/clans?")) return Response.json({ data: [{ Name: "new" }] });
    return detail(String(url).split("/").at(-1));
  });
  t.mock.method(console, "log", () => {});
  t.mock.method(console, "error", () => {});
  t.after(() => sql.close());
  return {
    sql, battle, requests, writes,
    setDetail(fn) { detail = fn; },
    setFailure(fn) { failQuery = fn; },
    cursor() { return sql.prepare("SELECT update_cursor FROM battle_state WHERE battle_id = ?").get(battle).update_cursor; },
    async tick() {
      let work;
      await worker.scheduled(null, { D1_DB: db }, { waitUntil(promise) { work = promise; } });
      await work;
    },
  };
}

const detailRequests = (f) => f.requests.filter((url) => url.includes("/api/clan/")).map((url) => url.split("/").at(-1));

test("two-clan ticks cover a stable roster, then refresh in a separate tick", async (t) => {
  const f = fixture(t);
  await f.tick();
  assert.deepEqual(detailRequests(f), ["a", "b"]);
  assert.equal(f.cursor(), 2);
  assert.ok(!f.requests.some((url) => url.includes("/clans?")));
  assert.ok(!f.writes.some((query) => query.includes("DELETE FROM username_cache")));
  await f.tick();
  await f.tick();
  await f.tick();
  assert.deepEqual(detailRequests(f), ["a", "b", "c", "d", "e", "f", "g"]);
  assert.equal(f.cursor(), -1);
  await f.tick();
  assert.equal(detailRequests(f).length, 7);
  assert.equal(f.cursor(), 0);
  assert.equal(f.requests.filter((url) => url.includes("/clans?")).length, 1);
  assert.ok(f.writes.some((query) => query.includes("DELETE FROM username_cache")));
  assert.equal(f.sql.prepare("SELECT count(*) AS n FROM clan_snapshots").get().n, 7);
});

test("a failed clan commit rolls back snapshot, changes and cursor; next tick resumes there", async (t) => {
  const f = fixture(t);
  const previous = JSON.stringify({ PointContributions: [{ UserID: 2, Points: 1 }] });
  f.sql.prepare("INSERT INTO clan_snapshots (battle_id, clan_name, timestamp, data_json, signature) VALUES (?, 'b', '2026-09-05T00:00:00Z', ?, 'old')").run(f.battle, previous);
  f.setFailure((query, params) => query.includes("INSERT INTO clan_snapshots") && params[1] === "b");
  await f.tick();
  assert.equal(f.cursor(), 1);
  assert.equal(f.sql.prepare("SELECT count(*) AS n FROM clan_snapshots WHERE clan_name='b'").get().n, 1);
  assert.equal(f.sql.prepare("SELECT count(*) AS n FROM clan_changes").get().n, 0);
  f.setFailure(null);
  f.requests.length = 0;
  await f.tick();
  assert.deepEqual(detailRequests(f), ["b", "c"]);
  assert.equal(f.cursor(), 3);
  assert.equal(f.sql.prepare("SELECT count(*) AS n FROM clan_changes WHERE clan_name='b'").get().n, 2);
});

test("unchanged snapshots still advance the durable cursor without duplicate history", async (t) => {
  const f = fixture(t, ["a"]);
  await f.tick();
  f.sql.prepare("UPDATE battle_state SET update_cursor=0").run();
  await f.tick();
  assert.equal(f.cursor(), -1);
  assert.equal(f.sql.prepare("SELECT count(*) AS n FROM clan_snapshots").get().n, 1);
});

test("unavailable clans do not starve the next batch or falsely report success", async (t) => {
  const f = fixture(t);
  f.setDetail(() => new Response("missing", { status: 404 }));
  await f.tick();
  assert.equal(f.cursor(), 2);
  const status = f.sql.prepare("SELECT * FROM scheduler_status").get();
  assert.equal(status.state, "error");
  assert.equal(status.last_success_at, null);
  await f.tick();
  await f.tick();
  await f.tick();
  assert.deepEqual(detailRequests(f), ["a", "b", "c", "d", "e", "f", "g"]);
});

test("maintenance bootstraps a new battle without claiming successful clan collection", async (t) => {
  const f = fixture(t, []);
  f.sql.exec("DELETE FROM battle_state");
  await f.tick();
  assert.equal(f.cursor(), 0);
  assert.equal(detailRequests(f).length, 0);
  assert.equal(f.sql.prepare("SELECT last_success_at FROM scheduler_status").get().last_success_at, null);
  assert.ok(f.sql.prepare("SELECT count(*) AS n FROM tracked_clans").get().n > 0);
});

test("roster refresh and cursor reset are atomic on a maintenance write failure", async (t) => {
  const f = fixture(t);
  f.sql.exec("UPDATE battle_state SET update_cursor=-1");
  f.setFailure((query) => query.includes("INSERT INTO battle_state"));
  await f.tick();
  assert.equal(f.cursor(), -1);
  assert.deepEqual(f.sql.prepare("SELECT clan_name FROM tracked_clans ORDER BY clan_name").all().map((r) => r.clan_name), ["a", "b", "c", "d", "e", "f", "g"]);
});

test("wall-time guard leaves the remaining clans for the next tick", async (t) => {
  const f = fixture(t);
  const now = Date.now();
  let time = now;
  t.mock.method(Date, "now", () => time);
  f.setDetail(() => {
    time += 41000;
    return Response.json({ data: { Battles: { [f.battle]: { Points: 1, PointContributions: [] } } } });
  });
  await f.tick();
  assert.deepEqual(detailRequests(f), ["a"]);
  assert.equal(f.cursor(), 1);
});

test("a 65-clan rotation covers every clan exactly once in 33 processing ticks", async (t) => {
  const clans = Array.from({ length: 65 }, (_, i) => `clan${String(i).padStart(2, "0")}`);
  const f = fixture(t, clans);
  for (let i = 0; i < 33; i += 1) {
    const before = detailRequests(f).length;
    await f.tick();
    assert.equal(detailRequests(f).length - before, i === 32 ? 1 : 2);
  }
  assert.deepEqual(detailRequests(f), clans);
  assert.equal(f.cursor(), -1);
  await f.tick();
  assert.equal(detailRequests(f).length, 65);
  assert.equal(f.cursor(), 0);
});

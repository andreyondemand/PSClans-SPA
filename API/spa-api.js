const USERNAME_CACHE_TTL_SECONDS = 24 * 60 * 60;
const DEFAULT_MAX_RETRIES = 4;
const BASE_BACKOFF_MS = 400;
const MAX_BACKOFF_MS = 8000;
const DEFAULT_MIN_REQUEST_INTERVAL_MS = 120;
const LOCAL_CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_CLAN_FETCHES_PER_RUN = 30;
const MAX_CHANGES_BATCH_CLANS = 30;
const MAX_USERNAMES_BATCH_IDS = 200;
const MAX_CLAN_HISTORY_LIMIT = 2000;
const DEFAULT_CLAN_HISTORY_LIMIT = MAX_CLAN_HISTORY_LIMIT;
const PINNED_CLANS = [
  "KOR_",
  "GANG",
  "K0ii",
  "fr3e",
  "AWZY",
  "Gpz",
  "FFLH",
  "ACDR",
  "Sqiz",
  "gcem",
  "BYRD",
  "ang_",
  "ns4r",
  "LXCC",
  "WHLE",
  "0RBI",
  "_hot",
  "FL4F",
  "LSQ",
  "KOHV",
  "_MGW",
  "minx",
  "DVLL",
  "Sopu",
  "H8ER",
  "GST2",
  "CC4T",
  "H8M3",
  "sh2p",
  "pr0x",
  "VDC1",
  "Karl",
  "UN0",
  "FGZW",
  "XPQX",
];

let activeBattle = "";
let activeBattleEndTime = 0;
let nextAllowedRequestTime = 0;
const localCache = new Map();

function setBindings(env) {
  if (env?.D1_DB) {
    globalThis.D1_DB = env.D1_DB;
  }
}

export default {
  async fetch(request, env) {
    setBindings(env);
    return handleRequest(request);
  },
  async scheduled(_controller, env, ctx) {
    setBindings(env);
    ctx.waitUntil(fetchAndUpdatePoints().catch((error) => console.error("Scheduled fetch failed:", error)));
  },
};

function createJsonHeaders() {
  return {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function getDB() {
  const db = globalThis.D1_DB;
  if (!db || typeof db.prepare !== "function") {
    throw new Error("Missing D1 binding: D1_DB");
  }
  return db;
}

async function dbFirst(query, params = []) {
  return await getDB().prepare(query).bind(...params).first();
}

async function dbAll(query, params = []) {
  const result = await getDB().prepare(query).bind(...params).all();
  return Array.isArray(result?.results) ? result.results : [];
}

async function dbRun(query, params = []) {
  await getDB().prepare(query).bind(...params).run();
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function parseRetryAfterMs(response) {
  const retryAfter = response.headers.get("Retry-After");
  if (!retryAfter) {
    return null;
  }

  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }

  const dateMs = Date.parse(retryAfter);
  if (Number.isFinite(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }

  return null;
}

async function throttleRequests(intervalMs = DEFAULT_MIN_REQUEST_INTERVAL_MS) {
  const now = Date.now();
  if (nextAllowedRequestTime > now) {
    await sleep(nextAllowedRequestTime - now);
  }
  nextAllowedRequestTime = Math.max(nextAllowedRequestTime, Date.now()) + intervalMs;
}

function getLocalCache(key) {
  const entry = localCache.get(key);
  if (!entry) {
    return null;
  }

  if (entry.expiresAt <= Date.now()) {
    localCache.delete(key);
    return null;
  }

  return entry.value;
}

function setLocalCache(key, value, ttlMs = LOCAL_CACHE_TTL_MS) {
  localCache.set(key, {
    value,
    expiresAt: Date.now() + ttlMs,
  });
}

function parsePositiveInt(value) {
  const parsed = Number.parseInt(value || "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

function parseTimestampMs(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const asDate = Date.parse(String(value));
  if (Number.isFinite(asDate)) {
    return asDate;
  }

  const asNumber = Number(value);
  if (!Number.isFinite(asNumber)) {
    return null;
  }

  if (asNumber > 1_000_000_000_000) {
    return asNumber;
  }
  return asNumber * 1000;
}

async function fetchWithRateLimit(url, options = {}, config = {}) {
  const {
    maxRetries = DEFAULT_MAX_RETRIES,
    minIntervalMs = DEFAULT_MIN_REQUEST_INTERVAL_MS,
    retryStatuses = [429, 500, 502, 503, 504],
  } = config;

  let lastError = null;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    await throttleRequests(minIntervalMs);

    try {
      const response = await fetch(url, options);
      if (!retryStatuses.includes(response.status)) {
        return response;
      }

      if (attempt === maxRetries) {
        return response;
      }

      const retryAfterMs = parseRetryAfterMs(response);
      const exponentialBackoffMs = Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
      const jitterMs = Math.floor(Math.random() * 250);
      const delayMs = retryAfterMs ?? (exponentialBackoffMs + jitterMs);
      await sleep(delayMs);
    } catch (error) {
      lastError = error;
      if (attempt === maxRetries) {
        break;
      }

      const exponentialBackoffMs = Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
      const jitterMs = Math.floor(Math.random() * 250);
      await sleep(exponentialBackoffMs + jitterMs);
    }
  }

  throw lastError || new Error("Request failed after retries");
}

async function handleRequest(request) {
  const headers = createJsonHeaders();
  const url = new URL(request.url);
  const pathname = url.pathname;

  switch (pathname) {
    case "/message":
      return handleMessageRequest(headers);
    case "/pinned":
      return handlePinnedRequest(headers);
    case "/clans":
      return handleClansRequest(headers);
    case "/changes":
      return handleChangesRequest(url.searchParams, headers);
    case "/clan":
      return handleClanRequest(url.searchParams, headers);
    case "/usernames":
      return handleUsernamesRequest(url.searchParams, headers);
    default:
      return new Response("Invalid endpoint", { status: 404, headers });
  }
}

function handleMessageRequest(headers) {
  const messageJson = {
    message: "website might not load properly due to limited resources",
    color: "darkblue",
    visible: true,
    status: "success",
  };

  return new Response(JSON.stringify(messageJson), {
    status: 200,
    headers,
  });
}

function handlePinnedRequest(headers) {
  return new Response(JSON.stringify(PINNED_CLANS), {
    status: 200,
    headers,
  });
}

async function handleClansRequest(headers) {
  try {
    await fetchActiveBattle();
    const clans = await getTrackedClansList(activeBattle);

    return new Response(JSON.stringify(clans), {
      status: 200,
      headers,
    });
  } catch (error) {
    console.error("Error loading clans:", error);
    return new Response("Internal Server Error", { status: 500, headers });
  }
}

async function handleChangesRequest(searchParams, headers) {
  const clan = (searchParams.get("clan") || "").toLowerCase();
  const clansParam = (searchParams.get("clans") || "").toLowerCase();
  const wantsCounts = searchParams.get("counts") === "1";

  const clans = clansParam
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  if (!clan && clans.length === 0) {
    return new Response("Missing clan name", { status: 400, headers });
  }

  try {
    await fetchActiveBattle();
    if (clans.length > 0) {
      const uniqueClans = [...new Set(clans)];
      if (uniqueClans.length > MAX_CHANGES_BATCH_CLANS) {
        return new Response(`Too many clans requested. Max ${MAX_CHANGES_BATCH_CLANS}.`, { status: 400, headers });
      }
      const payload = wantsCounts ? await getChangesCounts(uniqueClans) : await getChangesBatch(uniqueClans);
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers,
      });
    }

    if (wantsCounts) {
      const counts = await getChangesCounts([clan]);
      return new Response(JSON.stringify(counts), {
        status: 200,
        headers,
      });
    }

    const changes = await getChanges(clan);
    return new Response(JSON.stringify(changes), {
      status: 200,
      headers,
    });
  } catch (error) {
    console.error("Error loading changes:", error);
    return new Response("Internal Server Error", { status: 500, headers });
  }
}

async function handleClanRequest(searchParams, headers) {
  const clan = (searchParams.get("clan") || "").toLowerCase();
  const userId = Number.parseInt(searchParams.get("userId") || "", 10);
  const requestedLimit = parsePositiveInt(searchParams.get("limit"));
  const historyLimit = Math.min(requestedLimit || DEFAULT_CLAN_HISTORY_LIMIT, MAX_CLAN_HISTORY_LIMIT);
  const beforeRaw = searchParams.get("before");
  const beforeMs = parseTimestampMs(beforeRaw);

  if (!clan) {
    return new Response("Clan not specified in the URL.", { status: 400, headers });
  }
  if (beforeRaw && beforeMs === null) {
    return new Response("Invalid before timestamp.", { status: 400, headers });
  }

  try {
    await fetchActiveBattle();

    let clanPointsData = await readClanSnapshots(activeBattle, clan, beforeMs);
    if (clanPointsData.length === 0) {
      return new Response("No data found", { status: 404, headers });
    }

    if (Number.isFinite(userId)) {
      clanPointsData = clanPointsData.flatMap((entry) =>
        (entry?.data?.PointContributions || [])
          .filter((contribution) => contribution.UserID === userId)
          .map((contribution) => ({
            timestamp: entry.timestamp,
            UserID: contribution.UserID,
            Points: contribution.Points,
          }))
      );
    }

    if (beforeMs !== null) {
      clanPointsData = clanPointsData.filter((entry) => {
        const timestampMs = parseTimestampMs(entry?.timestamp);
        return timestampMs !== null && timestampMs < beforeMs;
      });
    }

    const hasMore = clanPointsData.length > historyLimit;
    if (clanPointsData.length > historyLimit) {
      clanPointsData = clanPointsData.slice(-historyLimit);
    }
    const oldestTimestamp = clanPointsData[0]?.timestamp || null;
    const newestTimestamp = clanPointsData[clanPointsData.length - 1]?.timestamp || null;

    return new Response(JSON.stringify({
      history: clanPointsData,
      meta: {
        hasMore,
        limit: historyLimit,
        returned: clanPointsData.length,
        before: beforeRaw || null,
        oldestTimestamp,
        newestTimestamp,
      },
    }), {
      status: 200,
      headers,
    });
  } catch (error) {
    console.error("Error loading clan history:", error);
    return new Response("Internal Server Error", { status: 500, headers });
  }
}

async function handleUsernamesRequest(searchParams, headers) {
  const idsParam = (searchParams.get("ids") || "").trim();
  if (idsParam) {
    const ids = [...new Set(
      idsParam
        .split(",")
        .map((value) => Number.parseInt(value.trim(), 10))
        .filter(Number.isFinite)
    )];

    if (ids.length > MAX_USERNAMES_BATCH_IDS) {
      return new Response(`Too many ids requested. Max ${MAX_USERNAMES_BATCH_IDS}.`, { status: 400, headers });
    }

    const resolvedUsers = await resolveUsernames(ids);
    return new Response(JSON.stringify(resolvedUsers), { status: 200, headers });
  }

  const clanName = (searchParams.get("clan") || "").toLowerCase();
  if (!clanName) {
    return new Response("Missing clan name or ids", { status: 400, headers });
  }
  return fetchClanUsernames(clanName, headers);
}

async function fetchClanUsernames(clanName, headers) {
  const cacheKey = `${clanName}_CACHE`;
  const localCached = getLocalCache(cacheKey);
  if (localCached) {
    return new Response(JSON.stringify(localCached), { status: 200, headers });
  }

  const cachedRow = await dbFirst(
    "SELECT data_json, expires_at FROM username_cache WHERE clan_name = ? LIMIT 1",
    [clanName]
  );
  if (cachedRow && Number(cachedRow.expires_at) > nowSeconds()) {
    const parsed = parseJson(cachedRow.data_json, []);
    const cachedUsers = Array.isArray(parsed) ? parsed : [];
    setLocalCache(cacheKey, cachedUsers);
    return new Response(JSON.stringify(cachedUsers), { status: 200, headers });
  }

  const response = await fetchWithRateLimit(`https://ps99.biggamesapi.io/api/clan/${encodeURIComponent(clanName)}`);
  if (!response.ok) {
    return new Response("Failed to fetch clan data", { status: 502, headers });
  }

  const clanData = await response.json();
  const members = clanData?.data?.Members || [];
  const ownerID = clanData?.data?.Owner;
  const currentUserIDs = [ownerID, ...members.map((member) => member.UserID)].filter(Number.isFinite);

  const resolvedUsers = await resolveUsernames(currentUserIDs);
  const ttlExpiresAt = nowSeconds() + USERNAME_CACHE_TTL_SECONDS;
  try {
    await dbRun(
      `INSERT INTO username_cache (clan_name, data_json, expires_at, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(clan_name) DO UPDATE SET
         data_json = excluded.data_json,
         expires_at = excluded.expires_at,
         updated_at = excluded.updated_at`,
      [clanName, JSON.stringify(resolvedUsers), ttlExpiresAt, nowSeconds()]
    );
  } catch (error) {
    console.warn(`Failed username cache write for ${clanName}:`, error);
  }
  setLocalCache(cacheKey, resolvedUsers);

  return new Response(JSON.stringify(resolvedUsers), { status: 200, headers });
}

async function resolveUsernames(userIDs) {
  if (userIDs.length === 0) {
    return [];
  }

  try {
    const response = await fetchWithRateLimit("https://users.roblox.com/v1/users", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        userIds: userIDs,
        excludeBannedUsers: true,
      }),
    });

    if (!response.ok) {
      return [];
    }

    const payload = await response.json();
    return (payload?.data || []).map((user) => ({
      id: user.id,
      name: user.name,
    }));
  } catch (error) {
    console.error("Batch username fetch failed:", error);
    return [];
  }
}

async function fetchActiveBattle() {
  const response = await fetchWithRateLimit("https://ps99.biggamesapi.io/api/activeClanBattle");
  const responseData = await response.json();

  activeBattle = responseData?.data?.configName || "";
  activeBattleEndTime = responseData?.data?.configData?.FinishTime || 0;

  if (!activeBattle) {
    throw new Error("Missing active battle configName");
  }
}

async function fetchTopClans() {
  const response = await fetchWithRateLimit(
    "https://ps99.biggamesapi.io/api/clans?page=1&pageSize=35&sort=Points&sortOrder=desc"
  );
  const payload = await response.json();
  return payload?.data || [];
}

async function fetchClanData(clanName) {
  const response = await fetchWithRateLimit(`https://ps99.biggamesapi.io/api/clan/${encodeURIComponent(clanName)}`);
  return response.json();
}

function buildPointsSignature(pointsData) {
  if (!pointsData || typeof pointsData !== "object") {
    return "";
  }
  const totalPoints = Number(pointsData.Points) || 0;
  const place = Number(pointsData.Place) || 0;
  const contributions = Array.isArray(pointsData.PointContributions) ? pointsData.PointContributions : [];
  const normalized = contributions
    .map((entry) => `${Number(entry?.UserID) || 0}:${Number(entry?.Points) || 0}`)
    .sort()
    .join(",");
  return `${totalPoints}|${place}|${normalized}`;
}

async function updatePoints(clanName, pointsData) {
  const timestamp = new Date().toISOString();
  const signature = buildPointsSignature(pointsData);

  const latestSnapshot = await dbFirst(
    `SELECT data_json, signature
     FROM clan_snapshots
     WHERE battle_id = ? AND clan_name = ?
     ORDER BY id DESC
     LIMIT 1`,
    [activeBattle, clanName]
  );

  if (latestSnapshot && String(latestSnapshot.signature || "") === signature) {
    return;
  }

  const previousData = latestSnapshot ? parseJson(latestSnapshot.data_json, null) : null;

  await dbRun(
    `INSERT INTO clan_snapshots (battle_id, clan_name, timestamp, data_json, signature)
     VALUES (?, ?, ?, ?, ?)`,
    [activeBattle, clanName, timestamp, JSON.stringify(pointsData), signature]
  );

  await trackChanges(clanName, previousData, pointsData, timestamp);
}

async function trackChanges(clanName, previousData, nextData, timestamp) {
  if (!previousData || !nextData) {
    return;
  }

  const oldUsers = new Set(previousData?.PointContributions?.map((user) => user.UserID) || []);
  const newUsers = new Set(nextData?.PointContributions?.map((user) => user.UserID) || []);

  const changes = [
    ...[...newUsers].filter((userId) => !oldUsers.has(userId)).map((userId) => ({
      type: "joined",
      UserID: userId,
      timestamp,
    })),
    ...[...oldUsers].filter((userId) => !newUsers.has(userId)).map((userId) => ({
      type: "left",
      UserID: userId,
      timestamp,
    })),
  ];

  if (changes.length === 0) {
    return;
  }

  for (const change of changes) {
    await dbRun(
      `INSERT INTO clan_changes (battle_id, clan_name, change_type, user_id, timestamp)
       VALUES (?, ?, ?, ?, ?)`,
      [activeBattle, clanName, change.type, Number(change.UserID), change.timestamp]
    );
  }
}

async function cleanupOldData() {
  const now = nowSeconds();
  if (!activeBattleEndTime || now < activeBattleEndTime + 86400) {
    return false;
  }

  const trackedClans = await getTrackedClansList(activeBattle);
  if (trackedClans.length === 0) {
    return false;
  }

  await dbRun("DELETE FROM clan_snapshots WHERE battle_id = ?", [activeBattle]);
  await dbRun("DELETE FROM clan_changes WHERE battle_id = ?", [activeBattle]);
  await dbRun("DELETE FROM tracked_clans WHERE battle_id = ?", [activeBattle]);
  await dbRun("DELETE FROM battle_state WHERE battle_id = ?", [activeBattle]);
  return true;
}

async function fetchAndUpdatePoints() {
  await fetchActiveBattle();
  const cleaned = await cleanupOldData();
  if (cleaned) {
    return;
  }

  const topClans = await fetchTopClans();
  const uniqueClans = new Set(topClans.map((clan) => String(clan.Name || "").toLowerCase()).filter(Boolean));
  PINNED_CLANS.forEach((clan) => uniqueClans.add(clan.toLowerCase()));
  const clansToTrack = [...uniqueClans];

  const cursorValue = await getBattleCursor(activeBattle);
  let cursor = Number.isFinite(cursorValue) ? cursorValue : 0;
  if (!Number.isFinite(cursor) || cursor < 0 || cursor >= clansToTrack.length) {
    cursor = 0;
  }

  let clansBatch = clansToTrack.slice(cursor, cursor + MAX_CLAN_FETCHES_PER_RUN);
  if (clansBatch.length === 0) {
    cursor = 0;
    clansBatch = clansToTrack.slice(0, MAX_CLAN_FETCHES_PER_RUN);
  }

  for (const clanName of clansBatch) {
    try {
      const clanData = await fetchClanData(clanName);
      const pointsData = clanData?.data?.Battles?.[activeBattle]?.PointContributions
        ? clanData.data.Battles[activeBattle]
        : null;
      if (pointsData) {
        await updatePoints(clanName, pointsData);
      }
    } catch (error) {
      console.error(`Failed clan update for ${clanName}:`, error);
    }
  }

  const nextCursor = cursor + clansBatch.length >= clansToTrack.length ? 0 : cursor + clansBatch.length;
  if (!Number.isFinite(cursorValue) || nextCursor !== cursorValue) {
    await setBattleCursor(activeBattle, nextCursor, activeBattleEndTime);
  }

  await ensureTrackedClans(activeBattle, clansToTrack);
}

async function readClanSnapshots(battleId, clanName, beforeMs) {
  let rows = [];
  if (beforeMs !== null) {
    rows = await dbAll(
      `SELECT timestamp, data_json
       FROM clan_snapshots
       WHERE battle_id = ? AND clan_name = ? AND timestamp < ?
       ORDER BY timestamp ASC`,
      [battleId, clanName, new Date(beforeMs).toISOString()]
    );
  } else {
    rows = await dbAll(
      `SELECT timestamp, data_json
       FROM clan_snapshots
       WHERE battle_id = ? AND clan_name = ?
       ORDER BY timestamp ASC`,
      [battleId, clanName]
    );
  }

  const history = [];
  for (const row of rows) {
    const parsedData = parseJson(row.data_json, null);
    if (!parsedData || typeof parsedData !== "object") {
      continue;
    }
    history.push({
      timestamp: row.timestamp,
      clan: clanName,
      data: parsedData,
    });
  }
  return history;
}

async function getBattleCursor(battleId) {
  const row = await dbFirst(
    "SELECT update_cursor FROM battle_state WHERE battle_id = ? LIMIT 1",
    [battleId]
  );
  if (!row) {
    return null;
  }
  const parsed = Number.parseInt(String(row.update_cursor || ""), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

async function setBattleCursor(battleId, updateCursor, endTime) {
  await dbRun(
    `INSERT INTO battle_state (battle_id, update_cursor, end_time, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(battle_id) DO UPDATE SET
       update_cursor = excluded.update_cursor,
       end_time = excluded.end_time,
       updated_at = excluded.updated_at`,
    [battleId, Number(updateCursor) || 0, Number(endTime) || 0, nowSeconds()]
  );
}

async function getTrackedClansList(battleId) {
  const rows = await dbAll(
    `SELECT clan_name
     FROM tracked_clans
     WHERE battle_id = ?
     ORDER BY added_at ASC, clan_name ASC`,
    [battleId]
  );
  return rows
    .map((row) => String(row.clan_name || "").toLowerCase())
    .filter(Boolean);
}

async function ensureTrackedClans(battleId, clansToTrack) {
  const existingRows = await dbAll(
    "SELECT clan_name FROM tracked_clans WHERE battle_id = ?",
    [battleId]
  );
  const existingSet = new Set(
    existingRows.map((row) => String(row.clan_name || "").toLowerCase()).filter(Boolean)
  );

  const now = nowSeconds();
  for (const clanName of clansToTrack) {
    const normalized = String(clanName || "").toLowerCase();
    if (!normalized || existingSet.has(normalized)) {
      continue;
    }

    await dbRun(
      "INSERT INTO tracked_clans (battle_id, clan_name, added_at) VALUES (?, ?, ?)",
      [battleId, normalized, now]
    );
    existingSet.add(normalized);
  }
}

async function getTrackedClansSet() {
  const trackedClans = await getTrackedClansList(activeBattle);
  return new Set(trackedClans);
}

async function readClanChanges(clanName, trackedSet) {
  if (!trackedSet.has(clanName)) {
    return [];
  }

  const rows = await dbAll(
    `SELECT change_type, user_id, timestamp
     FROM clan_changes
     WHERE battle_id = ? AND clan_name = ?
     ORDER BY id ASC`,
    [activeBattle, clanName]
  );

  return rows.map((row) => ({
    type: String(row.change_type || ""),
    UserID: Number(row.user_id),
    timestamp: row.timestamp,
  }));
}

function countRecentChanges(changes) {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  return (changes || []).filter((change) => new Date(change.timestamp).getTime() >= cutoff).length;
}

async function getChanges(clanName) {
  const trackedSet = await getTrackedClansSet();
  const clanChanges = await readClanChanges(clanName, trackedSet);
  return { [clanName]: clanChanges };
}

async function getChangesBatch(clanNames) {
  const trackedSet = await getTrackedClansSet();
  const entries = await Promise.all(
    clanNames.map(async (clanName) => [clanName, await readClanChanges(clanName, trackedSet)])
  );
  return Object.fromEntries(entries);
}

async function getChangesCounts(clanNames) {
  const changesByClan = await getChangesBatch(clanNames);
  return Object.fromEntries(clanNames.map((clanName) => [clanName, countRecentChanges(changesByClan[clanName])]));
}

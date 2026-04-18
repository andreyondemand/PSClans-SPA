const USERNAMES = USERNAMES_DATA;
const POINTS = POINTS_DATA;
const CACHE_TTL_SECONDS = 24 * 60 * 60;
const DEFAULT_MAX_RETRIES = 4;
const BASE_BACKOFF_MS = 400;
const MAX_BACKOFF_MS = 8000;
const DEFAULT_MIN_REQUEST_INTERVAL_MS = 120;
const LOCAL_CACHE_TTL_MS = 60 * 1000;
const MAX_CLAN_FETCHES_PER_RUN = 30;
const MAX_CHANGES_BATCH_CLANS = 30;
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

addEventListener("fetch", (event) => {
  event.respondWith(handleRequest(event.request));
});

addEventListener("scheduled", (event) => {
  event.waitUntil(fetchAndUpdatePoints().catch((error) => console.error("Scheduled fetch failed:", error)));
});

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
    const clansListKey = `${activeBattle}_clanslist`;
    const clans = await POINTS.get(clansListKey);

    return new Response(clans || "[]", {
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

    const clanKey = `${activeBattle}_${clan}`;
    const data = await POINTS.get(clanKey);
    if (!data) {
      return new Response("No data found", { status: 404, headers });
    }

    const pointsData = JSON.parse(data);
    let clanPointsData = pointsData.filter((entry) => String(entry?.clan || "").toLowerCase() === clan);

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
  const clanName = (searchParams.get("clan") || "").toLowerCase();
  if (!clanName) {
    return new Response("Missing clan name", { status: 400, headers });
  }
  return fetchClanUsernames(clanName, headers);
}

async function fetchClanUsernames(clanName, headers) {
  const cacheKey = `${clanName}_CACHE`;
  const localCached = getLocalCache(cacheKey);
  if (localCached) {
    return new Response(JSON.stringify(localCached), { status: 200, headers });
  }

  let cachedUsers = [];
  const kvCached = await USERNAMES.get(cacheKey);
  if (kvCached) {
    cachedUsers = JSON.parse(kvCached);
  }

  const cachedUserIDs = cachedUsers.map((user) => user.id);
  const response = await fetchWithRateLimit(`https://ps99.biggamesapi.io/api/clan/${encodeURIComponent(clanName)}`);
  if (!response.ok) {
    return new Response("Failed to fetch clan data", { status: 502, headers });
  }

  const clanData = await response.json();
  const members = clanData?.data?.Members || [];
  const ownerID = clanData?.data?.Owner;
  const currentUserIDs = [ownerID, ...members.map((member) => member.UserID)].filter(Number.isFinite);

  const newUserIDs = currentUserIDs.filter((id) => !cachedUserIDs.includes(id));
  const removedUserIDs = cachedUserIDs.filter((id) => !currentUserIDs.includes(id));

  const newUsers = await resolveUsernames(newUserIDs);
  cachedUsers = cachedUsers.filter((user) => !removedUserIDs.includes(user.id));
  cachedUsers.push(...newUsers);

  await USERNAMES.put(cacheKey, JSON.stringify(cachedUsers), { expirationTtl: CACHE_TTL_SECONDS });
  setLocalCache(cacheKey, cachedUsers);

  return new Response(JSON.stringify(cachedUsers), { status: 200, headers });
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

async function updatePoints(clanName, pointsData) {
  const timestamp = new Date().toISOString();
  const newEntry = { timestamp, clan: clanName, data: pointsData };
  const clanKey = `${activeBattle}_${clanName}`;

  let existingData = [];
  const raw = await POINTS.get(clanKey);
  if (raw) {
    existingData = JSON.parse(raw);
  }
  if (!Array.isArray(existingData)) {
    existingData = [];
  }

  const updatedData = [...existingData, newEntry];
  await POINTS.put(clanKey, JSON.stringify(updatedData, null, 2));
  await trackChanges(clanName, existingData, updatedData);
}

async function trackChanges(clanName, oldData, newData) {
  if (oldData.length === 0 || newData.length === 0) {
    return;
  }

  const oldUsers = new Set(oldData[oldData.length - 1]?.data?.PointContributions?.map((user) => user.UserID) || []);
  const newUsers = new Set(newData[newData.length - 1]?.data?.PointContributions?.map((user) => user.UserID) || []);
  const now = new Date().toISOString();

  const changes = [
    ...[...newUsers].filter((userId) => !oldUsers.has(userId)).map((userId) => ({
      type: "joined",
      UserID: userId,
      timestamp: now,
    })),
    ...[...oldUsers].filter((userId) => !newUsers.has(userId)).map((userId) => ({
      type: "left",
      UserID: userId,
      timestamp: now,
    })),
  ];

  if (changes.length === 0) {
    return;
  }

  const changesKey = `${activeBattle}_${clanName}_changes`;
  let existingChanges = [];
  const rawChanges = await POINTS.get(changesKey);
  if (rawChanges) {
    existingChanges = JSON.parse(rawChanges);
  }

  await POINTS.put(changesKey, JSON.stringify([...existingChanges, ...changes], null, 2));
}

async function cleanupOldData() {
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (!activeBattleEndTime || nowSeconds < activeBattleEndTime + 86400) {
    return false;
  }

  const clansListKey = `${activeBattle}_clanslist`;
  const clansList = await POINTS.get(clansListKey);
  if (!clansList) {
    return false;
  }

  const trackedClans = JSON.parse(clansList);
  for (const clan of trackedClans) {
    await POINTS.delete(`${activeBattle}_${clan}`);
    await POINTS.delete(`${activeBattle}_${clan}_changes`);
  }
  await POINTS.delete(clansListKey);
  await POINTS.delete(`${activeBattle}_update_cursor`);
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

  const cursorKey = `${activeBattle}_update_cursor`;
  const cursorValue = await POINTS.get(cursorKey);
  let cursor = Number.parseInt(cursorValue || "0", 10);
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
  await POINTS.put(cursorKey, String(nextCursor));

  const clansListKey = `${activeBattle}_clanslist`;
  const existing = await POINTS.get(clansListKey);
  if (!existing) {
    await POINTS.put(clansListKey, JSON.stringify(clansToTrack, null, 2));
    return;
  }

  const merged = [...new Set([...JSON.parse(existing), ...clansToTrack])];
  await POINTS.put(clansListKey, JSON.stringify(merged, null, 2));
}

async function getTrackedClansSet() {
  const clansListKey = `${activeBattle}_clanslist`;
  const clansRaw = await POINTS.get(clansListKey);
  if (!clansRaw) {
    return new Set();
  }

  const trackedClans = JSON.parse(clansRaw);
  return new Set(Array.isArray(trackedClans) ? trackedClans : []);
}

async function readClanChanges(clanName, trackedSet) {
  if (!trackedSet.has(clanName)) {
    return [];
  }

  const changesKey = `${activeBattle}_${clanName}_changes`;
  const clanChanges = await POINTS.get(changesKey);
  return clanChanges ? JSON.parse(clanChanges) : [];
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

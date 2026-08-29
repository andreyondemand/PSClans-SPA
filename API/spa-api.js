const USERNAME_CACHE_TTL_SECONDS = 24 * 60 * 60;
const DEFAULT_MAX_RETRIES = 4;
const BASE_BACKOFF_MS = 400;
const MAX_BACKOFF_MS = 8000;
const DEFAULT_MIN_REQUEST_INTERVAL_MS = 120;
const DEFAULT_FETCH_TIMEOUT_MS = 8000;
const DEFAULT_FETCH_BUDGET_MS = 25000;
const MAX_RETRY_AFTER_MS = 10000;
const LOCAL_CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_CLAN_FETCHES_PER_RUN = 30;
const MAX_CHANGES_BATCH_CLANS = 30;
const MAX_CHANGES_QUERY_LENGTH = 1024;
const MAX_USERNAMES_BATCH_IDS = 200;
const MAX_USERNAMES_QUERY_LENGTH = 4096;
const MAX_USERNAME_CACHE_ROWS = 5000;
const MAX_CLAN_NAME_LENGTH = 64;
const MAX_CLAN_HISTORY_LIMIT = 2000;
const DEFAULT_CLAN_HISTORY_LIMIT = MAX_CLAN_HISTORY_LIMIT;
const SCHEDULER_FRESHNESS_SECONDS = 20 * 60;
const RATE_LIMITED_PATHS = new Set(["/health", "/clans", "/changes", "/clan", "/usernames"]);
const PINNED_CLANS = [
  "DACE",
  "JKUS",
  "3zEZ",
  "EsPa",
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
  "taux",
  "s7py",
  "7hrw"
];

class UpstreamRequestError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "UpstreamRequestError";
  }
}

class UpstreamTimeoutError extends UpstreamRequestError {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "UpstreamTimeoutError";
  }
}

function createRuntime(env, options = {}) {
  const scheduled = Boolean(options.scheduled);
  return {
    db: env?.D1_DB,
    rateLimiter: env?.API_RATE_LIMITER,
    nextAllowedRequestTime: 0,
    localCache: new Map(),
    fetchPolicy: scheduled
      ? { maxRetries: 4, timeoutMs: 10000, budgetMs: 60000 }
      : { maxRetries: 2, timeoutMs: DEFAULT_FETCH_TIMEOUT_MS, budgetMs: DEFAULT_FETCH_BUDGET_MS },
  };
}

export default {
  async fetch(request, env) {
    const runtime = createRuntime(env);
    try {
      return await handleRequest(request, runtime);
    } catch (error) {
      return createErrorResponse(error, createJsonHeaders(), "Unhandled request failure");
    }
  },
  async scheduled(_controller, env, ctx) {
    const runtime = createRuntime(env, { scheduled: true });
    ctx.waitUntil(runScheduledUpdate(runtime).catch((error) => {
      logError("Scheduled fetch failed", error);
    }));
  },
};

function createJsonHeaders() {
  return {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  };
}

function logEvent(level, message, details = {}, error = null) {
  const payload = {
    message,
    ...details,
  };
  if (error) {
    payload.error = error instanceof Error ? error.message : String(error);
  }
  const method = level === "error" ? "error" : level === "warn" ? "warn" : "log";
  console[method](JSON.stringify(payload));
}

function logError(message, error, details = {}) {
  logEvent("error", message, details, error);
}

function logWarn(message, error, details = {}) {
  logEvent("warn", message, details, error);
}

function createErrorResponse(error, headers, context) {
  const isTimeout = error instanceof UpstreamTimeoutError;
  const isUpstream = error instanceof UpstreamRequestError;
  const status = isTimeout ? 504 : isUpstream ? 502 : 500;
  const code = isTimeout ? "upstream_timeout" : isUpstream ? "upstream_failure" : "internal_error";
  logError(context, error, { status, code });
  return new Response(JSON.stringify({ error: code }), { status, headers });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function getDB(runtime) {
  const db = runtime?.db;
  if (!db || typeof db.prepare !== "function") {
    throw new Error("Missing D1 binding: D1_DB");
  }
  return db;
}

async function dbFirst(runtime, query, params = []) {
  return await getDB(runtime).prepare(query).bind(...params).first();
}

async function dbAll(runtime, query, params = []) {
  const result = await getDB(runtime).prepare(query).bind(...params).all();
  return Array.isArray(result?.results) ? result.results : [];
}

async function dbRun(runtime, query, params = []) {
  await getDB(runtime).prepare(query).bind(...params).run();
}

async function cleanupUsernameCache(runtime) {
  await dbRun(runtime, "DELETE FROM username_cache WHERE expires_at <= ?", [nowSeconds()]);
  await dbRun(
    runtime,
    `DELETE FROM username_cache
     WHERE clan_name NOT IN (
       SELECT clan_name
       FROM username_cache
       ORDER BY updated_at DESC
       LIMIT ?
     )`,
    [MAX_USERNAME_CACHE_ROWS]
  );
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

async function readUpstreamJson(response, label) {
  try {
    return await response.json();
  } catch (error) {
    throw new UpstreamRequestError(`${label} returned invalid JSON`, { cause: error });
  }
}

function parseRetryAfterMs(response) {
  const retryAfter = response.headers.get("Retry-After");
  if (!retryAfter) {
    return null;
  }

  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds)) {
    return Math.min(Math.max(0, seconds * 1000), MAX_RETRY_AFTER_MS);
  }

  const dateMs = Date.parse(retryAfter);
  if (Number.isFinite(dateMs)) {
    return Math.min(Math.max(0, dateMs - Date.now()), MAX_RETRY_AFTER_MS);
  }

  return null;
}

async function throttleRequests(runtime, intervalMs = DEFAULT_MIN_REQUEST_INTERVAL_MS) {
  const now = Date.now();
  const scheduledRequestTime = Math.max(now, runtime.nextAllowedRequestTime);
  runtime.nextAllowedRequestTime = scheduledRequestTime + intervalMs;
  if (scheduledRequestTime > now) {
    await sleep(scheduledRequestTime - now);
  }
}

function getLocalCache(runtime, key) {
  const entry = runtime.localCache.get(key);
  if (!entry) {
    return null;
  }

  if (entry.expiresAt <= Date.now()) {
    runtime.localCache.delete(key);
    return null;
  }

  return entry.value;
}

function setLocalCache(runtime, key, value, ttlMs = LOCAL_CACHE_TTL_MS) {
  runtime.localCache.set(key, {
    value,
    expiresAt: Date.now() + ttlMs,
  });
}

function parsePositiveInt(value) {
  const normalized = String(value || "").trim();
  if (!/^[1-9]\d*$/.test(normalized)) {
    return null;
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed)) {
    return null;
  }
  return parsed;
}

function parseClanName(value) {
  const clanName = String(value || "").trim().toLowerCase();
  if (!clanName) {
    return { error: "Missing clan name" };
  }
  if (clanName.length > MAX_CLAN_NAME_LENGTH || /[\u0000-\u001f\u007f]/.test(clanName)) {
    return { error: "Invalid clan name" };
  }
  return { value: clanName };
}

function parseClanList(value) {
  const raw = String(value || "");
  if (!raw) {
    return { value: [] };
  }
  if (raw.length > MAX_CHANGES_QUERY_LENGTH) {
    return { error: "Clan list is too long" };
  }

  const tokens = raw.split(",");
  if (tokens.length > MAX_CHANGES_BATCH_CLANS) {
    return { error: `Too many clans requested. Max ${MAX_CHANGES_BATCH_CLANS}.` };
  }

  const clans = [];
  for (const token of tokens) {
    const parsed = parseClanName(token);
    if (parsed.error) {
      return { error: parsed.error };
    }
    clans.push(parsed.value);
  }
  return { value: [...new Set(clans)] };
}

function parseUserIds(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return { error: "Missing user ids" };
  }
  if (raw.length > MAX_USERNAMES_QUERY_LENGTH) {
    return { error: "User id list is too long" };
  }

  const tokens = raw.split(",");
  if (tokens.length > MAX_USERNAMES_BATCH_IDS) {
    return { error: `Too many ids requested. Max ${MAX_USERNAMES_BATCH_IDS}.` };
  }

  const ids = [];
  for (const token of tokens) {
    const normalized = token.trim();
    if (!/^[1-9]\d*$/.test(normalized)) {
      return { error: "Invalid user id" };
    }
    const id = Number(normalized);
    if (!Number.isSafeInteger(id)) {
      return { error: "Invalid user id" };
    }
    ids.push(id);
  }
  return { value: [...new Set(ids)] };
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

  const timestampMs = Math.abs(asNumber) > 1_000_000_000_000 ? asNumber : asNumber * 1000;
  if (!Number.isFinite(timestampMs) || Math.abs(timestampMs) > 8_640_000_000_000_000) {
    return null;
  }
  return timestampMs;
}

async function fetchWithRateLimit(runtime, url, options = {}, config = {}) {
  const policy = runtime?.fetchPolicy || {};
  const {
    maxRetries = policy.maxRetries ?? DEFAULT_MAX_RETRIES,
    minIntervalMs = DEFAULT_MIN_REQUEST_INTERVAL_MS,
    retryStatuses = [429, 500, 502, 503, 504],
    timeoutMs = policy.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS,
    budgetMs = policy.budgetMs ?? DEFAULT_FETCH_BUDGET_MS,
  } = config;

  let lastError = null;
  const deadlineMs = Date.now() + budgetMs;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const remainingBudgetMs = deadlineMs - Date.now();
    if (remainingBudgetMs <= 0) {
      throw new UpstreamTimeoutError("Upstream request exceeded its retry budget", { cause: lastError });
    }
    await throttleRequests(runtime, minIntervalMs);

    try {
      const attemptTimeoutMs = Math.max(1, Math.min(timeoutMs, deadlineMs - Date.now()));
      const timeoutSignal = AbortSignal.timeout(attemptTimeoutMs);
      const signal = options.signal && typeof AbortSignal.any === "function"
        ? AbortSignal.any([options.signal, timeoutSignal])
        : options.signal || timeoutSignal;
      const response = await fetch(url, { ...options, signal });
      if (!retryStatuses.includes(response.status)) {
        return response;
      }

      if (attempt === maxRetries) {
        return response;
      }

      const retryAfterMs = parseRetryAfterMs(response);
      const exponentialBackoffMs = Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
      const jitterMs = Math.floor(Math.random() * 250);
      const delayMs = Math.min(
        retryAfterMs ?? (exponentialBackoffMs + jitterMs),
        Math.max(0, deadlineMs - Date.now())
      );
      if (delayMs > 0) {
        await sleep(delayMs);
      }
    } catch (error) {
      const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
      lastError = timedOut
        ? new UpstreamTimeoutError("Upstream request timed out", { cause: error })
        : error;
      if (attempt === maxRetries) {
        break;
      }

      const exponentialBackoffMs = Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
      const jitterMs = Math.floor(Math.random() * 250);
      const delayMs = Math.min(exponentialBackoffMs + jitterMs, Math.max(0, deadlineMs - Date.now()));
      if (delayMs > 0) {
        await sleep(delayMs);
      }
    }
  }

  if (lastError instanceof UpstreamRequestError) {
    throw lastError;
  }
  throw new UpstreamRequestError("Upstream request failed after retries", { cause: lastError });
}

async function handleRequest(request, runtime) {
  const headers = createJsonHeaders();
  const url = new URL(request.url);
  const pathname = url.pathname;

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers });
  }
  if (request.method !== "GET") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers });
  }

  if (RATE_LIMITED_PATHS.has(pathname)) {
    const allowed = await enforceRateLimit(request, pathname, runtime);
    if (!allowed) {
      logEvent("warn", "API rate limit exceeded", { pathname });
      return new Response(JSON.stringify({ error: "rate_limited" }), {
        status: 429,
        headers: { ...headers, "Retry-After": "60" },
      });
    }
  }

  switch (pathname) {
    case "/health":
      return handleHealthRequest(headers, runtime);
    case "/message":
      return handleMessageRequest(headers);
    case "/pinned":
      return handlePinnedRequest(headers);
    case "/clans":
      return handleClansRequest(headers, runtime);
    case "/changes":
      return handleChangesRequest(url.searchParams, headers, runtime);
    case "/clan":
      return handleClanRequest(url.searchParams, headers, runtime);
    case "/usernames":
      return handleUsernamesRequest(url.searchParams, headers, runtime);
    default:
      return new Response("Invalid endpoint", { status: 404, headers });
  }
}

async function enforceRateLimit(request, pathname, runtime) {
  const limiter = runtime?.rateLimiter;
  if (!limiter || typeof limiter.limit !== "function") {
    return true;
  }
  const clientAddress = request.headers.get("CF-Connecting-IP") || "unknown";
  const result = await limiter.limit({ key: `${pathname}:${clientAddress}` });
  return result?.success === true;
}

async function handleHealthRequest(headers, runtime) {
  try {
    const row = await dbFirst(
      runtime,
      `SELECT state, battle_id, last_started_at, last_success_at, updated_at
       FROM scheduler_status
       WHERE id = 1
       LIMIT 1`
    );

    if (!row) {
      return new Response(JSON.stringify({
        status: "degraded",
        reason: "scheduler_has_not_reported",
      }), { status: 503, headers });
    }

    const lastSuccessAt = Number(row.last_success_at) || 0;
    const successAgeSeconds = lastSuccessAt > 0 ? Math.max(0, nowSeconds() - lastSuccessAt) : null;
    const fresh = successAgeSeconds !== null && successAgeSeconds <= SCHEDULER_FRESHNESS_SECONDS;
    const healthy = fresh && row.state !== "error";
    return new Response(JSON.stringify({
      status: healthy ? "ok" : "degraded",
      scheduler: {
        state: String(row.state || "unknown"),
        battleId: row.battle_id || null,
        lastStartedAt: Number(row.last_started_at) || null,
        lastSuccessAt: lastSuccessAt || null,
        successAgeSeconds,
        fresh,
      },
    }), { status: healthy ? 200 : 503, headers });
  } catch (error) {
    logError("Health check failed", error);
    return new Response(JSON.stringify({
      status: "degraded",
      reason: "health_check_failed",
    }), { status: 503, headers });
  }
}

function handleMessageRequest(headers) {
  const messageJson = {
    message: "psclans isn't shutting down! More info in the Discord",
    color: "darkblue",
    visible: false,
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

async function handleClansRequest(headers, runtime) {
  try {
    const { battleId } = await fetchActiveBattle(runtime);
    const clans = await getTrackedClansList(runtime, battleId);

    return new Response(JSON.stringify(clans), {
      status: 200,
      headers,
    });
  } catch (error) {
    return createErrorResponse(error, headers, "Error loading clans");
  }
}

async function handleChangesRequest(searchParams, headers, runtime) {
  const clanRaw = searchParams.get("clan") || "";
  const clanResult = clanRaw ? parseClanName(clanRaw) : { value: "" };
  const clansResult = parseClanList(searchParams.get("clans") || "");
  const wantsCounts = searchParams.get("counts") === "1";

  if (clanResult.error || clansResult.error) {
    return new Response(JSON.stringify({ error: clanResult.error || clansResult.error }), { status: 400, headers });
  }

  const clan = clanResult.value;
  const clans = clansResult.value;

  if (!clan && clans.length === 0) {
    return new Response(JSON.stringify({ error: "Missing clan name" }), { status: 400, headers });
  }

  try {
    const { battleId } = await fetchActiveBattle(runtime);
    if (clans.length > 0) {
      const payload = wantsCounts
        ? await getChangesCounts(runtime, battleId, clans)
        : await getChangesBatch(runtime, battleId, clans);
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers,
      });
    }

    if (wantsCounts) {
      const counts = await getChangesCounts(runtime, battleId, [clan]);
      return new Response(JSON.stringify(counts), {
        status: 200,
        headers,
      });
    }

    const changes = await getChanges(runtime, battleId, clan);
    return new Response(JSON.stringify(changes), {
      status: 200,
      headers,
    });
  } catch (error) {
    return createErrorResponse(error, headers, "Error loading changes");
  }
}

async function handleClanRequest(searchParams, headers, runtime) {
  const clanResult = parseClanName(searchParams.get("clan") || "");
  const userIdRaw = searchParams.get("userId") || "";
  const userIdResult = userIdRaw ? parseUserIds(userIdRaw) : { value: [] };
  const limitRaw = searchParams.get("limit") || "";
  const requestedLimit = parsePositiveInt(limitRaw);
  const historyLimit = Math.min(requestedLimit || DEFAULT_CLAN_HISTORY_LIMIT, MAX_CLAN_HISTORY_LIMIT);
  const beforeRaw = searchParams.get("before");
  const beforeMs = parseTimestampMs(beforeRaw);

  if (clanResult.error) {
    return new Response(JSON.stringify({ error: clanResult.error }), { status: 400, headers });
  }
  if (userIdResult.error || userIdResult.value.length > 1) {
    return new Response(JSON.stringify({ error: "Invalid user id" }), { status: 400, headers });
  }
  if (limitRaw && requestedLimit === null) {
    return new Response(JSON.stringify({ error: "Invalid history limit" }), { status: 400, headers });
  }
  const clan = clanResult.value;
  const userId = userIdResult.value[0] ?? null;
  if (beforeRaw && beforeMs === null) {
    return new Response(JSON.stringify({ error: "Invalid before timestamp" }), { status: 400, headers });
  }

  try {
    const { battleId } = await fetchActiveBattle(runtime);

    const snapshotPage = await readClanSnapshots(runtime, battleId, clan, beforeMs, historyLimit + 1);
    if (snapshotPage.length === 0) {
      return new Response("No data found", { status: 404, headers });
    }
    const hasMore = snapshotPage.length > historyLimit;
    const boundedPage = hasMore ? snapshotPage.slice(-historyLimit) : snapshotPage;
    const oldestTimestamp = boundedPage[0]?.timestamp || null;
    const newestTimestamp = boundedPage[boundedPage.length - 1]?.timestamp || null;
    let clanPointsData = boundedPage;

    if (userId !== null) {
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
    return createErrorResponse(error, headers, "Error loading clan history");
  }
}

async function handleUsernamesRequest(searchParams, headers, runtime) {
  const idsParam = (searchParams.get("ids") || "").trim();
  try {
    if (idsParam) {
      const idsResult = parseUserIds(idsParam);
      if (idsResult.error) {
        return new Response(JSON.stringify({ error: idsResult.error }), { status: 400, headers });
      }

      const resolvedUsers = await resolveUsernames(runtime, idsResult.value);
      return new Response(JSON.stringify(resolvedUsers), { status: 200, headers });
    }

    const clanResult = parseClanName(searchParams.get("clan") || "");
    if (clanResult.error) {
      return new Response(JSON.stringify({ error: "Missing or invalid clan name or ids" }), { status: 400, headers });
    }
    return await fetchClanUsernames(runtime, clanResult.value, headers);
  } catch (error) {
    return createErrorResponse(error, headers, "Error loading usernames");
  }
}

async function fetchClanUsernames(runtime, clanName, headers) {
  const cacheKey = `${clanName}_CACHE`;
  const localCached = getLocalCache(runtime, cacheKey);
  if (localCached) {
    return new Response(JSON.stringify(localCached), { status: 200, headers });
  }

  const cachedRow = await dbFirst(
    runtime,
    "SELECT data_json, expires_at FROM username_cache WHERE clan_name = ? LIMIT 1",
    [clanName]
  );
  if (cachedRow && Number(cachedRow.expires_at) > nowSeconds()) {
    const parsed = parseJson(cachedRow.data_json, []);
    const cachedUsers = Array.isArray(parsed) ? parsed : [];
    setLocalCache(runtime, cacheKey, cachedUsers);
    return new Response(JSON.stringify(cachedUsers), { status: 200, headers });
  }

  const response = await fetchWithRateLimit(
    runtime,
    `https://ps99.biggamesapi.io/api/clan/${encodeURIComponent(clanName)}`
  );
  if (!response.ok) {
    throw new UpstreamRequestError(`Clan request failed with ${response.status}`);
  }

  const clanData = await readUpstreamJson(response, "Clan request");
  const members = clanData?.data?.Members || [];
  const ownerID = clanData?.data?.Owner;
  const currentUserIDs = [ownerID, ...members.map((member) => member.UserID)].filter(Number.isFinite);

  const resolvedUsers = await resolveUsernames(runtime, currentUserIDs);
  const ttlExpiresAt = nowSeconds() + USERNAME_CACHE_TTL_SECONDS;
  try {
    await dbRun(
      runtime,
      `INSERT INTO username_cache (clan_name, data_json, expires_at, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(clan_name) DO UPDATE SET
         data_json = excluded.data_json,
         expires_at = excluded.expires_at,
         updated_at = excluded.updated_at`,
      [clanName, JSON.stringify(resolvedUsers), ttlExpiresAt, nowSeconds()]
    );
  } catch (error) {
    logWarn("Failed username cache write", error, { clanName });
  }
  try {
    await cleanupUsernameCache(runtime);
  } catch (error) {
    logWarn("Failed username cache cleanup", error, { clanName });
  }
  setLocalCache(runtime, cacheKey, resolvedUsers);

  return new Response(JSON.stringify(resolvedUsers), { status: 200, headers });
}

async function resolveUsernames(runtime, userIDs) {
  if (userIDs.length === 0) {
    return [];
  }

  const response = await fetchWithRateLimit(runtime, "https://users.roblox.com/v1/users", {
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
    throw new UpstreamRequestError(`Roblox username request failed with ${response.status}`);
  }

  const payload = await readUpstreamJson(response, "Roblox username request");
  if (!Array.isArray(payload?.data)) {
    throw new UpstreamRequestError("Roblox username request returned an invalid payload");
  }
  return payload.data.map((user) => ({
    id: user.id,
    name: user.name,
  }));
}

async function fetchActiveBattle(runtime) {
  const response = await fetchWithRateLimit(runtime, "https://ps99.biggamesapi.io/api/activeClanBattle");
  if (!response.ok) {
    throw new UpstreamRequestError(`Active battle request failed with ${response.status}`);
  }
  const responseData = await readUpstreamJson(response, "Active battle request");

  const battleId = responseData?.data?.configName || "";
  const endTime = responseData?.data?.configData?.FinishTime || 0;

  if (!battleId) {
    throw new UpstreamRequestError("Active battle request is missing configName");
  }
  return { battleId, endTime };
}

async function fetchTopClans(runtime) {
  const response = await fetchWithRateLimit(
    runtime,
    "https://ps99.biggamesapi.io/api/clans?page=1&pageSize=35&sort=Points&sortOrder=desc"
  );
  if (!response.ok) {
    throw new UpstreamRequestError(`Top clans request failed with ${response.status}`);
  }
  const payload = await readUpstreamJson(response, "Top clans request");
  if (!Array.isArray(payload?.data)) {
    throw new UpstreamRequestError("Top clans request returned an invalid payload");
  }
  return payload.data;
}

async function fetchClanData(runtime, clanName) {
  const response = await fetchWithRateLimit(
    runtime,
    `https://ps99.biggamesapi.io/api/clan/${encodeURIComponent(clanName)}`
  );
  if (!response.ok) {
    throw new UpstreamRequestError(`Clan ${clanName} request failed with ${response.status}`);
  }
  return readUpstreamJson(response, `Clan ${clanName} request`);
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

async function updatePoints(runtime, battleId, clanName, pointsData) {
  const timestamp = new Date().toISOString();
  const signature = buildPointsSignature(pointsData);

  const latestSnapshot = await dbFirst(
    runtime,
    `SELECT data_json, signature
     FROM clan_snapshots
     WHERE battle_id = ? AND clan_name = ?
     ORDER BY id DESC
     LIMIT 1`,
    [battleId, clanName]
  );

  if (latestSnapshot && String(latestSnapshot.signature || "") === signature) {
    return;
  }

  const previousData = latestSnapshot ? parseJson(latestSnapshot.data_json, null) : null;

  await dbRun(
    runtime,
    `INSERT INTO clan_snapshots (battle_id, clan_name, timestamp, data_json, signature)
     VALUES (?, ?, ?, ?, ?)`,
    [battleId, clanName, timestamp, JSON.stringify(pointsData), signature]
  );

  await trackChanges(runtime, battleId, clanName, previousData, pointsData, timestamp);
}

async function trackChanges(runtime, battleId, clanName, previousData, nextData, timestamp) {
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
      runtime,
      `INSERT INTO clan_changes (battle_id, clan_name, change_type, user_id, timestamp)
       VALUES (?, ?, ?, ?, ?)`,
      [battleId, clanName, change.type, Number(change.UserID), change.timestamp]
    );
  }
}

async function cleanupOldData(runtime, battleId, endTime) {
  const now = nowSeconds();
  if (!endTime || now < endTime + 86400) {
    return false;
  }

  const existingData = await dbFirst(
    runtime,
    `SELECT
       EXISTS(SELECT 1 FROM clan_snapshots WHERE battle_id = ? LIMIT 1) AS has_snapshots,
       EXISTS(SELECT 1 FROM clan_changes WHERE battle_id = ? LIMIT 1) AS has_changes,
       EXISTS(SELECT 1 FROM tracked_clans WHERE battle_id = ? LIMIT 1) AS has_tracked,
       EXISTS(SELECT 1 FROM battle_state WHERE battle_id = ? LIMIT 1) AS has_state`,
    [battleId, battleId, battleId, battleId]
  );
  const hasStoredData = existingData && Object.values(existingData).some((value) => Number(value) > 0);
  if (hasStoredData) {
    await dbRun(runtime, "DELETE FROM clan_snapshots WHERE battle_id = ?", [battleId]);
    await dbRun(runtime, "DELETE FROM clan_changes WHERE battle_id = ?", [battleId]);
    await dbRun(runtime, "DELETE FROM tracked_clans WHERE battle_id = ?", [battleId]);
    await dbRun(runtime, "DELETE FROM battle_state WHERE battle_id = ?", [battleId]);
  }

  // Returning true even after a previous cleanup prevents the scheduler from
  // repopulating an already-expired battle on every other invocation.
  return true;
}

async function tryRecordSchedulerStatus(runtime, state, options = {}) {
  const now = nowSeconds();
  const lastError = options.error
    ? (options.error instanceof Error ? options.error.message : String(options.error)).slice(0, 500)
    : null;
  try {
    await dbRun(
      runtime,
      `INSERT INTO scheduler_status
         (id, state, battle_id, last_started_at, last_success_at, last_error, updated_at)
       VALUES (1, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         state = excluded.state,
         battle_id = COALESCE(excluded.battle_id, scheduler_status.battle_id),
         last_started_at = COALESCE(excluded.last_started_at, scheduler_status.last_started_at),
         last_success_at = COALESCE(excluded.last_success_at, scheduler_status.last_success_at),
         last_error = excluded.last_error,
         updated_at = excluded.updated_at`,
      [
        state,
        options.battleId || null,
        options.started ? now : null,
        options.succeeded ? now : null,
        lastError,
        now,
      ]
    );
  } catch (error) {
    logWarn("Failed to persist scheduler status", error, { state });
  }
}

async function runScheduledUpdate(runtime) {
  await tryRecordSchedulerStatus(runtime, "running", { started: true });
  try {
    const result = await fetchAndUpdatePoints(runtime);
    await tryRecordSchedulerStatus(runtime, result.state, {
      battleId: result.battleId,
      succeeded: true,
    });
    logEvent("info", "Scheduled fetch completed", result);
  } catch (error) {
    await tryRecordSchedulerStatus(runtime, "error", { error });
    throw error;
  }
}

async function fetchAndUpdatePoints(runtime) {
  await cleanupUsernameCache(runtime);
  const { battleId, endTime } = await fetchActiveBattle(runtime);
  const cleaned = await cleanupOldData(runtime, battleId, endTime);
  if (cleaned) {
    return { state: "idle", battleId, trackedClanCount: 0 };
  }

  const topClans = await fetchTopClans(runtime);
  const uniqueClans = new Set(topClans.map((clan) => String(clan.Name || "").toLowerCase()).filter(Boolean));
  PINNED_CLANS.forEach((clan) => uniqueClans.add(clan.toLowerCase()));
  const clansToTrack = [...uniqueClans];

  const cursorValue = await getBattleCursor(runtime, battleId);
  let cursor = Number.isFinite(cursorValue) ? cursorValue : 0;
  if (!Number.isFinite(cursor) || cursor < 0 || cursor >= clansToTrack.length) {
    cursor = 0;
  }

  let clansBatch = clansToTrack.slice(cursor, cursor + MAX_CLAN_FETCHES_PER_RUN);
  if (clansBatch.length === 0) {
    cursor = 0;
    clansBatch = clansToTrack.slice(0, MAX_CLAN_FETCHES_PER_RUN);
  }

  let processedClanCount = 0;
  let failedClanCount = 0;
  for (const clanName of clansBatch) {
    try {
      const clanData = await fetchClanData(runtime, clanName);
      const pointsData = clanData?.data?.Battles?.[battleId]?.PointContributions
        ? clanData.data.Battles[battleId]
        : null;
      if (pointsData) {
        await updatePoints(runtime, battleId, clanName, pointsData);
        processedClanCount += 1;
      }
    } catch (error) {
      failedClanCount += 1;
      logError("Failed clan update", error, { clanName, battleId });
    }
  }

  if (clansBatch.length > 0 && processedClanCount === 0) {
    throw new UpstreamRequestError("Scheduled clan batch produced no usable updates");
  }

  const nextCursor = cursor + clansBatch.length >= clansToTrack.length ? 0 : cursor + clansBatch.length;
  if (!Number.isFinite(cursorValue) || nextCursor !== cursorValue) {
    await setBattleCursor(runtime, battleId, nextCursor, endTime);
  }

  await syncTrackedClans(runtime, battleId, clansToTrack);
  return {
    state: "ok",
    battleId,
    trackedClanCount: clansToTrack.length,
    processedClanCount,
    failedClanCount,
  };
}

async function readClanSnapshots(runtime, battleId, clanName, beforeMs, rowLimit) {
  const boundedLimit = Math.max(1, Math.min(Number(rowLimit) || 1, MAX_CLAN_HISTORY_LIMIT + 1));
  let rows = [];
  if (beforeMs !== null) {
    rows = await dbAll(
      runtime,
      `SELECT timestamp, data_json
       FROM clan_snapshots
       WHERE battle_id = ? AND clan_name = ? AND timestamp < ?
       ORDER BY timestamp DESC
       LIMIT ?`,
      [battleId, clanName, new Date(beforeMs).toISOString(), boundedLimit]
    );
  } else {
    rows = await dbAll(
      runtime,
      `SELECT timestamp, data_json
       FROM clan_snapshots
       WHERE battle_id = ? AND clan_name = ?
       ORDER BY timestamp DESC
       LIMIT ?`,
      [battleId, clanName, boundedLimit]
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
  return history.reverse();
}

async function getBattleCursor(runtime, battleId) {
  const row = await dbFirst(
    runtime,
    "SELECT update_cursor FROM battle_state WHERE battle_id = ? LIMIT 1",
    [battleId]
  );
  if (!row) {
    return null;
  }
  const parsed = Number.parseInt(String(row.update_cursor || ""), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

async function setBattleCursor(runtime, battleId, updateCursor, endTime) {
  await dbRun(
    runtime,
    `INSERT INTO battle_state (battle_id, update_cursor, end_time, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(battle_id) DO UPDATE SET
       update_cursor = excluded.update_cursor,
       end_time = excluded.end_time,
       updated_at = excluded.updated_at`,
    [battleId, Number(updateCursor) || 0, Number(endTime) || 0, nowSeconds()]
  );
}

async function getTrackedClansList(runtime, battleId) {
  const rows = await dbAll(
    runtime,
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

async function syncTrackedClans(runtime, battleId, clansToTrack) {
  const existingRows = await dbAll(
    runtime,
    "SELECT clan_name FROM tracked_clans WHERE battle_id = ?",
    [battleId]
  );
  const existingSet = new Set(
    existingRows.map((row) => String(row.clan_name || "").toLowerCase()).filter(Boolean)
  );
  const desiredSet = new Set(
    clansToTrack.map((clanName) => String(clanName || "").toLowerCase()).filter(Boolean)
  );

  for (const clanName of existingSet) {
    if (desiredSet.has(clanName)) {
      continue;
    }
    await dbRun(
      runtime,
      "DELETE FROM tracked_clans WHERE battle_id = ? AND clan_name = ?",
      [battleId, clanName]
    );
  }

  const now = nowSeconds();
  for (const clanName of clansToTrack) {
    const normalized = String(clanName || "").toLowerCase();
    if (!normalized || existingSet.has(normalized)) {
      continue;
    }

    await dbRun(
      runtime,
      "INSERT INTO tracked_clans (battle_id, clan_name, added_at) VALUES (?, ?, ?)",
      [battleId, normalized, now]
    );
    existingSet.add(normalized);
  }
}

async function getTrackedClansSet(runtime, battleId) {
  const trackedClans = await getTrackedClansList(runtime, battleId);
  return new Set(trackedClans);
}

async function readClanChanges(runtime, battleId, clanName, trackedSet) {
  if (!trackedSet.has(clanName)) {
    return [];
  }

  const rows = await dbAll(
    runtime,
    `SELECT change_type, user_id, timestamp
     FROM clan_changes
     WHERE battle_id = ? AND clan_name = ?
     ORDER BY id ASC`,
    [battleId, clanName]
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

async function getChanges(runtime, battleId, clanName) {
  const trackedSet = await getTrackedClansSet(runtime, battleId);
  const clanChanges = await readClanChanges(runtime, battleId, clanName, trackedSet);
  return { [clanName]: clanChanges };
}

async function getChangesBatch(runtime, battleId, clanNames) {
  const trackedSet = await getTrackedClansSet(runtime, battleId);
  const entries = await Promise.all(
    clanNames.map(async (clanName) => [clanName, await readClanChanges(runtime, battleId, clanName, trackedSet)])
  );
  return Object.fromEntries(entries);
}

async function getChangesCounts(runtime, battleId, clanNames) {
  const changesByClan = await getChangesBatch(runtime, battleId, clanNames);
  return Object.fromEntries(clanNames.map((clanName) => [clanName, countRecentChanges(changesByClan[clanName])]));
}

import { FALLBACK_MESSAGE, FALLBACK_PINNED_CLANS } from "./data/local-data.js";

const BIG_API = "https://ps99.biggamesapi.io/api";
const BIG_IMAGE_API = "https://ps99.biggamesapi.io/image";
const ROPROXY_USERS = "https://users.roproxy.com/v1";
const ROPROXY_THUMBS = "https://thumbnails.roproxy.com/v1";
const WORKER_API = "https://petsimulatorclansapi.andreybusinessacc6675.workers.dev";
const ASSET_BASE = "./assets/images";
const CACHE_PREFIX = "psc_http_cache_v1_";
const WORKER_MIN_INTERVAL_MS = 180;
const CACHE_TTL_MS = {
  message: 10 * 60 * 1000,
  pinned: 15 * 60 * 1000,
  trackedClans: 15 * 60 * 1000,
  clanHistory: 3 * 60 * 1000,
  clanChanges: 3 * 60 * 1000,
  clanUsernames: 6 * 60 * 60 * 1000,
  usernameById: 24 * 60 * 60 * 1000,
};

const appEl = document.getElementById("app");
const topBarEl = document.getElementById("topBar");
const navLinks = Array.from(document.querySelectorAll("#main-nav a"));
const popupEl = document.getElementById("graph-popup");
const closePopupBtn = document.getElementById("close-popup");
const timeframeDropdown = document.getElementById("timeframeDropdown");

const ROUTES = {
  HOME: "/",
  CLANS: "/clans",
  CLAN: "/clan",
  PLAYERS: "/players",
  ENCHANTS: "/enchants",
};

const state = {
  routeNonce: 0,
  chart: null,
  popupClan: "",
  popupUserId: null,
  popupTimeline: [],
  activeBattle: "",
  trackedClans: null,
  trackedClansFetchedAt: 0,
  assetIconCache: new Map(),
  userAvatarCache: new Map(),
  usernameCache: new Map(),
  responseCache: new Map(),
  inFlightRequests: new Map(),
  nextWorkerRequestAt: 0,
};

closePopupBtn.addEventListener("click", closePopup);
popupEl.addEventListener("click", (event) => {
  if (event.target === popupEl) {
    closePopup();
  }
});

timeframeDropdown.addEventListener("change", () => {
  if (!state.popupUserId) {
    return;
  }
  renderPopupGraph(timeframeDropdown.value);
});

window.addEventListener("hashchange", renderRoute);

init();

async function init() {
  if (!window.location.hash) {
    window.location.hash = "#/";
  }
  state.activeBattle = await fetchActiveBattleName();
  await loadAnnouncement();
  renderRoute();
}

function parseHashRoute() {
  const hash = window.location.hash || "#/";
  const trimmed = hash.startsWith("#") ? hash.slice(1) : hash;
  const [pathPart, query = ""] = trimmed.split("?");
  return {
    path: pathPart || "/",
    params: new URLSearchParams(query),
  };
}

function setActiveNav(path) {
  navLinks.forEach((link) => {
    const target = link.getAttribute("data-route");
    link.classList.toggle("active", target === path || (target === ROUTES.HOME && path === "/"));
  });
}

function renderRoute() {
  const nonce = ++state.routeNonce;
  const route = parseHashRoute();

  closePopup();
  setActiveNav(route.path);

  if (route.path === ROUTES.HOME) {
    renderHome(nonce);
    return;
  }

  if (route.path === ROUTES.CLANS) {
    renderClans(nonce);
    return;
  }

  if (route.path === ROUTES.CLAN) {
    renderClan(route.params, nonce);
    return;
  }

  if (route.path === ROUTES.PLAYERS) {
    renderPlayers(route.params, nonce);
    return;
  }

  if (route.path === ROUTES.ENCHANTS) {
    renderEnchants(nonce);
    return;
  }

  renderNotFound();
}

async function loadAnnouncement() {
  const message = await fetchJSONCached(`${WORKER_API}/message`, {
    cacheKey: "message",
    ttlMs: CACHE_TTL_MS.message,
  }).catch(() => FALLBACK_MESSAGE);
  const effectiveMessage = message && typeof message === "object" ? message : FALLBACK_MESSAGE;

  if (effectiveMessage.visible) {
    topBarEl.textContent = effectiveMessage.message || "petsimulatorclans";
    topBarEl.style.backgroundColor = effectiveMessage.color || "#3c3c3c";
    topBarEl.classList.remove("hidden");
    return;
  }

  topBarEl.textContent = "petsimulatorclans";
  topBarEl.style.backgroundColor = "#3c3c3c";
  topBarEl.classList.add("hidden");
}

function renderNotFound() {
  appEl.innerHTML = `
    <header class="guild-header">
      <img src="${ASSET_BASE}/error.png" alt="Not found" />
      <div class="guild-info">
        <h1>Page Not Found</h1>
        <p>Use navigation to continue.</p>
      </div>
    </header>
  `;
}

function setLoadingElements(loadingEl, elementIds) {
  if (!loadingEl) {
    return;
  }
  loadingEl.textContent = `Loading ${elementIds.join(", ")}`;
}

function setLoadingItem(loadingEl, label) {
  if (!loadingEl) {
    return;
  }
  loadingEl.textContent = `Loading ${label}`;
}

async function renderHome(nonce) {
  appEl.innerHTML = `
    <header class="guild-header">
      <img id="guild-icon" src="${ASSET_BASE}/clans.webp" alt="Pet Simulator Clans" />
      <div class="guild-info">
        <h1>Pet Simulator Clans</h1>
      </div>
    </header>

    <div class="search-container">
      <input type="text" id="searchInput" placeholder="Enter clan name..." />
      <button id="searchButton">Search</button>
    </div>

    <div class="carousel-container">
      <div class="carousel top-clans">
        <div class="carousel-header"><h2>Top Clans</h2></div>
        <div class="carousel-content" id="topclans"></div>
        <div class="navigation"><a href="#/clans" class="button">View all clans</a></div>
      </div>

      <div class="carousel pinned-clans">
        <div class="carousel-header">
          <h2>Pinned Clans</h2>
          <div class="subtext">
            <p>
              Want your clan pinned?
              <a href="https://discord.gg/wPhaR58pDp" target="_blank" rel="noopener noreferrer">Join the Discord</a>
              and message andreyondemand.
            </p>
          </div>
        </div>
        <div class="carousel-content" id="pinnedclans"></div>
      </div>
    </div>
  `;

  wireClanSearch();

  const topContainer = document.getElementById("topclans");
  const pinnedContainer = document.getElementById("pinnedclans");

  try {
    const leaderboard = await fetchClanLeaderboard(10);
    if (nonce !== state.routeNonce) {
      return;
    }

    const assetIds = leaderboard.map((clan) => stripAssetId(clan.Icon));
    await resolveAssetIconsBatch(assetIds);

    topContainer.innerHTML = "";
    leaderboard.sort((a, b) => b.Points - a.Points).forEach((clan, idx) => {
      topContainer.appendChild(createClanCard(clan.Name, idx + 1, state.assetIconCache.get(stripAssetId(clan.Icon))));
    });

    const pinned = await fetchPinnedClans();
    const activeBattle = state.activeBattle || (await fetchActiveBattleName());

    const pinnedData = await Promise.all(
      pinned.map(async (clanName) => {
        const data = await fetchClanData(clanName).catch(() => null);
        if (!data?.Name) {
          return null;
        }
        return {
          ...data,
          place: data.Battles?.[activeBattle]?.Place || 99999,
        };
      })
    );

    if (nonce !== state.routeNonce) {
      return;
    }

    await resolveAssetIconsBatch(
      pinnedData.filter(Boolean).map((clan) => stripAssetId(clan.Icon))
    );

    pinnedContainer.innerHTML = "";
    pinnedData
      .filter(Boolean)
      .sort((a, b) => a.place - b.place)
      .forEach((clan) => {
        pinnedContainer.appendChild(
          createClanCard(
            clan.Name,
            clan.place === 99999 ? "N/A" : clan.place,
            state.assetIconCache.get(stripAssetId(clan.Icon))
          )
        );
      });
  } catch (error) {
    topContainer.innerHTML = `<div class="error-block">Failed to load top clans.</div>`;
    pinnedContainer.innerHTML = `<div class="error-block">Failed to load pinned clans.</div>`;
  }
}

async function renderClans(nonce) {
  appEl.innerHTML = `
    <header>
      <div class="guild-header">
        <img id="icon" src="${ASSET_BASE}/clans.webp" alt="Icon" />
        <div class="guild-info">
          <h1 id="name">Top Clans</h1>
          <h3 id="desc">The top tracked clans have advanced member point history</h3>
        </div>
        <div class="search-container">
          <input type="text" id="searchInput" placeholder="Enter clan name..." />
          <button id="searchButton">Search</button>
        </div>
      </div>
    </header>

    <div class="content">
      <h2>Clans</h2>
      <div class="table-scroll">
        <table class="responsive-table">
          <thead>
            <tr>
              <th>Place</th>
              <th>Clan</th>
              <th>24HR Member Changes</th>
              <th>Points</th>
              <th>Members</th>
            </tr>
          </thead>
          <tbody id="clans-body"></tbody>
        </table>
      </div>
    </div>
  `;

  wireClanSearch();

  const tbody = document.getElementById("clans-body");

  try {
    const clans = await fetchClanLeaderboard(100);
    if (nonce !== state.routeNonce) {
      return;
    }

    const tracked = await fetchTrackedClans();
    const trackedSet = new Set(tracked.map((name) => name.toLowerCase()));

    await resolveAssetIconsBatch(clans.map((clan) => stripAssetId(clan.Icon)));

    tbody.innerHTML = "";

    clans.sort((a, b) => b.Points - a.Points).forEach((clan, index) => {
      const row = document.createElement("tr");
      row.style.cursor = "pointer";
      row.addEventListener("click", () => goToClan(clan.Name));

      const iconUrl = state.assetIconCache.get(stripAssetId(clan.Icon)) || `${ASSET_BASE}/error.png`;
      const medal = getMedalIcon(index);

      row.innerHTML = `
        <td data-label="Place">#${index + 1}${medal ? ` <img class="icon" src="${medal}" alt="medal" />` : ""}</td>
        <td data-label="Clan">
          <div style="display:flex;align-items:center;gap:10px;">
            <img src="${iconUrl}" width="50" height="50" alt="${escapeHtml(clan.Name)}" />
            <span style="font-size:24px;line-height:50px;">${escapeHtml(clan.Name)}</span>
          </div>
        </td>
        <td class="changes-cell" data-label="24HR Member Changes">${trackedSet.has(clan.Name.toLowerCase()) ? "Loading..." : "N/A"}</td>
        <td data-label="Points">${formatNumber(clan.Points)}</td>
        <td data-label="Members">${formatNumber((clan.Members || 0) + 1)}</td>
      `;

      tbody.appendChild(row);

      if (trackedSet.has(clan.Name.toLowerCase())) {
        fetchMemberChangesCount(clan.Name.toLowerCase()).then((count) => {
          if (nonce === state.routeNonce) {
            const cell = row.querySelector(".changes-cell");
            if (cell) {
              cell.textContent = Number.isFinite(count) ? formatNumber(count) : "N/A";
            }
          }
        });
      }
    });
  } catch (error) {
    tbody.innerHTML = `<tr><td colspan="5"><div class="error-block">Failed to load clans.</div></td></tr>`;
  }
}

async function renderClan(params, nonce) {
  const clanName = (params.get("clan") || "").trim();
  if (!clanName) {
    appEl.innerHTML = `
      <header class="guild-header">
        <img id="guild-icon" src="${ASSET_BASE}/clans.webp" alt="Clan" />
        <div class="guild-info">
          <h1>Clan Not Provided</h1>
          <p>Use search to open a clan page.</p>
        </div>
      </header>
      <div class="search-container">
        <input type="text" id="searchInput" placeholder="Enter clan name..." />
        <button id="searchButton">Search</button>
      </div>
    `;
    wireClanSearch();
    return;
  }

  appEl.innerHTML = `
    <div id="loading-indicator">Loading...</div>
    <header>
      <div class="container">
        <div class="info-container">
          <div class="info">
            <div class="infoInfoContainer">
              <img id="guild-icon" src="${ASSET_BASE}/clans.webp" alt="Guild Icon" />
              <div class="guild-info">
                <h1 id="guild-name"></h1>
                <p id="guild-desc"></p>
                <p><strong><img class="icon" src="${ASSET_BASE}/icon_medal_gold.webp" alt="rank" /> Battle Leaderboard Place:</strong> <span id="battle-place"></span></p>
              </div>
            </div>
          </div>
          <div class="info">
            <p><strong><img class="icon" src="${ASSET_BASE}/recycle.png" alt="changes" /> Member changes in the last 24 hours:</strong> <span id="member-changes-count"></span></p>
            <p><strong><img class="icon" src="${ASSET_BASE}/clans.webp" alt="level" /> Clan Level:</strong> <span id="guild-level"></span></p>
            <p><strong><img class="icon" src="${ASSET_BASE}/clock.png" alt="kick" /> Kick Cooldown:</strong> <span id="kick-time"></span></p>
            <p><strong><img class="icon" src="${ASSET_BASE}/gold_star_1_outline.png" alt="points" /> Battle Points:</strong> <span id="battle-points"></span></p>
            <p><strong><img class="icon" src="${ASSET_BASE}/uparrow.png" alt="up" /> Points needed to surpass next clan:</strong> <span id="points-needed"></span></p>
            <p><strong><img class="icon" src="${ASSET_BASE}/downarrow.png" alt="down" /> Points needed for lower clan to surpass us:</strong> <span id="points-needed2"></span></p>
          </div>
        </div>
      </div>
    </header>

    <div class="content">
      <div class="select-container">
        <label for="memberSortDropdown">Sort:</label>
        <select id="memberSortDropdown">
          <option value="low_high">Highest to Lowest</option>
          <option value="online_offline">Online to Offline</option>
        </select>

        <label for="memberViewDropdown">View:</label>
        <select id="memberViewDropdown">
          <option value="grid">Grid Layout</option>
          <option value="list">List layout</option>
        </select>

        <label for="memberSearchInput">Member Search:</label>
        <input type="text" id="memberSearchInput" class="search-input" placeholder="Search members..." />
      </div>

      <div id="membersGrid" class="grid-container"></div>
      <div id="membersTable"></div>
      <p style="color: gray">*player online status may be inaccurate; check with the user for an accurate reading</p>

      <div class="carousel-container">
        <div class="carousel top-clans">
          <div class="carousel-header"><h2>Recent Member Changes</h2></div>
          <div class="carousel-content" id="memberChangesCarousel"></div>
        </div>
      </div>

      <div class="previousContent">
        <h2>Previous Battles</h2>
        <div class="table-scroll">
          <table class="responsive-table">
            <thead>
              <tr><th>Battle</th><th>Players</th><th>Medal</th><th>Place</th></tr>
            </thead>
            <tbody id="previousbattles"></tbody>
          </table>
        </div>
      </div>
    </div>
  `;

  const loadingEl = document.getElementById("loading-indicator");
  const clanLower = clanName.toLowerCase();

  try {
    setLoadingElements(loadingEl, ["#battle-place", "#battle-points", "#guild-level"]);
    const activeBattle = state.activeBattle || (await fetchActiveBattleName());
    setLoadingElements(loadingEl, ["#guild-name", "#guild-desc", "#guild-icon"]);
    const clanData = await fetchClanData(clanName);

    if (nonce !== state.routeNonce) {
      return;
    }

    if (!clanData?.Name) {
      throw new Error("Clan not found");
    }

    const iconId = stripAssetId(clanData.Icon);
    setLoadingElements(loadingEl, ["#guild-icon"]);
    await resolveAssetIconsBatch([iconId], {
      onProgress: (label) => setLoadingItem(loadingEl, label),
    });
    const iconUrl = state.assetIconCache.get(iconId) || `${ASSET_BASE}/error.png`;

    document.getElementById("guild-icon").src = iconUrl;
    document.getElementById("guild-name").textContent = `[${clanData.Name}]`;
    document.getElementById("guild-desc").textContent = clanData.Desc || "";

    const currentBattle = clanData.Battles?.[activeBattle];
    document.getElementById("battle-place").textContent = currentBattle?.Place || "N/A";
    document.getElementById("guild-level").textContent = clanData.GuildLevel ?? "N/A";
    document.getElementById("battle-points").textContent = formatNumber(currentBattle?.Points || 0);

    if (clanData.LastKickTimestamp) {
      startCountdown(clanData.LastKickTimestamp + 24 * 60 * 60, document.getElementById("kick-time"), "Kick Available");
    } else {
      document.getElementById("kick-time").textContent = "N/A";
    }

    setLoadingElements(loadingEl, ["#member-changes-count", "#memberChangesCarousel", "#membersGrid", "#membersTable"]);
    const history = await fetchClanHistory(clanLower);

    const changes = await fetchClanChanges(clanLower);
    document.getElementById("member-changes-count").textContent = formatNumber(countRecentChanges(changes));

    setLoadingElements(loadingEl, ["#points-needed", "#points-needed2"]);
    await populatePointsNeeded(clanLower);
    setLoadingElements(loadingEl, ["#memberChangesCarousel"]);
    await populateMemberChangesCarousel(changes, clanLower, nonce, (label) => setLoadingItem(loadingEl, label));
    populatePreviousBattles(clanData, activeBattle);

    const contributions = [...(currentBattle?.PointContributions || [])];
    const members = [...(clanData.Members || [])];
    members.push({ UserID: clanData.Owner, PermissionLevel: "Owner", JoinTime: null });

    const contributionMap = new Map(contributions.map((entry) => [entry.UserID, entry.Points]));
    members.forEach((member) => {
      if (!contributionMap.has(member.UserID)) {
        contributionMap.set(member.UserID, 0);
      }
    });

    const rows = Array.from(contributionMap.entries()).map(([UserID, Points]) => ({ UserID, Points }));
    rows.sort((a, b) => b.Points - a.Points);

    const userIds = rows.map((row) => row.UserID);
    setLoadingElements(loadingEl, ["#membersGrid", "#membersTable"]);
    const usernameMap = await resolveClanUsernames(clanLower, userIds, {
      onProgress: (label) => setLoadingItem(loadingEl, label),
    });
    await resolveUserAvatarsBatch(userIds, {
      onProgress: (label) => setLoadingItem(loadingEl, label),
      labelById: (id) => `@${usernameMap[id] || id} (user ${id})`,
    });

    const timelineMap = buildTimelineMap(history, activeBattle);

    if (nonce !== state.routeNonce) {
      return;
    }

    const memberSortDropdown = document.getElementById("memberSortDropdown");
    const memberViewDropdown = document.getElementById("memberViewDropdown");
    const memberSearchInput = document.getElementById("memberSearchInput");

    const rerender = () => {
      const searchTerm = memberSearchInput.value.trim().toLowerCase();
      const filteredRows = rows.filter((member) => {
        const username = usernameMap[member.UserID] || String(member.UserID);
        return username.toLowerCase().includes(searchTerm) || String(member.UserID).includes(searchTerm);
      });
      const sorted = sortMembers([...filteredRows], memberSortDropdown.value);
      if (memberViewDropdown.value === "list") {
        renderMembersList(sorted, usernameMap, timelineMap, clanData, clanLower, members);
      } else {
        renderMembersGrid(sorted, usernameMap, timelineMap, clanData, clanLower, members);
      }
    };

    memberSortDropdown.addEventListener("change", rerender);
    memberViewDropdown.addEventListener("change", rerender);
    memberSearchInput.addEventListener("input", rerender);
    rerender();

    loadingEl.classList.add("hidden");
  } catch (error) {
    loadingEl.classList.add("hidden");
    appEl.innerHTML = `<div class="error-block">Failed to load clan <strong>${escapeHtml(clanName)}</strong>.</div>`;
  }
}

async function renderPlayers(params, nonce) {
  const clan = (params.get("clan") || "").trim();
  const battleID = (params.get("battleID") || "").trim();

  if (!clan || !battleID) {
    appEl.innerHTML = `<div class="error-block">Missing clan or battleID.</div>`;
    return;
  }

  appEl.innerHTML = `
    <header>
      <div class="guild-header">
        <img id="guild-icon" src="${ASSET_BASE}/clans.webp" alt="Guild Icon" />
        <div class="guild-info">
          <h1 id="guild-name">Loading...</h1>
          <p id="guild-desc"></p>
        </div>
      </div>
    </header>
    <div id="loading-indicator">Loading...</div>
    <div class="content">
      <h2 id="battlename"></h2>
      <p><strong>Battle Points:</strong> <span id="battle-points"></span></p>
      <div class="search-container" style="margin-bottom: 20px;">
        <input type="text" id="searchInput" placeholder="Search members..." />
      </div>
      <div id="membersGrid" class="grid-container"></div>
      <h2>Players may be missing due to not being part of the clan, or not having any points during the battle.</h2>
    </div>
  `;

  const loadingEl = document.getElementById("loading-indicator");

  try {
    setLoadingElements(loadingEl, ["#guild-name", "#guild-desc", "#battlename", "#battle-points", "#guild-icon"]);
    const clanData = await fetchClanData(clan);
    if (nonce !== state.routeNonce) {
      return;
    }

    const battle = clanData.Battles?.[battleID];
    if (!battle) {
      throw new Error("Battle not found");
    }

    const iconId = stripAssetId(clanData.Icon);
    setLoadingElements(loadingEl, ["#guild-icon"]);
    await resolveAssetIconsBatch([iconId], {
      onProgress: (label) => setLoadingItem(loadingEl, label),
    });

    document.getElementById("guild-name").textContent = `[${clanData.Name}]`;
    document.getElementById("guild-desc").textContent = clanData.Desc || "";
    document.getElementById("battlename").textContent = `${battleID} Players`;
    document.getElementById("battle-points").textContent = formatNumber(battle.Points || 0);
    document.getElementById("guild-icon").src = state.assetIconCache.get(iconId) || `${ASSET_BASE}/error.png`;

    const contributions = [...(battle.PointContributions || [])].sort((a, b) => b.Points - a.Points);
    const userIds = contributions.map((entry) => entry.UserID);
    setLoadingElements(loadingEl, ["#membersGrid"]);
    const usernameMap = await resolveClanUsernames(clan.toLowerCase(), userIds, {
      onProgress: (label) => setLoadingItem(loadingEl, label),
    });
    await resolveUserAvatarsBatch(userIds, {
      onProgress: (label) => setLoadingItem(loadingEl, label),
      labelById: (id) => `@${usernameMap[id] || id} (user ${id})`,
    });

    if (nonce !== state.routeNonce) {
      return;
    }

    const grid = document.getElementById("membersGrid");
    const cardEntries = [];

    contributions.forEach((entry, idx) => {
      const userId = entry.UserID;
      const username = usernameMap[userId] || String(userId);
      const avatar = state.userAvatarCache.get(userId) || `${ASSET_BASE}/me.png`;

      const card = document.createElement("div");
      card.className = "card";
      card.innerHTML = `
        <img src="${avatar}" alt="${escapeHtml(username)}" />
        <h4 class="player-place">#${idx + 1}</h4>
        <p class="player-name">${escapeHtml(username)}</p>
        <p class="points"><img class="icon" src="${ASSET_BASE}/gold_star_1_outline.png" alt="points" /> ${formatNumber(entry.Points)} Points</p>
      `;
      grid.appendChild(card);
      cardEntries.push({
        card,
        search: username.toLowerCase(),
      });
    });

    const searchInput = document.getElementById("searchInput");
    searchInput.addEventListener("input", () => {
      const term = searchInput.value.trim().toLowerCase();
      cardEntries.forEach((entry) => {
        entry.card.style.display = entry.search.includes(term) ? "block" : "none";
      });
    });

    document.getElementById("loading-indicator")?.classList.add("hidden");
  } catch (error) {
    appEl.innerHTML = `<div class="error-block">Failed to load players view.</div>`;
  }
}

async function renderEnchants(nonce) {
  appEl.innerHTML = `
    <header>
      <div class="guild-header">
        <img id="header-icon" src="${ASSET_BASE}/clans.webp" alt="icon" />
        <div class="guild-info">
          <h1>Enchants</h1>
          <h3>The maximum amount of the same book you can use at a time</h3>
        </div>
      </div>
    </header>
    <div class="content">
      <div class="search-container" style="margin-bottom: 20px">
        <input type="text" id="searchInput" placeholder="Search Enchants..." />
      </div>
      <div id="enchantsGrid" class="grid-container"></div>
    </div>
  `;

  const grid = document.getElementById("enchantsGrid");

  try {
    const payload = await fetchJSON(`${BIG_API}/collection/enchants`);
    const enchants = payload?.data || [];

    if (nonce !== state.routeNonce) {
      return;
    }

    const iconIds = enchants.map((enchant) => {
      const maxTier = Math.max((enchant.configData?.MaxTier || 1) - 1, 0);
      return stripAssetId(enchant.configData?.Tiers?.[maxTier]?.Icon);
    });
    await resolveAssetIconsBatch(iconIds);

    const cards = [];

    enchants.forEach((enchant) => {
      const maxTier = Math.max((enchant.configData?.MaxTier || 1) - 1, 0);
      const tier = enchant.configData?.Tiers?.[maxTier] || enchant.configData?.Tiers?.[0] || {};
      const title = (enchant.configName || "").replace("Enchant | ", "") || "Unknown";
      const threshold = Number(enchant.configData?.DiminishPowerThreshold || 0);
      const power = Number(tier.Power || 0);
      const totalBooks = power > 0 ? Math.ceil((threshold / power) * 10) / 10 : 0;
      const iconId = stripAssetId(tier.Icon);

      const card = document.createElement("div");
      card.className = "card";
      card.innerHTML = `
        <img src="${state.assetIconCache.get(iconId) || `${ASSET_BASE}/error.png`}" alt="${escapeHtml(title)}" />
        <p class="configName">${escapeHtml(title)}</p>
        <p class="diminishPowerThreshold">Maximum power: ${round2(threshold)}</p>
        <p>Power per each tier ${maxTier + 1} book: ${round2(power)}</p>
        <p>Total tier ${maxTier + 1} books possible at the same time: ${round2(totalBooks)}</p>
      `;

      cards.push({
        card,
        search: `${title} ${threshold}`.toLowerCase(),
      });

      grid.appendChild(card);
    });

    const searchInput = document.getElementById("searchInput");
    searchInput.addEventListener("input", () => {
      const term = searchInput.value.trim().toLowerCase();
      cards.forEach((entry) => {
        entry.card.style.display = entry.search.includes(term) ? "block" : "none";
      });
    });
  } catch (error) {
    grid.innerHTML = `<div class="error-block">Failed to load enchants.</div>`;
  }
}

function wireClanSearch() {
  const input = document.getElementById("searchInput");
  const button = document.getElementById("searchButton");
  if (!input || !button) {
    return;
  }

  button.addEventListener("click", () => {
    goToClan(input.value.trim());
  });

  input.addEventListener("keypress", (event) => {
    if (event.key === "Enter") {
      goToClan(input.value.trim());
    }
  });
}

function goToClan(clanName) {
  if (!clanName) {
    return;
  }
  window.location.hash = `#/clan?clan=${encodeURIComponent(clanName)}`;
}

function goToPlayers(clanName, battleID) {
  window.location.hash = `#/players?clan=${encodeURIComponent(clanName)}&battleID=${encodeURIComponent(battleID)}`;
}

function createClanCard(clanName, rank, iconUrl) {
  const card = document.createElement("a");
  card.href = `#/clan?clan=${encodeURIComponent(clanName)}`;
  card.className = "nav-card";
  card.style.backgroundImage = `url('${iconUrl || `${ASSET_BASE}/error.png`}')`;

  const content = document.createElement("div");
  content.className = "card-content";
  content.innerHTML = `<p>${typeof rank === "number" ? `#${rank}` : escapeHtml(String(rank))}</p><p>${escapeHtml(clanName)}</p>`;

  card.appendChild(content);
  return card;
}

function getMedalIcon(index) {
  if (index === 0) {
    return `${ASSET_BASE}/icon_medal_gold.png`;
  }
  if (index >= 1 && index < 10) {
    return `${ASSET_BASE}/icon_medal_emerald_old.png`;
  }
  if (index >= 10 && index < 50) {
    return `${ASSET_BASE}/icon_medal_bronze.png`;
  }
  return "";
}

async function populatePointsNeeded(clanLower) {
  const pointsNeeded = document.getElementById("points-needed");
  const pointsNeeded2 = document.getElementById("points-needed2");

  try {
    const leaderboard = await fetchClanLeaderboard(100);
    const idx = leaderboard.findIndex((clan) => clan.Name.toLowerCase() === clanLower);

    if (idx < 0 || idx >= leaderboard.length) {
      pointsNeeded.textContent = "N/A";
      pointsNeeded2.textContent = "N/A";
      return;
    }

    if (idx === 0) {
      pointsNeeded.textContent = "None";
    } else {
      const needed = Math.max(leaderboard[idx - 1].Points - leaderboard[idx].Points, 0);
      pointsNeeded.textContent = `${formatNumber(needed)} Points needed to pass ${leaderboard[idx - 1].Name}`;
    }

    if (idx === leaderboard.length - 1) {
      pointsNeeded2.textContent = "N/A";
    } else {
      const needed2 = Math.max(leaderboard[idx].Points - leaderboard[idx + 1].Points, 0);
      pointsNeeded2.textContent = `${leaderboard[idx + 1].Name} needs ${formatNumber(needed2)} Points`;
    }
  } catch (error) {
    pointsNeeded.textContent = "N/A";
    pointsNeeded2.textContent = "N/A";
  }
}

async function populateMemberChangesCarousel(changes, clanLower, nonce, onProgress) {
  const carousel = document.getElementById("memberChangesCarousel");
  if (!carousel) {
    return;
  }

  if (!Array.isArray(changes) || changes.length === 0) {
    carousel.innerHTML = `<div class="member-change-entry"><p>No member changes to display.</p></div>`;
    return;
  }

  const sorted = [...changes].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  const ids = sorted.map((entry) => entry.UserID);
  const usernameMap = await resolveClanUsernames(clanLower, ids, { onProgress });
  await resolveUserAvatarsBatch(ids, {
    onProgress,
    labelById: (id) => `@${usernameMap[id] || id} (user ${id})`,
  });

  if (nonce !== state.routeNonce) {
    return;
  }

  carousel.innerHTML = "";
  sorted.forEach((change) => {
    const username = usernameMap[change.UserID] || String(change.UserID);
    const avatar = state.userAvatarCache.get(change.UserID) || `${ASSET_BASE}/me.png`;

    const entry = document.createElement("div");
    entry.className = "member-change-entry";
    entry.innerHTML = `
      <img src="${avatar}" class="user-image" alt="${escapeHtml(username)}" />
      <div class="member-info">
        <p><strong>Username:</strong> ${escapeHtml(username)}</p>
        <p><strong>Status:</strong> ${escapeHtml(change.type || "unknown")}</p>
        <p><small>Timestamp: ${formatTimestamp(change.timestamp)}</small></p>
      </div>
    `;
    carousel.appendChild(entry);
  });
}

function populatePreviousBattles(clanData, activeBattle) {
  const tbody = document.getElementById("previousbattles");
  if (!tbody) {
    return;
  }

  tbody.innerHTML = "";
  Object.values(clanData.Battles || {}).forEach((battle) => {
    if (!battle || battle.BattleID === activeBattle) {
      return;
    }

    const row = document.createElement("tr");
    row.innerHTML = `
      <td data-label="Battle">${escapeHtml(battle.BattleID)}</td>
      <td data-label="Players"><a href="#">Players</a></td>
      <td data-label="Medal">${escapeHtml(battle.EarnedMedal || "None")}</td>
      <td data-label="Place">${escapeHtml(String(battle.Place || "N/A"))}</td>
    `;

    row.querySelector("a")?.addEventListener("click", (event) => {
      event.preventDefault();
      goToPlayers(clanData.Name.toLowerCase(), battle.BattleID);
    });

    tbody.appendChild(row);
  });
}

function renderMembersGrid(rows, usernameMap, timelineMap, clanData, clanLower, members) {
  const grid = document.getElementById("membersGrid");
  const tableWrap = document.getElementById("membersTable");
  if (!grid || !tableWrap) {
    return;
  }

  grid.innerHTML = "";
  tableWrap.innerHTML = "";

  rows.forEach((member, idx) => {
    const username = usernameMap[member.UserID] || String(member.UserID);
    const gained = getGainedLastDay(member.UserID, member.Points, timelineMap);
    const avatar = state.userAvatarCache.get(member.UserID) || `${ASSET_BASE}/me.png`;

    const card = document.createElement("div");
    card.className = "card";
    if (member.Points > 0) {
      card.style.cursor = "pointer";
      card.addEventListener("click", () => openPopupForMember(member.UserID, username, clanData, clanLower, members, member.Points));
    }

    card.innerHTML = `
      <img src="${avatar}" alt="${escapeHtml(username)}" />
      <h4 class="player-place">#${idx + 1}</h4>
      <p class="player-name">${escapeHtml(username)}</p>
      <p class="points"><img class="icon" src="${ASSET_BASE}/gold_star_1_outline.png" alt="points" /> ${formatNumber(member.Points)} Points</p>
      <p class="LastDay">Gained ${formatNumber(gained)} points in the last day</p>
    `;

    grid.appendChild(card);
  });
}

function renderMembersList(rows, usernameMap, timelineMap, clanData, clanLower, members) {
  const grid = document.getElementById("membersGrid");
  const tableWrap = document.getElementById("membersTable");
  if (!grid || !tableWrap) {
    return;
  }

  grid.innerHTML = "";

  const table = document.createElement("table");
  table.className = "responsive-table";
  table.innerHTML = `
    <thead>
      <tr><th>Place</th><th>Player</th><th>Points</th><th>Presence</th><th>Gained in the last day</th></tr>
    </thead>
    <tbody></tbody>
  `;

  const tbody = table.querySelector("tbody");

  rows.forEach((member, idx) => {
    const username = usernameMap[member.UserID] || String(member.UserID);
    const gained = getGainedLastDay(member.UserID, member.Points, timelineMap);

    const row = document.createElement("tr");
    row.className = "listrow";
    if (member.Points > 0) {
      row.style.cursor = "pointer";
      row.addEventListener("click", () => openPopupForMember(member.UserID, username, clanData, clanLower, members, member.Points));
    }

    row.innerHTML = `
      <td data-label="Place">#${idx + 1}</td>
      <td class="player-name" data-label="Player">${escapeHtml(username)}</td>
      <td class="points" data-label="Points">${formatNumber(member.Points)}</td>
      <td data-label="Presence">N/A</td>
      <td data-label="Gained in the last day">Gained ${formatNumber(gained)} points in the last day</td>
    `;

    tbody.appendChild(row);
  });

  tableWrap.innerHTML = "";
  tableWrap.appendChild(table);
}

function sortMembers(rows, sortMode) {
  if (sortMode === "online_offline") {
    return rows.sort((a, b) => b.Points - a.Points);
  }
  return rows.sort((a, b) => b.Points - a.Points);
}

function buildTimelineMap(history, activeBattle) {
  const map = new Map();

  history.forEach((entry) => {
    const data = entry?.data;
    if (!data) {
      return;
    }

    const contributions = Array.isArray(data.PointContributions)
      ? data.PointContributions
      : Array.isArray(entry.PointContributions)
      ? entry.PointContributions
      : [];

    contributions.forEach((cont) => {
      const list = map.get(cont.UserID) || [];
      list.push({
        timestamp: entry.timestamp,
        Points: cont.Points,
      });
      map.set(cont.UserID, list);
    });
  });

  map.forEach((entries, key) => {
    entries.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    map.set(key, entries);
  });

  return map;
}

function getGainedLastDay(userId, currentPoints, timelineMap) {
  const timeline = timelineMap.get(userId) || [];
  if (timeline.length === 0) {
    return 0;
  }

  const last24 = Date.now() - 24 * 60 * 60 * 1000;
  const recent = timeline.find((entry) => new Date(entry.timestamp).getTime() >= last24);
  if (!recent) {
    return 0;
  }

  return Math.max(currentPoints - recent.Points, 0);
}

async function openPopupForMember(userId, username, clanData, clanLower, members, currentPoints) {
  state.popupUserId = userId;
  state.popupClan = clanLower;

  document.getElementById("popup-username").textContent = username;
  document.getElementById("popup-userid").innerHTML = `<a href="https://www.roblox.com/users/${userId}/profile" target="_blank" rel="noopener noreferrer">${userId}</a>`;

  const member = members.find((entry) => entry.UserID === userId);
  document.getElementById("popup-joined").textContent = member?.JoinTime
    ? new Date(member.JoinTime * 1000).toLocaleString()
    : "N/A";

  document.getElementById("popup-points").textContent = formatNumber(currentPoints);

  state.popupTimeline = await fetchClanUserTimeline(clanLower, userId);

  timeframeDropdown.value = "minute";
  popupEl.style.display = "block";
  popupEl.setAttribute("aria-hidden", "false");

  renderPopupGraph("minute");
}

function renderPopupGraph(timeframe) {
  const data = timeframe === "minute" ? state.popupTimeline : collapseTimeline(state.popupTimeline, timeframe);
  const ctx = document.getElementById("pointsGraph").getContext("2d");

  if (state.chart) {
    state.chart.destroy();
  }

  const labels = data.map((entry) => new Date(entry.timestamp));
  const points = data.map((entry) => entry.Points);

  state.chart = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Points Over Time",
          data: points,
          backgroundColor: "rgba(54, 162, 235, 0.2)",
          borderColor: "rgba(54, 162, 235, 1)",
          borderWidth: 1,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        yAxes: [
          {
            type: "linear",
            position: "left",
            ticks: { beginAtZero: true },
            scaleLabel: { display: true, labelString: "Points" },
          },
        ],
        xAxes: [
          {
            type: "time",
            time: {
              tooltipFormat: "ll h:mm A",
              displayFormats: {
                minute: "MMM DD, h:mm A",
                hour: "MMM DD, h:mm A",
                day: "MMM DD",
              },
            },
            distribution: "linear",
            scaleLabel: { display: true, labelString: "Date and Time" },
          },
        ],
      },
      tooltips: {
        intersect: false,
        mode: "index",
      },
      pan: { enabled: true, mode: "x" },
      zoom: { enabled: true, mode: "x" },
    },
  });
}

function collapseTimeline(timeline, timeframe) {
  const buckets = new Map();
  timeline.forEach((entry) => {
    const date = new Date(entry.timestamp);
    const key = timeframe === "hour"
      ? `${date.getUTCFullYear()}-${date.getUTCMonth()}-${date.getUTCDate()}-${date.getUTCHours()}`
      : `${date.getUTCFullYear()}-${date.getUTCMonth()}-${date.getUTCDate()}`;
    buckets.set(key, entry);
  });
  return Array.from(buckets.values()).sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
}

function closePopup() {
  popupEl.style.display = "none";
  popupEl.setAttribute("aria-hidden", "true");
}

async function fetchTrackedClans() {
  if (state.trackedClans && Date.now() - state.trackedClansFetchedAt < CACHE_TTL_MS.trackedClans) {
    return state.trackedClans;
  }

  try {
    const payload = await fetchJSONCached(`${WORKER_API}/clans`, {
      cacheKey: "tracked_clans",
      ttlMs: CACHE_TTL_MS.trackedClans,
    });
    if (!Array.isArray(payload) || payload.length === 0) {
      throw new Error("Invalid tracked clans payload");
    }

    state.trackedClans = [...new Set(payload.map((name) => String(name).toLowerCase()))].slice(0, 30);
    state.trackedClansFetchedAt = Date.now();
  } catch {
    try {
      const leaderboard = await fetchClanLeaderboard(35);
      const merged = [
        ...new Set([
          ...leaderboard.map((clan) => clan.Name.toLowerCase()),
          ...FALLBACK_PINNED_CLANS.map((name) => name.toLowerCase()),
        ]),
      ];
      state.trackedClans = merged.slice(0, 30);
      state.trackedClansFetchedAt = Date.now();
    } catch {
      state.trackedClans = [...new Set(FALLBACK_PINNED_CLANS.map((name) => name.toLowerCase()))];
      state.trackedClansFetchedAt = Date.now();
    }
  }

  return state.trackedClans;
}

async function fetchPinnedClans() {
  try {
    const payload = await fetchJSONCached(`${WORKER_API}/pinned`, {
      cacheKey: "pinned_clans",
      ttlMs: CACHE_TTL_MS.pinned,
    });
    if (Array.isArray(payload) && payload.length > 0) {
      return payload;
    }
  } catch {}
  return FALLBACK_PINNED_CLANS;
}

async function fetchMemberChangesCount(clanLower) {
  const changes = await fetchClanChanges(clanLower);
  return countRecentChanges(changes);
}

function countRecentChanges(changes) {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  return (changes || []).filter((change) => new Date(change.timestamp).getTime() >= cutoff).length;
}

async function fetchClanChanges(clanLower) {
  try {
    const payload = await fetchJSONCached(`${WORKER_API}/changes?clan=${encodeURIComponent(clanLower)}`, {
      cacheKey: `clan_changes_${clanLower}`,
      ttlMs: CACHE_TTL_MS.clanChanges,
    });
    const changes = normalizeChangesPayload(payload, clanLower);
    return changes;
  } catch {}

  return [];
}

async function fetchClanHistory(clanLower) {
  try {
    const payload = await fetchJSONCached(`${WORKER_API}/clan?clan=${encodeURIComponent(clanLower)}`, {
      cacheKey: `clan_history_${clanLower}`,
      ttlMs: CACHE_TTL_MS.clanHistory,
    });
    const history = normalizeHistoryPayload(payload, clanLower);
    return history;
  } catch {}

  return [];
}

async function fetchClanUserTimeline(clanLower, userId) {
  const history = await fetchClanHistory(clanLower);
  return history
    .map((entry) => {
      const cont = (entry?.data?.PointContributions || []).find((candidate) => candidate.UserID === userId);
      if (!cont) {
        return null;
      }
      return {
        timestamp: entry.timestamp,
        Points: cont.Points,
      };
    })
    .filter(Boolean)
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
}

async function fetchActiveBattleName() {
  try {
    const payload = await fetchJSON(`${BIG_API}/activeClanBattle`);
    return payload?.data?.configName || "";
  } catch {
    return "";
  }
}

async function fetchClanLeaderboard(pageSize) {
  const payload = await fetchJSON(`${BIG_API}/clans?page=1&pageSize=${pageSize}&sort=Points&sortOrder=desc`);
  return payload?.data || [];
}

async function fetchClanData(clanName) {
  const payload = await fetchJSON(`${BIG_API}/clan/${encodeURIComponent(clanName)}`);
  return payload?.data || null;
}

async function resolveClanUsernames(clanLower, userIds, options = {}) {
  const onProgress = typeof options.onProgress === "function" ? options.onProgress : null;
  const map = {};
  const uniqueIds = [...new Set((userIds || []).map((id) => Number(id)).filter(Number.isFinite))];
  const requested = new Set(uniqueIds);

  try {
    const payload = await fetchJSONCached(`${WORKER_API}/usernames?clan=${encodeURIComponent(clanLower)}`, {
      cacheKey: `clan_usernames_${clanLower}`,
      ttlMs: CACHE_TTL_MS.clanUsernames,
    });
    if (Array.isArray(payload)) {
      payload.forEach((entry) => {
        const userId = Number(entry?.id);
        const name = typeof entry?.name === "string" ? entry.name : "";
        if (Number.isFinite(userId) && name) {
          map[userId] = name;
          state.usernameCache.set(userId, name);
          localStorage.setItem(`psc_username_${userId}`, name);
          if (requested.has(userId) && onProgress) {
            onProgress(`username @${name} (user ${userId})`);
          }
        }
      });
    }
  } catch {}

  const missingIds = uniqueIds.filter((id) => !map[id]);
  const fallbackMap = await resolveUsernamesBatch(missingIds, { onProgress });
  Object.assign(map, fallbackMap);

  uniqueIds.forEach((id) => {
    if (!map[id]) {
      map[id] = String(id);
    }
  });

  return map;
}

async function resolveUsernamesBatch(userIds, options = {}) {
  const onProgress = typeof options.onProgress === "function" ? options.onProgress : null;
  const unique = [...new Set((userIds || []).map((id) => Number(id)).filter(Number.isFinite))];
  const result = {};

  unique.forEach((id) => {
    if (state.usernameCache.has(id)) {
      result[id] = state.usernameCache.get(id);
    }
  });

  const missing = unique.filter((id) => !result[id]);
  if (missing.length === 0) {
    return result;
  }

  for (const id of missing) {
    const storageKey = `psc_username_${id}`;
    const saved = localStorage.getItem(storageKey);
    if (saved) {
      result[id] = saved;
      state.usernameCache.set(id, saved);
      if (onProgress) {
        onProgress(`username @${saved} (user ${id})`);
      }
      continue;
    }

    const payload = await fetchJSONCached(`${ROPROXY_USERS}/users/${encodeURIComponent(id)}`, {
      cacheKey: `username_by_id_${id}`,
      ttlMs: CACHE_TTL_MS.usernameById,
    }).catch(() => null);
    const username = payload?.name ? payload.name : String(id);
    result[id] = username;
    state.usernameCache.set(id, username);
    if (onProgress) {
      onProgress(`username @${username} (user ${id})`);
    }
    if (payload?.name) {
      localStorage.setItem(storageKey, payload.name);
    }
  }

  return result;
}

function normalizeChangesPayload(payload, clanLower) {
  if (Array.isArray(payload)) {
    return payload;
  }

  if (payload && Array.isArray(payload[clanLower])) {
    return payload[clanLower];
  }

  if (payload && Array.isArray(payload.changes)) {
    return payload.changes;
  }

  return [];
}

function normalizeHistoryPayload(payload, clanLower) {
  if (Array.isArray(payload)) {
    return payload;
  }

  if (payload && Array.isArray(payload[clanLower])) {
    return payload[clanLower];
  }

  if (payload && Array.isArray(payload.history)) {
    return payload.history;
  }

  return [];
}

async function resolveAssetIconsBatch(assetIds, options = {}) {
  const onProgress = typeof options.onProgress === "function" ? options.onProgress : null;
  const labelById = typeof options.labelById === "function" ? options.labelById : (id) => `asset image ${id}`;
  const unique = [...new Set((assetIds || []).filter(Boolean))];
  const missing = unique.filter((id) => !state.assetIconCache.has(id));

  if (missing.length === 0) {
    return;
  }

  const chunks = chunkArray(missing, 50);
  for (const chunk of chunks) {
    const query = chunk.join(",");
    const payload = await fetchJSON(
      `${ROPROXY_THUMBS}/assets?assetIds=${encodeURIComponent(query)}&size=420x420&format=Png&isCircular=false`
    ).catch(() => null);

    const byId = new Map(
      (payload?.data || []).map((entry) => [String(entry.targetId), entry.imageUrl || `${BIG_IMAGE_API}/${entry.targetId}`])
    );

    chunk.forEach((id) => {
      state.assetIconCache.set(id, byId.get(String(id)) || `${BIG_IMAGE_API}/${encodeURIComponent(id)}`);
      if (onProgress) {
        onProgress(labelById(id));
      }
    });
  }
}

async function resolveUserAvatarsBatch(userIds, options = {}) {
  const onProgress = typeof options.onProgress === "function" ? options.onProgress : null;
  const labelById = typeof options.labelById === "function" ? options.labelById : (id) => `user ${id}`;
  const unique = [...new Set((userIds || []).map((id) => Number(id)).filter(Number.isFinite))];
  const missing = unique.filter((id) => !state.userAvatarCache.has(id));
  if (missing.length === 0) {
    return;
  }

  const chunks = chunkArray(missing, 100);
  for (const chunk of chunks) {
    const query = chunk.join(",");
    const payload = await fetchJSON(
      `${ROPROXY_THUMBS}/users/avatar-headshot?userIds=${encodeURIComponent(query)}&size=180x180&format=Png&isCircular=false`
    ).catch(() => null);

    const byId = new Map((payload?.data || []).map((entry) => [entry.targetId, entry.imageUrl || `${ASSET_BASE}/me.png`]));
    chunk.forEach((id) => {
      state.userAvatarCache.set(id, byId.get(id) || `${ASSET_BASE}/me.png`);
      if (onProgress) {
        onProgress(`avatar image for ${labelById(id)}`);
      }
    });
  }
}

async function fetchJSON(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return await response.json();
}

async function fetchJSONCached(url, config = {}) {
  const ttlMs = Number(config.ttlMs || 0);
  const cacheKey = String(config.cacheKey || url);
  const forceRefresh = Boolean(config.forceRefresh);
  const allowStaleOnError = config.allowStaleOnError !== false;

  const freshEntry = forceRefresh ? null : readCachedEntry(cacheKey);
  if (freshEntry) {
    return freshEntry.value;
  }

  if (state.inFlightRequests.has(cacheKey)) {
    return state.inFlightRequests.get(cacheKey);
  }

  const staleEntry = readStoredCacheEntry(cacheKey);
  const request = (async () => {
    if (url.startsWith(WORKER_API)) {
      await throttleWorkerRequests();
    }

    const payload = await fetchJSON(url, config.fetchOptions);
    if (ttlMs > 0) {
      writeCachedEntry(cacheKey, payload, ttlMs);
    }
    return payload;
  })().catch((error) => {
    if (allowStaleOnError && staleEntry) {
      return staleEntry.value;
    }
    throw error;
  }).finally(() => {
    state.inFlightRequests.delete(cacheKey);
  });

  state.inFlightRequests.set(cacheKey, request);
  return request;
}

async function throttleWorkerRequests() {
  const now = Date.now();
  if (state.nextWorkerRequestAt > now) {
    await sleep(state.nextWorkerRequestAt - now);
  }
  state.nextWorkerRequestAt = Math.max(state.nextWorkerRequestAt, Date.now()) + WORKER_MIN_INTERVAL_MS;
}

function readCachedEntry(cacheKey) {
  const memoryEntry = state.responseCache.get(cacheKey);
  if (memoryEntry && memoryEntry.expiresAt > Date.now()) {
    return memoryEntry;
  }
  if (memoryEntry) {
    state.responseCache.delete(cacheKey);
  }

  const stored = readStoredCacheEntry(cacheKey);
  if (!stored) {
    return null;
  }
  if (stored.expiresAt <= Date.now()) {
    return null;
  }
  state.responseCache.set(cacheKey, stored);
  return stored;
}

function readStoredCacheEntry(cacheKey) {
  const raw = localStorage.getItem(`${CACHE_PREFIX}${cacheKey}`);
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    if (typeof parsed.expiresAt !== "number") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeCachedEntry(cacheKey, value, ttlMs) {
  const entry = {
    value,
    expiresAt: Date.now() + ttlMs,
  };
  state.responseCache.set(cacheKey, entry);
  localStorage.setItem(`${CACHE_PREFIX}${cacheKey}`, JSON.stringify(entry));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chunkArray(values, size) {
  const chunks = [];
  for (let i = 0; i < values.length; i += size) {
    chunks.push(values.slice(i, i + size));
  }
  return chunks;
}

function stripAssetId(icon) {
  return String(icon || "").replace("rbxassetid://", "");
}

function startCountdown(timestamp, element, endText) {
  let intervalId = null;

  const update = () => {
    const remaining = timestamp * 1000 - Date.now();
    if (remaining <= 0) {
      element.textContent = endText || "Ready";
      clearInterval(intervalId);
      return;
    }

    const days = Math.floor(remaining / (24 * 60 * 60 * 1000));
    const hours = Math.floor((remaining % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
    const minutes = Math.floor((remaining % (60 * 60 * 1000)) / (60 * 1000));
    const seconds = Math.floor((remaining % (60 * 1000)) / 1000);

    element.textContent = `${days}d ${hours}h ${minutes}m ${seconds}s`;
  };

  update();
  intervalId = setInterval(update, 1000);
}

function formatTimestamp(timestamp) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return "Unknown";
  }
  return date.toLocaleString();
}

function formatNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return String(value ?? "N/A");
  }
  return number.toLocaleString("en-US");
}

function round2(value) {
  return Math.ceil(Number(value) * 100) / 100;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

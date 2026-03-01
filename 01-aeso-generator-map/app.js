const DEFAULT_API_KEY = "fa2f3b8461cf4aa4ba3ebf38aebf8a7b";
const API_PATHS = {
  assetList: "/assetlist-api/v1/assetlist",
  currentSupplyDemand: "/currentsupplydemand-api/v1/csd/generation/assets/current",
};

const MAP_DEFAULT_CENTER = [54.9, -114.5];
const MAP_DEFAULT_ZOOM = 6;

const STATUS_RANK = {
  "Generating": 1,
  "Online (0 MW)": 2,
  "Active (No telemetry)": 3,
  "Inactive": 4,
  "Suspended": 5,
  "Retired": 6,
};

const DEFAULT_STATUS_FILTER = "LIVE_ONLY";

const dom = {
  apiKeyInput: document.getElementById("apiKeyInput"),
  apiHostSelect: document.getElementById("apiHostSelect"),
  autoRefreshToggle: document.getElementById("autoRefreshToggle"),
  loadButton: document.getElementById("loadButton"),
  runtimeMessage: document.getElementById("runtimeMessage"),
  lastUpdatedLabel: document.getElementById("lastUpdatedLabel"),
  errorBanner: document.getElementById("errorBanner"),
  statTotal: document.getElementById("statTotal"),
  statGenerating: document.getElementById("statGenerating"),
  statZero: document.getElementById("statZero"),
  statOther: document.getElementById("statOther"),
  searchInput: document.getElementById("searchInput"),
  statusFilter: document.getElementById("statusFilter"),
  assetTableBody: document.getElementById("assetTableBody"),
};

const state = {
  map: null,
  markersLayer: null,
  markersByAssetId: new Map(),
  coordinateOverrides: {},
  assets: [],
  filteredAssets: [],
  loading: false,
  refreshTimer: null,
};

init().catch((error) => {
  showError(`Initialization failed: ${error.message}`);
  setRuntime("Initialization failed.", "error");
});

async function init() {
  dom.apiKeyInput.value = DEFAULT_API_KEY;
  initMap();
  bindEvents();
  setRuntime("Waiting to load data.", "idle");

  await loadCoordinateOverrides();
  await loadData();
}

function bindEvents() {
  dom.loadButton.addEventListener("click", () => {
    void loadData();
  });

  dom.searchInput.addEventListener("input", () => {
    applyFiltersAndRender();
  });

  dom.statusFilter.addEventListener("change", () => {
    applyFiltersAndRender();
  });

  dom.autoRefreshToggle.addEventListener("change", () => {
    updateRefreshTimer();
  });

  window.addEventListener("beforeunload", () => {
    if (state.refreshTimer) {
      clearInterval(state.refreshTimer);
      state.refreshTimer = null;
    }
  });
}

function initMap() {
  state.map = L.map("map", {
    zoomControl: false,
    preferCanvas: true,
    minZoom: 4,
    maxZoom: 12,
  }).setView(MAP_DEFAULT_CENTER, MAP_DEFAULT_ZOOM);

  L.control.zoom({ position: "topright" }).addTo(state.map);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors",
  }).addTo(state.map);

  state.markersLayer = L.layerGroup().addTo(state.map);
}

async function loadCoordinateOverrides() {
  try {
    const response = await fetch("./data/asset-coordinates.json", { cache: "no-store" });
    if (!response.ok) {
      state.coordinateOverrides = {};
      return;
    }
    const payload = await response.json();
    state.coordinateOverrides = payload && typeof payload === "object" ? payload : {};
  } catch {
    state.coordinateOverrides = {};
  }
}

async function loadData() {
  if (state.loading) {
    return;
  }

  const apiKey = dom.apiKeyInput.value.trim();
  if (!apiKey) {
    showError("An AESO API key is required.");
    return;
  }

  const selectedHost = String(dom.apiHostSelect.value || "").replace(/\/$/, "");
  if (!selectedHost) {
    showError("Select an API host before loading data.");
    return;
  }

  clearError();
  setRuntime("Loading AESO data...", "loading");
  setLoading(true);

  try {
    const assetListUrl = buildUrl(`${selectedHost}${API_PATHS.assetList}`, {
      asset_type: "SOURCE",
    });
    const csdUrl = buildUrl(`${selectedHost}${API_PATHS.currentSupplyDemand}`);

    const [assetPayload, csdPayload] = await Promise.all([
      fetchJson(assetListUrl, apiKey),
      fetchJson(csdUrl, apiKey),
    ]);

    const assets = parseAssetList(assetPayload);
    const csdReport = parseCurrentSupply(csdPayload);
    const liveByAssetId = buildLiveIndex(csdReport.records);

    const merged = mergeAssets(assets, liveByAssetId);
    const matchedTelemetryCount = merged.filter(
      (asset) => Number.isFinite(asset.netGeneration) || Number.isFinite(asset.maximumCapability),
    ).length;
    const liveCount = merged.filter((asset) => isLiveStatus(asset.status)).length;
    const liveMappedCount = merged.filter(
      (asset) => isLiveStatus(asset.status) && hasCoordinate(asset),
    ).length;

    state.assets = merged;
    populateStatusFilterOptions(merged);
    applyFiltersAndRender();

    const nowLabel = formatTimestamp(csdReport.reportTime || new Date().toISOString());
    dom.lastUpdatedLabel.textContent = `Updated: ${nowLabel}`;

    setRuntime(
      `Loaded ${merged.length.toLocaleString()} source assets (${matchedTelemetryCount.toLocaleString()} with live telemetry, ${liveMappedCount.toLocaleString()} mapped live of ${liveCount.toLocaleString()}).`,
      "ready",
    );
  } catch (error) {
    const formatted = formatFetchError(error);
    showError(formatted);
    setRuntime("Failed to load AESO data.", "error");
  } finally {
    setLoading(false);
  }
}

function buildUrl(baseUrl, params = {}) {
  const rawBase = asText(baseUrl);
  if (!rawBase) {
    throw new Error("Missing API host value.");
  }

  if (rawBase.startsWith("/") && window.location.protocol === "file:") {
    throw new Error("Proxy host paths require serving this app over http(s), not file://.");
  }

  const url = /^https?:\/\//i.test(rawBase)
    ? new URL(rawBase)
    : new URL(rawBase, window.location.href);

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") {
      continue;
    }
    url.searchParams.set(key, value);
  }

  return url.toString();
}

async function fetchJson(url, apiKey, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "API-KEY": apiKey,
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorPayload = await response.text();
      const compact = asText(errorPayload).replace(/\s+/g, " ");
      const detail = compact ? ` - ${compact.slice(0, 300)}` : "";
      throw new Error(`HTTP ${response.status} ${response.statusText}${detail}`);
    }

    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      return await response.json();
    }

    const text = await response.text();
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

function parseAssetList(payload) {
  const rows = extractArray(payload, ["asset_list", "assetList", "assets", "data"]);
  const dedupe = new Map();

  for (const row of rows) {
    const assetId = asText(row.asset_ID ?? row.assetId ?? row.asset ?? row.asset_id);
    if (!assetId || dedupe.has(assetId)) {
      continue;
    }

    const assetType = asText(row.asset_type ?? row.assetType);
    if (assetType && assetType.toUpperCase() !== "SOURCE") {
      continue;
    }

    dedupe.set(assetId, {
      assetId,
      assetName: asText(row.asset_name ?? row.assetName ?? row.name) || assetId,
      assetType,
      operatingStatus: normalizeOperatingStatus(asText(row.operating_status ?? row.operatingStatus)),
      poolParticipantName: asText(row.pool_participant_name ?? row.poolParticipantName),
      poolParticipantId: asText(row.pool_participant_ID ?? row.poolParticipantId),
      includesStorage: asText(row.asset_incl_storage_flag ?? row.assetInclStorageFlag),
      netToGrid: asText(row.net_to_grid_asset_flag ?? row.netToGridAssetFlag),
      apiCoordinate: extractCoordinateFromRecord(row),
    });
  }

  return Array.from(dedupe.values());
}

function parseCurrentSupply(payload) {
  const reportTime = findValueDeep(payload, [
    "last_updated_datetime_mpt",
    "last_updated_datetime_utc",
    "lastUpdatedDatetimeMpt",
    "lastUpdatedDatetimeUtc",
  ]);

  let rows = extractArray(payload, ["asset_list", "assetList", "assets", "data"]);
  if (!rows.length || !rows.some((row) => isLikelyCurrentSupplyRow(row))) {
    rows = findMatchingObjectsDeep(payload, (node) => isLikelyCurrentSupplyRow(node));
  }

  const records = [];

  for (const row of rows) {
    const assetId = asText(readValue(row, ["asset", "asset_ID", "assetId", "asset_id"]));
    if (!assetId) {
      continue;
    }

    records.push({
      assetId,
      fuelType: asText(readValue(row, ["fuel_type", "fuelType"])),
      subFuelType: asText(readValue(row, ["sub_fuel_type", "subFuelType"])),
      maximumCapability: asNumber(readValue(row, ["maximum_capability", "maximumCapability"])),
      netGeneration: asNumber(readValue(row, ["net_generation", "netGeneration"])),
      contingencyReserve: asNumber(
        readValue(row, ["dispatched_contingency_reserve", "dispatchedContingencyReserve"]),
      ),
      apiCoordinate: extractCoordinateFromRecord(row),
    });
  }

  return { reportTime, records };
}

function buildLiveIndex(records) {
  const index = new Map();

  for (const record of records) {
    const rawKey = asText(record.assetId).toUpperCase();
    const canonicalKey = canonicalAssetId(record.assetId);
    const keys = [rawKey, canonicalKey].filter(Boolean);

    for (const key of keys) {
      const current = index.get(key);
      if (!current || liveRecordScore(record) > liveRecordScore(current)) {
        index.set(key, record);
      }
    }
  }

  return index;
}

function liveRecordScore(record) {
  let score = 0;
  if (Number.isFinite(record.netGeneration)) {
    score += 1000 + record.netGeneration;
  }
  if (Number.isFinite(record.maximumCapability)) {
    score += 100 + record.maximumCapability / 10;
  }
  if (Number.isFinite(record.contingencyReserve)) {
    score += 10 + record.contingencyReserve / 10;
  }
  return score;
}

function extractArray(payload, preferredKeys = []) {
  if (Array.isArray(payload)) {
    return payload;
  }

  if (!payload || typeof payload !== "object") {
    return [];
  }

  for (const key of preferredKeys) {
    if (Array.isArray(payload[key])) {
      return payload[key];
    }
  }

  for (const value of Object.values(payload)) {
    if (Array.isArray(value)) {
      return value;
    }
  }

  if (payload.asset_ID || payload.asset || payload.asset_name) {
    return [payload];
  }

  return [];
}

function mergeAssets(assets, liveByAssetId) {
  const merged = assets.map((asset) => {
    const rawKey = asText(asset.assetId).toUpperCase();
    const canonicalKey = canonicalAssetId(asset.assetId);
    const live = liveByAssetId.get(rawKey) ?? liveByAssetId.get(canonicalKey) ?? null;
    const status = deriveStatus(asset.operatingStatus, live);
    const coordinate = resolveCoordinate(asset.assetId, asset.apiCoordinate, live?.apiCoordinate);

    return {
      ...asset,
      status,
      maximumCapability: live?.maximumCapability ?? null,
      netGeneration: live?.netGeneration ?? null,
      fuelType: live?.fuelType ?? "",
      subFuelType: live?.subFuelType ?? "",
      lat: coordinate.lat,
      lng: coordinate.lng,
      coordinateSource: coordinate.source,
    };
  });

  merged.sort((a, b) => {
    const rankA = statusRank(a.status);
    const rankB = statusRank(b.status);
    if (rankA !== rankB) {
      return rankA - rankB;
    }

    const generationA = a.netGeneration ?? -1;
    const generationB = b.netGeneration ?? -1;
    if (generationA !== generationB) {
      return generationB - generationA;
    }

    return a.assetId.localeCompare(b.assetId);
  });

  return merged;
}

function deriveStatus(operatingStatus, liveRecord) {
  const normalized = normalizeOperatingStatus(operatingStatus);

  if (normalized === "RETIRED") {
    return "Retired";
  }

  if (normalized === "INACTIVE") {
    return "Inactive";
  }

  if (normalized === "SUSPENDED") {
    return "Suspended";
  }

  if (!liveRecord) {
    return "Active (No telemetry)";
  }

  if ((liveRecord.netGeneration ?? 0) > 0) {
    return "Generating";
  }

  return "Online (0 MW)";
}

function statusRank(status) {
  return STATUS_RANK[status] ?? 99;
}

function isLiveStatus(status) {
  return status === "Generating" || status === "Online (0 MW)";
}

function hasCoordinate(asset) {
  return Number.isFinite(asset?.lat) && Number.isFinite(asset?.lng);
}

function resolveCoordinate(assetId, assetApiCoordinate, liveApiCoordinate) {
  const fromLive = parseCoordinate(liveApiCoordinate);
  if (fromLive) {
    return { ...fromLive, source: "api" };
  }

  const fromAsset = parseCoordinate(assetApiCoordinate);
  if (fromAsset) {
    return { ...fromAsset, source: "api" };
  }

  const override = parseCoordinate(state.coordinateOverrides[assetId]);
  if (override) {
    return { ...override, source: "override" };
  }

  return {
    lat: null,
    lng: null,
    source: "unmapped",
  };
}

function parseCoordinate(value) {
  if (Array.isArray(value) && value.length >= 2) {
    const lat = asNumber(value[0]);
    const lng = asNumber(value[1]);
    if (isCoordinateInRange(lat, lng)) {
      return { lat, lng };
    }
  }

  if (value && typeof value === "object") {
    const lat = asNumber(
      readValue(value, ["lat", "latitude", "y", "y_coordinate", "ycoord", "coord_y"]),
    );
    const lng = asNumber(
      readValue(value, [
        "lng",
        "lon",
        "long",
        "longitude",
        "x",
        "x_coordinate",
        "xcoord",
        "coord_x",
      ]),
    );
    if (isCoordinateInRange(lat, lng)) {
      return { lat, lng };
    }

    const nestedCoordinate = readValue(value, ["coordinate", "coordinates", "location", "point"]);
    const parsedNested = parseCoordinate(nestedCoordinate);
    if (parsedNested) {
      return parsedNested;
    }

    const coordText = asText(
      readValue(value, ["lat_lng", "latlng", "location", "coordinates", "point", "position"]),
    );
    const parsedText = parseCoordinateText(coordText);
    if (parsedText) {
      return parsedText;
    }
  }

  return null;
}

function parseCoordinateText(value) {
  if (!value) {
    return null;
  }

  const matches = value.match(/-?\d+(\.\d+)?/g);
  if (!matches || matches.length < 2) {
    return null;
  }

  const lat = asNumber(matches[0]);
  const lng = asNumber(matches[1]);
  if (isCoordinateInRange(lat, lng)) {
    return { lat, lng };
  }

  if (isCoordinateInRange(lng, lat)) {
    return { lat: lng, lng: lat };
  }

  return null;
}

function extractCoordinateFromRecord(record) {
  const direct = parseCoordinate(record);
  if (direct) {
    return direct;
  }

  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return null;
  }

  for (const value of Object.values(record)) {
    const nested = parseCoordinate(value);
    if (nested) {
      return nested;
    }
  }

  return null;
}

function isCoordinateInRange(lat, lng) {
  return Number.isFinite(lat) && Number.isFinite(lng) && lat >= 48.8 && lat <= 60.5 && lng >= -120.5 && lng <= -109.2;
}

function applyFiltersAndRender() {
  const search = dom.searchInput.value.trim().toLowerCase();
  const filterStatus = dom.statusFilter.value || DEFAULT_STATUS_FILTER;

  state.filteredAssets = state.assets.filter((asset) => {
    if (filterStatus === DEFAULT_STATUS_FILTER) {
      if (!isLiveStatus(asset.status)) {
        return false;
      }
    } else if (filterStatus !== "ALL" && asset.status !== filterStatus) {
      return false;
    }

    if (!search) {
      return true;
    }

    const haystack = [
      asset.assetId,
      asset.assetName,
      asset.poolParticipantName,
      asset.poolParticipantId,
      asset.fuelType,
      asset.subFuelType,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    return haystack.includes(search);
  });

  renderStats(state.assets);
  renderTable(state.filteredAssets);
  renderMap(state.filteredAssets.filter((asset) => hasCoordinate(asset)));
}

function renderStats(assets) {
  let generating = 0;
  let onlineZero = 0;
  let other = 0;

  for (const asset of assets) {
    if (asset.status === "Generating") {
      generating += 1;
    } else if (asset.status === "Online (0 MW)") {
      onlineZero += 1;
    } else {
      other += 1;
    }
  }

  dom.statTotal.textContent = assets.length.toLocaleString();
  dom.statGenerating.textContent = generating.toLocaleString();
  dom.statZero.textContent = onlineZero.toLocaleString();
  dom.statOther.textContent = other.toLocaleString();
}

function renderTable(assets) {
  dom.assetTableBody.innerHTML = "";

  if (!assets.length) {
    const row = document.createElement("tr");
    row.innerHTML = '<td colspan="3" class="placeholder">No assets match the current filters.</td>';
    dom.assetTableBody.append(row);
    return;
  }

  for (const asset of assets) {
    const row = document.createElement("tr");
    const statusClass = statusClassName(asset.status);
    const dotColor = markerColor(asset.status);
    const mwText = Number.isFinite(asset.netGeneration)
      ? `${asset.netGeneration.toLocaleString()} MW`
      : "n/a";

    row.innerHTML = `
      <td>
        <span class="asset-name">${escapeHtml(asset.assetName)}</span><br />
        <span class="asset-id">${escapeHtml(asset.assetId)}</span>
      </td>
      <td>
        <span class="status-pill ${statusClass}">
          <span class="status-dot" style="background:${dotColor}"></span>
          ${escapeHtml(asset.status)}
        </span>
      </td>
      <td>${escapeHtml(mwText)}</td>
    `;

    row.addEventListener("click", () => {
      focusAsset(asset.assetId);
    });

    dom.assetTableBody.append(row);
  }
}

function renderMap(assets) {
  state.markersLayer.clearLayers();
  state.markersByAssetId.clear();

  if (!assets.length) {
    state.map.setView(MAP_DEFAULT_CENTER, MAP_DEFAULT_ZOOM);
    return;
  }

  const bounds = [];

  for (const asset of assets) {
    const marker = L.circleMarker([asset.lat, asset.lng], {
      radius: markerRadius(asset),
      color: "#0a243f",
      weight: 1,
      fillColor: markerColor(asset.status),
      fillOpacity: 0.84,
    });

    marker.bindPopup(buildPopupHtml(asset), {
      className: "map-popup",
      maxWidth: 310,
    });

    marker.addTo(state.markersLayer);
    state.markersByAssetId.set(asset.assetId, marker);
    bounds.push([asset.lat, asset.lng]);
  }

  if (bounds.length) {
    state.map.fitBounds(bounds, { padding: [26, 26], maxZoom: 8 });
  }
}

function markerRadius(asset) {
  const maxCapability = asset.maximumCapability;
  if (!Number.isFinite(maxCapability) || maxCapability <= 0) {
    return 6;
  }

  return Math.max(6, Math.min(16, 4 + Math.sqrt(maxCapability) / 2));
}

function markerColor(status) {
  if (status === "Generating") {
    return "#169c5f";
  }

  if (status === "Online (0 MW)") {
    return "#c28705";
  }

  if (status === "Active (No telemetry)") {
    return "#d67a14";
  }

  return "#607189";
}

function statusClassName(status) {
  if (status === "Generating") {
    return "status-generating";
  }

  if (status === "Online (0 MW)") {
    return "status-zero";
  }

  if (status === "Active (No telemetry)") {
    return "status-warn";
  }

  return "status-off";
}

function buildPopupHtml(asset) {
  const mwText = Number.isFinite(asset.netGeneration)
    ? `${asset.netGeneration.toLocaleString()} MW`
    : "n/a";
  const maxCapText = Number.isFinite(asset.maximumCapability)
    ? `${asset.maximumCapability.toLocaleString()} MW`
    : "n/a";

  let sourceText = "Unmapped";
  if (asset.coordinateSource === "override") {
    sourceText = "Manual override";
  } else if (asset.coordinateSource === "api") {
    sourceText = "AESO API";
  }

  return `
    <div class="map-popup">
      <h3>${escapeHtml(asset.assetName)}</h3>
      <p><strong>ID:</strong> <code>${escapeHtml(asset.assetId)}</code></p>
      <p><strong>Status:</strong> ${escapeHtml(asset.status)}</p>
      <p><strong>Net generation:</strong> ${escapeHtml(mwText)}</p>
      <p><strong>Max capability:</strong> ${escapeHtml(maxCapText)}</p>
      <p><strong>Fuel:</strong> ${escapeHtml(asset.fuelType || "n/a")}${asset.subFuelType ? ` / ${escapeHtml(asset.subFuelType)}` : ""}</p>
      <p><strong>Location source:</strong> ${escapeHtml(sourceText)}</p>
    </div>
  `;
}

function focusAsset(assetId) {
  const marker = state.markersByAssetId.get(assetId);
  if (!marker) {
    setRuntime(
      `No mapped coordinate available for ${assetId}. Add it to data/asset-coordinates.json to place it on map.`,
      "error",
    );
    return;
  }

  const latLng = marker.getLatLng();
  state.map.flyTo(latLng, Math.max(state.map.getZoom(), 8), {
    duration: 0.65,
  });
  marker.openPopup();
}

function populateStatusFilterOptions(assets) {
  const current = dom.statusFilter.value || DEFAULT_STATUS_FILTER;
  const statuses = Array.from(new Set(assets.map((asset) => asset.status)));

  statuses.sort((a, b) => {
    const rankDiff = statusRank(a) - statusRank(b);
    return rankDiff || a.localeCompare(b);
  });

  dom.statusFilter.innerHTML = "";
  appendSelectOption(dom.statusFilter, DEFAULT_STATUS_FILTER, "Live only (Generating + Online 0 MW)");
  appendSelectOption(dom.statusFilter, "ALL", "All statuses");

  for (const status of statuses) {
    appendSelectOption(dom.statusFilter, status, status);
  }

  const allowed = new Set([DEFAULT_STATUS_FILTER, "ALL", ...statuses]);
  dom.statusFilter.value = allowed.has(current) ? current : DEFAULT_STATUS_FILTER;
}

function appendSelectOption(selectEl, value, label) {
  const option = document.createElement("option");
  option.value = value;
  option.textContent = label;
  selectEl.append(option);
}

function setLoading(loading) {
  state.loading = loading;
  dom.loadButton.disabled = loading;
}

function updateRefreshTimer() {
  if (state.refreshTimer) {
    clearInterval(state.refreshTimer);
    state.refreshTimer = null;
  }

  if (!dom.autoRefreshToggle.checked) {
    return;
  }

  state.refreshTimer = setInterval(() => {
    void loadData();
  }, 60000);
}

function showError(message) {
  dom.errorBanner.hidden = false;
  dom.errorBanner.textContent = message;
}

function clearError() {
  dom.errorBanner.hidden = true;
  dom.errorBanner.textContent = "";
}

function setRuntime(message, mode) {
  dom.runtimeMessage.textContent = message;
  dom.runtimeMessage.classList.remove("loading", "ready", "error");

  if (mode === "loading") {
    dom.runtimeMessage.classList.add("loading");
  } else if (mode === "ready") {
    dom.runtimeMessage.classList.add("ready");
  } else if (mode === "error") {
    dom.runtimeMessage.classList.add("error");
  }
}

function formatFetchError(error) {
  if (error?.name === "AbortError") {
    return "Request timed out while calling AESO API.";
  }

  const message = error?.message || "Unknown error";
  if (message.includes("Failed to fetch")) {
    return "Request failed before response (network or CORS). If this persists, we may need an nginx reverse proxy.";
  }

  return `AESO request failed: ${message}`;
}

function asText(value) {
  if (value === undefined || value === null) {
    return "";
  }

  return String(value).trim();
}

function asNumber(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function canonicalAssetId(value) {
  return asText(value).toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function normalizeKey(value) {
  return asText(value).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function readValue(record, aliases) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return undefined;
  }

  const aliasSet = new Set(aliases.map((alias) => normalizeKey(alias)));
  for (const [key, value] of Object.entries(record)) {
    if (aliasSet.has(normalizeKey(key))) {
      return value;
    }
  }

  return undefined;
}

function isLikelyCurrentSupplyRow(node) {
  if (!node || typeof node !== "object" || Array.isArray(node)) {
    return false;
  }

  const assetId = asText(readValue(node, ["asset", "asset_ID", "assetId", "asset_id"]));
  if (!assetId) {
    return false;
  }

  const hasNetGen = readValue(node, ["net_generation", "netGeneration"]) !== undefined;
  const hasMaxCap = readValue(node, ["maximum_capability", "maximumCapability"]) !== undefined;
  return hasNetGen || hasMaxCap;
}

function findMatchingObjectsDeep(payload, predicate, maxNodes = 50000) {
  const matches = [];
  const stack = [payload];
  const visited = new Set();
  let seen = 0;

  while (stack.length && seen < maxNodes) {
    const current = stack.pop();
    if (!current || typeof current !== "object") {
      continue;
    }
    if (visited.has(current)) {
      continue;
    }

    visited.add(current);
    seen += 1;

    if (Array.isArray(current)) {
      for (let i = current.length - 1; i >= 0; i -= 1) {
        stack.push(current[i]);
      }
      continue;
    }

    if (predicate(current)) {
      matches.push(current);
    }

    for (const value of Object.values(current)) {
      if (value && typeof value === "object") {
        stack.push(value);
      }
    }
  }

  return matches;
}

function findValueDeep(payload, aliases, maxNodes = 50000) {
  const stack = [payload];
  const visited = new Set();
  let seen = 0;

  while (stack.length && seen < maxNodes) {
    const current = stack.pop();
    if (!current || typeof current !== "object") {
      continue;
    }
    if (visited.has(current)) {
      continue;
    }

    visited.add(current);
    seen += 1;

    if (Array.isArray(current)) {
      for (let i = current.length - 1; i >= 0; i -= 1) {
        stack.push(current[i]);
      }
      continue;
    }

    const match = readValue(current, aliases);
    if (asText(match)) {
      return asText(match);
    }

    for (const value of Object.values(current)) {
      if (value && typeof value === "object") {
        stack.push(value);
      }
    }
  }

  return "";
}

function normalizeOperatingStatus(status) {
  return asText(status).toUpperCase();
}

function formatTimestamp(value) {
  const date = new Date(value);
  if (!Number.isNaN(date.valueOf())) {
    return date.toLocaleString("en-CA", {
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  }

  return asText(value) || "Unknown";
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

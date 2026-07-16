// Data access — ECCC MSC GeoMet OGC API (api.weather.gc.ca) + GeoMet WMS.
// All endpoints send Access-Control-Allow-Origin: *, so the site can run
// entirely client-side (GitHub Pages friendly).

const API = 'https://api.weather.gc.ca';
export const WMS = 'https://geo.weather.gc.ca/geomet';

// Bounding box that covers Ontario (incl. Thunder Bay, Sault Ste. Marie).
const ON_BBOX = '-96,41,-73.9,57';

const floorHourISO = (d = new Date()) => {
  const t = new Date(d);
  t.setUTCMinutes(0, 0, 0);
  return t.toISOString().replace(/\.\d{3}Z$/, 'Z');
};

async function getJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

/** All Ontario AQHI stations: [{id, name, lat, lon}] */
export async function fetchStations() {
  const d = await getJSON(
    `${API}/collections/aqhi-stations/items?f=json&limit=500&eccc_administrative-zone=ont`
  );
  return d.features
    .map((f) => ({
      id: f.properties.location_id,
      name: f.properties.location_name_en,
      lon: f.geometry.coordinates[0],
      lat: f.geometry.coordinates[1],
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Hourly observations for all Ontario stations (~ last 3 days from the
 * realtime collection). Returns Map(stationId -> Map(isoHour -> aqhi)).
 */
export async function fetchObservations() {
  const url =
    `${API}/collections/aqhi-observations-realtime/items?f=json` +
    `&bbox=${ON_BBOX}&limit=9000` +
    `&properties=location_id,observation_datetime,aqhi`;
  const d = await getJSON(url);
  const byStation = new Map();
  for (const f of d.features) {
    const p = f.properties;
    if (p.aqhi == null || !p.observation_datetime) continue;
    let m = byStation.get(p.location_id);
    if (!m) byStation.set(p.location_id, (m = new Map()));
    m.set(p.observation_datetime, p.aqhi);
  }
  return byStation;
}

/**
 * Hourly AQHI forecasts for all Ontario stations, from the current hour
 * forward, deduplicated to the most recent publication per station-hour.
 * (Period bulletins are nested objects the API can't select in bulk —
 * fetchBulletin() gets them per station.)
 * Returns Map(id -> Map(isoHour -> aqhi)).
 */
export async function fetchForecasts() {
  // NB: the collection's `datetime` filter matches publication_datetime, not
  // forecast_datetime — so grab the most recent publications and filter the
  // forecast horizon client-side.
  const now = floorHourISO();
  const url =
    `${API}/collections/aqhi-forecasts-realtime/items?f=json` +
    `&bbox=${ON_BBOX}&limit=10000&sortby=-publication_datetime` +
    `&properties=location_id,forecast_datetime,aqhi,publication_datetime`;
  const d = await getJSON(url);
  const byStation = new Map();
  const pub = new Map(); // station|hour -> publication_datetime kept
  for (const f of d.features) {
    const p = f.properties;
    if (p.aqhi == null || !p.forecast_datetime || p.forecast_datetime < now) continue;
    const key = `${p.location_id}|${p.forecast_datetime}`;
    if (pub.has(key) && pub.get(key) >= p.publication_datetime) continue;
    pub.set(key, p.publication_datetime);
    let m = byStation.get(p.location_id);
    if (!m) byStation.set(p.location_id, (m = new Map()));
    m.set(p.forecast_datetime, p.aqhi);
  }
  return byStation;
}

/** Latest period bulletin (Today / Tonight / Tomorrow …) for one station. */
export async function fetchBulletin(stationId) {
  const url =
    `${API}/collections/aqhi-forecasts-realtime/items?f=json` +
    `&location_id=${stationId}&sortby=-publication_datetime&limit=120`;
  const d = await getJSON(url);
  for (const f of d.features) {
    const p = f.properties;
    if (p.forecast_period) {
      return {
        publication_datetime: p.publication_datetime,
        periods: Object.values(p.forecast_period),
      };
    }
  }
  return null;
}

/**
 * Archived observations committed by the GitHub Action (extends history to
 * ~7 days once the action has been running). Absent locally / on first
 * deploy — a 404 is fine.
 */
export async function fetchArchive() {
  try {
    const res = await fetch('data/archive/observations.json', { cache: 'no-cache' });
    if (!res.ok) return null;
    const d = await res.json();
    const byStation = new Map();
    for (const [id, series] of Object.entries(d.obs || {})) {
      byStation.set(id, new Map(Object.entries(series)));
    }
    return byStation;
  } catch {
    return null;
  }
}

/** Merge archive + live observations (live wins). */
export function mergeObservations(archive, live) {
  if (!archive) return live;
  const out = new Map();
  for (const [id, m] of archive) out.set(id, new Map(m));
  for (const [id, m] of live) {
    let dst = out.get(id);
    if (!dst) out.set(id, (dst = new Map()));
    for (const [t, v] of m) dst.set(t, v);
  }
  return out;
}

/**
 * Time range of the RAQDPS surface-PM2.5 model layer (for the map overlay),
 * parsed from a layer-filtered WMS GetCapabilities (small, CORS-enabled).
 * Returns {start, end} ISO strings or null.
 */
export async function fetchWmsTimeRange(layer = 'RAQDPS.SFC_PM2.5') {
  try {
    const res = await fetch(
      `${WMS}?service=WMS&version=1.3.0&request=GetCapabilities&LAYERS=${layer}`
    );
    if (!res.ok) return null;
    const xml = await res.text();
    const m = xml.match(
      /<Dimension name="time"[^>]*>([^<]+)<\/Dimension>/
    );
    if (!m) return null;
    const [start, end] = m[1].split('/');
    return { start, end };
  } catch {
    return null;
  }
}

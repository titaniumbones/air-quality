// Model-derived AQHI estimate beyond the official hourly forecast horizon.
//
// ECCC's hourly AQHI forecast product stops ~36-48 h out, but the RAQDPS
// model it is based on publishes gridded hourly pollutant fields to +72 h
// on GeoMet WMS. We point-sample the three AQHI pollutants at the station
// with GetFeatureInfo and apply the published AQHI formula
// (3-hour rolling means; Stieb et al. 2008):
//
//   AQHI = (1000/10.4) * [ (e^(0.000537*O3) - 1)
//                        + (e^(0.000871*NO2) - 1)
//                        + (e^(0.000487*PM2.5) - 1) ]
//   with O3, NO2 in ppb and PM2.5 in ug/m3.
//
// This is raw model guidance, not a forecaster product — the UI labels it
// "model estimate" and draws it distinctly.

import { WMS } from './api.js';

const HOUR = 3600 * 1000;

const LAYERS = [
  { key: 'pm25', layer: 'RAQDPS.SFC_PM2.5', scale: 1e9 }, // kg/m3 -> ug/m3
  { key: 'o3', layer: 'RAQDPS.SFC_O3', scale: 1e9 },      // mol/mol -> ppb
  { key: 'no2', layer: 'RAQDPS.SFC_NO2', scale: 1e9 },    // mol/mol -> ppb
];

const cache = new Map(); // `${stationId}|${iso}|${key}` -> number

const isoOf = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

function featureInfoUrl(layer, station, iso) {
  const d = 0.05; // tiny box around the station; query its center pixel
  const bbox = `${station.lat - d},${station.lon - d},${station.lat + d},${station.lon + d}`;
  return (
    `${WMS}?service=WMS&version=1.3.0&request=GetFeatureInfo` +
    `&layers=${layer}&query_layers=${layer}` +
    `&crs=EPSG:4326&bbox=${bbox}&width=10&height=10&i=5&j=5` +
    `&info_format=application/json&time=${iso}`
  );
}

async function sample(spec, station, iso) {
  const k = `${station.id}|${iso}|${spec.key}`;
  if (cache.has(k)) return cache.get(k);
  const res = await fetch(featureInfoUrl(spec.layer, station, iso));
  if (!res.ok) throw new Error(`GetFeatureInfo ${res.status}`);
  const d = await res.json();
  const raw = d.features?.[0]?.properties?.value;
  if (raw == null) throw new Error('no model value');
  const v = raw * spec.scale;
  cache.set(k, v);
  return v;
}

/** Run thunks with bounded concurrency, reporting progress. */
async function pool(thunks, limit, onProgress) {
  const results = new Array(thunks.length);
  let next = 0;
  let done = 0;
  async function worker() {
    while (next < thunks.length) {
      const i = next++;
      results[i] = await thunks[i]();
      onProgress?.(++done, thunks.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, thunks.length) }, worker));
  return results;
}

function aqhiFrom(o3, no2, pm25) {
  const v =
    (1000 / 10.4) *
    (Math.expm1(0.000537 * o3) +
      Math.expm1(0.000871 * no2) +
      Math.expm1(0.000487 * pm25));
  return Math.max(1, v);
}

/**
 * Hourly model-estimated AQHI for `station`, for hours in (startMs, endMs].
 * Fetches two extra leading hours so every returned hour has a full
 * 3-hour rolling mean. ~3 requests per hour, concurrency-limited.
 *
 * @returns [{t, v}] sorted by time
 */
export async function fetchModelAqhi(station, startMs, endMs, onProgress) {
  const hours = [];
  for (let t = startMs - 2 * HOUR; t <= endMs; t += HOUR) hours.push(t);
  if (hours.length < 3) return [];

  const thunks = [];
  for (const t of hours) {
    for (const spec of LAYERS) {
      thunks.push(() => sample(spec, station, isoOf(t)).catch(() => null));
    }
  }
  const flat = await pool(thunks, 8, onProgress);

  // Regroup: per hour, [pm25, o3, no2] in LAYERS order.
  const byHour = new Map();
  hours.forEach((t, hi) => {
    const vals = {};
    LAYERS.forEach((spec, si) => { vals[spec.key] = flat[hi * LAYERS.length + si]; });
    byHour.set(t, vals);
  });

  const out = [];
  for (const t of hours) {
    if (t <= startMs) continue; // leading hours only feed the rolling mean
    const window = [byHour.get(t - 2 * HOUR), byHour.get(t - HOUR), byHour.get(t)];
    if (window.some((w) => !w || w.pm25 == null || w.o3 == null || w.no2 == null)) continue;
    const mean = (key) => (window[0][key] + window[1][key] + window[2][key]) / 3;
    out.push({ t, v: aqhiFrom(mean('o3'), mean('no2'), mean('pm25')) });
  }
  return out;
}

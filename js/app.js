// Orchestration: load data, render stat tiles, forecast cards, timeline
// chart, map; theme toggle; periodic refresh.

import {
  fetchStations, fetchObservations, fetchForecasts, fetchArchive,
  fetchBulletin, fetchWmsTimeRange, fetchUsAqi, mergeObservations,
} from './api.js';
import { aqiCategoryFor, aqiDisplay } from './aqi.js';
import {
  displayValue, colorFor, categoryFor, inkOn, MESSAGES, CATEGORIES,
  AQHI_COLORS, fmtDayTime, fmtTime,
} from './aqhi.js';
import { renderTimeline, renderTable, renderSparkline } from './chart.js';
import { fetchModelAqhi } from './model.js';
import { AqhiMap, buildTimeline } from './map.js';

const HOUR = 3600 * 1000;
const $ = (sel) => document.querySelector(sel);

const state = {
  stations: [],
  obs: new Map(),   // id -> Map(iso -> aqhi), archive+live merged
  fcst: new Map(),  // id -> Map(iso -> aqhi)
  bulletins: new Map(),
  station: localStorage.getItem('aqhi-station') || 'FCWYG', // Toronto Downtown
  rangeHours: 72,
  map: null,
  modelOn: false,
  modelSeries: new Map(), // stationId -> [{t,v}] model-estimated AQHI
  modelRange: null,       // {start,end} of the RAQDPS layer, fetched once
  aqi: null,              // {current, hourly: Map(ms -> v)} US AQI for the selected station
};

// ---------- theme ----------
function applyTheme(mode) {
  document.documentElement.dataset.theme = mode;
  localStorage.setItem('aqhi-theme', mode);
  $('#theme-toggle').textContent = mode === 'dark' ? '☀' : '☾';
  state.map?.setTheme(mode);
}
function initTheme() {
  const saved = localStorage.getItem('aqhi-theme');
  const mode = saved || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  applyTheme(mode);
  $('#theme-toggle').addEventListener('click', () =>
    applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
}

// ---------- series helpers ----------
function seriesFor(id, source) {
  const m = source.get(id);
  if (!m) return [];
  return [...m.entries()]
    .map(([iso, v]) => ({ t: Date.parse(iso), v }))
    .sort((a, b) => a.t - b.t);
}

function chartData() {
  const cutoff = Date.now() - state.rangeHours * HOUR;
  const obs = seriesFor(state.station, state.obs).filter((d) => d.t >= cutoff);
  const obsEnd = obs.length ? obs[obs.length - 1].t : 0;
  const fcst = seriesFor(state.station, state.fcst).filter((d) => d.t > obsEnd);
  const fcstEnd = fcst.length ? fcst[fcst.length - 1].t : obsEnd;
  const model = state.modelOn
    ? (state.modelSeries.get(state.station) || []).filter((d) => d.t > fcstEnd)
    : [];
  return { obs, fcst, model, aqi: state.aqi?.hourly || null };
}

// ---------- stat tiles ----------
function chip(cat, label = cat ? `${cat.name} risk` : 'No data') {
  const c = document.createElement('span');
  c.className = 'cat-chip';
  const dot = document.createElement('span');
  dot.className = 'cat-dot';
  dot.style.background = cat?.color || '#898781';
  c.append(dot, document.createTextNode(label));
  return c;
}

function renderTiles() {
  const obs = seriesFor(state.station, state.obs);
  const fcst = seriesFor(state.station, state.fcst);
  const stationName = state.stations.find((s) => s.id === state.station)?.name ?? state.station;
  const last = obs[obs.length - 1];

  // Page + hero titles follow the selected station
  $('#page-title').textContent = `${stationName} air quality`;
  document.title = `${stationName} Air Quality — AQHI Dashboard`;
  $('#hero-station').textContent = stationName;
  const heroVal = $('#hero-value');
  heroVal.textContent = last ? displayValue(last.v) : '–';
  const badge = $('#hero-badge');
  badge.style.background = last ? colorFor(last.v) : 'transparent';
  badge.style.color = last ? inkOn(colorFor(last.v)) : 'inherit';
  const cat = last ? categoryFor(last.v) : null;
  const chipHost = $('#hero-chip');
  chipHost.textContent = '';
  chipHost.appendChild(chip(cat));
  $('#hero-time').textContent = last ? `Observed ${fmtDayTime(last.t)}` : 'No recent observation';
  $('#hero-message').textContent = cat ? MESSAGES[cat.name].general : '';
  $('#hero-message-risk').textContent = cat ? `At-risk populations: ${MESSAGES[cat.name].atRisk}` : '';

  // 24h peak
  const dayAgo = Date.now() - 24 * HOUR;
  const last24 = obs.filter((d) => d.t >= dayAgo);
  const peak = last24.length ? last24.reduce((a, b) => (b.v > a.v ? b : a)) : null;
  setTile('#tile-peak', peak ? displayValue(peak.v) : '–',
    peak ? `at ${fmtTime(peak.t)}` : 'no data', peak ? categoryFor(peak.v) : null);

  // Next-24h forecast peak
  const next24 = fcst.filter((d) => d.t <= Date.now() + 24 * HOUR);
  const fpeak = next24.length ? next24.reduce((a, b) => (b.v > a.v ? b : a)) : null;
  setTile('#tile-fcst', fpeak ? displayValue(fpeak.v) : '–',
    fpeak ? `around ${fmtTime(fpeak.t)}` : 'no forecast', fpeak ? categoryFor(fpeak.v) : null);

  // Trend tile: sparkline last 24h + delta vs 24h ago
  renderSparkline($('#tile-trend .spark'), last24.map((d) => d.v));
  const deltaEl = $('#tile-trend .delta');
  deltaEl.textContent = '';
  if (last24.length >= 2 && last) {
    const prev = last24[0].v;
    const d = Math.round(last.v) - Math.round(prev);
    deltaEl.textContent = d === 0 ? 'steady vs 24 h ago'
      : `${d > 0 ? '▲' : '▼'} ${Math.abs(d)} vs 24 h ago`;
    deltaEl.className = 'delta ' + (d > 0 ? 'delta-bad' : d < 0 ? 'delta-good' : '');
  }
}

function setTile(sel, value, note, cat) {
  const tile = $(sel);
  tile.querySelector('.tile-value').textContent = value;
  tile.querySelector('.tile-note').textContent = note;
  const chipHost = tile.querySelector('.tile-chip');
  chipHost.textContent = '';
  if (cat) chipHost.appendChild(chip(cat));
}

// ---------- US AQI tile (Open-Meteo) ----------
async function loadAqi() {
  const station = state.stations.find((s) => s.id === state.station);
  if (!station) return;
  const forStation = state.station;
  try {
    const aqi = await fetchUsAqi(station);
    if (state.station !== forStation) return; // user switched mid-fetch
    state.aqi = aqi;
  } catch (err) {
    console.error('[AQI] Open-Meteo fetch failed', err);
    if (state.station !== forStation) return;
    state.aqi = { current: null, hourly: new Map() };
  }
  renderAqiTile();
  renderChart(); // tooltip + table pick up the hourly AQI
}

function renderAqiTile() {
  const cur = state.aqi?.current;
  const cat = cur ? aqiCategoryFor(cur.v) : null;
  const tile = $('#tile-aqi');
  tile.querySelector('.tile-value').textContent = cur ? aqiDisplay(cur.v) : '–';
  tile.querySelector('.tile-note').textContent =
    cur ? `as of ${fmtTime(cur.t)}` : state.aqi ? 'unavailable' : 'loading…';
  const chipHost = tile.querySelector('.tile-chip');
  chipHost.textContent = '';
  if (cat) chipHost.appendChild(chip(cat, cat.name));
}

// ---------- forecast period cards ----------
async function renderForecastCards() {
  const host = $('#forecast-cards');
  let b = state.bulletins.get(state.station);
  if (b === undefined) {
    try {
      b = await fetchBulletin(state.station);
    } catch { b = null; }
    state.bulletins.set(state.station, b);
  }
  host.textContent = '';
  if (!b) {
    host.textContent = 'No forecast bulletin available for this station.';
    return;
  }
  for (const p of b.periods) {
    if (!p) continue;
    const card = document.createElement('article');
    card.className = 'fcst-card';
    const period = document.createElement('div');
    period.className = 'fcst-period';
    period.textContent = p.forecast_period_en;
    const valWrap = document.createElement('div');
    valWrap.className = 'fcst-value-row';
    const badge = document.createElement('span');
    badge.className = 'fcst-badge';
    const col = colorFor(p.aqhi);
    badge.style.background = col;
    badge.style.color = inkOn(col);
    badge.textContent = displayValue(p.aqhi);
    const cat = document.createElement('span');
    cat.className = 'fcst-cat';
    cat.textContent = categoryFor(p.aqhi)?.name ?? '';
    valWrap.append(badge, cat);
    card.append(period, valWrap);
    if (p.aqhi_insmoke != null) {
      const smoke = document.createElement('div');
      smoke.className = 'fcst-smoke';
      smoke.textContent = `${displayValue(p.aqhi_insmoke)} if smoke arrives`;
      card.appendChild(smoke);
    }
    host.appendChild(card);
  }
  const pub = document.createElement('div');
  pub.className = 'fcst-pub';
  pub.textContent = `Issued ${fmtDayTime(Date.parse(b.publication_datetime))}`;
  host.appendChild(pub);
}

// ---------- chart ----------
function renderChart() {
  const data = chartData();
  renderTimeline($('#chart'), $('.chart-card'), data);
  renderTable($('#chart-table'), data);

  // When the selected range asks for more history than exists yet, say so
  // (ECCC's feed keeps ~3 days; the archive job grows it toward 7).
  const note = $('#history-note');
  const full = seriesFor(state.station, state.obs);
  const availableHours = full.length
    ? (Date.now() - full[0].t) / HOUR
    : 0;
  if (full.length && availableHours < state.rangeHours - 1) {
    note.textContent =
      `History for this station is available from ${fmtDayTime(full[0].t)} — ` +
      'the ECCC feed keeps about 3 days, and the archive job is extending it ' +
      'toward the full 7 days.';
    note.hidden = false;
  } else {
    note.hidden = true;
  }
}

// ---------- map ----------
function initMap() {
  state.map = new AqhiMap({
    mapEl: $('#map'),
    sliderEl: $('#time-slider'),
    timeLabelEl: $('#time-label'),
    playBtn: $('#play-btn'),
    overlayToggle: $('#wms-toggle'),
    wmsLegend: $('#wms-legend'),
    onStationSelect: (id) => {
      $('#station-select').value = id;
      selectStation(id);
    },
  });
  state.map.setTheme(document.documentElement.dataset.theme);
  state.map.setStations(state.stations);
  $('#fit-ontario').addEventListener('click', () => state.map.fitOntario());
  buildMapTimeline();
  fetchWmsTimeRange().then((r) => r && state.map.enableWms(r));
}

function buildMapTimeline() {
  let min = Infinity;
  let max = -Infinity;
  for (const source of [state.obs, state.fcst]) {
    for (const m of source.values()) {
      for (const iso of m.keys()) {
        const t = Date.parse(iso);
        if (t < min) min = t;
        if (t > max) max = t;
      }
    }
  }
  if (!isFinite(min)) return;
  min = Math.max(min, Date.now() - 7 * 24 * HOUR);
  const timeline = buildTimeline(min, max);
  const isoOf = new Map(timeline.map((t) => [t, new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z')]));
  state.map.setTimeline(timeline, (id, t) => {
    const iso = isoOf.get(t);
    const o = state.obs.get(id)?.get(iso);
    if (o != null) return { v: o, kind: 'obs' };
    const f = state.fcst.get(id)?.get(iso);
    if (f != null) return { v: f, kind: 'fcst' };
    return null;
  });
}

// ---------- AQHI scale legend strip ----------
function renderScaleLegend() {
  for (const host of document.querySelectorAll('.aqhi-scale')) {
    host.textContent = '';
    AQHI_COLORS.forEach((c, i) => {
      const cell = document.createElement('span');
      cell.className = 'scale-cell';
      cell.style.background = c;
      cell.style.color = inkOn(c);
      cell.textContent = i === 10 ? '+' : String(i + 1);
      host.appendChild(cell);
    });
    const cats = document.createElement('div');
    cats.className = 'scale-cats';
    for (const c of CATEGORIES) {
      const s = document.createElement('span');
      s.textContent = `${c.name} ${c.range}`;
      cats.appendChild(s);
    }
    host.after(cats);
  }
}

// ---------- station + range controls ----------
function populateStations() {
  const sel = $('#station-select');
  sel.textContent = '';
  const toronto = state.stations.filter((s) => s.name.startsWith('Toronto'));
  const rest = state.stations.filter((s) => !s.name.startsWith('Toronto'));
  const groupT = document.createElement('optgroup');
  groupT.label = 'Toronto';
  for (const s of toronto) groupT.appendChild(new Option(s.name, s.id));
  const groupO = document.createElement('optgroup');
  groupO.label = 'Ontario';
  for (const s of rest) groupO.appendChild(new Option(s.name, s.id));
  sel.append(groupT, groupO);
  if (!state.stations.some((s) => s.id === state.station)) {
    state.station = toronto[0]?.id ?? state.stations[0]?.id;
  }
  sel.value = state.station;
  sel.addEventListener('change', () => selectStation(sel.value));
}

function selectStation(id) {
  state.station = id;
  localStorage.setItem('aqhi-station', id);
  state.aqi = null; // don't show the previous station's AQI
  renderAqiTile();
  renderTiles();
  renderChart();
  renderForecastCards();
  loadAqi();
  if (state.modelOn) ensureModelSeries().then(renderChart);
}

function initRangeButtons() {
  for (const btn of document.querySelectorAll('.range-btn')) {
    btn.addEventListener('click', () => {
      state.rangeHours = +btn.dataset.hours;
      for (const b of document.querySelectorAll('.range-btn')) {
        b.setAttribute('aria-pressed', b === btn ? 'true' : 'false');
      }
      renderChart();
    });
  }
}

// ---------- model estimate (+72 h) ----------
async function ensureModelSeries() {
  const id = state.station;
  if (state.modelSeries.has(id)) return;
  const status = $('#model-status');
  const toggle = $('#model-toggle');
  try {
    if (!state.modelRange) {
      state.modelRange = await fetchWmsTimeRange('RAQDPS.SFC_PM2.5');
      if (!state.modelRange) throw new Error('model time range unavailable');
    }
    const fcst = seriesFor(id, state.fcst);
    const obs = seriesFor(id, state.obs);
    const lastOfficial = fcst.length
      ? fcst[fcst.length - 1].t
      : obs.length ? obs[obs.length - 1].t : Date.now();
    const end = Date.parse(state.modelRange.end);
    if (end <= lastOfficial) {
      state.modelSeries.set(id, []);
      status.textContent = 'model adds no extra hours right now';
      return;
    }
    const station = state.stations.find((s) => s.id === id);
    toggle.disabled = true;
    const series = await fetchModelAqhi(station, lastOfficial, end, (done, total) => {
      status.textContent = `loading model ${Math.round((100 * done) / total)}%`;
    });
    state.modelSeries.set(id, series);
    status.textContent = '';
  } catch (err) {
    console.error('[AQHI] model fetch failed', err);
    status.textContent = 'model data unavailable';
    state.modelOn = false;
    toggle.checked = false;
  } finally {
    toggle.disabled = false;
  }
}

async function setModelOn(on) {
  state.modelOn = on;
  $('#model-key').hidden = !on;
  if (on) {
    await ensureModelSeries();
  } else {
    $('#model-status').textContent = '';
  }
  renderChart();
}

function initModelToggle() {
  const toggle = $('#model-toggle');
  toggle.addEventListener('change', () => setModelOn(toggle.checked));
}

function initTableToggle() {
  const btn = $('#table-toggle');
  btn.addEventListener('click', () => {
    const tbl = $('#chart-table');
    const chart = $('#chart');
    const showTable = tbl.hidden;
    tbl.hidden = !showTable;
    chart.hidden = showTable;
    btn.textContent = showTable ? 'Chart view' : 'Table view';
    btn.setAttribute('aria-pressed', String(showTable));
  });
}

// ---------- data load ----------
async function loadData({ firstLoad = false } = {}) {
  const main = $('main');
  if (!firstLoad) main.classList.add('reloading');
  try {
    const [stations, liveObs, fcst, archive] = await Promise.all([
      firstLoad ? fetchStations() : Promise.resolve(state.stations),
      fetchObservations(),
      fetchForecasts(),
      fetchArchive(),
    ]);
    state.stations = stations;
    state.obs = mergeObservations(archive, liveObs);
    state.fcst = fcst;
    state.bulletins.clear(); // refetched on demand so they never go stale
    $('#updated').textContent = `Updated ${fmtTime(Date.now())}`;
    $('#error-banner').hidden = true;
  } catch (err) {
    console.error('[AQHI] data load failed', err);
    const banner = $('#error-banner');
    banner.hidden = false;
    banner.textContent =
      'Could not reach the Environment Canada data service. Showing the last loaded data; will retry automatically.';
  } finally {
    main.classList.remove('reloading');
  }
}

async function boot() {
  initTheme();
  renderScaleLegend();
  initRangeButtons();
  initTableToggle();
  initModelToggle();
  await loadData({ firstLoad: true });
  populateStations();
  renderTiles();
  renderChart();
  renderForecastCards();
  loadAqi(); // deliberately not awaited — Open-Meteo must never block AQHI
  initMap();

  // Re-render chart on resize (debounced).
  let rt;
  new ResizeObserver(() => {
    clearTimeout(rt);
    rt = setTimeout(renderChart, 150);
  }).observe($('#chart'));

  // Refresh every 10 minutes.
  setInterval(async () => {
    await loadData();
    renderTiles();
    renderChart();
    renderForecastCards();
    loadAqi();
    buildMapTimeline();
  }, 10 * 60 * 1000);
}

boot();

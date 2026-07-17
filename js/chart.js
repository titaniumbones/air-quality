// SVG timeline chart: observed AQHI (solid) + forecast (dashed projection),
// AQHI risk-category bands, hairline grid, crosshair + tooltip, keyboard
// navigation, and a table-view twin.

import { displayValue, categoryFor, fmtDay, fmtHour, fmtDayTime, CATEGORIES } from './aqhi.js';
import { aqiCategoryFor, aqiDisplay, AQI_CATEGORIES } from './aqi.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const HOUR = 3600 * 1000;

function el(name, attrs = {}, parent) {
  const n = document.createElementNS(SVGNS, name);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (parent) parent.appendChild(n);
  return n;
}

// A scale bundles everything index-specific the timeline needs: risk bands
// (drawn as faint washes behind the data — the label names the band, color is
// never alone), axis behavior, formatting, and series naming.
export const AQHI_SCALE = {
  label: 'AQHI',
  bands: [
    { from: 0, to: 3.5, cat: CATEGORIES[0] },
    { from: 3.5, to: 6.5, cat: CATEGORIES[1] },
    { from: 6.5, to: 10.5, cat: CATEGORIES[2] },
    { from: 10.5, to: Infinity, cat: CATEGORIES[3] },
  ],
  vmaxFor: (max) => Math.max(12, Math.ceil(max + 1)),
  tickStep: () => 2,
  display: displayValue,
  categoryFor,
  kinds: { obs: 'Observed', fcst: 'Forecast', model: 'Model estimate' },
  // Secondary tooltip lines: Ontario AQHI+ and US AQI for the hovered hour.
  extraTooltip(data, p) {
    const lines = [];
    const pm = data.pm25?.get(p.t);
    if (pm != null) {
      const line = document.createElement('div');
      line.className = 'tt-cat';
      const key = document.createElement('span');
      key.className = 'tt-key tt-key-plus';
      line.append(key, document.createTextNode(
        ` Ontario AQHI+ ${Math.ceil(pm / 10)} · PM2.5 ${Math.round(pm)} µg/m³`
      ));
      lines.push(line);
    }
    const v = data.aqi?.get(p.t);
    if (v != null) {
      const line = document.createElement('div');
      line.className = 'tt-cat';
      const key = document.createElement('span');
      key.className = 'tt-key';
      key.style.background = aqiCategoryFor(v)?.color || '';
      line.append(key, document.createTextNode(
        ` US AQI ${aqiDisplay(v)} · ${aqiCategoryFor(v)?.name ?? ''}`
      ));
      lines.push(line);
    }
    return lines.length ? lines : null;
  },
};

export const AQI_SCALE = {
  label: 'US AQI',
  bands: AQI_CATEGORIES.map((cat, i) => ({
    from: i ? AQI_CATEGORIES[i - 1].max : 0,
    to: cat.max,
    cat,
    shortLabel: cat.short,
  })),
  vmaxFor: (max) => Math.max(60, Math.ceil((max + 10) / 10) * 10),
  tickStep: (vmax) => (vmax <= 160 ? 25 : vmax <= 400 ? 50 : 100),
  display: aqiDisplay,
  categoryFor: aqiCategoryFor,
  // Both directions come from the CAMS model, so "Observed" would overclaim.
  kinds: { obs: 'Past (model)', fcst: 'Forecast' },
  extraTooltip: () => null,
};

/**
 * @param container  host element (emptied and refilled)
 * @param tooltipHost positioned ancestor for the tooltip div
 * @param data {obs:[{t,v}], fcst:[{t,v}], model?:[{t,v}]} sorted by time (ms epochs)
 * @param scale index definition (bands, formatting) — defaults to AQHI
 */
export function renderTimeline(container, tooltipHost, data, scale = AQHI_SCALE) {
  container.textContent = '';
  tooltipHost.querySelectorAll('.chart-tooltip').forEach((n) => n.remove());
  const model = data.model || [];
  const plus = data.plus || [];
  const width = container.clientWidth || 800;
  const height = 320;
  const m = { top: 18, right: 74, bottom: 30, left: 34 };
  const pw = width - m.left - m.right;
  const ph = height - m.top - m.bottom;

  const all = [...data.obs, ...data.fcst, ...model, ...plus];
  if (!all.length) {
    container.textContent = 'No data available.';
    return;
  }
  const t0 = Math.min(...all.map((d) => d.t));
  const t1 = Math.max(...all.map((d) => d.t));
  const vmax = scale.vmaxFor(Math.max(...all.map((d) => d.v)));

  const x = (t) => m.left + ((t - t0) / (t1 - t0 || 1)) * pw;
  const y = (v) => m.top + ph - (v / vmax) * ph;

  const svg = el('svg', {
    width, height,
    viewBox: `0 0 ${width} ${height}`,
    role: 'img',
    'aria-label': `${scale.label} timeline from ${fmtDayTime(t0)} to ${fmtDayTime(t1)}. Use the table view for exact values.`,
  }, container);
  svg.setAttribute('tabindex', '0');
  svg.classList.add('timeline-svg');

  // --- risk bands (behind everything) ---
  for (const b of scale.bands) {
    const top = y(Math.min(b.to === Infinity ? vmax : b.to, vmax));
    const bot = y(b.from);
    if (bot - top < 1) continue;
    el('rect', {
      x: m.left, y: top, width: pw, height: bot - top,
      fill: b.cat.color, class: 'band-fill',
    }, svg);
    if (bot - top < 12) continue; // sliver of a clipped band: skip the label
    const label = el('text', {
      x: m.left + pw + 8, y: (top + bot) / 2 + 3.5,
      class: 'band-label',
    }, svg);
    label.textContent = b.shortLabel ?? b.cat.name;
  }

  // --- grid + y ticks ---
  for (let v = 0; v <= vmax; v += scale.tickStep(vmax)) {
    el('line', {
      x1: m.left, x2: m.left + pw, y1: y(v), y2: y(v), class: 'gridline',
    }, svg);
    const t = el('text', { x: m.left - 8, y: y(v) + 3.5, class: 'tick tick-y' }, svg);
    t.textContent = String(v);
  }

  // --- x ticks: labels every 6/12h, day names at local midnights ---
  const spanH = (t1 - t0) / HOUR;
  const stepH = spanH <= 78 ? 6 : 12;
  const firstTick = Math.ceil(t0 / (stepH * HOUR)) * stepH * HOUR;
  for (let t = firstTick; t <= t1; t += stepH * HOUR) {
    el('line', {
      x1: x(t), x2: x(t), y1: m.top + ph, y2: m.top + ph + 4, class: 'axis-tick',
    }, svg);
    const lbl = el('text', { x: x(t), y: m.top + ph + 15, class: 'tick tick-x' }, svg);
    lbl.textContent = fmtHour(t);
  }
  // Day labels where the local date changes. The chart's first hour is
  // usually mid-day, so only label it if the first real midnight boundary
  // is far enough away not to collide (boundaries win over the partial day).
  const dayMarks = [];
  let prevDay = null;
  for (let t = t0; t <= t1; t += HOUR) {
    const day = fmtDay(t);
    if (day !== prevDay) {
      dayMarks.push({ t, day });
      prevDay = day;
    }
  }
  if (dayMarks.length > 1 && x(dayMarks[1].t) - x(dayMarks[0].t) < 88) {
    dayMarks.shift();
  }
  let lastLabelX = -Infinity;
  for (const mk of dayMarks) {
    const lx = x(mk.t) + 4;
    if (lx - lastLabelX < 88) continue;
    lastLabelX = lx;
    const lbl = el('text', { x: lx, y: m.top + ph + 27, class: 'tick tick-day' }, svg);
    lbl.textContent = mk.day;
  }

  el('line', {
    x1: m.left, x2: m.left + pw, y1: y(0), y2: y(0), class: 'baseline',
  }, svg);

  const path = (pts) =>
    pts.map((d, i) => `${i ? 'L' : 'M'}${x(d.t).toFixed(1)},${y(d.v).toFixed(1)}`).join('');

  // --- observed line + subtle area wash ---
  if (data.obs.length) {
    const area =
      path(data.obs) +
      `L${x(data.obs[data.obs.length - 1].t).toFixed(1)},${y(0)}` +
      `L${x(data.obs[0].t).toFixed(1)},${y(0)}Z`;
    el('path', { d: area, class: 'obs-area' }, svg);
    el('path', { d: path(data.obs), class: 'obs-line' }, svg);
  }

  // --- forecast: dashed projection, connected to last observation ---
  if (data.fcst.length) {
    const fpts = data.obs.length
      ? [data.obs[data.obs.length - 1], ...data.fcst]
      : data.fcst;
    el('path', { d: path(fpts), class: 'fcst-line' }, svg);
  }

  // --- model estimate: dotted continuation beyond the official forecast ---
  if (model.length) {
    const lead = data.fcst[data.fcst.length - 1] || data.obs[data.obs.length - 1];
    const mpts = lead ? [lead, ...model] : model;
    el('path', { d: path(mpts), class: 'model-line' }, svg);
  }

  // --- Ontario AQHI+ (PM2.5-derived, uncapped) — drawn over the ECCC series ---
  if (plus.length) {
    el('path', { d: path(plus), class: 'plus-line' }, svg);
  }

  // --- "now" marker ---
  const now = Date.now();
  if (now > t0 && now < t1) {
    el('line', { x1: x(now), x2: x(now), y1: m.top, y2: m.top + ph, class: 'now-line' }, svg);
    const lbl = el('text', { x: x(now), y: m.top - 5, class: 'now-label' }, svg);
    lbl.textContent = 'Now';
  }

  // --- end dot + direct label on latest observation only ---
  if (data.obs.length) {
    const last = data.obs[data.obs.length - 1];
    el('circle', { cx: x(last.t), cy: y(last.v), r: 6.5, class: 'dot-ring' }, svg);
    el('circle', { cx: x(last.t), cy: y(last.v), r: 4.5, class: 'dot' }, svg);
    const lbl = el('text', {
      x: x(last.t), y: y(last.v) - 12, class: 'end-label',
    }, svg);
    lbl.textContent = scale.display(last.v);
  }

  // --- hover layer: crosshair + tooltip, keyboard navigable ---
  const points = [
    ...data.obs.map((p) => ({ ...p, kind: scale.kinds.obs })),
    ...data.fcst.map((p) => ({ ...p, kind: scale.kinds.fcst })),
    ...model.map((p) => ({ ...p, kind: scale.kinds.model })),
  ].sort((a, b) => a.t - b.t);
  const cross = el('line', {
    y1: m.top, y2: m.top + ph, class: 'crosshair', visibility: 'hidden',
  }, svg);
  const hoverDot = el('circle', { r: 4.5, class: 'dot', visibility: 'hidden' }, svg);
  const hoverRing = el('circle', { r: 6.5, class: 'dot-ring', visibility: 'hidden' }, svg);

  const tooltip = document.createElement('div');
  tooltip.className = 'chart-tooltip';
  tooltip.hidden = true;
  tooltipHost.appendChild(tooltip);

  let idx = -1;
  const show = (i) => {
    idx = Math.max(0, Math.min(points.length - 1, i));
    const p = points[idx];
    const px = x(p.t);
    cross.setAttribute('x1', px);
    cross.setAttribute('x2', px);
    cross.setAttribute('visibility', 'visible');
    hoverRing.setAttribute('cx', px);
    hoverRing.setAttribute('cy', y(p.v));
    hoverRing.setAttribute('visibility', 'visible');
    hoverDot.setAttribute('cx', px);
    hoverDot.setAttribute('cy', y(p.v));
    hoverDot.setAttribute('visibility', 'visible');

    tooltip.textContent = '';
    const val = document.createElement('div');
    val.className = 'tt-value';
    val.textContent = `${scale.label} ${scale.display(p.v)}`;
    const cat = document.createElement('div');
    cat.className = 'tt-cat';
    const key = document.createElement('span');
    key.className = 'tt-key';
    key.style.background = scale.categoryFor(p.v)?.color || '';
    cat.append(key, document.createTextNode(
      ` ${scale.categoryFor(p.v)?.name ?? ''} · ${p.kind}`
    ));
    const extra = scale.extraTooltip(data, p);
    const when = document.createElement('div');
    when.className = 'tt-when';
    when.textContent = fmtDayTime(p.t);
    tooltip.append(val, cat, ...[extra ?? []].flat(), when);
    tooltip.hidden = false;

    const hostRect = tooltipHost.getBoundingClientRect();
    const svgRect = svg.getBoundingClientRect();
    const baseX = svgRect.left - hostRect.left + px;
    const flip = px > width * 0.72;
    tooltip.style.left = `${baseX + (flip ? -tooltip.offsetWidth - 12 : 12)}px`;
    tooltip.style.top = `${svgRect.top - hostRect.top + y(p.v) - 20}px`;
  };
  const hide = () => {
    for (const n of [cross, hoverDot, hoverRing]) n.setAttribute('visibility', 'hidden');
    tooltip.hidden = true;
    idx = -1;
  };

  svg.addEventListener('pointermove', (e) => {
    const rect = svg.getBoundingClientRect();
    const t = t0 + ((e.clientX - rect.left - m.left) / pw) * (t1 - t0);
    let best = 0;
    let bd = Infinity;
    for (let i = 0; i < points.length; i++) {
      const d = Math.abs(points[i].t - t);
      if (d < bd) { bd = d; best = i; }
    }
    show(best);
  });
  svg.addEventListener('pointerleave', hide);
  svg.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight') { show(idx < 0 ? points.length - 1 : idx + 1); e.preventDefault(); }
    else if (e.key === 'ArrowLeft') { show(idx < 0 ? points.length - 1 : idx - 1); e.preventDefault(); }
    else if (e.key === 'Escape') hide();
  });
  svg.addEventListener('focus', () => { if (idx < 0) show(points.length - 1); });
  svg.addEventListener('blur', hide);
}

/** Table-view twin of the timeline (WCAG-clean equivalent). */
export function renderTable(container, data) {
  container.textContent = '';
  const table = document.createElement('table');
  table.className = 'data-table';
  const cap = table.createCaption();
  cap.textContent = 'Hourly AQHI and US AQI values (observed and forecast)';
  const head = table.createTHead().insertRow();
  for (const h of ['Time (Toronto)', 'AQHI', 'AQHI+', 'US AQI', 'Risk', 'Type']) {
    const th = document.createElement('th');
    th.scope = 'col';
    th.textContent = h;
    head.appendChild(th);
  }
  const body = table.createTBody();
  const rows = [
    ...data.obs.map((p) => ({ ...p, kind: 'Observed' })),
    ...data.fcst.map((p) => ({ ...p, kind: 'Forecast' })),
    ...(data.model || []).map((p) => ({ ...p, kind: 'Model estimate' })),
  ].sort((a, b) => b.t - a.t);
  for (const p of rows) {
    const tr = body.insertRow();
    tr.insertCell().textContent = fmtDayTime(p.t);
    tr.insertCell().textContent = displayValue(p.v);
    const pm = data.pm25?.get(p.t);
    tr.insertCell().textContent = pm == null ? '–' : String(Math.ceil(pm / 10));
    tr.insertCell().textContent = aqiDisplay(data.aqi?.get(p.t));
    tr.insertCell().textContent = categoryFor(p.v)?.name ?? '';
    tr.insertCell().textContent = p.kind;
  }
  container.appendChild(table);
}

/** 24-point sparkline for the trend stat tile. */
export function renderSparkline(container, values) {
  container.textContent = '';
  if (!values.length) return;
  const w = 120;
  const h = 34;
  const vmax = Math.max(...values, 10);
  const vmin = 0;
  const x = (i) => (i / (values.length - 1 || 1)) * (w - 8) + 4;
  const y = (v) => h - 4 - ((v - vmin) / (vmax - vmin || 1)) * (h - 8);
  const svg = el('svg', { width: w, height: h, viewBox: `0 0 ${w} ${h}`, 'aria-hidden': 'true' }, container);
  const d = values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  el('path', { d, class: 'spark-line' }, svg);
  el('circle', { cx: x(values.length - 1), cy: y(values[values.length - 1]), r: 3.5, class: 'dot' }, svg);
}

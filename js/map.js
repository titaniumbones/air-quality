// Leaflet map: AQHI station markers across Ontario, hourly time scrubber
// spanning observed history → forecast, optional RAQDPS PM2.5 model overlay.

/* global L */
import { displayValue, colorFor, inkOn, fmtDayTime } from './aqhi.js';
import { WMS } from './api.js';

const HOUR = 3600 * 1000;

const BASEMAPS = {
  light: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
  dark: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
};
const BASEMAP_ATTR =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>';

export class AqhiMap {
  /**
   * @param opts {mapEl, sliderEl, timeLabelEl, playBtn, overlayToggle,
   *              onStationSelect(id)}
   */
  constructor(opts) {
    this.o = opts;
    this.markers = new Map(); // stationId -> L.Marker
    this.times = [];
    this.timeIndex = 0;
    this.playTimer = null;
    this.wmsRange = null;
    this.wmsLayer = null;

    this.map = L.map(opts.mapEl, {
      minZoom: 3,
      maxZoom: 13,
      worldCopyJump: true,
    });
    this.theme = 'light';
    this.base = L.tileLayer(BASEMAPS.light, {
      attribution: BASEMAP_ATTR,
      subdomains: 'abcd',
      maxZoom: 19,
    }).addTo(this.map);
    this.markerLayer = L.layerGroup().addTo(this.map);
    // Default view: southern Ontario prominent, all-Ontario reachable.
    this.map.setView([44.6, -79.9], 6);
  }

  setTheme(mode) {
    if (mode === this.theme) return;
    this.theme = mode;
    // Replace the layer rather than setUrl(): a full add cleanly resets the
    // tile grid (setUrl mid-view occasionally painted a stale tile origin).
    this.base.remove();
    this.base = L.tileLayer(BASEMAPS[mode] || BASEMAPS.light, {
      attribution: BASEMAP_ATTR,
      subdomains: 'abcd',
      maxZoom: 19,
    }).addTo(this.map);
  }

  setStations(stations) {
    this.stations = stations;
    this.markerLayer.clearLayers();
    this.markers.clear();
    for (const s of stations) {
      const icon = L.divIcon({
        className: 'aqhi-marker-wrap',
        html: '<div class="aqhi-marker aqhi-marker-empty">–</div>',
        iconSize: [30, 30],
        iconAnchor: [15, 15],
      });
      const mk = L.marker([s.lat, s.lon], { icon, keyboard: true, title: s.name });
      mk.on('click', () => this.o.onStationSelect?.(s.id));
      mk.bindTooltip('', { direction: 'top', offset: [0, -14], opacity: 0.96 });
      mk.addTo(this.markerLayer);
      this.markers.set(s.id, mk);
    }
  }

  fitOntario() {
    if (!this.stations?.length) return;
    this.map.fitBounds(
      L.latLngBounds(this.stations.map((s) => [s.lat, s.lon])).pad(0.06)
    );
  }

  /**
   * @param timeline sorted array of ms epochs
   * @param valueAt (stationId, tMs) -> {v, kind:'obs'|'fcst'} | null
   */
  setTimeline(timeline, valueAt) {
    this.times = timeline;
    this.valueAt = valueAt;
    const s = this.o.sliderEl;
    s.min = 0;
    s.max = timeline.length - 1;
    // Default: latest observed hour (the last time any station has an obs).
    let latestObs = 0;
    for (let i = 0; i < timeline.length; i++) {
      if (this.stations.some((st) => valueAt(st.id, timeline[i])?.kind === 'obs')) {
        latestObs = i;
      }
    }
    s.value = latestObs;
    this.showTime(latestObs);
    s.addEventListener('input', () => this.showTime(+s.value));
    this.o.playBtn.addEventListener('click', () => this.togglePlay());
  }

  showTime(i) {
    this.timeIndex = i;
    const t = this.times[i];
    if (t == null) return;
    let anyFcst = false;
    let anyObs = false;
    for (const s of this.stations) {
      const mk = this.markers.get(s.id);
      const res = this.valueAt(s.id, t);
      const elDiv = mk.getElement()?.querySelector('.aqhi-marker');
      if (!elDiv) continue;
      if (!res) {
        elDiv.className = 'aqhi-marker aqhi-marker-empty';
        elDiv.textContent = '–';
        elDiv.style.background = '';
        elDiv.style.color = '';
        mk.setTooltipContent(`${s.name} — no data at this hour`);
        continue;
      }
      if (res.kind === 'fcst') anyFcst = true; else anyObs = true;
      const bg = colorFor(res.v);
      elDiv.className = 'aqhi-marker' + (res.kind === 'fcst' ? ' aqhi-marker-fcst' : '');
      elDiv.style.background = bg;
      elDiv.style.color = inkOn(bg);
      elDiv.textContent = displayValue(res.v);
      mk.setTooltipContent(
        `${s.name}: AQHI ${displayValue(res.v)} (${res.kind === 'fcst' ? 'forecast' : 'observed'})`
      );
    }
    const kind = anyFcst && !anyObs ? 'Forecast' : anyObs && anyFcst ? 'Observed + forecast' : anyObs ? 'Observed' : '';
    this.o.timeLabelEl.textContent = `${fmtDayTime(t)} · ${kind}`;
    this.o.sliderEl.value = i;
    this.o.sliderEl.setAttribute('aria-valuetext', `${fmtDayTime(t)} ${kind}`);
    this.updateWms(t);
  }

  togglePlay() {
    if (this.playTimer) {
      clearInterval(this.playTimer);
      this.playTimer = null;
      this.o.playBtn.textContent = '▶';
      this.o.playBtn.setAttribute('aria-label', 'Play animation');
      return;
    }
    this.o.playBtn.textContent = '⏸';
    this.o.playBtn.setAttribute('aria-label', 'Pause animation');
    this.playTimer = setInterval(() => {
      const next = this.timeIndex + 1 > this.times.length - 1 ? 0 : this.timeIndex + 1;
      this.showTime(next);
    }, 450);
  }

  enableWms(range) {
    this.wmsRange = range; // {start,end} ISO
    const toggle = this.o.overlayToggle;
    toggle.disabled = !range;
    toggle.addEventListener('change', () => {
      if (toggle.checked) {
        this.wmsLayer = L.tileLayer.wms(WMS, {
          layers: 'RAQDPS.SFC_PM2.5',
          format: 'image/png',
          transparent: true,
          version: '1.3.0',
          opacity: 0.55,
          attribution: 'PM2.5 model: ECCC RAQDPS',
        }).addTo(this.map);
        this.updateWms(this.times[this.timeIndex]);
        this.o.wmsLegend.src =
          `${WMS}?service=WMS&version=1.3.0&request=GetLegendGraphic` +
          `&layer=RAQDPS.SFC_PM2.5&format=image/png&sld_version=1.1.0`;
        this.o.wmsLegend.hidden = false;
      } else {
        this.wmsLayer?.remove();
        this.wmsLayer = null;
        this.o.wmsLegend.hidden = true;
      }
    });
  }

  updateWms(tMs) {
    if (!this.wmsLayer || !this.wmsRange || tMs == null) return;
    const start = Date.parse(this.wmsRange.start);
    const end = Date.parse(this.wmsRange.end);
    const clamped = Math.min(Math.max(tMs, start), end);
    const iso = new Date(clamped).toISOString().replace(/\.\d{3}Z$/, 'Z');
    this.wmsLayer.setParams({ time: iso });
    // Dim the overlay when the scrubber is outside the model window.
    this.wmsLayer.setOpacity(clamped === tMs ? 0.55 : 0.15);
  }
}

export function buildTimeline(startMs, endMs) {
  const out = [];
  for (let t = startMs; t <= endMs; t += HOUR) out.push(t);
  return out;
}

// US EPA Air Quality Index (0–500) scale utilities.
// Colors are the official EPA AQI category colors. Data: Open-Meteo (CC BY 4.0).

// `short` fits the chart's band-label gutter; `name` is the official label.
export const AQI_CATEGORIES = [
  { max: 50, name: 'Good', short: 'Good', color: '#00e400' },
  { max: 100, name: 'Moderate', short: 'Moderate', color: '#ffff00' },
  { max: 150, name: 'Unhealthy for Sensitive Groups', short: 'Sensitive', color: '#ff7e00' },
  { max: 200, name: 'Unhealthy', short: 'Unhealthy', color: '#ff0000' },
  { max: 300, name: 'Very Unhealthy', short: 'V. unhealthy', color: '#8f3f97' },
  { max: Infinity, name: 'Hazardous', short: 'Hazardous', color: '#7e0023' },
];

/** Category object for an AQI value, or null when missing. */
export function aqiCategoryFor(v) {
  if (v == null || Number.isNaN(v)) return null;
  return AQI_CATEGORIES.find((c) => Math.round(v) <= c.max);
}

/** Rounded display string ('–' when missing). */
export function aqiDisplay(v) {
  return v == null || Number.isNaN(v) ? '–' : String(Math.round(v));
}

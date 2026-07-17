// AQHI scale utilities — official ECCC Air Quality Health Index scale.
// Colors are Environment and Climate Change Canada's published AQHI colors.
// They are a domain-standard severity scale; every colored mark in this app
// also carries its numeric value (color is never the only channel).

export const AQHI_COLORS = [
  '#00ccff', // 1
  '#0099cc', // 2
  '#006699', // 3
  '#ffff00', // 4
  '#ffcc00', // 5
  '#ff9933', // 6
  '#ff6666', // 7
  '#ff0000', // 8
  '#cc0000', // 9
  '#990000', // 10
  '#660000', // 10+
];

export const CATEGORIES = [
  { name: 'Low', range: '1–3', color: '#0099cc' },
  { name: 'Moderate', range: '4–6', color: '#ffcc00' },
  { name: 'High', range: '7–10', color: '#ff0000' },
  { name: 'Very high', range: '10+', color: '#660000' },
];

// Official ECCC health messages by category.
export const MESSAGES = {
  Low: {
    atRisk: 'Enjoy your usual outdoor activities.',
    general: 'Ideal air quality for outdoor activities.',
  },
  Moderate: {
    atRisk: 'Consider reducing or rescheduling strenuous activities outdoors if you are experiencing symptoms.',
    general: 'No need to modify your usual outdoor activities unless you experience symptoms such as coughing and throat irritation.',
  },
  High: {
    atRisk: 'Reduce or reschedule strenuous activities outdoors. Children and the elderly should also take it easy.',
    general: 'Consider reducing or rescheduling strenuous activities outdoors if you experience symptoms such as coughing and throat irritation.',
  },
  'Very high': {
    atRisk: 'Avoid strenuous activities outdoors. Children and the elderly should also avoid outdoor physical exertion.',
    general: 'Reduce or reschedule strenuous activities outdoors, especially if you experience symptoms such as coughing and throat irritation.',
  },
};

/** Rounded display value; values above 10 keep the "Very high" category/color. */
export function displayValue(v) {
  if (v == null || Number.isNaN(v)) return '–';
  return String(Math.max(1, Math.round(v)));
}

/** Color for a (possibly fractional) AQHI value. */
export function colorFor(v) {
  if (v == null || Number.isNaN(v)) return '#898781';
  const n = Math.max(1, Math.round(v));
  return AQHI_COLORS[Math.min(n, 11) - 1];
}

export function categoryFor(v) {
  if (v == null || Number.isNaN(v)) return null;
  const n = Math.round(v);
  if (n <= 3) return CATEGORIES[0];
  if (n <= 6) return CATEGORIES[1];
  if (n <= 10) return CATEGORIES[2];
  return CATEGORIES[3];
}

/** Ink color (dark or white) legible on a given AQHI fill. */
export function inkOn(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const lin = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  const L = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return L > 0.35 ? '#0b0b0b' : '#ffffff';
}

const TZ = 'America/Toronto';

export function fmtTime(iso) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, hour: 'numeric', minute: '2-digit',
  }).format(new Date(iso));
}

export function fmtDayTime(iso) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  }).format(new Date(iso));
}

export function fmtDay(iso) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric',
  }).format(new Date(iso));
}

export function fmtHour(iso) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, hour: 'numeric' })
    .format(new Date(iso));
}

// Small inline-SVG line-icon set (no external assets, no emoji). Each icon is
// built from plain shapes so it stays crisp at any size and inherits color.
const NS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; };

const SHAPES = {
  home: [['path', { d: 'M4 11.5 12 5l8 6.5' }], ['path', { d: 'M6.5 10v9h11v-9' }], ['path', { d: 'M10 19v-5h4v5' }]],
  members: [['circle', { cx: 9, cy: 8, r: 3 }], ['path', { d: 'M3.5 19c0-3.3 2.5-5.5 5.5-5.5s5.5 2.2 5.5 5.5' }], ['circle', { cx: 17, cy: 9, r: 2.4 }], ['path', { d: 'M15.7 13.6c2.6.3 4.3 2.3 4.3 5.4' }]],
  church: [['path', { d: 'M12 3v3' }], ['path', { d: 'M10.5 4.5h3' }], ['path', { d: 'M12 6l7 5.5v9.5H5V11.5z' }], ['path', { d: 'M10.6 21v-5.2a1.4 1.4 0 0 1 2.8 0V21' }]],
  attendance: [['rect', { x: 4, y: 4.5, width: 16, height: 15, rx: 3 }], ['path', { d: 'M8 9.5 11 12.5 16.5 7' }]],
  finance: [['circle', { cx: 12, cy: 12, r: 8 }], ['path', { d: 'M12 7.6v8.8' }], ['path', { d: 'M14.6 9.6c-.4-.8-1.3-1.3-2.4-1.3-1.4 0-2.5.8-2.5 1.9 0 1.2 1.1 1.6 2.5 1.9 1.4.3 2.5.8 2.5 2 0 1.1-1.1 1.9-2.5 1.9-1.1 0-2-.5-2.4-1.3' }]],
  notices: [['path', { d: 'M4 10.5v3.8h2.4L14 18V7l-7.6 3.5z' }], ['path', { d: 'M17 10a3 3 0 0 1 0 4.6' }], ['path', { d: 'M8 14.5v3.3a1.6 1.6 0 0 0 3.1.5l.7-2.4' }]],
  reports: [['path', { d: 'M4 20V9' }], ['path', { d: 'M10.5 20V5' }], ['path', { d: 'M17 20v-7' }], ['path', { d: 'M3 20h18' }]],
  staff: [['circle', { cx: 8, cy: 9, r: 3.4 }], ['path', { d: 'M11 11.5 18.5 4' }], ['path', { d: 'M15.5 7 18 9.5' }], ['path', { d: 'M18 4l2 2-2.2 2.2' }]],
  settings: [['circle', { cx: 12, cy: 12, r: 3 }], ['path', { d: 'M12 3.5v2.4M12 18.1v2.4M20.5 12h-2.4M5.9 12H3.5M17.7 6.3l-1.7 1.7M8 14l-1.7 1.7M17.7 17.7 16 16M8 10 6.3 8.3' }]],
  signout: [['path', { d: 'M13.5 4.5h-7a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h7' }], ['path', { d: 'M10.5 12h10' }], ['path', { d: 'M17.5 8.5 21 12l-3.5 3.5' }]],
  sync: [['path', { d: 'M5 11a7 7 0 0 1 12-4.5M19 6v4h-4' }], ['path', { d: 'M19 13a7 7 0 0 1-12 4.5M5 18v-4h4' }]],
  close: [['path', { d: 'M6 6l12 12M18 6 6 18' }]],
  plus: [['path', { d: 'M12 5v14M5 12h14' }]],
  search: [['circle', { cx: 10.5, cy: 10.5, r: 6 }], ['path', { d: 'M15 15l5 5' }]],
  edit: [['path', { d: 'M15.2 4.8 19 8.6 8.6 19H4.8v-3.8z' }]],
  trash: [['path', { d: 'M5 7h14' }], ['path', { d: 'M9.5 7V5.2A1.2 1.2 0 0 1 10.7 4h2.6a1.2 1.2 0 0 1 1.2 1.2V7' }], ['path', { d: 'M7 7l1 12.2A1.5 1.5 0 0 0 9.5 20.5h5A1.5 1.5 0 0 0 16 19.2L17 7' }]],
  phone: [['path', { d: 'M6 4.5h3l1.2 4-2 1.4a10 10 0 0 0 5 5l1.4-2 4 1.2v3a1.5 1.5 0 0 1-1.7 1.5A15.5 15.5 0 0 1 4.5 6.2 1.5 1.5 0 0 1 6 4.5Z' }]],
  chat: [['path', { d: 'M4 5.5h16v10.5H9.5L5 20v-4H4z' }]],
  download: [['path', { d: 'M12 4v11' }], ['path', { d: 'M7.5 10.5 12 15l4.5-4.5' }], ['path', { d: 'M5 18h14' }]],
  upload: [['path', { d: 'M12 15V4' }], ['path', { d: 'M7.5 8.5 12 4l4.5 4.5' }], ['path', { d: 'M5 18h14' }]],
  print: [['rect', { x: 5, y: 8.5, width: 14, height: 7, rx: 1.4 }], ['path', { d: 'M7.5 8.5V4.5h9v4' }], ['path', { d: 'M7.5 15.5v4h9v-4' }]],
  calendar: [['rect', { x: 4, y: 5.5, width: 16, height: 14, rx: 2 }], ['path', { d: 'M4 10h16' }], ['path', { d: 'M8 3.5v3.5M16 3.5v3.5' }]],
  household: [['path', { d: 'M4.5 11 12 5l7.5 6' }], ['path', { d: 'M7 10v8.5h10V10' }], ['path', { d: 'M10 18.5v-4h4v4' }]],
  gift: [['rect', { x: 4.5, y: 10, width: 15, height: 9.5, rx: 1.4 }], ['path', { d: 'M4.5 13.5h15' }], ['path', { d: 'M12 10v9.5' }], ['path', { d: 'M12 10c-3.6 0-4.6-4.8-1.6-5.6C12.4 3.8 12 8 12 10Zm0 0c3.6 0 4.6-4.8 1.6-5.6C11.6 3.8 12 8 12 10Z' }]],
  // A stylized QR code (Settings > "QR check-in" card) — three finder-pattern corner squares
  // plus a couple of loose data-module dots, just enough to read as "QR code" at icon size.
  qrcode: [['rect', { x: 3.5, y: 3.5, width: 6, height: 6, rx: 1, fill: 'none' }], ['rect', { x: 5.5, y: 5.5, width: 2, height: 2, fill: 'currentColor', stroke: 'none' }],
    ['rect', { x: 14.5, y: 3.5, width: 6, height: 6, rx: 1, fill: 'none' }], ['rect', { x: 16.5, y: 5.5, width: 2, height: 2, fill: 'currentColor', stroke: 'none' }],
    ['rect', { x: 3.5, y: 14.5, width: 6, height: 6, rx: 1, fill: 'none' }], ['rect', { x: 5.5, y: 16.5, width: 2, height: 2, fill: 'currentColor', stroke: 'none' }],
    ['rect', { x: 14.5, y: 14.5, width: 2.2, height: 2.2, fill: 'currentColor', stroke: 'none' }], ['rect', { x: 18, y: 14.5, width: 2.2, height: 2.2, fill: 'currentColor', stroke: 'none' }],
    ['rect', { x: 14.5, y: 18, width: 2.2, height: 2.2, fill: 'currentColor', stroke: 'none' }], ['rect', { x: 18, y: 18, width: 2.2, height: 2.2, fill: 'currentColor', stroke: 'none' }]],
  // Top bar notification bell (things needing attention: birthdays today, visitors to
  // follow up, members absent lately, programmes coming up, pledges due soon).
  bell: [['path', { d: 'M7 10a5 5 0 0 1 10 0v4.2l1.6 2.3H5.4L7 14.2z' }], ['path', { d: 'M10.2 19a1.8 1.8 0 0 0 3.6 0' }], ['path', { d: 'M12 4.3v1.8' }]],
  // Password field show/hide toggle (login + registration).
  eye: [['path', { d: 'M2.5 12S6 5 12 5s9.5 7 9.5 7-3.5 7-9.5 7S2.5 12 2.5 12Z' }], ['circle', { cx: 12, cy: 12, r: 3 }]],
  eyeOff: [['path', { d: 'M3.5 3.5l17 17' }], ['path', { d: 'M10.6 5.1A10.9 10.9 0 0 1 12 5c6 0 9.5 7 9.5 7a15.9 15.9 0 0 1-3.1 4M6.3 6.9C3.9 8.6 2.5 12 2.5 12s3.5 7 9.5 7a10 10 0 0 0 3-.45' }], ['path', { d: 'M9.9 10a3 3 0 0 0 4.15 4.1' }]],
  // The small caret on a "Button ▾" dropdown trigger (see ui.js's menu()).
  chevronDown: [['path', { d: 'M6 9.5 12 15l6-5.5' }]],
  // Phone's bottom tab bar "More" tab (main.js's mobile-tabbar) — three solid dots rather than
  // the usual outline shapes, since a row of open circles reads as faint at this size.
  more: [['circle', { cx: 5, cy: 12, r: 1.8, fill: 'currentColor', stroke: 'none' }],
    ['circle', { cx: 12, cy: 12, r: 1.8, fill: 'currentColor', stroke: 'none' }],
    ['circle', { cx: 19, cy: 12, r: 1.8, fill: 'currentColor', stroke: 'none' }]],
};

export function icon(name, { size = 20, cls = '' } = {}) {
  const svg = el('svg', { viewBox: '0 0 24 24', width: size, height: size, class: `icon ${cls}`, 'aria-hidden': 'true', focusable: 'false' });
  for (const [tag, attrs] of SHAPES[name] ?? SHAPES.settings) svg.append(el(tag, { fill: 'none', stroke: 'currentColor', 'stroke-width': 1.7, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', ...attrs }));
  return svg;
}

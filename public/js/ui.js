// Small helpers shared by the pages.
import qrcode from '../vendor/qrcode.js';

export const $ = (sel, root = document) => root.querySelector(sel);

// Build an element: h('li', { class: 'team', style: '--team: red' }, 'text', child)
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  el.append(...children.flat().filter((c) => c != null && c !== false));
  return el;
}

// Black or white text, whichever reads better on this team colour.
export function inkFor(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const lum = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return lum > 0.3 ? '#10131f' : '#ffffff';
}

// A QR code as an SVG element (dark squares on white, with the required quiet border).
export function qrSvg(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const pad = 4;
  let d = '';
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (qr.isDark(y, x)) d += `M${x + pad},${y + pad}h1v1h-1z`;
  const size = n + pad * 2;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', text);
  svg.innerHTML = `<rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="#000"/>`;
  return svg;
}

// The phone address without "http://" and the trailing slash, for reading off the TV.
export const shortUrl = (url) => url.replace(/^https?:\/\//, '').replace(/\/$/, '');

// How long the running timer lasts in total (ms), for drawing the countdown bar.
export function timerTotal(view) {
  const s = view.settings;
  const secs = { armed: s.buzzSeconds, answering: s.answerSeconds, finalQuestion: s.finalSeconds }[view.phase] ?? 0;
  return secs * 1000;
}

// A countdown bar for the current deadline (nothing if there is no timer running).
export function countdown(view) {
  if (view.deadline == null) return null;
  return h('div', { class: 'countdown', 'data-deadline': view.deadline, 'data-total': timerTotal(view), role: 'timer' });
}

// Keeps every countdown bar and [data-seconds] number on the page moving. `now` is the server clock.
export function runCountdowns(now) {
  const tick = () => {
    const t = now();
    for (const el of document.querySelectorAll('[data-deadline]')) {
      const left = Math.max(0, Number(el.dataset.deadline) - t);
      const total = Number(el.dataset.total) || 1;
      el.style.setProperty('--left', Math.min(1, left / total).toFixed(4));
      el.classList.toggle('low', left < 3000);
      if (el.hasAttribute('data-seconds')) el.textContent = String(Math.ceil(left / 1000));
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

export const teamStyle = (team) => `--team: ${team.color}; --team-ink: ${inkFor(team.color)}`;

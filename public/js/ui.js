// Small helpers shared by the pages.
import qrcode from '../vendor/qrcode.js';
import { t } from './i18n.js';

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
  el.append(...children.flat(Infinity).filter((c) => c != null && c !== false));
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
// The short address as text that may wrap before a dot (a long internet address breaks into
// "quiet-river-sample-words" and ".trycloudflare.com" instead of in the middle of a word).
export const urlNodes = (url) => shortUrl(url).split(/(?=\.)/).flatMap((part, i) => (i ? [document.createElement('wbr'), part] : [part]));

// How long the running timer lasts in total (ms), for drawing the countdown bar.
export function timerTotal(view) {
  const s = view.settings;
  if (view.mode === 'quick') return ({ ready: s.quickReadSeconds, open: view.q?.seconds }[view.phase] ?? 0) * 1000;
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

// Like el.replaceChildren(), but skips null/false (which replaceChildren would show as the text "null").
export function fill(el, ...children) {
  el.replaceChildren(...children.flat(Infinity).filter((c) => c != null && c !== false));
}

// The frosted "glass" look (setting `glass`): a class on <body> that style.css reacts to. The host remembers the
// choice in localStorage so the editor, which has no game state, can look the same.
const GLASS_KEY = 'proquiz.glass';
export function setGlass(on, { remember = false } = {}) {
  document.body.classList.toggle('glass', Boolean(on));
  if (remember) {
    try {
      localStorage.setItem(GLASS_KEY, on ? '1' : '0');
    } catch {}
  }
}
export function savedGlass(fallback = true) {
  try {
    const v = localStorage.getItem(GLASS_KEY);
    return v === null ? fallback : v === '1';
  } catch {
    return fallback;
  }
}

// Quick quiz: the answer shapes (SHAPES in lib/quick.js), drawn the same on every screen. Filled with currentColor.
const SHAPE_PATHS = {
  triangle: '<path d="M50 9 95 89H5Z"/>',
  diamond: '<path d="M50 4 94 50 50 96 6 50Z"/>',
  circle: '<circle cx="50" cy="50" r="44"/>',
  square: '<rect x="10" y="10" width="80" height="80" rx="4"/>',
};
export function shapeSvg(shape, cls = 'shape') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 100 100');
  svg.setAttribute('class', cls);
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = SHAPE_PATHS[shape] ?? '';
  return svg;
}

// Quick quiz: the style for answer option n (its colour and the text colour on it).
export const optionStyle = (color) => `--opt: ${color}; --opt-ink: ${inkFor(color)}`;

// ----- branding (brand.js on the server): the host's logo, event name and accent colour -----

// The accent colours offered in the lobby. Violet is ProQuiz's own (no accent saved); each other one has a second
// colour for the warm end of the gradients. A colour picked by hand gets one made from it (customFlare()).
export const ACCENTS = [
  { id: 'violet', color: null, swatch: '#6f55ff', flare: '#ff5fa2' },
  { id: 'blue', color: '#2f6bff', flare: '#2fd0ff' },
  { id: 'teal', color: '#0f9f95', flare: '#6fe3c8' },
  { id: 'green', color: '#1f9d55', flare: '#b5e550' },
  { id: 'orange', color: '#e8630a', flare: '#ffc23d' },
  { id: 'red', color: '#d7263d', flare: '#ff7a59' },
];

const hexRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
function rgbHsl([r, g, b]) {
  [r, g, b] = [r / 255, g / 255, b / 255];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}
function hslRgb([h, s, l]) {
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  return [0, 8, 4].map((n) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1)))));
}
function luminance(rgb) {
  const lin = (c) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const [r, g, b] = rgb.map(lin);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const onWhite = (rgb) => 1.05 / (luminance(rgb) + 0.05); // contrast of white text on this colour
// Darker until white text on it reads well enough (bold display text, as on the gradient pills).
function forWhiteText([h, s, l], min) {
  let rgb = hslRgb([h, s, l]);
  while (onWhite(rgb) < min && l > 0.2) rgb = hslRgb([h, s, (l -= 0.02)]);
  return rgb;
}
const triple = (rgb) => rgb.join(' ');
const hex = (rgb) => '#' + rgb.map((c) => c.toString(16).padStart(2, '0')).join('');

// ProQuiz's own deep and pale tones; with an accent they take its hue (and, for a greyish accent, less colour).
const TONES = {
  '--bg': '#0c0b24',
  '--bg-deep': '#07061a',
  '--ink': '#f6f4ff',
  '--muted': '#a7a2d4',
  '--panel': '#14123a',
  '--pale': '#ece9ff',
  '--primary-ink': '#150f3d',
  '--light-2-rgb': [150, 130, 255],
  '--light-3-rgb': [170, 155, 255],
  '--deep-0-rgb': [7, 6, 26],
  '--deep-1-rgb': [14, 11, 46],
  '--deep-2-rgb': [12, 10, 40],
  '--deep-3-rgb': [24, 20, 68],
  '--deep-4-rgb': [28, 24, 76],
};
const BRAND_VARS = ['--light-rgb', '--flare-rgb', ...Object.keys(TONES)];

// The second colour for an accent picked by hand: a little further round the colour wheel, lighter.
const customFlare = ([h, s]) => hslRgb([(h + 40) % 360, s, 0.64]);

// The CSS variables for an accent colour ('#rrggbb'), or null for ProQuiz's own violet.
export function accentVars(accent) {
  if (!/^#[0-9a-f]{6}$/i.test(accent ?? '')) return null;
  const preset = ACCENTS.find((a) => a.color === accent.toLowerCase());
  const [h, s, l] = rgbHsl(hexRgb(accent));
  const light = forWhiteText([h, s, Math.min(0.62, Math.max(0.42, l))], 3);
  const flare = forWhiteText(rgbHsl(preset ? hexRgb(preset.flare) : customFlare([h, s])), 1.9);
  const vars = { '--light-rgb': triple(light), '--flare-rgb': triple(flare) };
  for (const [name, value] of Object.entries(TONES)) {
    const [, s0, l0] = rgbHsl(Array.isArray(value) ? value : hexRgb(value));
    const rgb = hslRgb([h, s0 * s, l0]);
    vars[name] = Array.isArray(value) ? triple(rgb) : hex(rgb);
  }
  return vars;
}

// The logo as a picture (always an <img>, so an SVG logo can never run anything), or null when there is none.
export function brandLogo(brand, cls = 'brand-logo') {
  if (!brand?.logo) return null;
  return h('img', { class: `${cls}${brand.plate ? ' plate' : ''}`, src: brand.logo, alt: brand.name || 'Logo', draggable: 'false' });
}

// Puts the branding on the page: the accent colours, and the logo in place of every "ProQuiz" wordmark.
export function setBrand(brand) {
  const root = document.documentElement;
  const vars = accentVars(brand?.accent);
  for (const name of BRAND_VARS) {
    if (vars) root.style.setProperty(name, vars[name]);
    else root.style.removeProperty(name);
  }
  document.body.dataset.accent = vars ? brand.accent : '';
  document.body.classList.toggle('has-logo', Boolean(brand?.logo));
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', vars?.['--bg'] ?? TONES['--bg']);
  for (const mark of document.querySelectorAll('.wordmark')) {
    const img = mark.querySelector('img');
    if (!brand?.logo) {
      if (img || mark.textContent !== 'ProQuiz') mark.textContent = 'ProQuiz';
      mark.classList.remove('logo');
      continue;
    }
    mark.classList.add('logo');
    if (img?.getAttribute('src') === brand.logo && img.classList.contains('plate') === Boolean(brand.plate) && img.alt === (brand.name || 'Logo')) continue;
    mark.replaceChildren(brandLogo(brand));
  }
}

// ----- ProQuiz's own pop-up questions, in place of the browser's confirm(), alert() and prompt() -----
//
// A <dialog> opened with showModal(), so the page underneath can't be clicked and Esc means Cancel. One at a time;
// each is built fresh and removed when it closes. Destructive questions (`danger`) get a red button and start with
// Cancel focused, so Enter cancels; the others start on the main button, so Enter says yes.

// True while one of these (or any other modal dialog) is open: the host page's keys wait.
export const modalOpen = () => Boolean(document.querySelector('dialog[open]'));

let modalSeq = 0;
function openModal({ title, text, ok, cancel, danger = false, field = null, onSubmit = () => true }) {
  const id = `pq-modal-${++modalSeq}`;
  const okBtn = h('button', { class: `btn ${danger ? 'btn-bad' : 'btn-primary'}`, type: 'submit', value: 'ok' }, ok ?? t('dlgOk'));
  const cancelBtn = cancel === false ? null : h('button', { class: 'btn', type: 'button', value: 'cancel' }, cancel ?? t('dlgCancel'));
  const form = h(
    'form',
    { method: 'dialog', novalidate: true },
    h('h2', { id: `${id}-title` }, title),
    text ? h('p', { id: `${id}-text`, class: 'pq-modal-text' }, text) : null,
    field,
    h('div', { class: 'pq-modal-actions' }, cancelBtn, okBtn),
  );
  const dialog = h('dialog', { class: `pq-modal${danger ? ' danger' : ''}`, 'aria-labelledby': `${id}-title`, 'aria-describedby': text ? `${id}-text` : false }, form);
  const before = document.activeElement;
  return new Promise((resolve) => {
    cancelBtn?.addEventListener('click', () => dialog.close('cancel'));
    form.addEventListener('submit', (e) => {
      if (onSubmit() === false) e.preventDefault(); // stays open (a bad number)
    });
    dialog.addEventListener('close', () => {
      dialog.remove();
      if (before?.isConnected && typeof before.focus === 'function') before.focus({ preventScroll: true });
      resolve(dialog.returnValue === 'ok');
    });
    document.body.append(dialog);
    dialog.returnValue = '';
    dialog.showModal();
    const first = field?.querySelector('input') ?? (danger ? cancelBtn : okBtn) ?? okBtn;
    first.focus();
    if (first.select) first.select();
  });
}

// Yes or no. Resolves true for the main button, false for Cancel, Esc or closing.
export const ask = ({ title, text, ok, cancel, danger = false }) => openModal({ title, text, ok, cancel, danger });

// Just a message with an OK button.
export const tell = ({ title, text, ok }) => openModal({ title, text, ok, cancel: false }).then(() => undefined);

// A whole number (negative allowed). Resolves the number, or null when cancelled. `preview(n)` can return a line
// shown under the field as the host types (e.g. the new score); `allowZero` false refuses 0 like an empty field.
export async function askNumber({ title, text, value = '', label, ok, cancel, allowZero = false, preview = null }) {
  const input = h('input', { type: 'number', inputmode: 'numeric', step: '1', value: String(value), autocomplete: 'off', 'aria-label': label ?? t('dlgPoints') });
  const flip = h('button', { class: 'btn pq-sign', type: 'button', title: t('dlgFlipSign'), 'aria-label': t('dlgFlipSign') }, '±');
  const error = h('p', { class: 'pq-modal-error', role: 'alert', hidden: true }, t('dlgNumberBad'));
  const note = preview ? h('p', { class: 'pq-modal-preview', 'aria-live': 'polite' }) : null;
  const read = () => {
    const raw = input.value.trim();
    const n = Math.round(Number(raw));
    return raw === '' || !Number.isFinite(n) || (!allowZero && n === 0) ? null : n;
  };
  const update = () => {
    error.hidden = true;
    input.removeAttribute('aria-invalid');
    if (note) note.textContent = read() == null ? '' : preview(read());
  };
  input.addEventListener('input', update);
  flip.addEventListener('click', () => {
    const n = read();
    if (n != null) input.value = String(-n);
    update();
    input.focus();
  });
  const field = h('div', { class: 'pq-modal-field' }, h('label', { class: 'pq-modal-label' }, h('span', {}, label ?? t('dlgPoints')), h('span', { class: 'pq-number' }, flip, input)), note, error);
  update();
  const okd = await openModal({
    title,
    text,
    ok,
    cancel,
    field,
    onSubmit: () => {
      if (read() != null) return true;
      error.hidden = false;
      input.setAttribute('aria-invalid', 'true');
      input.focus();
      return false;
    },
  });
  return okd ? read() : null;
}

// A colour of your own (the branding's accent), in place of the browser's colour picker, which can open outside
// the window. Sliders for colour tone, strength and brightness, and the colour code. `onPreview(hex)` is called as
// it changes. Resolves '#rrggbb', or null when cancelled.
export async function askColor({ title, text, value, ok, cancel, onPreview = () => {} }) {
  let [hue, sat, light] = rgbHsl(hexRgb(/^#[0-9a-f]{6}$/i.test(value ?? '') ? value : '#6f55ff'));
  let typed = null; // a colour code typed in is kept exactly
  const current = () => typed ?? hex(hslRgb([hue, sat, light]));
  const swatch = h('span', { class: 'pq-color-swatch', 'aria-hidden': 'true' });
  const code = h('input', { type: 'text', class: 'pq-color-hex', maxlength: '7', spellcheck: 'false', autocomplete: 'off', 'aria-label': t('dlgColorHex') });
  const field = h('div', { class: 'pq-modal-field pq-color' });
  const sliders = [
    [t('dlgHue'), 'hue', 0, 360, () => hue, (v) => (hue = v)],
    [t('dlgSaturation'), 'sat', 0, 100, () => sat * 100, (v) => (sat = v / 100)],
    [t('dlgLightness'), 'light', 10, 90, () => light * 100, (v) => (light = v / 100)],
  ].map(([label, cls, min, max, get, set]) => {
    const input = h('input', { type: 'range', class: `pq-range ${cls}`, min: String(min), max: String(max), step: '1', 'aria-label': label });
    input.addEventListener('input', () => {
      set(Number(input.value));
      typed = null;
      update(input);
    });
    return { input, get, label };
  });
  function update(from) {
    const c = current();
    swatch.style.background = c;
    field.style.setProperty('--h', String(Math.round(hue)));
    field.style.setProperty('--s', `${Math.round(sat * 100)}%`);
    field.style.setProperty('--l', `${Math.round(light * 100)}%`);
    if (from !== code) code.value = c;
    for (const s of sliders) if (s.input !== from) s.input.value = String(Math.round(s.get()));
    onPreview(c);
  }
  code.addEventListener('input', () => {
    const m = /^#?([0-9a-f]{6})$/i.exec(code.value.trim());
    if (!m) return;
    typed = `#${m[1].toLowerCase()}`;
    [hue, sat, light] = rgbHsl(hexRgb(typed));
    update(code);
  });
  field.append(
    h('div', { class: 'pq-color-top' }, swatch, code),
    ...sliders.map((s) => h('label', { class: 'pq-modal-label pq-color-row' }, h('span', {}, s.label), s.input)),
  );
  update(null);
  const okd = await openModal({ title, text, ok, cancel, field });
  return okd ? current() : null;
}

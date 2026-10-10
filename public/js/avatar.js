// Drawing the avatars (lib/avatar.js has the parts and the rules). Every face is drawn here as a small SVG,
// with flat colours only (no filters, blurs or gradients), so thirty of them on the TV stay cheap.
// avatarSvg() is plain text and works without a page (the tests use it); avatarEl() makes the element.
//
// The picture is 100 × 100: the head in the middle, shoulders at the bottom. The round background is the
// element's own CSS background, and the CSS clips it to a circle.
import { AVATAR_PARTS, isValidAvatar, avatarKey } from '../../lib/avatar.js'; // (relative, so the tests can load this file too)

const LINE = 'rgb(0 0 0 / .28)'; // the soft outline round head, hair and hats, so they read on loud colours
const INK = '#2b1d2a'; // eyes and pupils
const MOUTH = '#5a2232';

// Skin tones, light to deep: [face, shade (neck and ears' inside)].
export const SKINS = [
  ['#ffe2cc', '#f1c3a6'],
  ['#f6c9a1', '#e3a87e'],
  ['#e0a77c', '#c98a60'],
  ['#c4875c', '#a86c45'],
  ['#93603e', '#7a4c2f'],
  ['#5f3c27', '#4b2e1d'],
];
// Hair colours: [hair, darker strands]: black, brown, blonde, red, grey, violet-pink.
export const HAIR_COLORS = [
  ['#2a2230', '#141018'],
  ['#6e4024', '#4f2b15'],
  ['#efc75e', '#c99b33'],
  ['#d2582c', '#a83f1b'],
  ['#c3c3cf', '#9a9aa8'],
  ['#c86de0', '#9d45b8'],
];

const p = (d, fill, extra = '') => `<path d="${d}" fill="${fill}"${extra}/>`;
const outlined = (d, fill) => p(d, fill, ` stroke="${LINE}" stroke-width="2" stroke-linejoin="round"`);
const circle = (cx, cy, r, fill, extra = '') => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}"${extra}/>`;
const line = (d, color, w = 2.6) => `<path d="${d}" fill="none" stroke="${color}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`;
// Several shapes with one outline round all of them: the outlines first, then the fills on top.
const blob = (shapes, fill) => `<g stroke="${LINE}" stroke-width="4" fill="${LINE}">${shapes.join('')}</g><g fill="${fill}">${shapes.join('')}</g>`;

// ----- hair: what goes behind the head, what goes over it, and how high it reaches (for hats) -----

// Each style: { back(c, hat), front(c, hat), top, low }. `c` is [hair, dark]; `hat` is the hat's number, so nothing
// sticks out through a cap or beanie (and a bun or mohawk makes room for a crown or party hat: then `low` is the top).
const under = (hat) => hat === 1 || hat === 2; // a cap or a beanie

export const HAIRS = [
  // 0 bald: just a little shine
  { back: () => '', front: () => '', top: 30 },
  // 1 short, side-swept
  {
    back: () => '',
    front: ([c, d]) =>
      outlined('M28.5 52 C25 33 35 23.5 50 23.5 C64 23.5 75 31 71.5 52 C70 45 68 41 65 38.5 C58 41 47 41.5 38 37 C33 40 30 45 28.5 52 Z', c) +
      line('M46 26.5 C44 30 41 33 38 36', d, 1.6),
    top: 24,
  },
  // 2 curly
  {
    back: () => '',
    front: ([c, d], hat) => {
      const tucked = under(hat);
      const curls = [[30, 46, 6.5], [31.5, 37.5, 7], [37.5, 30.5, 7.5], [46, 26, 7.5], [55, 26, 7.5], [63, 30.5, 7.5], [68.5, 37.5, 7], [70, 46, 6.5], [42, 35, 6], [52, 34, 6], [60, 36, 6]];
      const shown = tucked ? curls.filter(([, y]) => y > 30) : curls;
      return blob(shown.map(([x, y, r]) => circle(x, y, r, 'inherit').replace(' fill="inherit"', '')), c) + line('M40 30 q3 -3 6 0 M53 28 q3 -3 6 0 M33 40 q2 -3 5 -1 M62 40 q3 -2 5 1', d, 1.5);
    },
    top: 18.5,
  },
  // 3 long, with a side parting
  {
    back: ([c]) => outlined('M27 50 C23 28 36 20.5 50 20.5 C64 20.5 77 28 73 50 L76.5 82 C71 86 64 85 61.5 80 L38.5 80 C36 85 29 86 23.5 82 Z', c),
    front: ([c, d]) =>
      outlined('M27.5 56 C25 32 36 23 50 23 C64 23 75 32 72.5 56 C71 46 67 40 62 36.5 C57 42 47 44.5 37 43.5 C32 46 29 50 27.5 56 Z', c) +
      line('M58 25 C60 29 61.5 32.5 62 36.5', d, 1.6),
    top: 21,
  },
  // 4 top bun
  {
    back: ([c, d], hat) => (hat && hat !== 5 ? '' : outlined('M41 22 C41 13 59 13 59 22 C59 28 41 28 41 22 Z', c) + line('M44 19.5 C47 17 53 17 56 19.5', d, 1.5)),
    front: ([c, d]) =>
      outlined('M28.5 50 C26 32 36 24.5 50 24.5 C64 24.5 74 32 71.5 50 C70 43 67 38.5 62 36 C55 38.5 45 38.5 38 36 C33 38.5 30 43 28.5 50 Z', c) +
      line('M42 27 C45 31 49 33 50 36 M58 27 C55 31 51 33 50 36', d, 1.4),
    top: 13,
    low: 24.5,
  },
  // 5 spiky
  {
    back: () => '',
    front: ([c], hat) =>
      under(hat)
        ? outlined('M28.5 50 C26 33 36 25 50 25 C64 25 74 33 71.5 50 C69 44 66 40 62 38 L58 41 L54 37.5 L50 41 L46 37.5 L42 41 L38 38 C34 40 30.5 44 28.5 50 Z', c)
        : outlined('M28.5 50 L26.5 35 L32.5 36.5 L31.5 25.5 L39 30 L42 19 L48.5 27 L55 18.5 L59 28.5 L67 24 L67.5 35.5 L73.5 34 L71.5 50 C69 44 66 40 62 38 L58 41 L54 37.5 L50 41 L46 37.5 L42 41 L38 38 C34 40 30.5 44 28.5 50 Z', c),
    top: 19,
  },
  // 6 bob with a straight fringe
  {
    back: ([c]) => outlined('M26 52 C22.5 28 36 21.5 50 21.5 C64 21.5 77.5 28 74 52 L75.5 69 C71 72.5 66 71.5 64.5 67 L35.5 67 C34 71.5 29 72.5 24.5 69 Z', c),
    front: ([c, d]) =>
      outlined('M28 47 C26.5 31 36.5 24 50 24 C63.5 24 73.5 31 72 47 L71.5 43 C64 41 57 40.5 50 40.5 C43 40.5 36 41 28.5 43 Z', c) +
      line('M40 28 L38.5 40.5 M50 26 L50 40 M60 28 L61.5 40.5', d, 1.3),
    top: 22,
  },
  // 7 mohawk
  {
    back: () => '',
    front: ([c, d], hat) =>
      (hat && hat !== 5 ? '' : outlined('M43.5 38 C41 27 43 17 50 10.5 C57 17 59 27 56.5 38 Z', c) + line('M50 15 L50 34', d, 1.4)) +
      p('M29 48 C28 37 33 31 38 29 L39 33 C35 36 32 41 29 48 Z M71 48 C72 37 67 31 62 29 L61 33 C65 36 68 41 71 48 Z', d, ' opacity=".55"'),
    top: 12,
    low: 28,
  },
];

// ----- eyes (5), mouths (5) -----

const EL = 41; // left eye x
const ER = 59; // right eye x
const EY = 53; // eyes y
const dot = (x) => circle(x, EY, 3.2, INK) + circle(x + 1.1, EY - 1.2, 1, '#fff');
const arc = (x) => line(`M${x - 4} ${EY + 1} Q${x} ${EY - 4.5} ${x + 4} ${EY + 1}`, INK, 2.6);
export const EYES = [
  // dots
  () => dot(EL) + dot(ER),
  // happy arcs
  () => arc(EL) + arc(ER),
  // big round
  () => [EL, ER].map((x) => circle(x, EY, 5, '#fff', ` stroke="${LINE}" stroke-width="1"`) + circle(x + 0.6, EY + 0.6, 3, INK) + circle(x + 1.6, EY - 0.6, 1.1, '#fff')).join(''),
  // wink
  () => dot(EL) + arc(ER),
  // sleepy
  () => [EL, ER].map((x) => p(`M${x - 4} ${EY} A4 3.6 0 0 0 ${x + 4} ${EY} Z`, INK) + line(`M${x - 4.6} ${EY - 0.4} L${x + 4.6} ${EY - 0.4}`, INK, 2)).join(''),
];

const MY = 65; // mouth y
export const MOUTHS = [
  // smile
  () => line(`M43 ${MY - 1.5} Q50 ${MY + 5} 57 ${MY - 1.5}`, MOUTH, 2.6),
  // grin with teeth
  () => p(`M41.5 ${MY - 2.5} Q50 ${MY + 9} 58.5 ${MY - 2.5} Z`, MOUTH) + p(`M43.5 ${MY - 2} L56.5 ${MY - 2} L55.6 ${MY + 0.5} Q50 ${MY + 1.6} 44.4 ${MY + 0.5} Z`, '#fff'),
  // "o"
  () => `<ellipse cx="50" cy="${MY + 0.5}" rx="3.4" ry="4" fill="${MOUTH}"/>` + `<ellipse cx="50" cy="${MY + 2}" rx="2" ry="1.6" fill="#e86b7d"/>`,
  // flat, a little unsure
  () => line(`M45 ${MY} Q50 ${MY + 1.2} 55 ${MY - 0.6}`, MOUTH, 2.6),
  // tongue out
  () => p(`M42 ${MY - 2.5} Q50 ${MY + 7} 58 ${MY - 2.5} Z`, MOUTH) + p(`M46 ${MY + 0.8} Q50 ${MY - 0.6} 54 ${MY + 0.8} L54 ${MY + 4.6} Q50 ${MY + 8.8} 46 ${MY + 4.6} Z`, '#ef6b80') + line(`M50 ${MY + 1} L50 ${MY + 4}`, '#c94a5e', 1.1),
];

// ----- glasses (4: none, round, square, sunglasses) -----

const FRAME = '#2b2140';
export const GLASSES = [
  () => '',
  () => [EL, ER].map((x) => circle(x, EY, 7, 'rgb(255 255 255 / .22)', ` stroke="${FRAME}" stroke-width="2.4"`)).join('') + line(`M${EL + 7} ${EY - 1} Q50 ${EY - 3.5} ${ER - 7} ${EY - 1}`, FRAME, 2.2) + line(`M${EL - 7} ${EY - 1} L29 ${EY - 3}  M${ER + 7} ${EY - 1} L71 ${EY - 3}`, FRAME, 2.2),
  () => [EL, ER].map((x) => `<rect x="${x - 7.5}" y="${EY - 5.5}" width="15" height="11" rx="3" fill="rgb(255 255 255 / .22)" stroke="${FRAME}" stroke-width="2.4"/>`).join('') + line(`M${EL + 7.5} ${EY - 1.5} L${ER - 7.5} ${EY - 1.5}`, FRAME, 2.2) + line(`M${EL - 7.5} ${EY - 2} L29 ${EY - 3}  M${ER + 7.5} ${EY - 2} L71 ${EY - 3}`, FRAME, 2.2),
  () =>
    p(`M${EL - 8.5} ${EY - 5} L${ER + 8.5} ${EY - 5} L${ER + 7.5} ${EY + 2} Q${ER + 6.5} ${EY + 6.5} ${ER} ${EY + 6.5} Q${ER - 6} ${EY + 6.5} ${ER - 7} ${EY + 1} L${ER - 7.5} ${EY - 1} L${EL + 7.5} ${EY - 1} L${EL + 7} ${EY + 1} Q${EL + 6} ${EY + 6.5} ${EL} ${EY + 6.5} Q${EL - 6.5} ${EY + 6.5} ${EL - 7.5} ${EY + 2} Z`, '#1c1726', ` stroke="${LINE}" stroke-width="1"`) +
    line(`M${EL - 4.5} ${EY - 2.5} L${EL - 1} ${EY - 2.5} M${ER - 4.5} ${EY - 2.5} L${ER - 1} ${EY - 2.5}`, 'rgb(255 255 255 / .55)', 1.6) +
    line(`M${EL - 8.5} ${EY - 4} L29 ${EY - 4.5} M${ER + 8.5} ${EY - 4} L71 ${EY - 4.5}`, '#1c1726', 2.2),
];

// ----- hats (6: none, cap, beanie, crown, party hat, headphones). `top` is how high the hair reaches. -----

export const HATS = [
  () => '',
  // cap, peak to the side
  () =>
    outlined('M26.5 44 C25.5 26 37 18.5 50 18.5 C63 18.5 74.5 26 73.5 44 C65 40.5 35 40.5 26.5 44 Z', '#ff5b4f') +
    line('M50 19 L50 41', 'rgb(0 0 0 / .18)', 1.4) +
    outlined('M56 41.5 C66 38 80 38.5 87 43 C84 47 70 47.5 56 46 Z', '#2c2a63') +
    circle(50, 18.8, 2.2, '#2c2a63'),
  // beanie with a pompom
  () =>
    outlined('M27.5 44 C25.5 25 37 16.5 50 16.5 C63 16.5 74.5 25 72.5 44 Z', '#36c2b4') +
    line('M37 22 L37 38 M44 18.5 L44 38 M51 17.5 L51 38 M58 18.5 L58 38 M65 22 L65 38', 'rgb(0 0 0 / .14)', 1.6) +
    outlined('M25.5 39 C36 35.5 64 35.5 74.5 39 L74.5 46.5 C64 43.5 36 43.5 25.5 46.5 Z', '#1f9a8e') +
    circle(50, 13.5, 5.2, '#fff', ` stroke="${LINE}" stroke-width="2"`),
  // crown
  (top) => {
    const b = top + (top < 22 ? 9 : 7); // sits down into tall hair a little
    return (
      outlined(`M33 ${b} L30.5 ${b - 15} L40.5 ${b - 7.5} L50 ${b - 18} L59.5 ${b - 7.5} L69.5 ${b - 15} L67 ${b} Z`, '#ffcb2e') +
      p(`M33 ${b - 3.5} L67 ${b - 3.5} L67 ${b} L33 ${b} Z`, '#e8a514') +
      circle(50, b - 9, 2, '#ff4f7a') + circle(40.5, b - 4.8, 1.4, '#2fb3ff') + circle(59.5, b - 4.8, 1.4, '#2fb3ff') +
      circle(30.5, b - 15, 1.6, '#ffe58a') + circle(50, b - 18, 1.6, '#ffe58a') + circle(69.5, b - 15, 1.6, '#ffe58a')
    );
  },
  // party hat, a little tilted, with two stripes
  (top) => {
    const b = top + (top < 22 ? 10 : 8);
    const [L, T, R] = [[41, b + 1.5], [54, b - 15], [63, b - 1]];
    const at = (from, k) => [from[0] + (T[0] - from[0]) * k, from[1] + (T[1] - from[1]) * k].map((n) => n.toFixed(1)).join(' ');
    const band = (k1, k2) => `M${at(L, k1)} L${at(R, k1)} L${at(R, k2)} L${at(L, k2)} Z`;
    return (
      outlined(`M${L.join(' ')} L${T.join(' ')} L${R.join(' ')} Q53 ${b + 3.5} ${L.join(' ')} Z`, '#ff6fb5') +
      p(band(0.22, 0.38) + band(0.58, 0.72), '#ffd23f') +
      circle(T[0], T[1] - 1, 3.2, '#ffd23f', ` stroke="${LINE}" stroke-width="1.6"`)
    );
  },
  // headphones
  (top) => {
    const t = Math.max(14, top - 3);
    return (
      line(`M25.5 54 C23 ${t + 6} 36 ${t} 50 ${t} C64 ${t} 77 ${t + 6} 74.5 54`, '#2c2a63', 5) +
      line(`M25.5 54 C23 ${t + 6} 36 ${t} 50 ${t} C64 ${t} 77 ${t + 6} 74.5 54`, '#5a57b0', 2) +
      `<rect x="19.5" y="45" width="11" height="19" rx="5" fill="#ff5b4f" stroke="${LINE}" stroke-width="2"/>` +
      `<rect x="69.5" y="45" width="11" height="19" rx="5" fill="#ff5b4f" stroke="${LINE}" stroke-width="2"/>` +
      `<rect x="25.5" y="47.5" width="4" height="14" rx="2" fill="#2c2a63"/><rect x="70.5" y="47.5" width="4" height="14" rx="2" fill="#2c2a63"/>`
    );
  },
];

const SHIRT = ['#2c2a63', '#3a3878']; // the shoulders: deep blue, so they read on every team colour

// The whole avatar as SVG text, or '' for none (or a broken one).
export function avatarSvg(a) {
  if (!isValidAvatar(a)) return '';
  const [skin, shade] = SKINS[a.skin];
  const hc = HAIR_COLORS[a.hairColor];
  const hair = HAIRS[a.hair];
  const parts = [
    // shoulders and neck
    outlined('M13 104 C14 86 30 80.5 50 80.5 C70 80.5 86 86 87 104 Z', SHIRT[0]),
    p('M41 81 Q50 90 59 81 Z', SHIRT[1]),
    p('M43.5 66 L56.5 66 L56.5 81.5 Q50 85.5 43.5 81.5 Z', shade),
    hair.back(hc, a.hat),
    // ears and head
    circle(29, 55.5, 5.6, skin, ` stroke="${LINE}" stroke-width="2"`),
    circle(71, 55.5, 5.6, skin, ` stroke="${LINE}" stroke-width="2"`),
    circle(29.5, 55.5, 2.4, shade),
    circle(70.5, 55.5, 2.4, shade),
    outlined('M50 29 C62.5 29 71 37 71 52 C71 66.5 62 76 50 76 C38 76 29 66.5 29 52 C29 37 37.5 29 50 29 Z', skin),
    `<ellipse cx="40" cy="36.5" rx="6" ry="3.2" fill="#fff" opacity=".18" transform="rotate(-20 40 36.5)"/>`,
    circle(35.5, 61.5, 3.6, '#ff7d8e', ' opacity=".32"'),
    circle(64.5, 61.5, 3.6, '#ff7d8e', ' opacity=".32"'),
    EYES[a.eyes](),
    MOUTHS[a.mouth](),
    hair.front(hc, a.hat),
    GLASSES[a.glasses](),
    HATS[a.hat](a.hat && a.hat !== 5 ? hair.low ?? hair.top : hair.top),
  ];
  // A little bigger than drawn, so the face fills the circle and still reads when small.
  return `<svg viewBox="0 0 100 100" class="avatar-svg" aria-hidden="true" focusable="false"><g transform="matrix(1.12 0 0 1.12 -6 -6.5)">${parts.join('')}</g></svg>`;
}

// ----- in the page -----

const cache = new Map(); // avatarKey → SVG text

export function avatarHtml(a) {
  const key = avatarKey(a);
  if (!key) return '';
  if (!cache.has(key)) cache.set(key, avatarSvg(a));
  return cache.get(key);
}

// A <span class="avatar"> with the face in it, or null without an avatar (so it simply drops out of h()).
// Its size comes from the CSS (1em by default, so it follows the text it sits in).
export function avatarEl(a, cls = '') {
  if (typeof document === 'undefined') return null;
  const svg = avatarHtml(a);
  if (!svg) return null;
  const el = document.createElement('span');
  el.className = cls ? `avatar ${cls}` : 'avatar';
  el.innerHTML = svg;
  return el;
}

// The number of options each part has here must match lib/avatar.js (a test checks it).
export const DRAWN = { skin: SKINS.length, hair: HAIRS.length, hairColor: HAIR_COLORS.length, eyes: EYES.length, mouth: MOUTHS.length, glasses: GLASSES.length, hat: HATS.length };
export { AVATAR_PARTS };

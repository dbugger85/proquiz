// The branding rules shared by the laptop (brand.js, on disk), the hub (the website keeps the brand in memory) and
// the website's browser store: the logo's size and name, the event name's length, and `cleanBrand()`. No Node
// modules, so the browser and the Worker can load this too.

export const MAX_LOGO = 2 * 1024 * 1024; // the logo file: 2 MB
export const MAX_BRAND_NAME = 60;
export const LOGO_FILE = /^logo-[0-9a-f]{16}\.(png|jpg|webp|svg)$/;
export const ACCENT = /^#[0-9a-f]{6}$/;
export const NO_BRAND = { name: '', accent: null, plate: false, logo: null };

// Settings as they may be saved: unknown fields dropped, the name tidied, a bad colour means the default. The logo
// is kept from `base` (it changes through its own calls); `cleanLogo()` checks a logo name.
export function cleanBrand(input = {}, base = NO_BRAND) {
  const out = { ...base };
  if (!input || typeof input !== 'object') return out;
  if ('name' in input) out.name = String(input.name ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_BRAND_NAME);
  if ('accent' in input) {
    const a = String(input.accent ?? '').toLowerCase();
    out.accent = ACCENT.test(a) ? a : null;
  }
  if ('plate' in input) out.plate = input.plate === true;
  return out;
}

// A logo's file name as it may be kept (`logo-<16 hex>.<png|jpg|webp|svg>`), or null.
export const cleanLogo = (name) => (typeof name === 'string' && LOGO_FILE.test(name) ? name : null);

// Nothing set at all (no logo, no name, ProQuiz's own colour): the screens then look exactly as without branding.
export const isNoBrand = (b) => !b || (!b.name && !b.accent && !b.logo);

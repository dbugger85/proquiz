// Your own branding: a logo, an event name and an accent colour, shown on the TV, the phones and the host laptop.
// It belongs to the person running ProQuiz, not to a quiz, so it lives in the data folder and is never part of a
// quiz export:
//
//   <data dir>/brand/brand.json          { v: 1, name, accent, plate, logo }
//   <data dir>/brand/logo-<hash>.<ext>   the logo (PNG, JPG, WebP or SVG, at most 2 MB), named after its content
//
// The logo is served to everyone (phones and TV pages over the internet too) at /brand/<file>, and only ever shown
// with <img>, so an SVG's scripts never run. It is also served with a Content-Security-Policy that blocks them if
// someone opens the address directly. Changing anything goes through /api/brand (the laptop only).

import { readFile, writeFile, mkdir, rename, unlink, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

export const MAX_LOGO = 2 * 1024 * 1024;
export const MAX_BRAND_NAME = 60;
export const LOGO_FILE = /^logo-[0-9a-f]{16}\.(png|jpg|webp|svg)$/;
const LOGO_TYPES = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', svg: 'image/svg+xml' };
const ACCENT = /^#[0-9a-f]{6}$/;
export const NO_BRAND = { name: '', accent: null, plate: false, logo: null };

// Headers for the logo. The CSP and `nosniff` matter for SVG: opened directly, it can't run scripts or load anything.
export function logoHeaders(file) {
  return {
    'Content-Type': LOGO_TYPES[file.slice(file.lastIndexOf('.') + 1)],
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox",
    'Cache-Control': 'max-age=31536000, immutable', // the name changes with the content
  };
}

// What kind of picture these bytes really are (the file name's extension alone isn't trusted).
export function logoKind(bytes) {
  const b = bytes;
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  // SVG is text: an optional BOM, XML declaration, comments and doctype, then an <svg> element.
  const head = b.toString('utf8', 0, Math.min(b.length, 4096)).replace(/^﻿/, '');
  const rest = head.replace(/^\s*(<\?xml[^>]*\?>\s*)?((<!--[\s\S]*?-->|<!DOCTYPE[^>]*>)\s*)*/i, '');
  if (/^<svg[\s>]/i.test(rest)) return 'svg';
  return null;
}

// Settings as they may be saved: unknown fields dropped, the name tidied, a bad colour means the default.
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

export function createBrand(dataDir) {
  const dir = path.join(dataDir, 'brand');
  const file = path.join(dir, 'brand.json');
  let brand = { ...NO_BRAND };

  async function load() {
    try {
      const saved = JSON.parse(await readFile(file, 'utf8'));
      brand = cleanBrand(saved);
      brand.logo = typeof saved.logo === 'string' && LOGO_FILE.test(saved.logo) ? saved.logo : null;
    } catch {
      brand = { ...NO_BRAND };
    }
    return brand;
  }

  async function write() {
    await mkdir(dir, { recursive: true });
    await writeFile(file + '.tmp', JSON.stringify({ v: 1, ...brand }, null, 2));
    await rename(file + '.tmp', file);
  }

  // Old logo files (after a new one or "Remove logo"), so the folder holds at most the one in use.
  async function tidy() {
    let names = [];
    try {
      names = await readdir(dir);
    } catch {}
    for (const n of names) if (LOGO_FILE.test(n) && n !== brand.logo) await unlink(path.join(dir, n)).catch(() => {});
  }

  return {
    load,
    get: () => ({ ...brand }),
    // What every screen gets in its state message.
    view: () => ({ name: brand.name, accent: brand.accent, plate: brand.plate, logo: brand.logo ? `/brand/${brand.logo}` : null }),
    async update(input) {
      brand = { ...cleanBrand(input, brand), logo: brand.logo };
      await write();
      return brand;
    },
    async setLogo(bytes) {
      if (bytes.length > MAX_LOGO) throw httpError(413, 'logo-too-big');
      const kind = logoKind(bytes);
      if (!kind) throw httpError(400, 'logo-bad-type');
      brand.logo = `logo-${createHash('sha256').update(bytes).digest('hex').slice(0, 16)}.${kind}`;
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, brand.logo), bytes);
      await write();
      await tidy();
      return brand;
    },
    async removeLogo() {
      brand.logo = null;
      await write();
      await tidy();
      return brand;
    },
    async readLogo(name) {
      if (!LOGO_FILE.test(name)) return null;
      try {
        return await readFile(path.join(dir, name));
      } catch {
        return null;
      }
    },
  };
}

function httpError(status, code) {
  return Object.assign(new Error(code), { status, code });
}

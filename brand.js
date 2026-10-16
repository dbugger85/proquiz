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
import { logoHeaders, logoKind } from './lib/mime.js';
import { MAX_LOGO, MAX_BRAND_NAME, LOGO_FILE, NO_BRAND, cleanBrand } from './lib/brand-core.js';

export { logoHeaders }; // the logo's headers live in lib/mime.js (shared with the website version)
// The rules (the logo's size and name, the name's length, cleanBrand()) live in lib/brand-core.js, shared with the
// hub and the website's browser store.
export { MAX_LOGO, MAX_BRAND_NAME, LOGO_FILE, NO_BRAND, cleanBrand };

// What kind of picture these bytes really are (`logoKind` in lib/mime.js, shared with the picture search and the website).
export { logoKind };

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

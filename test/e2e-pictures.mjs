// Browser test for "Find a free picture" in the editor: searching Openverse and Wikimedia Commons (both pretend:
// the server gets a fake `fetchImpl`, so nothing here goes on the internet), the licence and source pills (and that
// they are remembered), Show more, the preview, Back, choosing a picture, its credit in the dialog and the quiz,
// no internet and too many searches, a phone-width window, glass on and off; then the TV's small credit line, only
// once the answer is shown, on a board and in a Quick quiz.
//
// Screenshots: test/screenshots/editor-pic-*.png, tv-picture-credit*.png, host-picture-credit.png, quick-tv-picture-credit.png

import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { startServer } from '../server.js';
import { COLORS } from '../lib/game.js';

const shots = fileURLToPath(new URL('./screenshots', import.meta.url));
mkdirSync(shots, { recursive: true });
const dataDir = mkdtempSync(join(tmpdir(), 'proquiz-pictures-e2e-'));
const filesDir = join(dataDir, 'files');
mkdirSync(filesDir, { recursive: true });

// ----- a pretend internet -----
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const OPENVERSE = [
  ['Eiffel Tower at dusk', 'Ann Lee', 'by', '2.0'],
  ['Tour Eiffel from the Trocadéro gardens on a summer evening, seen across the fountains', 'johntrainor', 'by-sa', '2.0'],
  ['Paris skyline', 'Nasjonalbiblioteket from Norway', 'cc0', '1.0'],
  ['Iron lattice', 'Musée d’Orsay', 'pdm', ''],
  ['Champ de Mars', 'Kari Nordmann', 'by', '4.0'],
  ['Night lights', 'Ole Hansen', 'by-sa', '4.0'],
  ['Seine bridge', 'Smithsonian Institution', 'cc0', '1.0'],
  ['The tower in fog', 'M. Dupont', 'by', '3.0'],
  ['Postcard 1900', 'Library of Congress', 'pdm', ''],
  ['Sunset view', 'Ingrid B.', 'by', '2.0'],
  ['From below', 'photo_fan_88', 'by-sa', '3.0'],
  ['Winter morning', 'Erik', 'by', '2.0'],
  ['Montmartre steps', 'Lena', 'cc0', '1.0'],
  ['Arc de Triomphe', 'P. Martin', 'by', '2.0'],
  ['Louvre courtyard', 'Anna K.', 'by-sa', '4.0'],
  ['Café terrace', 'Jonas', 'by', '2.0'],
  ['Rooftops', 'Sofie', 'cc0', '1.0'],
  ['Metro sign', 'Thomas', 'by', '2.0'],
].map(([title, creator, license, license_version], i) => ({ n: i + 1, title, creator, license, license_version }));
const NONCOMMERCIAL = [
  ['Eiffel Tower, holiday snap', 'Hans', 'by-nc', '2.0'],
  ['Tower and carousel', 'Mia', 'by-nc-sa', '4.0'],
].map(([title, creator, license, license_version], i) => ({ n: 19 + i, title, creator, license, license_version }));
const FLAGS = ['Flag of Norway', 'Flag of France', 'Flag of Japan', 'Flag of Sweden', 'Flag of Italy', 'Flag of Denmark'];

const ovItem = (it) => ({
  id: uuid(it.n),
  title: it.title,
  creator: it.creator,
  license: it.license,
  license_version: it.license_version,
  license_url: `https://creativecommons.org/licenses/${it.license}/${it.license_version || '1.0'}/`,
  foreign_landing_url: `https://www.flickr.com/photos/test/${it.n}`,
  url: `https://live.staticflickr.com/test/${it.n}.jpg`,
  // One thumbnail is "gone" (the thumbnail service said no): the editor falls back to the original.
  thumbnail: it.n === 3 ? '/files/missing-thumb.png' : `/files/thumb-${((it.n - 1) % 14) + 1}.png`,
  provider: it.n % 5 === 0 ? 'smithsonian' : 'flickr',
  width: 1600,
  height: 1200,
  mature: false,
});
const net = { mode: 'ok', calls: [] };
const jsonRes = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });
async function fakeFetch(address) {
  const url = new URL(address);
  net.calls.push(url.href);
  if (net.mode === 'offline') throw new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }) });
  if (net.mode === 'busy') return jsonRes({ detail: 'slow down' }, 429, { 'retry-after': '60' });
  const p = url.searchParams;
  if (url.host === 'api.openverse.org' && url.pathname === '/v1/images/') {
    const all = p.get('license').includes('nc') ? [...NONCOMMERCIAL, ...OPENVERSE] : OPENVERSE;
    const page = Number(p.get('page'));
    const per = 12;
    return jsonRes({ result_count: all.length, page_count: Math.ceil(all.length / per), page_size: per, page, results: all.slice((page - 1) * per, page * per).map(ovItem) });
  }
  const detail = url.pathname.match(/^\/v1\/images\/([0-9a-f-]{36})\/$/);
  if (url.host === 'api.openverse.org' && detail) {
    const it = [...OPENVERSE, ...NONCOMMERCIAL].find((x) => uuid(x.n) === detail[1]);
    return jsonRes(ovItem(it));
  }
  if (url.host === 'live.staticflickr.com') {
    const n = Number(url.pathname.match(/(\d+)\.jpg$/)[1]);
    return new Response(readFileSync(join(filesDir, `thumb-${((n - 1) % 14) + 1}.png`)));
  }
  if (url.host === 'commons.wikimedia.org') {
    const meta = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { value: v }]));
    const page = (name, i) => ({
      title: `File:${name}.svg`,
      index: i + 1,
      imageinfo: [
        {
          mime: 'image/svg+xml',
          width: 1100,
          height: 800,
          thumburl: p.get('titles') ? `https://upload.wikimedia.org/render/flag-${i + 1}.png` : `/files/flag-${i + 1}.png`,
          url: `https://upload.wikimedia.org/${name}.svg`,
          descriptionurl: `https://commons.wikimedia.org/wiki/File:${name.replace(/ /g, '_')}.svg`,
          extmetadata: meta({ ObjectName: name, Artist: '<a href="//commons.wikimedia.org/wiki/User:Flagmaker">Flagmaker</a>', LicenseShortName: 'Public domain' }),
        },
      ],
    });
    if (p.get('titles')) {
      const name = p.get('titles').replace(/^File:|\.svg$/g, '');
      return jsonRes({ query: { pages: [page(name, FLAGS.indexOf(name))] } });
    }
    return jsonRes({ query: { pages: FLAGS.map(page) } });
  }
  if (url.host === 'upload.wikimedia.org') return new Response(readFileSync(join(filesDir, `flag-${url.pathname.match(/flag-(\d)/)[1]}.png`)));
  throw new Error(`no pretend answer for ${address}`);
}

const srv = await startServer({ port: 3496, quiet: true, dataDir, pictureOptions: { fetchImpl: fakeFetch } });
const base = `http://127.0.0.1:${srv.info.port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/usr/bin/chromium' });
const errors = [];
const state = () => srv.hub.getState();

async function shot(page, name) {
  const text = await page.evaluate(() => document.body.innerText);
  const bad = text.match(/[^\n]*(\b((?<!under )null|undefined|NaN)\b|\[object \w+\])[^\n]*/);
  assert.equal(bad, null, `${name} shows a broken value: ${JSON.stringify(bad?.[0])}`);
  await page.screenshot({ path: `${shots}/${name}.png` });
}
const watch = (page, label) => {
  page.on('pageerror', (e) => errors.push(`${label}: ${e.message}`));
  // Expected: the "gone" thumbnail (404), and the pretend no-internet / too-many answers (503, 429).
  page.on('console', (m) => m.type() === 'error' && !/status of (4\d\d|503)/.test(m.text()) && errors.push(`${label}: ${m.text()}`));
  page.on('dialog', (d) => {
    errors.push(`${label}: a browser ${d.type()} appeared`);
    d.dismiss().catch(() => {});
  });
};
// Every thumbnail in view has loaded (none broken; the ones further down load lazily when scrolled to).
const thumbsLoaded = (page) =>
  page.waitForFunction(() => {
    const imgs = [...document.querySelectorAll('#pic-dialog .pic-thumb img, #pic-dialog .pic-preview-img img')].filter((im) => {
      const r = im.getBoundingClientRect();
      return r.bottom > 0 && r.top < innerHeight && r.height > 0;
    });
    return imgs.length > 0 && imgs.every((im) => im.complete && im.naturalWidth > 0);
  });
// The browser never goes on the internet in this test: an original that stands in for a missing thumbnail is
// answered here, and anything else from outside is refused (and counted as an error).
async function offlineContext(options) {
  const ctx = await browser.newContext(options);
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1[:/])/, (route) => {
    const url = route.request().url();
    const n = url.match(/^https:\/\/live\.staticflickr\.com\/test\/(\d+)\.jpg$/)?.[1];
    if (n) return route.fulfill({ path: join(filesDir, `thumb-${((n - 1) % 14) + 1}.png`), contentType: 'image/png' });
    errors.push(`the browser tried to load ${url}`);
    return route.abort();
  });
  return ctx;
}
const tiles = (page) => page.locator('#pic-dialog .pic-tile');
const pickPill = (page, name, value) => page.click(`#pic-dialog label:has(> input[name=${name}][value=${value}])`);
const searches = () => net.calls.filter((c) => /v1\/images\/\?|generator=search/.test(c));

try {
  // Pretend pictures: landscapes with a tower, and a few flags, drawn here in the browser.
  {
    const maker = await browser.newPage();
    const made = await maker.evaluate(() => {
      const out = {};
      const scene = (n) => {
        const c = document.createElement('canvas');
        c.width = 640;
        c.height = 480;
        const g = c.getContext('2d');
        const hue = (n * 37 + 190) % 360;
        const sky = g.createLinearGradient(0, 0, 0, 480);
        sky.addColorStop(0, `hsl(${hue} 65% 72%)`);
        sky.addColorStop(1, `hsl(${(hue + 40) % 360} 70% 42%)`);
        g.fillStyle = sky;
        g.fillRect(0, 0, 640, 480);
        g.fillStyle = `hsl(${(hue + 180) % 360} 90% 85% / 0.9)`;
        g.beginPath();
        g.arc(120 + ((n * 83) % 400), 110 + ((n * 29) % 60), 46, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = `hsl(${(hue + 60) % 360} 35% 22%)`;
        g.beginPath();
        g.moveTo(0, 480);
        for (let x = 0; x <= 640; x += 40) g.lineTo(x, 360 + Math.sin((x + n * 50) / 70) * 30);
        g.lineTo(640, 480);
        g.fill();
        // The tower: a lattice triangle.
        const cx = 260 + ((n * 61) % 160);
        g.strokeStyle = `hsl(${(hue + 30) % 360} 30% 15%)`;
        g.lineWidth = 6;
        g.beginPath();
        g.moveTo(cx - 70, 420);
        g.lineTo(cx, 70);
        g.lineTo(cx + 70, 420);
        g.moveTo(cx - 48, 300);
        g.lineTo(cx + 48, 300);
        g.moveTo(cx - 26, 190);
        g.lineTo(cx + 26, 190);
        g.stroke();
        return c.toDataURL('image/png');
      };
      const flag = (n) => {
        const c = document.createElement('canvas');
        c.width = 660;
        c.height = 480;
        const g = c.getContext('2d');
        const k = [
          ['#ba0c2f', '#fff', '#00205b', 'cross'],
          ['#0055a4', '#fff', '#ef4135', 'v3'],
          ['#fff', '#bc002d', '', 'disc'],
          ['#006aa7', '#fecc02', '', 'cross1'],
          ['#009246', '#fff', '#ce2b37', 'v3'],
          ['#c8102e', '#fff', '', 'cross1'],
        ][n - 1];
        g.fillStyle = k[0];
        g.fillRect(0, 0, 660, 480);
        if (k[3] === 'v3') {
          g.fillStyle = k[1];
          g.fillRect(220, 0, 220, 480);
          g.fillStyle = k[2];
          g.fillRect(440, 0, 220, 480);
        } else if (k[3] === 'disc') {
          g.fillStyle = k[1];
          g.beginPath();
          g.arc(330, 240, 140, 0, Math.PI * 2);
          g.fill();
        } else {
          g.fillStyle = k[1];
          g.fillRect(180, 0, 120, 480);
          g.fillRect(0, 180, 660, 120);
          if (k[3] === 'cross') {
            g.fillStyle = k[2];
            g.fillRect(210, 0, 60, 480);
            g.fillRect(0, 210, 660, 60);
          }
        }
        return c.toDataURL('image/png');
      };
      for (let n = 1; n <= 14; n++) out[`thumb-${n}.png`] = scene(n);
      for (let n = 1; n <= 6; n++) out[`flag-${n}.png`] = flag(n);
      return out;
    });
    for (const [name, url] of Object.entries(made)) writeFileSync(join(filesDir, name), Buffer.from(url.split(',')[1], 'base64'));
    await maker.close();
  }

  // ----- the editor, on a laptop-sized window -----
  const ctx = await offlineContext({ viewport: { width: 1280, height: 860 } });
  const ed = await ctx.newPage();
  watch(ed, 'editor');
  await ed.goto(`${base}/editor`);
  await ed.click('#new-quiz');
  await ed.waitForSelector('.ed-name input:not([disabled])');
  await ed.fill('.ed-name input', 'Byer');
  await ed.fill('.ed-col:nth-child(1) .ed-cat input', 'Landmarks');
  await ed.click('.ed-col:nth-child(1) .ed-tile:nth-of-type(1)');
  await ed.waitForSelector('#q-dialog[open]');
  await ed.fill('#q-form textarea', 'Which city has this tower?');
  await ed.fill('#q-form .field:nth-of-type(3) input', 'Paris');
  const findButtons = ed.locator('#q-form .ed-pic-search');
  assert.equal(await findButtons.count(), 2, 'a Find button for the question picture and the answer picture (not for the clip)');

  // Opening it: the question's words to start from, Openverse and "Free for any use" the first time.
  await findButtons.nth(0).click();
  await ed.waitForSelector('#pic-dialog[open]');
  assert.equal(await ed.inputValue('#pic-query'), 'Which city has this tower');
  assert.ok(await ed.isChecked('input[name=picSource][value=openverse]'));
  assert.ok(await ed.isChecked('input[name=picLicense][value=any]'));
  assert.equal(await ed.evaluate(() => document.activeElement?.id), 'pic-query');
  await shot(ed, 'editor-pic-1-empty');

  // Search (Enter in the field): a grid of thumbnails, each with its licence, and Show more.
  await ed.fill('#pic-query', 'eiffel tower');
  await ed.press('#pic-query', 'Enter');
  await ed.waitForSelector('#pic-dialog[open] .pic-tile');
  assert.equal(await tiles(ed).count(), 12);
  assert.ok(await ed.isVisible('#pic-dialog[open]'), 'Enter searched instead of closing the dialog');
  const first = new URL(searches().at(-1));
  assert.equal(first.searchParams.get('q'), 'eiffel tower');
  assert.equal(first.searchParams.get('license'), 'cc0,pdm,by,by-sa');
  await thumbsLoaded(ed); // the "gone" thumbnail fell back to the original
  const badges = await ed.locator('#pic-dialog .pic-tile .pic-badge').allTextContents();
  assert.deepEqual(badges.slice(0, 4), ['CC BY 2.0', 'CC BY-SA 2.0', 'CC0', 'Public domain']);
  assert.match(await ed.textContent('#pic-dialog .pic-tile:nth-child(3) .pic-cap'), /Nasjonalbiblioteket/);
  assert.ok(await ed.isVisible('#pic-dialog .pic-more'));
  await shot(ed, 'editor-pic-2-results');
  await ed.click('#pic-dialog .pic-more');
  await ed.waitForFunction(() => document.querySelectorAll('#pic-dialog .pic-tile').length === 18);
  assert.ok(await ed.isHidden('#pic-dialog .pic-more'), 'no more after the last page');

  // "Also non-commercial": searched again, those pictures marked, the choice remembered.
  await pickPill(ed, 'picLicense', 'nc');
  await ed.waitForFunction(() => document.querySelectorAll('#pic-dialog .pic-badge.nc').length > 0);
  assert.equal(new URL(searches().at(-1)).searchParams.get('license'), 'cc0,pdm,by,by-sa,by-nc,by-nc-sa');
  assert.match(await ed.textContent('#pic-dialog .pic-license-hint'), /non-commercial/);
  assert.equal(await ed.evaluate(() => localStorage.getItem('proquiz.picLicense')), 'nc');
  await thumbsLoaded(ed);
  await shot(ed, 'editor-pic-2b-noncommercial');
  // A non-commercial picture's preview says so.
  await ed.click('#pic-dialog .pic-tile:has(.pic-badge.nc)');
  await ed.waitForSelector('#pic-dialog .pic-preview');
  assert.match(await ed.textContent('#pic-dialog .pic-nc-note'), /Only for non-commercial use/);
  await ed.click('#pic-dialog .pic-back');
  await pickPill(ed, 'picLicense', 'any');
  await ed.waitForFunction(() => document.querySelectorAll('#pic-dialog .pic-tile').length === 12 && !document.querySelector('#pic-dialog .pic-badge.nc'));

  // Wikimedia Commons: other results, and the note instead of the licence choice.
  await pickPill(ed, 'picSource', 'wikimedia');
  await ed.waitForFunction(() => document.querySelector('#pic-dialog .pic-tile .pic-cap')?.textContent === 'Flagmaker');
  assert.equal(await tiles(ed).count(), 6);
  assert.ok(await ed.isVisible('#pic-dialog .pic-wiki-note'));
  assert.equal(await ed.locator('#pic-dialog input[name=picLicense]').count(), 0);
  assert.match(new URL(searches().at(-1)).searchParams.get('gsrsearch'), /eiffel tower/);
  await thumbsLoaded(ed);
  await shot(ed, 'editor-pic-2c-wikimedia');
  await pickPill(ed, 'picSource', 'openverse');
  await ed.waitForFunction(() => document.querySelectorAll('#pic-dialog .pic-tile').length === 12);
  await thumbsLoaded(ed);

  // The preview, Back (to the same results, nothing asked again), then use it.
  const asked = searches().length;
  await tiles(ed).nth(1).click();
  await ed.waitForSelector('#pic-dialog .pic-preview');
  await thumbsLoaded(ed);
  const preview = await ed.textContent('#pic-dialog .pic-preview');
  assert.match(preview, /Tour Eiffel from the Trocadéro/);
  assert.match(preview, /By johntrainor/);
  assert.match(preview, /CC BY-SA 2\.0/);
  assert.match(preview, /About this licence/);
  assert.match(preview, /1600 × 1200 pixels · via Flickr/);
  assert.match(preview, /Open on Openverse/);
  assert.equal(await ed.getAttribute('#pic-dialog .pic-license-line a', 'rel'), 'noopener noreferrer');
  assert.equal(await ed.getAttribute('#pic-dialog .pic-preview-img img', 'referrerpolicy'), 'no-referrer');
  await shot(ed, 'editor-pic-3-preview');
  await ed.click('#pic-dialog .pic-back');
  await ed.waitForSelector('#pic-dialog .pic-grid');
  assert.equal(await tiles(ed).count(), 12);
  assert.equal(searches().length, asked);
  await tiles(ed).nth(0).click();
  await ed.click('#pic-dialog .pic-use');
  await ed.waitForSelector('#pic-dialog:not([open])', { state: 'attached' });
  assert.ok(await ed.isVisible('#q-dialog[open]'), 'the question dialog is still open');
  await ed.waitForSelector('#q-form .ed-media .ed-credit');
  const src = await ed.getAttribute('#q-form .ed-media img', 'src');
  const name = decodeURIComponent(src.replace('/files/', ''));
  assert.match(name, /^[0-9a-f]{16}\.png$/);
  assert.equal(await ed.textContent('#q-form .ed-credit'), 'Picture: Ann Lee · CC BY 2.0 · Openverse');
  assert.equal(await ed.getAttribute('#q-form .ed-credit a', 'href'), 'https://www.flickr.com/photos/test/1');
  await ed.waitForFunction(() => document.querySelector('#q-form .ed-media img')?.naturalWidth > 0);
  await shot(ed, 'editor-pic-4-chosen');

  // Saved with the quiz, listed under it, and in the export.
  await ed.click('#q-form button[value=done]');
  await ed.waitForSelector('#q-dialog:not([open])', { state: 'attached' });
  await ed.waitForFunction(() => document.querySelector('#ed-status').textContent === 'Saved');
  const list = await (await fetch(`${base}/api/sets`)).json();
  const quizId = list.find((x) => x.title === 'Byer').id;
  const saved = (await (await fetch(`${base}/api/sets/${quizId}`)).json()).set;
  assert.equal(saved.categories[0].questions[0].image, name);
  assert.deepEqual(saved.credits[name], {
    title: 'Eiffel Tower at dusk',
    author: 'Ann Lee',
    license: 'CC BY 2.0',
    licenseUrl: 'https://creativecommons.org/licenses/by/2.0/',
    source: 'openverse',
    sourceUrl: 'https://www.flickr.com/photos/test/1',
  });
  const pkg = await (await fetch(`${base}/api/export/${quizId}`)).json();
  assert.equal(pkg.set.credits[name].author, 'Ann Lee');
  assert.ok(pkg.files[name]);
  await ed.click('.ed-credits summary');
  assert.match(await ed.textContent('.ed-credits'), /Picture credits \(1\)[\s\S]*Eiffel Tower at dusk[\s\S]*Ann Lee/);
  await ed.locator('.ed-credits').scrollIntoViewIfNeeded();
  await shot(ed, 'editor-pic-4b-credits');

  // No internet, and too many searches: said plainly. The source and licence are remembered from last time.
  await ed.click('.ed-col:nth-child(1) .ed-tile:nth-of-type(1)');
  await ed.waitForSelector('#q-dialog[open]');
  await ed.locator('#q-form .ed-pic-search').nth(1).click(); // the answer picture: starts from the answer
  await ed.waitForSelector('#pic-dialog[open]');
  assert.equal(await ed.inputValue('#pic-query'), 'Paris');
  assert.ok(await ed.isChecked('input[name=picSource][value=openverse]'));
  net.mode = 'offline';
  await ed.click('#pic-dialog .pic-go');
  await ed.waitForFunction(() => /No internet/.test(document.querySelector('#pic-dialog .pic-status').textContent));
  assert.equal(await ed.getAttribute('#pic-dialog .pic-status', 'role'), 'alert');
  await shot(ed, 'editor-pic-5-offline');
  net.mode = 'busy';
  await ed.click('#pic-dialog .pic-go');
  await ed.waitForFunction(() => /Too many searches/.test(document.querySelector('#pic-dialog .pic-status').textContent));
  // The browser itself knows it's offline: said without asking the server.
  net.mode = 'ok';
  const before = net.calls.length;
  await ctx.setOffline(true);
  await ed.click('#pic-dialog .pic-go');
  await ed.waitForFunction(() => /No internet/.test(document.querySelector('#pic-dialog .pic-status').textContent));
  await ctx.setOffline(false);
  assert.equal(net.calls.length, before);
  // A picture that can't be added: the preview says why and stays open.
  await ed.click('#pic-dialog .pic-go');
  await ed.waitForSelector('#pic-dialog .pic-tile');
  await tiles(ed).nth(4).click();
  net.mode = 'busy';
  await ed.click('#pic-dialog .pic-use');
  await ed.waitForFunction(() => /Too many searches/.test(document.querySelector('#pic-dialog .pic-use-status').textContent));
  assert.ok(await ed.isEnabled('#pic-dialog .pic-use'));
  net.mode = 'ok';
  await ed.keyboard.press('Escape'); // closes only the picture search
  await ed.waitForSelector('#pic-dialog:not([open])', { state: 'attached' });
  assert.ok(await ed.isVisible('#q-dialog[open]'));
  await ed.click('#q-form button[value=done]');

  // Glass off: the same dialog in the plain look.
  await ed.evaluate(() => localStorage.setItem('proquiz.glass', '0'));
  await ed.reload();
  await ed.waitForSelector('.ed-tile');
  await ed.click('.ed-col:nth-child(1) .ed-tile:nth-of-type(2)');
  await ed.locator('#q-form .ed-pic-search').nth(0).click();
  await ed.fill('#pic-query', 'eiffel tower');
  await ed.click('#pic-dialog .pic-go');
  await ed.waitForSelector('#pic-dialog .pic-tile');
  await thumbsLoaded(ed);
  await shot(ed, 'editor-pic-glass-off-results');
  await tiles(ed).nth(1).click();
  await thumbsLoaded(ed);
  await shot(ed, 'editor-pic-glass-off-preview');
  await ed.evaluate(() => localStorage.setItem('proquiz.glass', '1'));
  await ctx.close();

  // ----- a phone-width window: two columns, everything at least 48px to tap -----
  const pctx = await offlineContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const ph = await pctx.newPage();
  watch(ph, 'narrow editor');
  await ph.goto(`${base}/editor#${quizId}`);
  await ph.waitForSelector('.ed-tile');
  await ph.click('.ed-col:nth-child(2) .ed-tile:nth-of-type(1)');
  await ph.waitForSelector('#q-dialog[open]');
  await ph.locator('#q-form .ed-pic-search').nth(0).click();
  await ph.fill('#pic-query', 'eiffel tower');
  await ph.press('#pic-query', 'Enter');
  await ph.waitForSelector('#pic-dialog .pic-tile');
  await thumbsLoaded(ph);
  const small = await ph.evaluate(() =>
    [...document.querySelectorAll('#pic-dialog .pic-tile, #pic-dialog .pills span, #pic-dialog .btn, #pic-query')]
      .filter((el) => el.offsetParent)
      .map((el) => [el.className || el.id, el.getBoundingClientRect().height])
      .filter(([, hgt]) => hgt < 48),
  );
  assert.deepEqual(small, [], 'every tap target is at least 48px');
  const cols = await ph.evaluate(() => getComputedStyle(document.querySelector('.pic-grid')).gridTemplateColumns.split(' ').length);
  assert.equal(cols, 2);
  assert.equal(await ph.evaluate(() => document.querySelector('#pic-form').scrollWidth <= document.querySelector('#pic-form').clientWidth), true, 'no sideways scrolling');
  await shot(ph, 'editor-pic-6-phone');
  await ph.evaluate(() => (document.querySelector('#pic-form').scrollTop = 520));
  await shot(ph, 'editor-pic-6b-phone-scrolled');
  await tiles(ph).nth(1).click();
  await thumbsLoaded(ph);
  await shot(ph, 'editor-pic-7-phone-preview');
  await pctx.close();

  // ----- in Norwegian: the texts, and the tip that Openverse understands English best -----
  srv.hub.dispatch({ type: 'settings', settings: { lang: 'no' } });
  const nctx = await offlineContext({ viewport: { width: 1280, height: 860 } });
  const no = await nctx.newPage();
  watch(no, 'Norwegian editor');
  await no.goto(`${base}/editor#${quizId}`);
  await no.waitForSelector('.ed-tile');
  await no.click('.ed-col:nth-child(1) .ed-tile:nth-of-type(1)');
  assert.match(await no.textContent('#q-form'), /Bilde: Ann Lee · CC BY 2\.0 · Openverse/);
  await no.locator('#q-form .ed-pic-search').nth(1).click();
  await no.waitForSelector('#pic-dialog[open]');
  assert.match(await no.textContent('#pic-dialog'), /Finn et gratis bilde[\s\S]*Openverse forstår engelsk best/);
  await no.click('#pic-dialog .pic-go');
  await no.waitForSelector('#pic-dialog .pic-tile');
  assert.ok(new URL(searches().at(-1)).searchParams.get('q') === 'Paris');
  await thumbsLoaded(no);
  await shot(no, 'editor-pic-8-norwegian');
  await nctx.close();
  srv.hub.dispatch({ type: 'settings', settings: { lang: 'en' } });

  // ----- the TV: the credit line only once the answer is shown -----
  const credits = saved.credits;
  const boardSet = {
    v: 1,
    title: 'Byer',
    categories: [
      {
        name: 'Landmarks',
        questions: [
          { value: 100, question: 'Which city has this tower?', answer: 'Paris', image: name },
          { value: 200, question: 'q2', answer: 'a2' },
        ],
      },
    ],
    credits,
  };
  srv.hub.dispatch({ type: 'settings', settings: { round2: false, finalRound: false, sound: false, music: false } });
  srv.hub.dispatch({ type: 'loadSet', set: boardSet, setId: quizId });
  srv.hub.dispatch({ type: 'join', teamId: 'bot-a', name: 'Fjellrevene', color: COLORS[0] });
  srv.hub.dispatch({ type: 'join', teamId: 'bot-b', name: 'Bølgene', color: COLORS[3] });
  const tvCtx = await offlineContext({ viewport: { width: 1280, height: 720 } });
  const tv = await tvCtx.newPage();
  watch(tv, 'tv');
  await tv.goto(`${base}/display`);
  const hostCtx = await offlineContext({ viewport: { width: 1280, height: 800 } });
  const host = await hostCtx.newPage();
  watch(host, 'host');
  await host.goto(`${base}/host`);
  await host.waitForSelector('body[data-phase=lobby]');
  await host.click('#group-look summary');
  assert.ok(await host.isChecked('#settings input[name=showCredits]'), 'on by default');
  assert.match(await host.textContent('#group-look'), /Picture credits on the TV/);
  srv.hub.dispatch({ type: 'start', picker: 'bot-a' });
  srv.hub.dispatch({ type: 'pick', c: 0, i: 0 });
  srv.hub.dispatch({ type: 'arm' });
  await tv.waitForSelector('.tv-q .q-img');
  assert.equal(await tv.locator('.pic-credit').count(), 0, 'no credit while the question is open');
  srv.hub.dispatch({ type: 'reveal' });
  await tv.waitForSelector('.tv-q .pic-credit');
  assert.equal(await tv.textContent('.pic-credit'), 'Picture: Ann Lee · CC BY 2.0 · Openverse');
  assert.doesNotMatch(await tv.textContent('.tv-q'), /Eiffel Tower at dusk/, 'never the picture’s title');
  await tv.waitForFunction(() => document.querySelector('.tv-q .q-img')?.naturalWidth > 0);
  await tv.waitForTimeout(600); // the zoom-in
  await shot(tv, 'tv-picture-credit');
  await host.waitForSelector('body[data-phase=revealed]');
  assert.match(await host.textContent('.host-imgs'), /Picture: Ann Lee · CC BY 2\.0 · Openverse/);
  await shot(host, 'host-picture-credit');
  srv.hub.dispatch({ type: 'settings', settings: { glass: false } });
  await tv.waitForSelector('body:not(.glass)');
  await tv.waitForTimeout(600); // the answer pops in again
  await shot(tv, 'tv-picture-credit-glass-off');
  srv.hub.dispatch({ type: 'settings', settings: { glass: true, showCredits: false } });
  await tv.waitForSelector('.pic-credit', { state: 'detached' });
  srv.hub.dispatch({ type: 'settings', settings: { showCredits: true } });

  // A Quick quiz: with the result.
  srv.hub.dispatch({ type: 'restart' });
  await host.waitForSelector('body[data-phase=lobby]');
  const quickSet = {
    v: 1,
    kind: 'quick',
    title: 'Byer kjapt',
    sections: [{ name: 'Landmarks', questions: [{ question: 'Which city has this tower?', options: ['Paris', 'London', 'Rome', 'Oslo'], correct: 0, image: name }] }],
    credits,
  };
  srv.hub.dispatch({ type: 'loadSet', set: quickSet, setId: null });
  srv.hub.dispatch({ type: 'join', teamId: 'bot-a', name: 'Fjellrevene', color: COLORS[0] });
  srv.hub.dispatch({ type: 'join', teamId: 'bot-b', name: 'Bølgene', color: COLORS[3] });
  srv.hub.dispatch({ type: 'start' });
  for (let n = 0; n < 5 && state().phase !== 'open'; n++) srv.hub.dispatch({ type: 'next' });
  await tv.waitForSelector('.quick-q');
  assert.equal(await tv.locator('.pic-credit').count(), 0);
  srv.hub.dispatch({ type: 'answer', teamId: 'bot-a', option: 0 });
  srv.hub.dispatch({ type: 'answer', teamId: 'bot-b', option: 2 });
  await tv.waitForSelector('.quick-q .pic-credit');
  await tv.waitForTimeout(900);
  await shot(tv, 'quick-tv-picture-credit');
  await tvCtx.close();
  await hostCtx.close();

  assert.deepEqual(errors, []);
  console.log('e2e-pictures: all good. Screenshots in test/screenshots/');
} catch (err) {
  for (const c of browser.contexts()) for (const pg of c.pages()) console.log(pg.url(), '→', (await pg.textContent('body').catch(() => '')).replace(/\s+/g, ' ').slice(0, 300));
  console.log(errors);
  throw err;
} finally {
  await browser.close();
  await srv.close();
}

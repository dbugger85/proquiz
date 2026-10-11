// Browser test for "Find a song clip" and the clip's trim bar in the editor, and the trimmed clip on the TV.
// Deezer is pretend: the server gets a fake `fetchImpl`, and the browser's own outside requests (covers, the ▶
// previews) are answered here, so nothing goes on the internet.
//
// Screenshots: test/screenshots/editor-song-*.png, editor-trim-*.png, tv-song-credit.png, host-song-credit.png,
// quick-tv-song-credit.png

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
const root = fileURLToPath(new URL('..', import.meta.url));
const dataDir = mkdtempSync(join(tmpdir(), 'proquiz-songs-e2e-'));
const filesDir = join(dataDir, 'files');
mkdirSync(filesDir, { recursive: true });
const CLIP = readFileSync(join(root, 'sets/files/sample-twinkle.mp3')); // 6.7 s; stands in for every 30 s preview

// ----- a pretend Deezer -----
const SONGS = [
  ['Dancing Queen', 'ABBA', 'ABBA Gold', 231],
  ['Dancing Queen (Live at Wembley)', 'ABBA', 'Live at Wembley Arena', 245],
  ['Waterloo', 'ABBA', 'Waterloo', 164],
  ['Mamma Mia', 'ABBA', 'ABBA', 212],
  ['Take a Chance on Me', 'ABBA', 'The Album', 245],
  ['Dancing Queen', 'The Royal Philharmonic Orchestra', 'Symphonic ABBA', 251],
  ['Gimme! Gimme! Gimme!', 'ABBA', 'Voulez-Vous', 292],
  ['Fernando', 'ABBA', 'Arrival', 253],
  ['Chiquitita', 'ABBA', 'Voulez-Vous', 326],
  ['Super Trouper', 'ABBA', 'Super Trouper', 252],
  ['Dancing Queen', 'Kari Nordmann', 'Norske favoritter', 198],
  ['Lay All Your Love on Me', 'ABBA', 'Super Trouper', 274],
  ['The Winner Takes It All', 'ABBA', 'Super Trouper', 295],
  ['SOS', 'ABBA', 'ABBA', 202],
  ['Knowing Me, Knowing You', 'ABBA', 'Arrival', 242],
].map(([title, artist, album, duration], i) => ({ id: 884000 + i, title, artist, album, duration }));
const track = (s) => ({
  id: s.id,
  readable: true,
  title: s.title,
  title_short: s.title,
  link: `https://www.deezer.com/track/${s.id}`,
  duration: s.duration,
  preview: `https://cdnt-preview.dzcdn.net/api/1/1/${s.id}.mp3?hdnea=exp=1791718203~hmac=abc`,
  artist: { id: 180, name: s.artist, link: 'https://www.deezer.com/artist/180', type: 'artist' },
  album: { id: 1, title: s.album, cover_medium: `https://cdn-images.dzcdn.net/images/cover/${s.id}/250x250-000000-80-0-0.jpg`, type: 'album' },
  type: 'track',
});
const net = { mode: 'ok', calls: [] };
const jsonRes = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });
async function fakeFetch(address) {
  const url = new URL(address);
  net.calls.push(url.href);
  if (net.mode === 'offline') throw new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }) });
  if (net.mode === 'busy') return jsonRes({ error: { type: 'Exception', message: 'Quota limit exceeded', code: 4 } });
  if (url.host === 'api.deezer.com' && url.pathname === '/search') {
    const index = Number(url.searchParams.get('index'));
    const limit = Number(url.searchParams.get('limit'));
    const page = SONGS.slice(index, index + limit);
    return jsonRes({ data: page.map(track), total: SONGS.length, ...(index + limit < SONGS.length && { next: `https://api.deezer.com/search?q=x&limit=${limit}&index=${index + limit}` }) });
  }
  const id = url.host === 'api.deezer.com' && url.pathname.match(/^\/track\/(\d+)$/)?.[1];
  if (id) {
    const s = SONGS.find((x) => x.id === Number(id));
    return s ? jsonRes(track(s)) : jsonRes({ error: { type: 'DataException', message: 'no data', code: 800 } });
  }
  if (url.host === 'cdnt-preview.dzcdn.net') return new Response(CLIP, { headers: { 'content-type': 'audio/mpeg' } });
  throw new Error(`no pretend answer for ${address}`);
}

const srv = await startServer({ port: 3498, quiet: true, dataDir, songOptions: { fetchImpl: fakeFetch } });
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
  // Expected: the pretend no-internet / too-many answers (503, 429).
  page.on('console', (m) => m.type() === 'error' && !/status of (4\d\d|503)/.test(m.text()) && errors.push(`${label}: ${m.text()}`));
  page.on('dialog', (d) => {
    errors.push(`${label}: a browser ${d.type()} appeared`);
    d.dismiss().catch(() => {});
  });
};
// The browser never goes on the internet in this test: covers and ▶ previews are answered here, anything else from
// outside is refused (and counted as an error).
async function offlineContext(options) {
  const ctx = await browser.newContext(options);
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1[:/])/, (route) => {
    const url = route.request().url();
    const cover = url.match(/^https:\/\/cdn-images\.dzcdn\.net\/images\/cover\/(\d+)\//)?.[1];
    if (cover) return route.fulfill({ path: join(filesDir, `cover-${(Number(cover) % 6) + 1}.png`), contentType: 'image/png' });
    if (/^https:\/\/cdnt-preview\.dzcdn\.net\//.test(url)) return route.fulfill({ body: CLIP, contentType: 'audio/mpeg' });
    errors.push(`the browser tried to load ${url}`);
    return route.abort();
  });
  return ctx;
}
const rows = (page) => page.locator('#song-dialog .song-row');
const coversLoaded = (page) =>
  page.waitForFunction(() => {
    const imgs = [...document.querySelectorAll('#song-dialog .song-cover')].filter((im) => im.tagName === 'IMG' && im.getBoundingClientRect().top < innerHeight);
    return imgs.length > 0 && imgs.every((im) => im.complete && im.naturalWidth > 0);
  });
const searches = () => net.calls.filter((c) => c.includes('/search?'));
const trimTimes = (page) => page.textContent('#q-form .ed-trim-times');
// The TV's clip player (public/js/clip.js is a module with one shared state, so the page's own copy answers).
// `clipModule` puts it on `window.__clip` once, so the waits below can be plain functions (an async function's
// promise would count as "true" at once).
const clipModule = (page) =>
  page.evaluate(async () => {
    window.__clip = await import('/js/clip.js');
  });
const clipTime = (page) => page.evaluate(() => window.__clip.clipTime());

try {
  // Pretend album covers: coloured squares with a letter, drawn here in the browser.
  {
    const maker = await browser.newPage();
    const made = await maker.evaluate(() => {
      const out = {};
      for (let n = 1; n <= 6; n++) {
        const c = document.createElement('canvas');
        c.width = 250;
        c.height = 250;
        const g = c.getContext('2d');
        const hue = (n * 61) % 360;
        const grad = g.createLinearGradient(0, 0, 250, 250);
        grad.addColorStop(0, `hsl(${hue} 70% 55%)`);
        grad.addColorStop(1, `hsl(${(hue + 50) % 360} 70% 30%)`);
        g.fillStyle = grad;
        g.fillRect(0, 0, 250, 250);
        g.fillStyle = 'rgb(255 255 255 / 0.85)';
        g.font = 'bold 150px sans-serif';
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.fillText('ABCDEF'[n - 1], 125, 135);
        out[`cover-${n}.png`] = c.toDataURL('image/png');
      }
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
  await ed.click('#new-quiz'); // "What kind of quiz?"
  await ed.click('.ed-kind-modal[open] .ed-kind-board');
  await ed.waitForSelector('.ed-name input:not([disabled])');
  await ed.fill('.ed-name input', 'Sanger');
  await ed.fill('.ed-col:nth-child(1) .ed-cat input', 'Songs');
  await ed.click('.ed-col:nth-child(1) .ed-tile:nth-of-type(1)');
  await ed.waitForSelector('#q-dialog[open]');
  await ed.fill('#q-form textarea', 'Which song is this?');
  await ed.fill('#q-form input[name=answer]', 'Dancing Queen');
  assert.equal(await ed.locator('#q-form .ed-song-search').count(), 1, 'one Find a song clip button, in the clip field');
  assert.equal(await ed.locator('#q-form .ed-trim').count(), 0, 'no trim bar without a clip');

  // Opening it: the answer's words to start from, the terms note at the top.
  await ed.click('#q-form .ed-song-search');
  await ed.waitForSelector('#song-dialog[open]');
  assert.equal(await ed.inputValue('#song-query'), 'Dancing Queen');
  assert.equal(await ed.evaluate(() => document.activeElement?.id), 'song-query');
  assert.match(await ed.textContent('#song-dialog .song-intro'), /30-second previews from Deezer, for private, non-commercial quizzes/);
  await shot(ed, 'editor-song-1-empty');

  // Search (Enter in the field): rows with the cover, title, artist, album and length, ▶ and Use this clip.
  await ed.press('#song-query', 'Enter');
  await ed.waitForSelector('#song-dialog[open] .song-row');
  assert.equal(await rows(ed).count(), 10);
  assert.ok(await ed.isVisible('#song-dialog[open]'), 'Enter searched instead of closing the dialog');
  assert.equal(new URL(searches().at(-1)).searchParams.get('q'), 'Dancing Queen');
  const first = await ed.textContent('#song-dialog .song-row:nth-child(1)');
  assert.match(first, /Dancing Queen[\s\S]*ABBA · ABBA Gold[\s\S]*3:51 · 30 s preview[\s\S]*Use this clip/);
  assert.equal(await ed.getAttribute('#song-dialog .song-row:nth-child(1) .song-cover', 'referrerpolicy'), 'no-referrer');
  await coversLoaded(ed);
  assert.ok(await ed.isVisible('#song-dialog .song-more'));
  await shot(ed, 'editor-song-2-results');
  await ed.click('#song-dialog .song-more');
  await ed.waitForFunction(() => document.querySelectorAll('#song-dialog .song-row').length === 15);
  assert.ok(await ed.isHidden('#song-dialog .song-more'), 'no more after the last page');

  // ▶ plays a preview in the dialog, one at a time; pressed again, it stops.
  await ed.click('#song-dialog .song-row:nth-child(2) .song-play');
  await ed.waitForSelector('#song-dialog .song-row:nth-child(2) .song-play.on');
  assert.equal(await ed.getAttribute('#song-dialog .song-row:nth-child(2) .song-play', 'aria-label'), 'Stop the preview');
  await ed.click('#song-dialog .song-row:nth-child(3) .song-play');
  await ed.waitForSelector('#song-dialog .song-row:nth-child(3) .song-play.on');
  assert.equal(await ed.locator('#song-dialog .song-play.on').count(), 1, 'only one preview plays');
  await shot(ed, 'editor-song-3-playing');
  await ed.click('#song-dialog .song-row:nth-child(3) .song-play');
  await ed.waitForSelector('#song-dialog .song-play.on', { state: 'detached' });

  // Use this clip: the preview is copied into the quiz, the credit shows under the clip, the trim bar shows it whole.
  await ed.click('#song-dialog .song-row:nth-child(1) .song-use');
  await ed.waitForSelector('#song-dialog:not([open])', { state: 'attached' });
  assert.ok(await ed.isVisible('#q-dialog[open]'), 'the question dialog is still open');
  await ed.waitForSelector('#q-form .ed-media .ed-credit');
  const src = await ed.getAttribute('#q-form .ed-media audio', 'src');
  const name = decodeURIComponent(src.replace('/files/', ''));
  assert.match(name, /^[0-9a-f]{16}\.mp3$/);
  assert.equal(await ed.textContent('#q-form .ed-credit'), 'Song: Dancing Queen – ABBA · Deezer');
  assert.equal(await ed.getAttribute('#q-form .ed-credit a', 'href'), 'https://www.deezer.com/track/884000');
  await ed.waitForSelector('#q-form .ed-trim:not(.loading)');
  assert.equal(await trimTimes(ed), 'The whole clip (0:06.7)');
  await shot(ed, 'editor-song-4-chosen');

  // The trim bar: the handles move with the keyboard (half a second a key), the times follow, and the chosen part
  // is lit up. The right handle at the very end means "to the end".
  await ed.focus('#q-form .ed-trim-handle.start');
  await ed.keyboard.press('ArrowRight');
  await ed.keyboard.press('ArrowRight');
  assert.equal(await trimTimes(ed), '0:01 – 0:06.7 (5.7 s)');
  await ed.focus('#q-form .ed-trim-handle.end');
  for (let n = 0; n < 6; n++) await ed.keyboard.press('ArrowLeft');
  assert.equal(await trimTimes(ed), '0:01 – 0:03.7 (2.7 s)');
  assert.equal(await ed.getAttribute('#q-form .ed-trim-handle.end', 'aria-valuetext'), '0:03.7');
  await ed.keyboard.press('End');
  assert.equal(await trimTimes(ed), '0:01 – 0:06.7 (5.7 s)', 'End puts the right handle at the very end');
  for (let n = 0; n < 6; n++) await ed.keyboard.press('ArrowLeft');
  // Dragging the right handle with the mouse to about 60 %.
  const trackBox = await ed.locator('#q-form .ed-trim-track').boundingBox();
  const endBox = await ed.locator('#q-form .ed-trim-handle.end').boundingBox();
  await ed.mouse.move(endBox.x + endBox.width / 2, endBox.y + endBox.height / 2);
  await ed.mouse.down();
  await ed.mouse.move(trackBox.x + trackBox.width * 0.6, endBox.y + endBox.height / 2, { steps: 6 });
  await ed.mouse.up();
  assert.equal(await trimTimes(ed), '0:01 – 0:04 (3 s)');
  const big = await ed.evaluate(() => [...document.querySelectorAll('#q-form .ed-trim-handle, #q-form .ed-trim-try')].every((el) => el.getBoundingClientRect().width >= 48 && el.getBoundingClientRect().height >= 48));
  assert.ok(big, 'the handles and Try it are at least 48px');
  await shot(ed, 'editor-trim-1-handles');
  // Try it: just the chosen part, with a playhead, then it stops by itself at the end of it.
  await ed.click('#q-form .ed-trim-try');
  await ed.waitForSelector('#q-form .ed-trim.trying');
  assert.equal(await ed.textContent('#q-form .ed-trim-try'), 'Stop');
  await ed.waitForFunction(() => !document.querySelector('#q-form .ed-trim-playhead').hidden && document.querySelector('#q-form audio').currentTime > 1.3);
  await shot(ed, 'editor-trim-2-trying');
  await ed.waitForSelector('#q-form .ed-trim:not(.trying)', { timeout: 10_000 });
  const tried = await ed.evaluate(() => ({ paused: document.querySelector('#q-form audio').paused, at: document.querySelector('#q-form audio').currentTime }));
  assert.ok(tried.paused && tried.at >= 3.8 && tried.at <= 4.4, `stopped at the end of the chosen part: ${JSON.stringify(tried)}`);
  assert.equal(await ed.textContent('#q-form .ed-trim-try'), 'Try it');

  // Saved with the quiz: the clip, the trim and the credit, also in the export.
  await ed.click('#q-form button[value=done]');
  await ed.waitForSelector('#q-dialog:not([open])', { state: 'attached' });
  await ed.waitForFunction(() => document.querySelector('#ed-status').textContent === 'Saved');
  const list = await (await fetch(`${base}/api/sets`)).json();
  const quizId = list.find((x) => x.title === 'Sanger').id;
  const saved = (await (await fetch(`${base}/api/sets/${quizId}`)).json()).set;
  assert.equal(saved.categories[0].questions[0].audio, name);
  assert.equal(saved.categories[0].questions[0].audioStart, 1);
  assert.equal(saved.categories[0].questions[0].audioLength, 3);
  assert.deepEqual(saved.credits[name], { title: 'Dancing Queen', author: 'ABBA', source: 'deezer', sourceUrl: 'https://www.deezer.com/track/884000' });
  const pkg = await (await fetch(`${base}/api/export/${quizId}`)).json();
  assert.equal(pkg.set.credits[name].author, 'ABBA');
  assert.equal(pkg.set.categories[0].questions[0].audioLength, 3);
  assert.ok(pkg.files[name]);
  await ed.click('.ed-credits summary');
  assert.match(await ed.textContent('.ed-credits'), /Picture and song credits \(1\)[\s\S]*Song: Dancing Queen – ABBA · Deezer/);
  await ed.locator('.ed-credits').scrollIntoViewIfNeeded();
  await shot(ed, 'editor-song-5-credits');

  // Reopened: the handles where they were.
  await ed.click('.ed-col:nth-child(1) .ed-tile:nth-of-type(1)');
  await ed.waitForSelector('#q-form .ed-trim:not(.loading)');
  assert.equal(await trimTimes(ed), '0:01 – 0:04 (3 s)');
  // No internet, and too many searches: said plainly, also when adding a clip.
  await ed.click('#q-form .ed-song-search');
  await ed.waitForSelector('#song-dialog[open]');
  net.mode = 'offline';
  await ed.fill('#song-query', 'fernando'); // new words: the first search is still in the server's cache
  await ed.click('#song-dialog .song-go');
  await ed.waitForFunction(() => /No internet/.test(document.querySelector('#song-dialog .song-status').textContent));
  assert.equal(await ed.getAttribute('#song-dialog .song-status', 'role'), 'alert');
  await shot(ed, 'editor-song-6-offline');
  net.mode = 'busy';
  await ed.fill('#song-query', 'mamma mia');
  await ed.click('#song-dialog .song-go');
  await ed.waitForFunction(() => /Too many searches/.test(document.querySelector('#song-dialog .song-status').textContent));
  // The browser itself knows it's offline: said without asking the server.
  net.mode = 'ok';
  const before = net.calls.length;
  await ctx.setOffline(true);
  await ed.click('#song-dialog .song-go');
  await ed.waitForFunction(() => /No internet/.test(document.querySelector('#song-dialog .song-status').textContent));
  await ctx.setOffline(false);
  assert.equal(net.calls.length, before);
  await ed.fill('#song-query', 'waterloo');
  await ed.click('#song-dialog .song-go');
  await ed.waitForSelector('#song-dialog .song-row');
  net.mode = 'busy';
  await ed.click('#song-dialog .song-row:nth-child(3) .song-use');
  await ed.waitForFunction(() => /Too many searches/.test(document.querySelector('#song-dialog .song-row:nth-child(3) .song-use-status').textContent));
  assert.ok(await ed.isEnabled('#song-dialog .song-row:nth-child(3) .song-use'));
  net.mode = 'ok';
  await ed.keyboard.press('Escape'); // closes only the song search
  await ed.waitForSelector('#song-dialog:not([open])', { state: 'attached' });
  assert.ok(await ed.isVisible('#q-dialog[open]'));
  await ed.click('#q-form button[value=done]');

  // Glass off: the same dialog and trim bar in the plain look.
  await ed.evaluate(() => localStorage.setItem('proquiz.glass', '0'));
  await ed.reload();
  await ed.waitForSelector('.ed-tile');
  await ed.click('.ed-col:nth-child(1) .ed-tile:nth-of-type(1)');
  await ed.waitForSelector('#q-form .ed-trim:not(.loading)');
  await shot(ed, 'editor-trim-glass-off');
  await ed.click('#q-form .ed-song-search');
  await ed.press('#song-query', 'Enter');
  await ed.waitForSelector('#song-dialog .song-row');
  await coversLoaded(ed);
  await shot(ed, 'editor-song-glass-off');
  await ed.evaluate(() => localStorage.setItem('proquiz.glass', '1'));
  await ctx.close();

  // ----- a phone-width window: everything at least 48px to tap, no sideways scrolling -----
  const pctx = await offlineContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const ph = await pctx.newPage();
  watch(ph, 'narrow editor');
  await ph.goto(`${base}/editor#${quizId}`);
  await ph.waitForSelector('.ed-tile');
  await ph.click('.ed-col:nth-child(1) .ed-tile:nth-of-type(1)');
  await ph.waitForSelector('#q-form .ed-trim:not(.loading)');
  await ph.locator('#q-form .ed-trim').scrollIntoViewIfNeeded();
  await shot(ph, 'editor-trim-3-phone');
  await ph.click('#q-form .ed-song-search');
  await ph.press('#song-query', 'Enter');
  await ph.waitForSelector('#song-dialog .song-row');
  await coversLoaded(ph);
  const small = await ph.evaluate(() =>
    [...document.querySelectorAll('#song-dialog .song-play, #song-dialog .song-use, #song-dialog .btn, #song-query')]
      .filter((el) => el.offsetParent)
      .map((el) => [el.className || el.id, el.getBoundingClientRect().height, el.getBoundingClientRect().width])
      .filter(([, hgt, w]) => hgt < 48 || w < 48),
  );
  assert.deepEqual(small, [], 'every tap target is at least 48px');
  assert.equal(await ph.evaluate(() => document.querySelector('#song-form').scrollWidth <= document.querySelector('#song-form').clientWidth), true, 'no sideways scrolling');
  await shot(ph, 'editor-song-7-phone');
  await pctx.close();

  // ----- in Norwegian -----
  srv.hub.dispatch({ type: 'settings', settings: { lang: 'no' } });
  const nctx = await offlineContext({ viewport: { width: 1280, height: 860 } });
  const no = await nctx.newPage();
  watch(no, 'Norwegian editor');
  await no.goto(`${base}/editor#${quizId}`);
  await no.waitForSelector('.ed-tile');
  await no.click('.ed-col:nth-child(1) .ed-tile:nth-of-type(1)');
  await no.waitForSelector('#q-form .ed-trim:not(.loading)');
  assert.match(await no.textContent('#q-form'), /Sang: Dancing Queen – ABBA · Deezer/);
  assert.equal(await trimTimes(no), '0:01 – 0:04 (3 s)');
  assert.match(await no.textContent('#q-form .ed-trim'), /Klipp til[\s\S]*Prøv/);
  await no.click('#q-form .ed-song-search');
  await no.waitForSelector('#song-dialog[open]');
  assert.match(await no.textContent('#song-dialog'), /Finn et sangklipp[\s\S]*smakebiter fra Deezer/);
  await no.press('#song-query', 'Enter');
  await no.waitForSelector('#song-dialog .song-row');
  await coversLoaded(no);
  await shot(no, 'editor-song-8-norwegian');
  await nctx.close();
  srv.hub.dispatch({ type: 'settings', settings: { lang: 'en' } });

  // ----- the TV: the trimmed clip stops by itself, 0 plays it again, and the artist shows only with the answer -----
  const credits = saved.credits;
  const boardSet = {
    v: 1,
    title: 'Sanger',
    categories: [
      {
        name: 'Songs',
        questions: [
          { value: 100, question: 'Which song is this?', answer: 'Dancing Queen', audio: name, audioStart: 1, audioLength: 2 },
          { value: 200, question: 'q2', answer: 'a2' },
        ],
      },
    ],
    credits,
  };
  srv.hub.dispatch({ type: 'settings', settings: { round2: false, finalRound: false, music: false } });
  srv.hub.dispatch({ type: 'loadSet', set: boardSet, setId: quizId });
  srv.hub.dispatch({ type: 'join', teamId: 'bot-a', name: 'Fjellrevene', color: COLORS[0] });
  srv.hub.dispatch({ type: 'join', teamId: 'bot-b', name: 'Bølgene', color: COLORS[3] });
  const tvCtx = await offlineContext({ viewport: { width: 1280, height: 720 } });
  const tv = await tvCtx.newPage();
  watch(tv, 'tv');
  await tv.goto(`${base}/display`);
  await tv.waitForSelector('#lobby:not([hidden])');
  await tv.mouse.click(5, 5); // a click lets the TV play sound
  await tv.waitForSelector('#sound-unlock[hidden]', { state: 'attached' });
  const hostCtx = await offlineContext({ viewport: { width: 1280, height: 800 } });
  const host = await hostCtx.newPage();
  watch(host, 'host');
  await host.goto(`${base}/host`);
  await host.waitForSelector('body[data-phase=lobby]');
  srv.hub.dispatch({ type: 'start', picker: 'bot-a' });
  srv.hub.dispatch({ type: 'pick', c: 0, i: 0 });
  await tv.waitForSelector('.clip-viz.on');
  await clipModule(tv);
  assert.equal(await tv.locator('.clip-credit').count(), 0, 'no credit while the question is open');
  assert.doesNotMatch(await tv.textContent('.tv-q'), /ABBA|Dancing/, 'nothing about the song before the answer');
  // It plays from 0:01 and pauses by itself at 0:03 (1 + 2 s).
  await tv.waitForFunction(() => window.__clip.clipPlaying(), null, { timeout: 5000 });
  await tv.waitForFunction(() => window.__clip.clipEnded(), null, { timeout: 8000 });
  let at = await clipTime(tv);
  assert.ok(at.paused && at.time >= 2.9 && at.time <= 3.4, `paused at the end of the trimmed part: ${JSON.stringify(at)}`);
  assert.equal(state().media.playing, true, 'the game still says playing: the clip just ran out');
  // 0 plays the trimmed part again from the start; P after the end also starts it over.
  srv.hub.dispatch({ type: 'mediaRestart' });
  await tv.waitForFunction(() => window.__clip.clipPlaying() && !window.__clip.clipEnded(), null, { timeout: 5000 });
  at = await clipTime(tv);
  assert.ok(at.time < 2.5, `started over: ${JSON.stringify(at)}`);
  await tv.waitForFunction(() => window.__clip.clipEnded(), null, { timeout: 8000 });
  srv.hub.dispatch({ type: 'mediaToggle' }); // paused
  srv.hub.dispatch({ type: 'mediaToggle' }); // playing again: from the start of the part
  await tv.waitForFunction(() => window.__clip.clipPlaying() && !window.__clip.clipEnded(), null, { timeout: 5000 });
  at = await clipTime(tv);
  assert.ok(at.time < 2.5, `started over after play: ${JSON.stringify(at)}`);
  // The host's line says what plays and who sings it (always).
  await host.waitForSelector('body[data-phase=reading]');
  assert.match(await host.textContent('.clip-line'), /\(from 0:01, 2 s\)[\s\S]*ABBA · preview from Deezer/);
  await shot(host, 'host-song-credit');
  srv.hub.dispatch({ type: 'reveal' });
  await tv.waitForSelector('.tv-q .clip-credit');
  assert.equal(await tv.textContent('.clip-credit'), 'ABBA · preview from Deezer');
  await tv.waitForTimeout(600); // the zoom-in
  await shot(tv, 'tv-song-credit');
  srv.hub.dispatch({ type: 'settings', settings: { showCredits: false } });
  await tv.waitForSelector('.clip-credit', { state: 'detached' });
  srv.hub.dispatch({ type: 'settings', settings: { showCredits: true } });
  await tv.waitForSelector('.tv-q .clip-credit');

  // A Quick quiz: with the result.
  srv.hub.dispatch({ type: 'restart' });
  await host.waitForSelector('body[data-phase=lobby]');
  const quickSet = {
    v: 1,
    kind: 'quick',
    title: 'Sanger kjapt',
    sections: [{ name: 'Songs', questions: [{ question: 'Which song is this?', options: ['Dancing Queen', 'Waterloo', 'Mamma Mia', 'Fernando'], correct: 0, audio: name, audioStart: 1, audioLength: 2 }] }],
    credits,
  };
  srv.hub.dispatch({ type: 'loadSet', set: quickSet, setId: null });
  srv.hub.dispatch({ type: 'join', teamId: 'bot-a', name: 'Fjellrevene', color: COLORS[0] });
  srv.hub.dispatch({ type: 'join', teamId: 'bot-b', name: 'Bølgene', color: COLORS[3] });
  srv.hub.dispatch({ type: 'start' });
  for (let n = 0; n < 5 && state().phase !== 'open'; n++) srv.hub.dispatch({ type: 'next' });
  await tv.waitForSelector('.quick-q');
  assert.equal(await tv.locator('.clip-credit').count(), 0);
  await tv.waitForFunction(() => window.__clip.clipEnded(), null, { timeout: 8000 });
  srv.hub.dispatch({ type: 'answer', teamId: 'bot-a', option: 0 });
  srv.hub.dispatch({ type: 'answer', teamId: 'bot-b', option: 2 });
  await tv.waitForSelector('.quick-q .clip-credit');
  assert.equal(await tv.textContent('.quick-q .clip-credit'), 'ABBA · preview from Deezer');
  await tv.waitForTimeout(900);
  await shot(tv, 'quick-tv-song-credit');
  await tvCtx.close();
  await hostCtx.close();

  assert.deepEqual(errors, []);
  console.log('e2e-songs: all good. Screenshots in test/screenshots/');
} catch (err) {
  for (const c of browser.contexts()) for (const pg of c.pages()) console.log(pg.url(), '→', (await pg.textContent('body').catch(() => '')).replace(/\s+/g, ' ').slice(0, 300));
  console.log(errors);
  throw err;
} finally {
  await browser.close();
  await srv.close();
}

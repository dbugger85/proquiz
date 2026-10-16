// Browser test of the website version (docs/dev/web-plan.md §7), against `wrangler dev` on port 3499:
//
//   npm run e2e:web
//
// The front page, a host page that makes a room, the TV and three phones at /r/<code>, a board question of the
// sample quiz, a picture and a clip question served from the room's own file store (the host page uploaded them at
// Start), the Quick quiz, the host page refreshed in the middle of a game (its key reopens the same room), then the
// editor keeping quizzes in the browser (IndexedDB: a new quiz with a picture and a song clip found through the
// room's search against a pretend internet, a shrunk picture, a laptop export imported, export one and all, the
// download imported back, delete, archive, the backup reminder) and a quiz made there played with its picture
// reaching the TV through the room. Also: the website restarted in the middle of a game (the TV and phones see
// "nobody is hosting this room yet", the host page sends its autosave back, Continue puts everyone back with their
// scores), the PIN (hosted wording, never on the TV, asked of a phone), branding kept in the browser (a logo, an
// event name and an accent colour reaching the host bar, the TV, the phones and the editor, and coming along into a
// new room), the game offered again in a new room, and a closed room on a phone. Screenshots go to
// test/screenshots/web-*.png. Waits are on the pages' own state (body[data-phase] and the like), never on time.
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { startWebDev } from './web-dev.mjs';
import { startFakeUpstream, FAKE_PORT, SONGS } from './fake-upstream.mjs';
import { ROOM_CODE } from '../lib/room.js';

const shots = fileURLToPath(new URL('./screenshots', import.meta.url));
const root = fileURLToPath(new URL('..', import.meta.url));
mkdirSync(shots, { recursive: true });

// The pretend Openverse, Wikimedia and Deezer the Worker is pointed at (test/fake-upstream.mjs); the previews it
// hands out are the sample clip, and the pictures are drawn in the browser below.
const CLIP = readFileSync(join(root, 'sets/files/sample-twinkle.mp3'));
const fake = await startFakeUpstream({ port: FAKE_PORT, clip: CLIP });
// Rooms close 20 s after the host leaves here (30 min on the site), so a closed room can be shown on a phone; the
// host page is never away longer than that (its reconnect after the restart below takes at most 5 s).
const IDLE_MS = 20_000;
const devVars = { UPSTREAM: fake.base, ROOM_IDLE_MS: IDLE_MS };
let dev = await startWebDev({ vars: devVars });
const base = dev.base;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/usr/bin/chromium' });
const errors = [];

// The host page keeps its room key in localStorage, so it needs one browser context that lives through a reload.
// `init` runs in every page of a new context before its scripts (the host's context pretends the browser agreed
// to keep the storage: headless Chromium always refuses `navigator.storage.persist()`, which would keep the backup
// reminder up for ever).
const contexts = {};
let restarting = false; // the website is being restarted below: the pages' failed reconnects are expected then
async function open(path, viewport, label, { context = label, init = null } = {}) {
  if (!contexts[context]) {
    contexts[context] = await browser.newContext({ viewport, deviceScaleFactor: viewport.width < 500 ? 2 : 1 });
    if (init) await contexts[context].addInitScript(init);
  }
  const page = await contexts[context].newPage();
  page.on('pageerror', (e) => errors.push(`${label}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    if (restarting && /WebSocket connection to .* failed/.test(m.text())) return; // the pages trying again while the website restarts
    errors.push(`${label}: ${m.text()}`);
  });
  page.on('dialog', (d) => {
    errors.push(`${label}: a browser ${d.type()} appeared: ${d.message()}`);
    d.dismiss().catch(() => {});
  });
  await page.goto(base + path);
  return page;
}
async function shot(page, name) {
  const text = await page.evaluate(() => document.body.innerText);
  const bad = text.match(/[^\n]*(\b((?<!under )null|undefined|NaN)\b|\[object \w+\])[^\n]*/);
  assert.equal(bad, null, `${name} shows a broken value: ${JSON.stringify(bad?.[0])}`);
  await page.screenshot({ path: `${shots}/${name}.png` });
}
const MODAL = 'dialog.pq-modal[open]';
async function answerModal(page, ok = true) {
  await page.waitForSelector(MODAL);
  await page.click(`${MODAL} button[value=${ok ? 'ok' : 'cancel'}]`);
  await page.waitForSelector('dialog.pq-modal', { state: 'detached' });
}
const phase = (page, p, timeout = 10_000) => page.waitForSelector(`body[data-phase=${p}]`, { state: 'attached', timeout });
// The editor's search dialogs show thumbnails and covers from the real sites: the browser never goes on the internet
// in this test, so those are answered here (the same drawn pictures the pretend upstream hands the room), and
// anything else from outside is refused and counted as an error.
const drawn = {}; // n → PNG bytes, drawn in the browser below
async function offline(ctx) {
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1[:/])/, (route) => {
    const url = route.request().url();
    const n = url.match(/^https:\/\/api\.openverse\.org\/v1\/images\/0*(\d+)-[0-9a-f-]+\/thumb\/$/)?.[1] ?? url.match(/^https:\/\/live\.staticflickr\.com\/test\/(\d+)\.jpg$/)?.[1];
    if (n) return route.fulfill({ body: drawn[Number(n)], contentType: 'image/png' });
    const flag = url.match(/^https:\/\/upload\.wikimedia\.org\/(thumb|render)\/flag-(\d)\.png$/)?.[2];
    if (flag) return route.fulfill({ body: drawn[100 + Number(flag)], contentType: 'image/png' });
    const cover = url.match(/^https:\/\/cdn-images\.dzcdn\.net\/images\/cover\/(\d+)\//)?.[1];
    if (cover) return route.fulfill({ body: drawn[100 + (Number(cover) % 3) + 1], contentType: 'image/png' });
    errors.push(`the browser tried to load ${url}`);
    return route.abort();
  });
}
const picsLoaded = (page, sel) =>
  page.waitForFunction((sel) => {
    const imgs = [...document.querySelectorAll(sel)].filter((im) => {
      const r = im.getBoundingClientRect();
      return r.bottom > 0 && r.top < innerHeight && r.height > 0;
    });
    return imgs.length > 0 && imgs.every((im) => im.complete && im.naturalWidth > 0);
  }, sel);
const hidden = async (page, sel) => assert.equal(await page.$eval(sel, (el) => el.hidden || el.closest('[hidden]') !== null), true, `${sel} should be hidden`);
// The logo has loaded and is drawn (not a broken picture).
const logoShown = (page, sel) => page.waitForFunction((s) => [...document.querySelectorAll(s)].some((img) => img.complete && img.naturalWidth > 0 && img.offsetHeight > 0), sel);
// Polls a check (something the page does in the background, like a fetch) for up to `ms`.
async function until(check, ms = 5000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error('until timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
}

try {
  // ----- The front page -----
  const keepStorage = () => {
    navigator.storage.persist = async () => true;
    navigator.storage.persisted = async () => true;
  };
  const home = await open('/', { width: 1366, height: 768 }, 'home', { init: keepStorage });
  await home.waitForSelector('#code');
  // Pretend pictures for the search: towers (1–14) and three flags (101–103), drawn here, handed to the pretend
  // upstream (what the room downloads) and to the browser's outside requests (the dialogs' thumbnails).
  {
    const made = await home.evaluate(() => {
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
        g.fillStyle = `hsl(${(hue + 60) % 360} 35% 22%)`;
        g.beginPath();
        g.moveTo(0, 480);
        for (let x = 0; x <= 640; x += 40) g.lineTo(x, 360 + Math.sin((x + n * 50) / 70) * 30);
        g.lineTo(640, 480);
        g.fill();
        const cx = 260 + ((n * 61) % 160);
        g.strokeStyle = `hsl(${(hue + 30) % 360} 30% 15%)`;
        g.lineWidth = 6;
        g.beginPath();
        g.moveTo(cx - 70, 420);
        g.lineTo(cx, 70);
        g.lineTo(cx + 70, 420);
        g.moveTo(cx - 48, 300);
        g.lineTo(cx + 48, 300);
        g.stroke();
        return c.toDataURL('image/png').split(',')[1];
      };
      const flag = (i) => {
        const c = document.createElement('canvas');
        c.width = 660;
        c.height = 480;
        const g = c.getContext('2d');
        const [bg, cross, inner] = [['#ba0c2f', '#fff', '#00205b'], ['#006aa7', '#fecc02', ''], ['#c8102e', '#fff', '']][i - 1];
        g.fillStyle = bg;
        g.fillRect(0, 0, 660, 480);
        g.fillStyle = cross;
        g.fillRect(180, 0, 120, 480);
        g.fillRect(0, 180, 660, 120);
        if (inner) {
          g.fillStyle = inner;
          g.fillRect(210, 0, 60, 480);
          g.fillRect(0, 210, 660, 60);
        }
        return c.toDataURL('image/png').split(',')[1];
      };
      for (let n = 1; n <= 14; n++) out[n] = scene(n);
      for (let i = 1; i <= 3; i++) out[100 + i] = flag(i);
      return out;
    });
    for (const [n, b64] of Object.entries(made)) drawn[Number(n)] = Buffer.from(b64, 'base64');
    fake.pictures = (n) => drawn[n] ?? drawn[((n - 1) % 14) + 1];
    await offline(contexts.home);
  }
  assert.equal(await home.textContent('h1'), 'Quiz night with phones as buzzers');
  await shot(home, 'web-home');
  await home.fill('#code', 'abc 1o');
  await home.click('#join-btn');
  await home.waitForSelector('#code-error:not([hidden])');
  assert.match(await home.textContent('#code-error'), /6 letters and numbers/);
  assert.equal(await home.inputValue('#code'), 'ABC1O'); // typed as it will be read: upper case, no spaces
  await shot(home, 'web-home-bad-code');
  // A wrong address lands back here with the message.
  await home.goto(`${base}/r/not-a-code`);
  await home.waitForSelector('#code-error:not([hidden])');
  assert.equal(new URL(home.url()).search, '?bad=1');
  // Norwegian, remembered.
  await home.click('#lang-no');
  assert.equal(await home.textContent('h1'), 'Quizkveld med mobilen som buzzer');
  await home.reload();
  await home.waitForSelector('#code');
  assert.equal(await home.textContent('h1'), 'Quizkveld med mobilen som buzzer');
  await home.click('#lang-en');
  // Every tap target is at least 48px.
  const small = await home.$$eval('button, a.btn, input', (els) => els.filter((el) => el.getBoundingClientRect().height < 48).map((el) => el.id || el.textContent));
  assert.deepEqual(small, []);

  // ----- The host makes a room -----
  await home.click('#host-btn');
  const host = home; // the same tab: the host's room key lives in this browser
  await host.waitForSelector('#lobby:not([hidden])');
  await host.waitForSelector('#room-code:not([hidden])');
  const code = (await host.textContent('#room-code')).trim();
  assert.match(code, ROOM_CODE);
  const saved = await host.evaluate(() => JSON.parse(localStorage.getItem('proquiz.room')));
  assert.equal(saved.code, code);
  assert.match(saved.key, /^[\w-]{22}$/);
  assert.equal(await host.getAttribute('#open-display', 'href'), `/r/${code}/display`);
  assert.match(await host.textContent('#url'), new RegExp(`/r/${code}$`));
  assert.match(await host.textContent('#join-hint'), /type the code/);
  assert.match(await host.textContent('#tv-url'), new RegExp(`/r/${code}/display`));
  assert.equal(await host.locator('#qr svg').count(), 1);
  assert.match(await host.textContent('#about-line'), /ProQuiz \d+\.\d+\.\d+/);
  // The laptop-only parts are gone: Quit, the tunnel, the new-version tick, own music. Branding stays (below).
  for (const sel of ['#quit-btn', '#join-mode-field', '#join-mode-hint', '#remote-state', '#update-check-setting', '#join-wait']) await hidden(host, sel);
  assert.equal(await host.$eval('#brand', (el) => el.hidden), false);
  await host.click('#group-sound > summary');
  await hidden(host, '#music-files');
  await host.click('#group-sound > summary');
  // The PIN tick stays (anyone with the code can open the phone page).
  await host.click('#group-remote > summary');
  assert.equal(await host.isVisible('#remote-pin-on'), true);
  await host.click('#group-remote > summary');
  // The quiz picker offers the built-in quizzes.
  await host.waitForSelector('#set-picker option[value=quick-sample]', { state: 'attached' });
  assert.deepEqual(await host.$$eval('#set-picker option', (els) => els.map((el) => el.value)), ['sample', 'eksempel', 'quick-sample', 'lynquiz']);
  await host.evaluate(() => (document.querySelector('.host > .lobby').scrollTop = 0)); // the group clicks scrolled it
  await shot(host, 'web-host-lobby');

  // ----- The TV and three phones join with the code -----
  const tv = await open(`/r/${code}/display`, { width: 1920, height: 1080 }, 'tv');
  await tv.waitForSelector('#lobby:not([hidden])');
  await tv.waitForFunction((c) => document.querySelector('#tv-code')?.textContent === c, code);
  assert.equal(await tv.isVisible('#tv-code-line'), true);
  await tv.mouse.click(5, 5);
  await shot(tv, 'web-tv-lobby');

  const phones = [];
  for (const [name, n] of [['Quizzy Rascals', 0], ['Blue Steel', 1], ['Lemon Heads', 3]]) {
    const p = await open(`/r/${code}`, { width: 390, height: 844 }, name);
    await p.waitForSelector('#join:not([hidden])');
    await p.fill('#name', name);
    await p.click(`#swatches label:nth-child(${n + 1})`);
    await p.click('#join-btn');
    await p.waitForSelector('#team:not([hidden])');
    phones.push(p);
  }
  const [red, blue] = phones;
  await host.waitForFunction(() => document.querySelectorAll('#teams li').length === 3);
  assert.equal(await host.locator('#teams .dot.on').count(), 3);
  assert.equal(await host.locator('#teams .elsewhere').count(), 0, 'no "elsewhere" tags on the website');
  await tv.waitForFunction(() => document.querySelectorAll('#teams li').length === 3);
  await host.evaluate(() => (document.querySelector('.host > .lobby').scrollTop = 0));
  await shot(host, 'web-host-teams');
  await shot(red, 'web-phone-joined');

  // ----- One board question of the sample quiz -----
  // Start first sends the quiz's pictures and clips into the room (web-plan.md §3): nothing there before, both after.
  const roomFiles = async () => (await (await fetch(`${base}/r/${code}/files`, { headers: { 'x-proquiz-key': saved.key } })).json()).files.map((f) => f.name).sort();
  assert.deepEqual(await roomFiles(), []);
  await host.click('#start');
  await host.waitForSelector('.host-board');
  assert.deepEqual(await roomFiles(), ['sample-flag-japan.svg', 'sample-mercury.svg', 'sample-twinkle.mp3']);
  await hidden(host, '#media-progress');
  await tv.waitForSelector('.tv-board');
  await shot(tv, 'web-tv-board');
  await host.click('.host-board .col:nth-child(1) .tile:nth-of-type(2)'); // Capitals 200
  await tv.waitForSelector('.tv-q');
  assert.match(await host.textContent('.host-q .answer'), /Rome/);
  assert.doesNotMatch(await tv.textContent('body'), /Rome/);
  await host.keyboard.press('Space');
  await red.waitForSelector('.buzzer.live');
  await shot(red, 'web-phone-armed');
  await blue.click('.buzzer');
  await blue.waitForFunction(() => document.body.textContent.includes('You’re first!'));
  await host.waitForSelector('.btn-good');
  await tv.waitForTimeout(600);
  await shot(tv, 'web-tv-buzzed');
  await host.keyboard.press('y');
  await tv.waitForSelector('.tv-q .answer');
  assert.match(await tv.textContent('.tv-q .answer'), /Rome/);
  await tv.waitForTimeout(500);
  await shot(tv, 'web-tv-revealed');
  await shot(host, 'web-host-revealed');
  await shot(blue, 'web-phone-correct');

  // ----- A picture and a clip, both fetched by the TV from the room's file store -----
  await host.keyboard.press('Space');
  await host.waitForSelector('body[data-phase=board]');
  await host.click('.host-board .col:nth-child(1) .tile:nth-of-type(3)'); // Capitals 300: the flag
  await host.waitForSelector('.host-q .host-img img');
  await tv.waitForSelector('.tv-q img.q-img');
  assert.equal(await tv.getAttribute('.tv-q img.q-img', 'src'), `/r/${code}/files/sample-flag-japan.svg`);
  await tv.waitForFunction(() => {
    const im = document.querySelector('.tv-q img.q-img');
    return im?.complete && im.naturalWidth > 0; // really loaded, not a broken picture
  });
  await tv.waitForTimeout(450);
  await shot(tv, 'web-tv-picture');
  await shot(host, 'web-host-picture');
  await host.keyboard.press('r');
  await host.waitForSelector('body[data-phase=revealed]');
  await host.keyboard.press('Space');
  await host.waitForSelector('body[data-phase=board]');
  // The clip: the TV loaded it from the room while the board showed (its <audio> asks for pieces, Range → 206;
  // wrangler's log is the witness, since the page started loading before this step) and it plays.
  await tv.evaluate(async () => (window.__clip = await import('/js/clip.js')));
  await host.click('.host-board .col:nth-child(4) .tile:nth-of-type(2)'); // the sound clip
  await host.waitForSelector('body[data-phase=reading]');
  await tv.waitForSelector('.clip-viz.on');
  await tv.waitForFunction(() => window.__clip.clipTime()?.time > 0, null, { timeout: 8000 }); // the bytes came and decode
  const clipHits = dev.log().match(new RegExp(`GET /r/${code}/files/sample-twinkle\\.mp3 \\d+`, 'g')) ?? [];
  assert.ok(clipHits.some((hit) => hit.endsWith(' 206')), `the TV fetched the clip from the room by Range: ${JSON.stringify(clipHits)}`);
  await tv.waitForTimeout(500);
  await shot(tv, 'web-tv-clip');
  await host.keyboard.press('r');
  await host.waitForSelector('body[data-phase=revealed]');

  // ----- Back to the lobby, the Quick quiz -----
  await host.click('#menu-btn');
  await answerModal(host);
  await host.waitForSelector('#lobby:not([hidden])');
  await host.waitForSelector('#resume:not([hidden])');
  await host.click('#resume-no');
  await host.waitForSelector('#resume[hidden]', { state: 'attached' });
  await host.selectOption('#set-picker', 'quick-sample');
  await host.waitForSelector('body[data-mode=quick]', { state: 'attached' });
  assert.equal(await host.evaluate(() => localStorage.getItem('proquiz.lastSet')), 'quick-sample');
  for (const [p, name] of [[red, 'Alex'], [blue, 'Mira'], [phones[2], 'Jonas']]) {
    await p.waitForSelector('#join:not([hidden])');
    await p.fill('#name', name);
    await p.click('#join-btn');
    await p.waitForSelector('#team:not([hidden])');
  }
  await host.waitForFunction(() => document.querySelectorAll('#teams li').length === 3);
  await shot(host, 'web-host-quick-lobby');
  await host.click('#start');
  await phase(host, 'section');
  await host.keyboard.press(' ');
  await phase(host, 'ready');
  await phase(host, 'open'); // after the read time
  await tv.waitForSelector('.quick-opts');
  await red.waitForSelector('.choice');
  await shot(tv, 'web-tv-quick-open');
  await shot(red, 'web-phone-quick-open');
  await red.click('.choice:nth-child(1)'); // Mercury is right
  await red.waitForSelector('.locked-shape');
  await blue.click('.choice:nth-child(3)');
  await phones[2].click('.choice:nth-child(1)');
  await phase(host, 'result');
  await tv.waitForSelector('.quick-bars');
  assert.match(await tv.textContent('.quick-verdict'), /2 of 3 got it right/);
  await tv.waitForTimeout(800);
  await shot(tv, 'web-tv-quick-result');
  await shot(red, 'web-phone-quick-result');

  // ----- The host page refreshed in the middle of the game: its key reopens the same room -----
  await host.reload();
  await host.waitForSelector('#game:not([hidden])');
  await phase(host, 'result');
  assert.equal((await host.evaluate(() => JSON.parse(localStorage.getItem('proquiz.room')).code)), code);
  await shot(host, 'web-host-refreshed');
  // And a stranger's browser can't be the host of this room: a fresh context has no key, so it makes its own room.
  const other = await open('/host', { width: 1366, height: 768 }, 'other-host');
  await other.waitForSelector('#room-code:not([hidden])');
  const otherCode = (await other.textContent('#room-code')).trim();
  assert.notEqual(otherCode, code);
  await other.waitForSelector('#lobby:not([hidden])');

  // ----- The room restarts in the middle of the game (a deploy does this): the game comes back from the browser -----
  // The scores as they are now, to compare after. The host's browser is held offline through the restart, so the
  // TV and the phones reconnect first and see "nobody is hosting this room yet" (web-plan.md §5).
  const scoresBefore = await host.$$eval('.quick-side .score-row', (rows) => rows.map((r) => [r.querySelector('.name-text').textContent, r.querySelector('.pts').lastChild.textContent.replace(/\s/g, '')]));
  assert.ok(scoresBefore.some(([, pts]) => pts !== '0'), `some points before the restart: ${JSON.stringify(scoresBefore)}`);
  const autosave = await host.evaluate(async () => (await (await import('/js/quizapi.js')).store.autosave()));
  assert.equal(autosave?.v, 1);
  assert.equal(autosave.state.phase, 'result');
  assert.equal(autosave.state.teams.length, 3, 'the room sent the game to the browser as it was played');
  restarting = true;
  await contexts.home.setOffline(true);
  await dev.stop();
  dev = await startWebDev({ vars: devVars });
  await tv.waitForSelector('#no-host:not([hidden])', { timeout: 30_000 });
  await red.waitForSelector('#no-host:not([hidden])', { timeout: 30_000 });
  assert.match(await red.textContent('#no-host h1'), /Nobody is hosting this room yet/);
  await shot(tv, 'web-room-no-host-tv');
  await shot(red, 'web-room-no-host-phone');
  await contexts.home.setOffline(false);
  // The host page reconnects, finds a fresh lobby and sends the autosave back: the familiar offer.
  await host.waitForSelector('#resume:not([hidden])', { timeout: 30_000 });
  restarting = false;
  assert.match(await host.textContent('#resume-text'), /^Sample quick quiz \(quick quiz\), saved at [\d:. APM]+\. 1 of \d+ questions played\.$/);
  assert.deepEqual(await host.$$eval('#resume-teams li', (els) => els.map((el) => el.querySelector(':scope > span:last-of-type').textContent)), ['Alex', 'Mira', 'Jonas']);
  await tv.waitForSelector('#no-host[hidden]', { state: 'attached' });
  await red.waitForSelector('#no-host[hidden]', { state: 'attached' });
  await tv.waitForSelector('#lobby:not([hidden])');
  await host.evaluate(() => (document.querySelector('.host > .lobby').scrollTop = 0));
  await shot(host, 'web-resume-offer');
  await shot(red, 'web-resume-phone-waiting');
  await host.click('#resume-yes');
  await phase(host, 'result');
  await host.waitForFunction(() => document.querySelectorAll('.quick-side .score-row').length === 3);
  const scoresAfter = await host.$$eval('.quick-side .score-row', (rows) => rows.map((r) => [r.querySelector('.name-text').textContent, r.querySelector('.pts').lastChild.textContent.replace(/\s/g, '')]));
  assert.deepEqual(scoresAfter, scoresBefore, 'the scores are back');
  await tv.waitForSelector('.quick-bars');
  for (const [p, name] of [[red, 'Alex'], [blue, 'Mira'], [phones[2], 'Jonas']]) {
    await p.waitForSelector('#team:not([hidden])');
    await p.waitForFunction((n) => document.querySelector('#me')?.textContent.includes(n), name);
  }
  await host.waitForFunction(() => document.querySelectorAll('.quick-side .dot.on').length === 3, null, { timeout: 15_000 }); // every phone back in its team
  await red.waitForFunction((pts) => document.querySelector('#score')?.textContent.replace(/\s/g, '').includes(pts), scoresBefore.find(([n]) => n === 'Alex')[1]);
  await tv.waitForTimeout(800);
  await shot(tv, 'web-resume-tv');
  await shot(host, 'web-resume-host');
  await shot(red, 'web-resume-phone');

  // ----- The editor keeps the quizzes in this browser (web-plan.md §2) -----
  await host.click('#menu-btn');
  await answerModal(host);
  await host.waitForSelector('#lobby:not([hidden])');
  await host.waitForSelector('#resume:not([hidden])');
  await host.click('#resume-no');
  await host.waitForSelector('#resume[hidden]', { state: 'attached' });
  assert.equal(await host.evaluate(async () => (await (await import('/js/quizapi.js')).store.autosave())), null, 'Start a new game forgets the saved game');

  // ----- The PIN: hosted wording, shown on the host screen, never on the TV, asked of a phone -----
  await host.click('#group-remote > summary');
  assert.equal(await host.textContent('#remote-pin-label'), 'Ask players for a PIN');
  assert.match(await host.textContent('#remote-pin-hint'), /Anyone with the room code/);
  await host.check('#remote-pin-on');
  await host.waitForSelector('#remote-pin-row:not([hidden])');
  const pin = (await host.textContent('#remote-pin-show')).match(/PIN: (\d{4})/)[1];
  await host.waitForFunction((p) => document.querySelector('#remote-pin')?.textContent.includes(p), pin); // the join card shows it
  assert.match(await host.textContent('#remote-status'), new RegExp(`PIN: ${pin}`));
  await host.evaluate(() => (document.querySelector('.host > .lobby').scrollTop = 0));
  await shot(host, 'web-pin-host');
  await tv.waitForSelector('#lobby:not([hidden])');
  await tv.waitForFunction(() => document.querySelectorAll('#teams li').length === 0);
  assert.doesNotMatch(await tv.evaluate(() => document.body.innerText), new RegExp(pin), 'the TV never shows the PIN');
  await hidden(tv, '#remote-pin');
  await shot(tv, 'web-pin-tv');
  const pinPhone = await open(`/r/${code}`, { width: 390, height: 844 }, 'pin-phone');
  await pinPhone.waitForSelector('#join:not([hidden])');
  await pinPhone.waitForSelector('#pin-field:not([hidden])');
  await pinPhone.fill('#name', 'Gate Crashers');
  await pinPhone.click('#swatches label:nth-child(5)');
  await pinPhone.fill('#pin', '0000');
  await shot(pinPhone, 'web-pin-phone');
  await pinPhone.click('#join-btn');
  await pinPhone.waitForFunction(() => document.querySelector('#join-error')?.textContent.includes('Wrong PIN'));
  await shot(pinPhone, 'web-pin-wrong');
  await pinPhone.fill('#pin', pin);
  await pinPhone.click('#join-btn');
  await pinPhone.waitForSelector('#team:not([hidden])');
  await host.waitForFunction(() => document.querySelectorAll('#teams li').length === 1);
  await host.uncheck('#remote-pin-on');
  await host.waitForSelector('#remote-pin-row[hidden]', { state: 'attached' });
  await host.click('#group-remote > summary');
  await host.click('#teams li .remove');
  await answerModal(host);
  await host.waitForFunction(() => document.querySelectorAll('#teams li').length === 0);
  await pinPhone.close();
  // The editor links are back in the picker, and no backup reminder yet (nothing of the host's own).
  assert.equal(await host.isVisible('#new-set'), true);
  assert.equal(await host.isVisible('#edit-set'), true);
  await hidden(host, '#backup');
  const ed = await open('/editor', { width: 1366, height: 768 }, 'editor', { context: 'home' }); // the same browser as the host: the same IndexedDB
  await ed.waitForSelector('.ed-note'); // the built-in sample is read-only
  assert.equal(await ed.locator('#quiz-list .ed-row').count(), 4, 'the four built-in quizzes');
  await hidden(ed, '#backup');
  await shot(ed, 'web-editor-sample');
  // A new quiz: its answer picture is a small SVG, kept as it is and named after its content like on the laptop.
  await ed.click('#new-quiz');
  await ed.click('.ed-kind-modal[open] .ed-kind-board');
  await ed.waitForSelector('.ed-name input:not([disabled])');
  const ownId = await ed.evaluate(() => location.hash.slice(1));
  assert.match(ownId, /^my-quiz-[0-9a-f]{6}$/);
  await ed.fill('.ed-name input', 'Nettquiz');
  await ed.click('.ed-col:nth-child(1) .ed-tile:nth-of-type(1)');
  await ed.waitForSelector('#q-dialog[open]');
  await ed.fill('#q-form textarea', 'Which planet is this?');
  await ed.fill('#q-form input[name=answer]', 'Mercury');
  // ----- Find a free picture and Find a song clip: the search runs in this browser's room (web-plan.md §4) -----
  assert.equal(await ed.locator('#q-form .ed-pic-search').count(), 2, 'Find a free picture for the question and the answer picture');
  assert.equal(await ed.locator('#q-form .ed-song-search').count(), 1, 'Find a song clip in the clip field');
  fake.calls.length = 0;
  await ed.locator('#q-form .ed-pic-search').nth(0).click();
  await ed.waitForSelector('#pic-dialog[open]');
  assert.equal(await ed.inputValue('#pic-query'), 'Which planet is this');
  await ed.fill('#pic-query', 'eiffel tower');
  await ed.press('#pic-query', 'Enter');
  await ed.waitForSelector('#pic-dialog[open] .pic-tile');
  await ed.waitForFunction(() => document.querySelectorAll('#pic-dialog .pic-tile').length === 12);
  await picsLoaded(ed, '#pic-dialog .pic-thumb img');
  assert.match(await ed.textContent('#pic-dialog .pic-tile:nth-child(1) .pic-cap'), /Ann Lee/);
  assert.equal(fake.searches().length, 1, 'one search went to the pretend Openverse, through the room');
  await shot(ed, 'web-editor-search-pictures');
  await ed.click('#pic-dialog .pic-tile:nth-child(1)');
  await ed.waitForSelector('#pic-dialog .pic-preview');
  await picsLoaded(ed, '#pic-dialog .pic-preview-img img');
  assert.match(await ed.textContent('#pic-dialog .pic-preview-info h3'), /Eiffel Tower at dusk/);
  await ed.click('#pic-dialog .pic-use');
  await ed.waitForSelector('#pic-dialog:not([open])', { state: 'attached' });
  await ed.waitForSelector('#q-form .ed-media .ed-credit');
  assert.equal(await ed.textContent('#q-form .ed-credit'), 'Picture: Ann Lee · CC BY 2.0 · Openverse');
  await ed.waitForSelector('#q-form .ed-media img[src^="blob:"]');
  await picsLoaded(ed, '#q-form .ed-media img');
  assert.deepEqual(await ed.$eval('#q-form .ed-media img', (im) => [im.naturalWidth, im.naturalHeight]), [640, 480]); // small enough: kept as it came
  assert.ok(fake.calls.some((c) => c === 'https://live.staticflickr.com/test/1.jpg'), 'the room downloaded the original');
  await shot(ed, 'web-editor-search-picked');
  // A song clip for the same question.
  await ed.click('#q-form .ed-song-search');
  await ed.waitForSelector('#song-dialog[open]');
  assert.equal(await ed.inputValue('#song-query'), 'Mercury');
  await ed.fill('#song-query', 'dancing queen');
  await ed.press('#song-query', 'Enter');
  await ed.waitForSelector('#song-dialog[open] .song-row');
  await ed.waitForFunction(() => document.querySelectorAll('#song-dialog .song-row').length === 10);
  await picsLoaded(ed, '#song-dialog .song-cover');
  assert.match(await ed.textContent('#song-dialog .song-row:nth-child(1)'), /Dancing Queen[\s\S]*ABBA · ABBA Gold/);
  await shot(ed, 'web-editor-search-songs');
  await ed.click('#song-dialog .song-row:nth-child(1) .song-use');
  await ed.waitForSelector('#song-dialog:not([open])', { state: 'attached' });
  await ed.waitForFunction(() => document.querySelectorAll('#q-form .ed-credit').length === 2);
  assert.equal(await ed.textContent('#q-form .ed-media:has(audio) .ed-credit'), 'Song: Dancing Queen – ABBA · Deezer');
  assert.equal(await ed.getAttribute('#q-form .ed-media:has(audio) .ed-credit a', 'href'), `https://www.deezer.com/track/${SONGS[0].id}`);
  await ed.waitForSelector('#q-form .ed-trim-track');
  await ed.waitForFunction(() => /\(\d:\d\d(\.\d)?\)/.test(document.querySelector('#q-form .ed-trim-times')?.textContent ?? '')); // the clip's length is known: "The whole clip (0:06.7)"
  await shot(ed, 'web-editor-search-song-picked');
  const mercury = readFileSync(join(root, 'sets/files/sample-mercury.svg'));
  const mercuryName = `${createHash('sha256').update(mercury).digest('hex').slice(0, 16)}.svg`;
  await ed.locator('#q-form input[type=file]').nth(1).setInputFiles(join(root, 'sets/files/sample-mercury.svg'));
  await ed.waitForSelector('#q-form .ed-media img[src^="blob:"]');
  await ed.click('#q-form .ed-dialog-close');
  // What the store has (the editor saves 600 ms after a change).
  const stored = (id) => ed.evaluate(async (id) => (await (await import('/js/quizapi.js')).store.get(id))?.set, id);
  const storedFile = (name) => ed.evaluate(async (name) => {
    const blob = await (await import('/js/quizapi.js')).store.fileBlob(name);
    return blob ? { size: blob.size, type: blob.type } : null;
  }, name);
  const settled = async (id, check) => {
    for (let n = 0; n < 60; n++) {
      const set = await stored(id);
      if (set && check(set)) return set;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`the store never had the change in ${id}`);
  };
  let own = await settled(ownId, (set) => set.categories[0].questions[0].answerImage);
  assert.equal(own.categories[0].questions[0].answerImage, mercuryName);
  assert.deepEqual(await storedFile(mercuryName), { size: mercury.length, type: 'image/svg+xml' });
  // The found picture and clip are stored under their content's names, with their credits on the quiz.
  const foundPic = own.categories[0].questions[0].image;
  const foundSong = own.categories[0].questions[0].audio;
  assert.equal(foundPic, `${createHash('sha256').update(drawn[1]).digest('hex').slice(0, 16)}.png`);
  assert.equal(foundSong, `${createHash('sha256').update(CLIP).digest('hex').slice(0, 16)}.mp3`);
  assert.deepEqual(await storedFile(foundPic), { size: drawn[1].length, type: 'image/png' });
  assert.deepEqual(await storedFile(foundSong), { size: CLIP.length, type: 'audio/mpeg' });
  assert.deepEqual(own.credits[foundPic], { title: 'Eiffel Tower at dusk', author: 'Ann Lee', license: 'CC BY 2.0', licenseUrl: 'https://creativecommons.org/licenses/by/2.0/', source: 'openverse', sourceUrl: 'https://www.flickr.com/photos/test/1' });
  assert.deepEqual(own.credits[foundSong], { title: 'Dancing Queen', author: 'ABBA', source: 'deezer', sourceUrl: `https://www.deezer.com/track/${SONGS[0].id}` });
  // About the quiz: a description, and the size line of the website.
  if (!(await ed.$('.ed-about-fold[open]'))) await ed.click('.ed-about-fold > summary');
  await ed.fill('.ed-about textarea[name=description]', 'Laget på nettsiden');
  await ed.waitForFunction(() => /^Pictures and clips: 0(\.\d)? MB of 48 MB$/.test(document.querySelector('.ed-media-size')?.textContent ?? ''));
  assert.match(await ed.textContent('.ed-fold-status'), /Pictures and clips: 0(\.\d)? MB of 48 MB/);
  assert.equal(await ed.locator('.ed-about .ed-pic-search').count(), 1, 'Find a free picture for the cover too');
  own = await settled(ownId, (set) => set.description === 'Laget på nettsiden');
  await shot(ed, 'web-editor-quiz');
  // The backup reminder: the host has a quiz of their own now and never exported anything. In the lobby too: the
  // editor's changes reach the host page through BroadcastChannel.
  await ed.waitForSelector('#backup:not([hidden])');
  assert.match(await ed.textContent('#backup-title'), /^Save a backup of your quizzes$/);
  assert.match(await ed.textContent('#backup-note'), /live only in this browser/);
  await host.waitForSelector('#backup:not([hidden])');
  await host.waitForFunction((id) => [...document.querySelectorAll('#set-picker option')].some((o) => o.value === id), ownId);
  await host.evaluate(() => (document.querySelector('.host > .lobby').scrollTop = 0));
  await shot(host, 'web-host-backup');

  // A quiz exported by the laptop version (test/fixtures): its cover, pictures and clip come along.
  const fixture = JSON.parse(readFileSync(join(root, 'test/fixtures/laptop-export.proquiz.json'), 'utf8'));
  await ed.setInputFiles('#import-file', join(root, 'test/fixtures/laptop-export.proquiz.json'));
  await ed.waitForFunction(() => document.querySelector('.ed-name input')?.value === 'Fra laptopen');
  const importedId = await ed.evaluate(() => location.hash.slice(1));
  assert.match(importedId, /^fra-laptopen-[0-9a-f]{6}$/);
  const imported = await stored(importedId);
  assert.equal(imported.cover, 'sample-mercury.svg');
  assert.equal(imported.description, fixture.set.description);
  assert.deepEqual(await storedFile('sample-twinkle.mp3'), { size: Buffer.from(fixture.files['sample-twinkle.mp3'], 'base64').length, type: 'audio/mpeg' });
  await ed.waitForSelector('#quiz-list .ed-item.with-cover img.ed-item-thumb[src^="blob:"]');
  await ed.waitForFunction(() => {
    const im = document.querySelector('#quiz-list .ed-item.with-cover img.ed-item-thumb');
    return im?.complete && im.naturalWidth > 0; // the cover really shows from the browser store
  });
  // A big photo (3000 × 1500, drawn here) for its first question is shrunk to 1920 px and saved as a JPEG before it
  // is named and stored (decision 4).
  await ed.click('.ed-col:nth-child(1) .ed-tile:nth-of-type(1)'); // Capitals 100
  await ed.waitForSelector('#q-dialog[open]');
  const bigPng = Buffer.from(
    await ed.evaluate(() => {
      const c = document.createElement('canvas');
      c.width = 3000;
      c.height = 1500;
      const g = c.getContext('2d');
      const grad = g.createLinearGradient(0, 0, 3000, 1500);
      grad.addColorStop(0, '#c0392b');
      grad.addColorStop(1, '#2980b9');
      g.fillStyle = grad;
      g.fillRect(0, 0, 3000, 1500);
      g.fillStyle = '#fff';
      g.font = 'bold 320px sans-serif';
      g.fillText('OSLO', 850, 860);
      return c.toDataURL('image/png').split(',')[1];
    }),
    'base64',
  );
  await ed.locator('#q-form input[type=file]').nth(0).setInputFiles({ name: 'oslo.png', mimeType: 'image/png', buffer: bigPng });
  await ed.waitForSelector('#q-form .ed-media img[src^="blob:"]');
  await ed.waitForFunction(() => {
    const im = document.querySelector('#q-form .ed-media img');
    return im?.complete && im.naturalWidth > 0;
  });
  assert.deepEqual(await ed.$eval('#q-form .ed-media img', (im) => [im.naturalWidth, im.naturalHeight]), [1920, 960]);
  await shot(ed, 'web-editor-picture');
  await ed.click('#q-form .ed-dialog-close');
  const withPicture = await settled(importedId, (set) => set.categories[0].questions[0].image);
  const jpg = withPicture.categories[0].questions[0].image;
  assert.match(jpg, /^[0-9a-f]{16}\.jpg$/);
  const jpgFile = await storedFile(jpg);
  assert.equal(jpgFile.type, 'image/jpeg');
  assert.ok(jpgFile.size > 5000 && jpgFile.size < bigPng.length / 4, `the stored picture is much smaller: ${jpgFile.size} of ${bigPng.length}`);
  await ed.waitForFunction(() => /^Pictures and clips: 0\.\d MB of 48 MB$/.test(document.querySelector('.ed-media-size')?.textContent ?? ''));
  await shot(ed, 'web-editor-imported');

  // Export one quiz: the same .proquiz.json the laptop writes, the pictures and the clip inside, made in the browser.
  const [one] = await Promise.all([ed.waitForEvent('download'), ed.click('.ed-head button:has-text("Export")')]);
  assert.equal(one.suggestedFilename(), 'fra-laptopen.proquiz.json');
  const onePkg = JSON.parse(readFileSync(await one.path(), 'utf8'));
  assert.equal(onePkg.proquiz, 1);
  assert.equal(onePkg.set.title, 'Fra laptopen');
  assert.deepEqual(Object.keys(onePkg.files).sort(), [jpg, 'sample-flag-japan.svg', 'sample-mercury.svg', 'sample-twinkle.mp3'].sort());
  assert.equal(onePkg.files['sample-twinkle.mp3'], fixture.files['sample-twinkle.mp3'], 'the clip comes back byte for byte');
  // Export all: both quizzes, every file once. An export counts as a backup, so the reminder goes (in the lobby too).
  const [all] = await Promise.all([ed.waitForEvent('download'), ed.click('#export-all')]);
  assert.match(all.suggestedFilename(), /^proquiz-all-\d{4}-\d\d-\d\d\.proquiz\.json$/);
  const allBytes = readFileSync(await all.path());
  const allPkg = JSON.parse(allBytes.toString('utf8'));
  assert.deepEqual(allPkg.sets.map((x) => x.set.title).sort(), ['Fra laptopen', 'Nettquiz']);
  assert.deepEqual(Object.keys(allPkg.files).sort(), [jpg, mercuryName, foundPic, foundSong, 'sample-flag-japan.svg', 'sample-mercury.svg', 'sample-twinkle.mp3'].sort());
  await ed.waitForSelector('#backup[hidden]', { state: 'attached' });
  await host.waitForSelector('#backup[hidden]', { state: 'attached' });
  assert.ok((await ed.evaluate(async () => (await import('/js/quizapi.js')).store.lastExport())) > Date.now() - 60_000, 'lastExport recorded');
  // The download imports back: two more quizzes. Delete one copy, archive the other.
  await ed.setInputFiles('#import-file', { name: all.suggestedFilename(), mimeType: 'application/json', buffer: allBytes });
  await ed.waitForSelector(MODAL);
  assert.match(await ed.textContent(MODAL), /Imported 2 quizzes/);
  await answerModal(ed);
  await ed.waitForFunction(() => document.querySelectorAll('#quiz-list .ed-row').length === 8);
  await ed.waitForFunction(() => document.querySelector('.ed-name input')?.value === 'Fra laptopen'); // the first of the two copies is open
  const copyId = await ed.evaluate(() => location.hash.slice(1));
  assert.notEqual(copyId, importedId);
  await ed.click('.ed-head button:has-text("Delete")');
  await answerModal(ed);
  await ed.waitForFunction(() => document.querySelectorAll('#quiz-list .ed-row').length === 7);
  assert.equal(await stored(copyId), undefined);
  // The copy of Nettquiz: its row is where the store's list has it (the editor shows the list in that order).
  const listed = await ed.evaluate(async () => (await (await import('/js/quizapi.js')).store.list()).filter((q) => !q.archived).map((q) => [q.id, q.title]));
  const copyRow = listed.findIndex(([id, title]) => title === 'Nettquiz' && id !== ownId) + 1;
  assert.ok(copyRow > 4, `the copy is among the own quizzes: ${JSON.stringify(listed)}`);
  assert.equal(await ed.$eval(`#quiz-list .ed-row:nth-child(${copyRow}) .ed-item-title`, (el) => el.textContent), 'Nettquiz');
  await ed.click(`#quiz-list .ed-row:nth-child(${copyRow}) .ed-archive`);
  await ed.waitForSelector('#quiz-archived:not([hidden])');
  assert.match(await ed.textContent('#quiz-archived summary'), /Archived \(1\)/);
  await ed.click('#quiz-archived summary');
  await ed.locator('#quiz-archived .ed-item').scrollIntoViewIfNeeded();
  await shot(ed, 'web-editor-archived');
  const archivedId = await ed.evaluate(async () => (await (await import('/js/quizapi.js')).store.archivedIds())[0]);
  assert.match(archivedId, /^nettquiz-[0-9a-f]{6}$/);

  // ----- The host plays the quiz from the browser: its picture reaches the TV through the room -----
  await host.waitForFunction((ids) => {
    const values = [...document.querySelectorAll('#set-picker option')].map((o) => o.value);
    return ids.every((id) => values.includes(id)) && values.length === 6; // the four built-ins and the two own quizzes, not the archived copy
  }, [ownId, importedId]);
  assert.equal(await host.$eval('#set-picker', (sel, id) => [...sel.options].some((o) => o.value === id), archivedId), false);
  await host.selectOption('#set-picker', importedId);
  await host.waitForFunction((id) => document.querySelector('#edit-set')?.getAttribute('href') === `/editor#${id}`, importedId);
  await host.waitForFunction((text) => document.querySelector('#quiz-about .quiz-desc')?.textContent === text, fixture.set.description);
  assert.equal(await host.evaluate(() => localStorage.getItem('proquiz.lastSet')), importedId);
  // A change saved in the editor reaches the lobby by itself (BroadcastChannel; `setSaved` on the laptop).
  await ed.click(`#quiz-list .ed-item:has-text("Fra laptopen")`);
  await ed.waitForFunction(() => document.querySelector('.ed-name input')?.value === 'Fra laptopen');
  if (!(await ed.$('.ed-about-fold[open]'))) await ed.click('.ed-about-fold > summary');
  await ed.fill('.ed-about textarea[name=description]', 'Laget i programmet, endret på nettsiden');
  await host.waitForFunction(() => document.querySelector('#quiz-about .quiz-desc')?.textContent === 'Laget i programmet, endret på nettsiden');
  await host.evaluate(() => (document.querySelector('.host > .lobby').scrollTop = 0));
  await shot(host, 'web-host-own-quiz');

  // ----- Branding on the website (web-plan.md Phase 6): kept in this browser, sent to the room -----
  // The same Look and branding block as on the laptop: an SVG logo (with a script that must never run), an event
  // name and the teal accent. The logo goes into the room's file store under its content name, the rest as a
  // `brand` message; the host bar, the TV and the phones' join screen follow, and the editor shows it too.
  const svgLogo = Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 380 84" width="380" height="84">
  <script>document.title = 'hacked'</script>
  <defs><linearGradient id="g" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="#14b8a6"/><stop offset="1" stop-color="#a3e635"/></linearGradient></defs>
  <rect x="2" y="2" width="80" height="80" rx="22" fill="url(#g)"/>
  <path d="M18 56 C 32 30, 46 62, 64 26" stroke="#fff" stroke-width="7" fill="none" stroke-linecap="round"/>
  <circle cx="64" cy="26" r="6" fill="#fff"/>
  <text x="100" y="58" font-family="Arial, Helvetica, sans-serif" font-size="44" font-weight="800" letter-spacing="3" fill="#ffffff">NORDLYS</text>
</svg>`);
  const logoName = `logo-${createHash('sha256').update(svgLogo).digest('hex').slice(0, 16)}.svg`;
  await host.click('#group-look > summary');
  await host.waitForSelector('#brand-preview.empty');
  await host.setInputFiles('#brand-file', { name: 'nordlys.svg', mimeType: 'image/svg+xml', buffer: svgLogo });
  await logoShown(host, '#brand-preview img');
  await logoShown(host, '.host-bar .wordmark img');
  assert.equal(await host.getAttribute('.host-bar .wordmark img', 'src'), `/r/${code}/files/${logoName}`);
  assert.notEqual(await host.title(), 'hacked', 'the logo is only ever a picture');
  assert.ok((await roomFiles()).includes(logoName), 'the logo went into the room');
  await host.fill('#brand-name', 'Nordlys Christmas Quiz');
  await host.press('#brand-name', 'Tab');
  await host.click('label.accent:has(> input[value=teal])');
  await host.waitForFunction(() => document.body.dataset.accent === '#0f9f95');
  await host.waitForFunction(() => document.querySelector('#look-status').textContent.includes('Teal'));
  assert.match(await host.textContent('#look-status'), /own logo/);
  // Kept in this browser (IndexedDB `meta.brand`, the logo as a file there), and never in an export.
  const myBrand = () => host.evaluate(async () => (await (await import('/js/quizapi.js')).store.brand()));
  assert.deepEqual(await myBrand(), { name: 'Nordlys Christmas Quiz', accent: '#0f9f95', plate: false, logo: logoName });
  assert.deepEqual(await storedFile(logoName), { size: svgLogo.length, type: 'image/svg+xml' });
  const exportedFiles = await host.evaluate(async () => Object.keys((await (await import('/js/quizapi.js')).store.exportAll()).files));
  assert.ok(exportedFiles.length > 0 && !exportedFiles.includes(logoName), 'the logo is never in an export');
  // A file that isn't a picture is refused with a clear message, and the logo stays.
  await host.setInputFiles('#brand-file', { name: 'notes.png', mimeType: 'image/png', buffer: Buffer.from('these are my quiz notes, not a picture') });
  await host.waitForSelector('#brand-logo-msg.error');
  assert.match(await host.textContent('#brand-logo-msg'), /can’t use that file/);
  assert.equal(await host.getAttribute('#brand-preview img', 'src'), `/r/${code}/files/${logoName}`);
  await host.locator('#group-look').scrollIntoViewIfNeeded();
  await shot(host, 'web-brand-host');
  await host.click('#group-look > summary');
  await host.evaluate(() => (document.querySelector('.host > .lobby').scrollTop = 0));
  // The TV: the big logo and the name above "Scan to join", the teal accent, the wordmark gone.
  await tv.waitForFunction(() => document.body.dataset.accent === '#0f9f95');
  await logoShown(tv, '#tv-brand img');
  assert.equal(await tv.getAttribute('#tv-brand img', 'src'), `/r/${code}/files/${logoName}`);
  assert.match(await tv.textContent('#tv-brand'), /Nordlys Christmas Quiz/);
  assert.equal(await tv.isHidden('.display > .wordmark'), true);
  assert.notEqual(await tv.title(), 'hacked');
  await tv.waitForTimeout(300);
  await shot(tv, 'web-brand-tv');
  // The phones' join screen: the logo and the event name, the theme colour from the accent.
  await red.waitForFunction(() => document.body.dataset.accent === '#0f9f95');
  await logoShown(red, '.join-head img');
  assert.match(await red.textContent('#brand-name'), /Nordlys Christmas Quiz/);
  assert.equal(await red.evaluate(() => document.querySelector('meta[name=theme-color]').content), await red.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()));
  await shot(red, 'web-brand-phone');
  // The editor shows the logo (from this browser's store, so a blob address) and the colour too.
  await ed.reload();
  await logoShown(ed, '.host-bar .wordmark img');
  assert.match(await ed.getAttribute('.host-bar .wordmark img', 'src'), /^blob:/);
  await ed.waitForFunction(() => document.body.dataset.accent === '#0f9f95');
  await shot(ed, 'web-brand-editor');

  for (const [p, name, n] of [[red, 'Quizzy Rascals', 0], [blue, 'Blue Steel', 1], [phones[2], 'Lemon Heads', 3]]) {
    await p.waitForSelector('#join:not([hidden])');
    await p.fill('#name', name);
    await p.click(`#swatches label:nth-child(${n + 1})`);
    await p.click('#join-btn');
    await p.waitForSelector('#team:not([hidden])');
  }
  await host.waitForFunction(() => document.querySelectorAll('#teams li').length === 3);
  await host.click('#start');
  await host.waitForSelector('.host-board');
  assert.ok((await roomFiles()).includes(jpg), 'the shrunk picture went from the browser store into the room');
  await host.click('.host-board .col:nth-child(1) .tile:nth-of-type(1)'); // Capitals 100: the big photo
  await tv.waitForSelector('.tv-q img.q-img');
  assert.equal(await tv.getAttribute('.tv-q img.q-img', 'src'), `/r/${code}/files/${jpg}`);
  await tv.waitForFunction(() => {
    const im = document.querySelector('.tv-q img.q-img');
    return im?.complete && im.naturalWidth === 1920;
  });
  await tv.waitForTimeout(450);
  await shot(tv, 'web-tv-own-picture');
  await shot(host, 'web-host-own-picture');

  // ----- The host comes back another day, in a new room: the game is offered from this browser -----
  await host.evaluate(() => localStorage.removeItem('proquiz.room'));
  await host.reload();
  await host.waitForSelector('#resume:not([hidden])', { timeout: 15_000 });
  const newCode = (await host.textContent('#room-code')).trim();
  assert.notEqual(newCode, code);
  assert.match(await host.textContent('#resume-text'), /^Fra laptopen, saved at [\d:. APM]+\. \d+ of \d+ questions played\.$/);
  assert.equal(await host.textContent('#set-title'), 'Fra laptopen');
  await host.evaluate(() => (document.querySelector('.host > .lobby').scrollTop = 0));
  await shot(host, 'web-resume-new-room');
  await host.click('#resume-no');
  await host.waitForSelector('#resume[hidden]', { state: 'attached' });
  // The branding came along into the new room (as it would after a restart): the logo from this browser into the
  // room's file store, the rest sent with it; a TV in the new room shows it.
  await logoShown(host, '.host-bar .wordmark img');
  assert.equal(await host.getAttribute('.host-bar .wordmark img', 'src'), `/r/${newCode}/files/${logoName}`);
  const newKey = await host.evaluate(() => JSON.parse(localStorage.getItem('proquiz.room')).key);
  const newRoomFiles = async () => (await (await fetch(`${base}/r/${newCode}/files`, { headers: { 'x-proquiz-key': newKey } })).json()).files.map((f) => f.name);
  assert.ok((await newRoomFiles()).includes(logoName), 'the logo is in the new room');
  const newTv = await open(`/r/${newCode}/display`, { width: 1920, height: 1080 }, 'new-tv');
  await newTv.waitForSelector('#lobby:not([hidden])');
  await newTv.waitForFunction(() => document.body.dataset.accent === '#0f9f95');
  await logoShown(newTv, '#tv-brand img');
  await newTv.mouse.click(5, 5);
  await shot(newTv, 'web-brand-new-room-tv');
  // Remove the logo: "ProQuiz" is back on every screen, the file goes from the browser and the room; the name and
  // colour stay. Then ProQuiz's own violet again: the built-in colours exactly.
  await host.click('#group-look > summary');
  await host.waitForSelector('#brand-remove:not([hidden])');
  await host.click('#brand-remove');
  await host.waitForSelector('#brand-preview.empty');
  await host.waitForFunction(() => document.querySelector('.host-bar .wordmark').textContent === 'ProQuiz');
  await newTv.waitForFunction(() => document.querySelector('.display > .wordmark').textContent === 'ProQuiz');
  assert.match(await newTv.textContent('#tv-brand'), /Nordlys Christmas Quiz/);
  assert.deepEqual(await myBrand(), { name: 'Nordlys Christmas Quiz', accent: '#0f9f95', plate: false, logo: null });
  assert.equal(await host.evaluate(async (n) => (await (await import('/js/quizapi.js')).store.fileBlob(n)), logoName), null);
  await until(async () => !(await newRoomFiles()).includes(logoName));
  await host.click('label.accent:has(> input[value=violet])');
  await newTv.waitForFunction(() => document.body.dataset.accent === '' && document.documentElement.style.getPropertyValue('--light-rgb') === '');
  await host.click('#group-look > summary');
  await newTv.close();

  // ----- A room that closed, on a phone: the host of the other room goes away for good -----
  const lost = await open(`/r/${otherCode}`, { width: 390, height: 844 }, 'lost-phone');
  await lost.waitForSelector('#join:not([hidden])');
  await lost.fill('#name', 'Night Owls');
  await lost.click('#swatches label:nth-child(2)');
  await lost.click('#join-btn');
  await lost.waitForSelector('#team:not([hidden])');
  await other.close();
  await lost.waitForSelector('#stopped:not([hidden])', { timeout: IDLE_MS + 15_000 });
  assert.equal(await lost.textContent('#stopped-title'), 'This room has closed');
  assert.equal(await lost.isVisible('#stopped-home'), true);
  await shot(lost, 'web-room-closed');
  await lost.click('#stopped-home');
  await lost.waitForSelector('#code');
  assert.equal(new URL(lost.url()).pathname, '/');

  assert.deepEqual(errors, []);
  console.log('e2e-web OK');
} catch (err) {
  console.error(err);
  if (errors.length) console.error('page errors:', errors);
  process.exitCode = 1;
} finally {
  await browser.close();
  await dev.stop();
  await fake.stop();
}

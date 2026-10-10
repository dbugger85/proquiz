// Browser test for branding: the host uploads a logo, types an event name and picks an accent colour in the lobby's
// "Look and branding" group, and the TV, the phones, the host bar and the editor follow. A board game to the end
// screen and a Quick quiz to the podium, both with the glass look on and off; then a dark PNG logo on a white
// backing with a colour of your own, a refused file, and removing the logo again.
//
// Screenshots: test/screenshots/brand-*.png

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { startServer } from '../server.js';
import { COLORS } from '../lib/game.js';

const shots = fileURLToPath(new URL('./screenshots', import.meta.url));
mkdirSync(shots, { recursive: true });
const tmp = mkdtempSync(join(tmpdir(), 'proquiz-brand-e2e-'));

const srv = await startServer({ port: 3486, quiet: true, dataDir: join(tmp, 'data') });
const base = `http://127.0.0.1:${srv.info.port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/usr/bin/chromium' });
const errors = [];

// Only the part under the top bar scrolls (the lobby, the game, the editor's quiz): scroll that, to a position or 'end'.
const scrollArea = (page, y) =>
  page.evaluate((y) => {
    const el =
      [...document.querySelectorAll('.host > .lobby, .host > #game, .ed-main, .ed-layout')].find(
        (e) => !e.hidden && e.scrollHeight > e.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(e).overflowY),
      ) ?? document.scrollingElement;
    el.scrollTop = y === 'end' ? el.scrollHeight : y;
    return el.scrollTop;
  }, y);

async function open(path, viewport, label) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: viewport.width < 500 ? 2 : 1 });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${label}: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !/status of 4\d\d/.test(m.text()) && errors.push(`${label}: ${m.text()}`));
  await page.goto(base + path);
  return page;
}
async function waitFor(check, ms = 3000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}
async function shot(page, name, opts = {}) {
  const text = await page.evaluate(() => document.body.innerText);
  const bad = text.match(/[^\n]*(\b((?<!under )null|undefined|NaN)\b|\[object \w+\])[^\n]*/);
  assert.equal(bad, null, `${name} shows a broken value: ${JSON.stringify(bad?.[0])}`);
  await page.screenshot({ path: `${shots}/${name}.png`, ...opts });
}
// The logo has loaded and is drawn (not a broken picture).
const logoShown = (page, sel) => page.waitForFunction((s) => [...document.querySelectorAll(s)].some((img) => img.complete && img.naturalWidth > 0 && img.offsetHeight > 0), sel);
// Glass on and off for the same screens: brand-glass-on-<name>.png / brand-glass-off-<name>.png.
async function glassPairs(pages) {
  for (const [page, name] of pages) await shot(page, `brand-glass-on-${name}`);
  srv.hub.dispatch({ type: 'settings', settings: { glass: false } });
  for (const [page] of pages) await page.waitForSelector('body:not(.glass)');
  for (const [page, name] of pages) await shot(page, `brand-glass-off-${name}`);
  srv.hub.dispatch({ type: 'settings', settings: { glass: true } });
  for (const [page] of pages) await page.waitForSelector('body.glass');
}
const phase = (page, p, timeout = 5000) => page.waitForSelector(`body[data-phase=${p}]`, { state: 'attached', timeout });

// Two test logos. A wide SVG with light text (with a script that must never run), and a dark PNG with a
// transparent background, drawn here in the browser, that needs the white backing on the dark screens.
const svgLogo = join(tmp, 'nordlys.svg');
writeFileSync(
  svgLogo,
  `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 380 84" width="380" height="84">
  <script>document.title = 'hacked'; fetch('/api/brand', {method: 'DELETE'})</script>
  <defs><linearGradient id="g" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="#14b8a6"/><stop offset="1" stop-color="#a3e635"/></linearGradient></defs>
  <rect x="2" y="2" width="80" height="80" rx="22" fill="url(#g)"/>
  <path d="M18 56 C 32 30, 46 62, 64 26" stroke="#fff" stroke-width="7" fill="none" stroke-linecap="round"/>
  <circle cx="64" cy="26" r="6" fill="#fff"/>
  <text x="100" y="58" font-family="Arial, Helvetica, sans-serif" font-size="44" font-weight="800" letter-spacing="3" fill="#ffffff">NORDLYS</text>
</svg>`,
);
const pngLogo = join(tmp, 'fjord.png');
{
  const maker = await browser.newPage({ viewport: { width: 600, height: 200 }, deviceScaleFactor: 2 });
  await maker.setContent(`<div id="logo" style="display:inline-flex;align-items:center;gap:14px;padding:6px;font:800 46px Arial,sans-serif;color:#13213c;letter-spacing:-1px">
    <svg width="56" height="56" viewBox="0 0 56 56"><path d="M4 44 L20 14 L30 32 L38 22 L52 44 Z" fill="#13213c"/><circle cx="42" cy="12" r="6" fill="#e8630a"/></svg>Fjord&amp;Co</div>`);
  await maker.locator('#logo').screenshot({ path: pngLogo, omitBackground: true });
  await maker.close();
}
const notAPicture = join(tmp, 'notes.png');
writeFileSync(notAPicture, 'these are my quiz notes, not a picture');

try {
  const host = await open('/host', { width: 1366, height: 768 }, 'host');
  const tv = await open('/display', { width: 1920, height: 1080 }, 'tv');
  await host.waitForSelector('#lobby:not([hidden])');
  await tv.waitForSelector('#lobby:not([hidden])');
  host.on('dialog', (d) => {
    errors.push(`host: a browser ${d.type()} appeared: ${d.message()}`); // ProQuiz asks with its own pop-ups now
    d.dismiss().catch(() => {});
  });

  // No branding yet: the wordmark everywhere, no logo, ProQuiz's own violet.
  assert.equal(await tv.textContent('.display > .wordmark'), 'ProQuiz');
  assert.equal(await tv.evaluate(() => document.body.dataset.accent), '');

  // The Look and branding group: upload the SVG logo, see it in the preview.
  await host.click('#group-look > summary');
  await host.waitForSelector('#brand-preview.empty');
  await host.setInputFiles('#brand-file', svgLogo);
  await logoShown(host, '#brand-preview img');
  await logoShown(host, '.host-bar .wordmark img');
  const brandNow = () => fetch(`${base}/api/brand`).then((r) => r.json());
  assert.match((await brandNow()).logo, /^\/brand\/logo-[0-9a-f]{16}\.svg$/);
  // Its script never ran (it is only ever an <img>).
  assert.notEqual(await host.title(), 'hacked');
  assert.ok((await brandNow()).logo);

  // An event name, and the teal accent.
  await host.fill('#brand-name', 'Nordlys Christmas Quiz');
  await host.press('#brand-name', 'Tab');
  await host.click('label.accent:has(> input[value=teal])');
  await host.waitForFunction(() => document.body.dataset.accent === '#0f9f95');
  assert.equal((await brandNow()).name, 'Nordlys Christmas Quiz');
  await host.waitForFunction(() => document.querySelector('#look-status').textContent.includes('Teal'));
  assert.match(await host.textContent('#look-status'), /own logo/);
  await host.locator('#group-look').scrollIntoViewIfNeeded();
  await shot(host, 'brand-host-settings', { clip: await host.locator('#settings').boundingBox().then((b) => ({ x: b.x, y: 0, width: b.width, height: 768 })) });

  // The TV follows at once: the big logo and the name above "Scan to join", the teal accent, no corner logo.
  await tv.waitForFunction(() => document.body.dataset.accent === '#0f9f95');
  await logoShown(tv, '#tv-brand img');
  assert.match(await tv.textContent('#tv-brand'), /Nordlys Christmas Quiz/);
  assert.equal(await tv.isHidden('.display > .wordmark'), true);

  // Phones: the logo and the event name on the join screen.
  const phones = [];
  for (const [name, n] of [['Quizzy Rascals', 0], ['Blue Steel', 1], ['Lemon Heads', 3]]) {
    const p = await open('/', { width: 390, height: 844 }, name);
    await p.waitForSelector('#join:not([hidden])');
    await logoShown(p, '.join-head img');
    if (!phones.length) {
      assert.match(await p.textContent('#brand-name'), /Nordlys Christmas Quiz/);
      assert.equal(await p.evaluate(() => document.querySelector('meta[name=theme-color]').content), await p.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()));
      await glassPairs([[p, 'phone-join']]);
    }
    await p.fill('#name', name);
    await p.click(`#swatches label:nth-child(${n + 1})`);
    await p.click('#join-btn');
    await p.waitForSelector('#team:not([hidden])');
    phones.push(p);
  }
  await tv.waitForFunction(() => document.querySelectorAll('#teams li').length === 3);
  await tv.waitForTimeout(600);
  await scrollArea(host, 0);
  await shot(host, 'brand-host-lobby');
  await glassPairs([[tv, 'tv-lobby']]);

  // A board game: the logo small in the TV's corner, and in the host bar.
  srv.hub.dispatch({ type: 'settings', settings: { round2: false, finalRound: false } });
  await host.click('#start');
  await host.waitForSelector('.host-board');
  await tv.waitForSelector('.tv-board');
  await logoShown(tv, '.display > .wordmark img');
  assert.equal(await tv.isVisible('.display > .wordmark'), true);
  // The corner logo doesn't sit on top of the board.
  const corner = await tv.locator('.display > .wordmark').boundingBox();
  const board = await tv.locator('.tv-board').boundingBox();
  assert.ok(corner.y + corner.height <= board.y, `the corner logo overlaps the board (${corner.y + corner.height} > ${board.y})`);
  await glassPairs([[tv, 'tv-board'], [host, 'host-board']]);

  await host.click('.host-board .col:nth-child(1) .tile:nth-of-type(2)');
  await tv.waitForSelector('.tv-q');
  await tv.waitForTimeout(500);
  await glassPairs([[tv, 'tv-question'], [phones[0], 'phone-buzzer']]);
  await host.keyboard.press('Escape'); // put the question back
  await phase(host, 'board');
  await host.keyboard.press('e'); // end the board
  await host.waitForSelector('dialog.pq-modal[open]');
  await host.keyboard.press('Enter'); // yes, end it
  await tv.waitForSelector('.tv-over');
  await tv.waitForTimeout(600);
  // The end screen: the logo big with the name, not in the corner too.
  await logoShown(tv, '.tv-over .tv-brand img');
  assert.match(await tv.textContent('.tv-over .tv-brand'), /Nordlys Christmas Quiz/);
  assert.equal(await tv.isHidden('.display > .wordmark'), true);
  await glassPairs([[tv, 'tv-over']]);

  // A Quick quiz to the podium, with the same branding.
  srv.hub.dispatch({ type: 'restart' });
  await phase(host, 'lobby');
  await host.selectOption('#set-picker', 'quick-sample');
  await host.waitForSelector('body[data-mode=quick]', { state: 'attached' });
  srv.hub.dispatch({ type: 'join', teamId: 'bot-bea', name: 'Bea', color: COLORS[4] });
  await host.click('#start');
  const state = () => srv.hub.getState();
  await waitFor(() => state().phase === 'section');
  await tv.waitForTimeout(400);
  await shot(tv, 'brand-tv-quick-section');
  srv.hub.dispatch({ type: 'next' });
  await waitFor(() => state().phase === 'ready');
  srv.hub.dispatch({ type: 'next' });
  await waitFor(() => state().phase === 'open');
  await tv.waitForSelector('.q-opts, .quick-q', { timeout: 5000 }).catch(() => {});
  await tv.waitForTimeout(500);
  await glassPairs([[tv, 'tv-quick-open']]);
  srv.hub.dispatch({ type: 'answer', teamId: 'bot-bea', option: 0, at: Date.now(), slack: 0 });
  for (let n = 0; n < 80 && state().phase !== 'over'; n++) {
    srv.hub.dispatch({ type: ['ready', 'open'].includes(state().phase) ? 'skip' : 'next' });
  }
  await phase(host, 'over');
  await tv.waitForSelector('.quick-podium');
  await tv.waitForTimeout(4200); // the podium rises 3rd, 2nd, 1st
  await logoShown(tv, '.quick-podium .tv-brand img');
  await glassPairs([[tv, 'tv-quick-podium']]);

  // A dark PNG logo on a white backing, with a colour of your own.
  srv.hub.dispatch({ type: 'restart' });
  await phase(host, 'lobby');
  await host.waitForSelector('#group-look[open]');
  await host.setInputFiles('#brand-file', pngLogo);
  await host.waitForFunction(() => /\.png$/.test(document.querySelector('#brand-preview img')?.getAttribute('src') ?? ''));
  await host.check('#brand-plate');
  await host.waitForSelector('#brand-preview img.plate');
  // Your own colour: ProQuiz's colour box (not the browser's picker). Cancel puts the old colour back.
  const accentBefore = await host.evaluate(() => document.body.dataset.accent ?? '');
  await host.click('#brand-color');
  await host.waitForSelector('dialog.pq-modal .pq-color');
  await host.locator('dialog.pq-modal .pq-range.hue').fill('20');
  await host.waitForTimeout(400);
  await shot(host, 'brand-host-color-box');
  await host.click('dialog.pq-modal button[value=cancel]');
  await host.waitForFunction((was) => (document.body.dataset.accent ?? '') === was, accentBefore);
  await host.click('#brand-color');
  await host.locator('dialog.pq-modal .pq-color-hex').fill('#c2410c');
  await host.click('dialog.pq-modal button[value=ok]');
  await host.waitForFunction(() => document.body.dataset.accent === '#c2410c');
  await host.waitForSelector('.accent.custom.on');
  assert.match(await host.textContent('#brand-accent-name'), /Your own colour/);
  await host.locator('#group-look').scrollIntoViewIfNeeded();
  await shot(host, 'brand-host-settings-plate', { clip: await host.locator('#settings').boundingBox().then((b) => ({ x: b.x, y: 0, width: b.width, height: 768 })) });
  await tv.waitForSelector('#tv-brand img.plate');
  await logoShown(tv, '#tv-brand img');
  await tv.waitForTimeout(300);
  await shot(tv, 'brand-plate-tv-lobby');
  const fresh = await open('/', { width: 390, height: 844 }, 'fresh phone');
  await logoShown(fresh, '.join-head img.plate');
  await shot(fresh, 'brand-plate-phone-join');

  // The editor shows the logo and the colour too.
  const ed = await open('/editor', { width: 1366, height: 768 }, 'editor');
  await logoShown(ed, '.host-bar .wordmark img');
  await ed.waitForFunction(() => document.body.dataset.accent === '#c2410c');
  await shot(ed, 'brand-editor');
  await ed.close();

  // A file that isn't a picture is refused with a clear message, and the logo stays.
  await host.setInputFiles('#brand-file', notAPicture);
  await host.waitForSelector('#brand-logo-msg.error');
  assert.match(await host.textContent('#brand-logo-msg'), /can’t use that file/);
  assert.match((await brandNow()).logo, /\.png$/);

  // Remove the logo: "ProQuiz" is back everywhere; the name and colour stay.
  await host.click('#brand-remove');
  await host.waitForSelector('#brand-preview.empty');
  await tv.waitForFunction(() => document.querySelector('.display > .wordmark').textContent === 'ProQuiz');
  await fresh.waitForFunction(() => document.querySelector('.join-head .wordmark').textContent === 'ProQuiz');
  assert.equal((await brandNow()).name, 'Nordlys Christmas Quiz');
  await tv.waitForTimeout(300);
  await shot(tv, 'brand-name-only-tv-lobby');

  // Back to ProQuiz's own violet: the page's colours are exactly the built-in ones again.
  await host.click('label.accent:has(> input[value=violet])');
  await tv.waitForFunction(() => document.body.dataset.accent === '' && document.documentElement.style.getPropertyValue('--light-rgb') === '');

  assert.deepEqual(errors, []);
  console.log('Branding e2e passed. Screenshots in test/screenshots/brand-*.png');
} finally {
  await browser.close();
  await srv.close();
}

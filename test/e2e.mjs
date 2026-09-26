// Browser test: one host laptop, one TV and three phones, each in its own browser context.
//
//   npm install && npm run e2e
//
// Needs Chromium (CHROMIUM=/path/to/chromium if not /usr/bin/chromium).
// Screenshots go to test/screenshots/ (ignored by git). Look at them after UI changes.

import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { startServer } from '../server.js';

const shots = fileURLToPath(new URL('./screenshots', import.meta.url));
mkdirSync(shots, { recursive: true });

const srv = await startServer({ port: 3456, quiet: true });
const base = `http://127.0.0.1:${srv.info.port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/usr/bin/chromium' });
const errors = [];

async function open(path, viewport, label) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: viewport.width < 500 ? 2 : 1 });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${label}: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && errors.push(`${label}: ${m.text()}`));
  await page.goto(base + path);
  return page;
}
const shot = (page, name) => page.screenshot({ path: `${shots}/${name}.png` });

try {
  const host = await open('/host', { width: 1366, height: 768 }, 'host');
  const tv = await open('/display', { width: 1920, height: 1080 }, 'tv');
  await host.waitForSelector('#lobby:not([hidden])');
  await tv.waitForSelector('#lobby:not([hidden])');
  await shot(host, 'host-1-empty');

  const phones = [];
  for (const [name, n] of [['Quizzy Rascals', 0], ['Blue Steel', 1], ['Lemon Heads', 3]]) {
    const p = await open('/', { width: 390, height: 844 }, name);
    await p.waitForSelector('#join:not([hidden])');
    if (!phones.length) await shot(p, 'phone-1-join');
    await p.fill('#name', name);
    await p.click(`#swatches label:nth-child(${n + 1})`);
    await p.click('#join-btn');
    await p.waitForSelector('#team:not([hidden])');
    phones.push(p);
  }
  await shot(phones[0], 'phone-2-joined');

  // Taken colours are shown as taken on a new phone.
  const fourth = await open('/', { width: 390, height: 844 }, 'fourth');
  await fourth.waitForSelector('#join:not([hidden])');
  assert.equal(await fourth.locator('.swatch.taken').count(), 3);
  await shot(fourth, 'phone-3-taken');

  await host.waitForFunction(() => document.querySelectorAll('#teams li').length === 3);
  assert.equal(await host.locator('#teams .dot.on').count(), 3);
  await tv.waitForFunction(() => document.querySelectorAll('#teams li').length === 3);
  await shot(host, 'host-2-teams');
  await tv.waitForTimeout(500); // let the pop-in finish
  await shot(tv, 'tv-1-lobby');

  // Reloading a phone keeps the team (no join form again).
  await phones[1].reload();
  await phones[1].waitForSelector('#team:not([hidden])');
  assert.equal(await phones[1].textContent('#me'), 'Blue Steel');

  // Switching to Norwegian changes the phones and the TV.
  await host.selectOption('select[name=lang]', 'no');
  await phones[0].waitForFunction(() => document.body.textContent.includes('Du er med!'));
  await tv.waitForFunction(() => document.body.textContent.includes('Skann for å bli med'));
  await shot(tv, 'tv-2-lobby-no');
  await host.selectOption('select[name=lang]', 'en');

  // A setting changed on the host reaches the game.
  await host.selectOption('select[name=penalty]', 'full');
  await host.waitForFunction(() => true);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(srv.hub.getState().settings.penalty, 'full');

  await host.click('#start');
  await host.waitForSelector('#game:not([hidden])');

  assert.deepEqual(errors, []);
  console.log('e2e: all good. Screenshots in test/screenshots/');
} finally {
  await browser.close();
  await srv.close();
}

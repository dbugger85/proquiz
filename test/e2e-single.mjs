// Browser test for single-screen mode: the host laptop and phones, but no separate TV screen.
//   npm run e2e   (runs this after the other browser tests)

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { startServer } from '../server.js';

const shots = fileURLToPath(new URL('./screenshots', import.meta.url));
const srv = await startServer({ port: 3458, quiet: true, dataDir: mkdtempSync(join(tmpdir(), 'proquiz-single-')) });
const base = `http://127.0.0.1:${srv.info.port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/usr/bin/chromium' });
const errors = [];
const state = () => srv.hub.getState();

async function open(path, viewport, label) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${label}: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && errors.push(`${label}: ${m.text()}`));
  await page.goto(base + path);
  return page;
}

try {
  const host = await open('/host', { width: 1366, height: 768 }, 'host');
  host.on('dialog', (d) => d.accept());
  const phones = [];
  for (const [name, n] of [['Quizzy Rascals', 0], ['Blue Steel', 1]]) {
    const p = await open('/', { width: 390, height: 844 }, name);
    await p.waitForSelector('#join:not([hidden])');
    await p.fill('#name', name);
    await p.click(`#swatches label:nth-child(${n + 1})`);
    await p.click('#join-btn');
    await p.waitForSelector('#team:not([hidden])');
    phones.push(p);
  }
  const [red, blue] = phones;

  await host.click('#start');
  await host.waitForSelector('body[data-phase=board]');
  // No TV screen is open, so the laptop shows the TV view with the controls underneath.
  await host.waitForSelector('.stage-area:not([hidden]) iframe');
  const tv = host.frameLocator('.stage-area iframe');
  await tv.locator('.tv-board button.tile').first().waitFor();
  assert.equal(await host.locator('.host-game').count(), 0);

  // Click a tile on the big board.
  await tv.locator('.tv-board .col:nth-child(1) button.tile').nth(1).click(); // Capitals 200
  await host.waitForSelector('body[data-phase=reading]');
  await tv.locator('.tv-q').waitFor();
  // The answer is nowhere on the screen.
  assert.doesNotMatch(await host.locator('body').innerText(), /Rome/);
  assert.doesNotMatch(await tv.locator('body').innerText(), /Rome/);
  await host.waitForTimeout(500);
  await host.screenshot({ path: `${shots}/single-1-question.png` });

  // Keys work even after clicking inside the TV view (they are passed on).
  await tv.locator('body').press('Space');
  await host.waitForSelector('body[data-phase=armed]');
  await red.waitForSelector('.buzzer.live');
  await red.click('.buzzer');
  await host.waitForSelector('body[data-phase=answering]');
  await host.keyboard.press('y');
  await host.waitForSelector('body[data-phase=revealed]');
  await tv.locator('.tv-q .answer').waitFor();
  assert.match(await tv.locator('.tv-q .answer').innerText(), /Rome/);

  // H peeks at the host view (with the answer and a warning), and H again goes back.
  await host.keyboard.press('h');
  await host.waitForSelector('.host-game .peek-note');
  assert.match(await host.locator('.host-q .answer').innerText(), /Rome/);
  await host.screenshot({ path: `${shots}/single-2-host-view.png` });
  await host.keyboard.press('h');
  await host.waitForSelector('.stage-area:not([hidden])');
  assert.equal(await host.locator('.host-game').count(), 0);

  // Undo goes back one step: from the reveal to Red answering.
  await host.keyboard.press('u');
  await host.waitForSelector('body[data-phase=answering]');
  await host.keyboard.press('y');
  await host.waitForSelector('body[data-phase=revealed]');
  await host.keyboard.press('Space');
  await host.waitForSelector('body[data-phase=board]');

  // Opening a separate TV screen turns this page back into the host view.
  const realTv = await open('/display', { width: 1280, height: 720 }, 'tv');
  await host.waitForSelector('.host-game .host-board');
  assert.equal(await host.locator('.stage-area').count(), 0);
  assert.equal(await host.locator('.peek-note').count(), 0);
  await realTv.close();
  await host.waitForSelector('.stage-area:not([hidden]) iframe');

  assert.equal(state().teams.find((t) => t.name === 'Quizzy Rascals').score, 200);
  assert.deepEqual(errors, []);
  console.log('e2e single screen: all good. Screenshots in test/screenshots/single-*');
} catch (err) {
  console.log(errors);
  throw err;
} finally {
  await browser.close();
  await srv.close();
}

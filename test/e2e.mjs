// Browser test: one host laptop, one TV and three phones, each in its own browser context.
//
//   npm install && npm run e2e
//
// Needs Chromium (CHROMIUM=/path/to/chromium if not /usr/bin/chromium).
// Screenshots go to test/screenshots/ (ignored by git). Look at them after UI changes.

import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { startServer } from '../server.js';

const shots = fileURLToPath(new URL('./screenshots', import.meta.url));
mkdirSync(shots, { recursive: true });

const srv = await startServer({ port: 3456, quiet: true, dataDir: mkdtempSync(join(tmpdir(), 'proquiz-e2e-')) });
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
async function waitFor(check, ms = 3000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}
const shot = (page, name) => page.screenshot({ path: `${shots}/${name}.png` });

try {
  const host = await open('/host', { width: 1366, height: 768 }, 'host');
  const tv = await open('/display', { width: 1920, height: 1080 }, 'tv');
  await host.waitForSelector('#lobby:not([hidden])');
  await tv.waitForSelector('#lobby:not([hidden])');
  await shot(host, 'host-1-empty');
  await shot(tv, 'tv-0-sound-hint');
  await tv.mouse.click(5, 5); // a click lets the TV play sound; every sound below must play without errors
  await tv.waitForSelector('#sound-unlock[hidden]', { state: 'attached' });

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
  await waitFor(() => srv.hub.getState().settings.penalty === 'full');
  await host.selectOption('select[name=penalty]', 'half');

  host.on('dialog', (d) => d.accept());
  const score = (name) => srv.hub.getState().teams.find((tm) => tm.name === name).score;
  const [red, blue, yellow] = phones;

  await host.click('#start');
  await host.waitForSelector('.host-board');
  await tv.waitForSelector('.tv-board');
  await shot(host, 'host-3-board');
  await shot(tv, 'tv-3-board');

  // Pick "Capitals 200". The host sees the answer, the TV doesn't.
  await host.click('.host-board .col:nth-child(1) .tile:nth-of-type(2)');
  await tv.waitForSelector('.tv-q');
  assert.match(await host.textContent('.host-q .answer'), /Rome/);
  assert.doesNotMatch(await tv.textContent('body'), /Rome/);
  await red.waitForSelector('.buzzer:not(.live)');

  // Buzzing while the host reads is too early.
  await yellow.click('.buzzer');
  await yellow.waitForFunction(() => document.body.textContent.includes('Too early!'));
  await tv.waitForTimeout(450);
  await shot(tv, 'tv-4-question');
  await shot(yellow, 'phone-4-too-early');

  // Space turns the buzzers on.
  await host.keyboard.press('Space');
  await red.waitForSelector('.buzzer.live');
  await shot(red, 'phone-5-armed');
  await shot(host, 'host-4-armed');

  await blue.click('.buzzer');
  await blue.waitForFunction(() => document.body.textContent.includes('You’re first!'));
  await red.waitForFunction(() => document.body.textContent.includes('Blue Steel was first'));
  await tv.waitForSelector('.tv-takeover');
  await shot(blue, 'phone-6-first');
  await shot(red, 'phone-7-other');
  await tv.waitForTimeout(700);
  await shot(tv, 'tv-5-buzzed');
  await shot(host, 'host-5-answering');

  // N = wrong: Blue loses half (100) and is out; the others can buzz again.
  await host.keyboard.press('n');
  await blue.waitForFunction(() => document.body.textContent.includes('Sit this one out'));
  assert.equal(score('Blue Steel'), -100);
  await red.waitForSelector('.buzzer.live');
  await shot(tv, 'tv-6-wrong-reopen');

  await red.click('.buzzer');
  await host.waitForSelector('.btn-good');
  await host.keyboard.press('y');
  await tv.waitForSelector('.tv-q .answer');
  assert.equal(score('Quizzy Rascals'), 200);
  assert.match(await tv.textContent('.tv-q .answer'), /Rome/);
  await tv.waitForTimeout(500);
  await shot(tv, 'tv-7-revealed');
  await shot(red, 'phone-8-correct');

  // U = undo, then judge again.
  await host.keyboard.press('u');
  await host.waitForSelector('.btn-good');
  assert.equal(score('Quizzy Rascals'), 0);
  await host.keyboard.press('y');
  await waitFor(() => score('Quizzy Rascals') === 200);
  await host.waitForSelector('.controls button:has-text("Back to the board")');

  // Space back to the board: the tile is used and Red picks.
  await host.keyboard.press('Space');
  await tv.waitForSelector('.tv-board');
  assert.equal(await tv.locator('.tv-board .tile.used').count(), 1);
  assert.match(await tv.textContent('.tv-picks'), /Quizzy Rascals picks/);
  await shot(tv, 'tv-8-board-after');

  // The host gives up on a question: R shows the answer.
  await host.click('.host-board .col:nth-child(2) .tile:nth-of-type(1)');
  await host.waitForSelector('.host-q');
  await host.keyboard.press('r');
  await tv.waitForSelector('.tv-q .answer');
  assert.match(await tv.textContent('.tv-q .band'), /Nobody got it/);
  await host.waitForSelector('.controls button:has-text("Back to the board")');
  await host.keyboard.press('Space');
  await host.waitForSelector('.host-board');

  // End the board (there's a final question, whose screens come later), then finish.
  await host.waitForSelector('.controls button:has-text("End the board")');
  await host.keyboard.press('e');
  await host.waitForSelector('body[data-phase=finalWager]');
  for (const phase of ['finalQuestion', 'finalJudge', 'over']) {
    await host.keyboard.press('Space');
    await host.waitForSelector(`body[data-phase=${phase}]`);
  }
  await tv.waitForSelector('.tv-over');
  await red.waitForFunction(() => document.body.textContent.includes('Place 1 of 3'));
  await shot(tv, 'tv-9-over');
  await shot(host, 'host-6-over');
  await shot(red, 'phone-9-over');

  assert.deepEqual(errors, []);
  console.log('e2e: all good. Screenshots in test/screenshots/');
} catch (err) {
  // Show what every screen said when it went wrong.
  for (const ctx of browser.contexts()) for (const pg of ctx.pages()) console.log(pg.url(), '→', (await pg.textContent('body')).replace(/\s+/g, ' ').slice(0, 300));
  console.log(errors);
  throw err;
} finally {
  await browser.close();
  await srv.close();
}

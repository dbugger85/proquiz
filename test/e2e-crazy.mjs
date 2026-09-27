// Browser test for Kaosmodus / Crazy mode: one of each special, with screenshots.
//   npm run e2e   (runs this after test/e2e.mjs)

import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { startServer } from '../server.js';

const shots = fileURLToPath(new URL('./screenshots', import.meta.url));
mkdirSync(shots, { recursive: true });
const srv = await startServer({ port: 3457, quiet: true, dataDir: mkdtempSync(join(tmpdir(), 'proquiz-crazy-')) });
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
async function shot(page, name) {
  const text = await page.evaluate(() => document.body.innerText);
  const bad = text.match(/[^\n]*(\b(null|undefined|NaN)\b|\[object \w+\])[^\n]*/);
  assert.equal(bad, null, `${name} shows a broken value: ${JSON.stringify(bad?.[0])}`);
  await page.screenshot({ path: `${shots}/${name}.png` });
}
async function waitFor(check, ms = 8000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}
const state = () => srv.hub.getState();
const score = (name) => state().teams.find((tm) => tm.name === name).score;

try {
  const host = await open('/host', { width: 1366, height: 768 }, 'host');
  host.on('dialog', (d) => d.accept());
  const tv = await open('/display', { width: 1920, height: 1080 }, 'tv');
  await tv.mouse.click(5, 5);
  const phones = [];
  for (const [name, n] of [['Quizzy Rascals', 0], ['Blue Steel', 1], ['Lemon Heads', 3]]) {
    const p = await open('/', { width: 390, height: 844 }, name);
    await p.waitForSelector('#join:not([hidden])');
    await p.fill('#name', name);
    await p.click(`#swatches label:nth-child(${n + 1})`);
    await p.click('#join-btn');
    await p.waitForSelector('#team:not([hidden])');
    phones.push(p);
  }
  const [red, blue, yellow] = phones;
  const id = (name) => state().teams.find((tm) => tm.name === name).id;

  // The lobby setting.
  await host.selectOption('select[name=crazy]', 'lots');
  await waitFor(() => state().settings.crazy === 'lots');
  // Leave the jackpot out.
  await host.waitForSelector('#crazy-kinds:not([hidden])');
  await host.uncheck('#crazy-kind-list input[value=jackpot]');
  await waitFor(() => state().settings.crazyExclude.join() === 'jackpot');
  await host.evaluate(() => document.querySelector('#settings').scrollIntoView({ block: 'end' }));
  await shot(host, 'crazy-0-lobby');
  await host.check('#crazy-kind-list input[value=jackpot]'); // back on: the game below uses every special
  await waitFor(() => state().settings.crazyExclude.length === 0);

  // Start with one of each special in known places (normally the server places them at random).
  const specials = { '0-0': 'triple', '0-1': 'bomb', '0-2': 'hotseat', '0-3': 'rescue', '0-4': 'jackpot', '1-0': 'freeze', '1-1': 'turbo' };
  srv.hub.dispatch({ type: 'start', picker: id('Quizzy Rascals'), specials });
  await host.waitForSelector('body[data-phase=board]');
  assert.equal(await host.locator('.host-board .tile[data-special]').count(), 7);
  assert.equal(await tv.locator('text=💣').count(), 0); // the TV doesn't know
  await shot(host, 'crazy-1-host-board');

  const tile = (c, i) => host.click(`.host-board .col:nth-child(${c + 1}) .tile:nth-of-type(${i + 1})`);
  const phase = (p) => host.waitForSelector(`body[data-phase=${p}]`);
  const reveal = async (c, i, name) => {
    await tile(c, i);
    await phase('special');
    await tv.waitForSelector('.tv-special.spin');
    await red.waitForFunction(() => document.body.textContent.includes('Look at the TV!'));
    await tv.waitForTimeout(2700); // the reel spins and lands
    await shot(tv, `crazy-${name}-tv`);
  };
  const space = async (then) => {
    await host.keyboard.press('Space');
    await phase(then);
  };

  // Triple: 100 becomes 300.
  await reveal(0, 0, 'triple');
  await shot(red, 'crazy-phone-look-tv');
  await shot(host, 'crazy-triple-host');
  await space('reading');
  await tv.waitForFunction(() => document.body.textContent.includes('100 ×3'));
  await space('armed');
  await blue.waitForSelector('.buzzer.live');
  await blue.click('.buzzer');
  await phase('answering');
  await host.keyboard.press('y');
  await phase('revealed');
  assert.equal(score('Blue Steel'), 300);
  await space('board');

  // Bomb: Blue picks it and loses 200 at once.
  await reveal(0, 1, 'bomb');
  await space('revealed');
  await tv.waitForSelector('.tv-boom');
  await blue.waitForFunction(() => document.body.textContent.includes('BOOM! −200'));
  await tv.waitForTimeout(800);
  await shot(tv, 'crazy-bomb-boom-tv');
  await shot(blue, 'crazy-bomb-phone');
  assert.equal(score('Blue Steel'), 100);
  await space('board');

  // Hot seat: only Blue answers; wrong costs half of 300.
  await reveal(0, 2, 'hotseat');
  await space('reading');
  await red.waitForFunction(() => document.body.textContent.includes('Blue Steel answers alone'));
  await blue.waitForFunction(() => document.body.textContent.includes('Your turn, alone!'));
  await shot(blue, 'crazy-hotseat-phone');
  await shot(tv, 'crazy-hotseat-question-tv');
  await space('answering');
  await host.keyboard.press('n');
  await phase('revealed');
  assert.equal(score('Blue Steel'), -50);
  await space('board');

  // Rescue: Blue is last, answers alone and gets it.
  await reveal(0, 3, 'rescue');
  await space('reading');
  assert.equal(state().q.solo, id('Blue Steel'));
  await space('answering');
  await host.keyboard.press('y');
  await phase('revealed');
  assert.equal(score('Blue Steel'), 350);
  await space('board');

  // Freeze: Blue freezes Red.
  await reveal(1, 0, 'freeze');
  await host.click('.freeze-pick button:has-text("Quizzy Rascals")');
  await tv.waitForFunction(() => document.body.textContent.includes('Quizzy Rascals is frozen!'));
  await shot(host, 'crazy-freeze-host');
  await space('reading');
  await space('armed');
  await red.waitForFunction(() => document.body.textContent.includes('Frozen!'));
  await shot(red, 'crazy-freeze-phone');
  await yellow.click('.buzzer');
  await phase('answering');
  await host.keyboard.press('y');
  await phase('revealed');
  assert.equal(score('Lemon Heads'), 100);
  await space('board');

  // Jackpot: the pot holds the bomb's 200 and the hot seat's 150.
  await reveal(0, 4, 'jackpot');
  await tv.waitForFunction(() => document.body.textContent.includes('win 350 extra points'));
  await space('reading');
  await space('armed');
  await red.click('.buzzer');
  await phase('answering');
  await host.keyboard.press('y');
  await phase('revealed');
  assert.equal(score('Quizzy Rascals'), 500 + 350);
  await tv.waitForTimeout(500);
  await shot(tv, 'crazy-jackpot-won-tv');
  await space('board');

  // Turbo: Red gets three questions, 5 seconds each, no penalty.
  await reveal(1, 1, 'turbo');
  await space('reading');
  await tv.waitForFunction(() => document.body.textContent.includes('⚡ 1/3'));
  const before = score('Quizzy Rascals');
  await space('answering');
  await tv.waitForTimeout(900); // let the colour flash settle
  await shot(tv, 'crazy-turbo-tv');
  await host.keyboard.press('y');
  await phase('revealed');
  await space('reading');
  await tv.waitForFunction(() => document.body.textContent.includes('⚡ 2/3'));
  await space('answering');
  await host.keyboard.press('n');
  await phase('revealed');
  await space('reading');
  await space('answering');
  await shot(red, 'crazy-turbo-phone');
  await phase('revealed').catch(() => {});
  await waitFor(() => state().phase === 'revealed', 7000); // time runs out: no penalty
  assert.ok(score('Quizzy Rascals') >= before);
  await space('board');
  assert.equal(state().turbo, null);

  assert.deepEqual(errors, []);
  console.log('e2e crazy: all good. Screenshots in test/screenshots/crazy-*');
} catch (err) {
  for (const ctx of browser.contexts()) for (const pg of ctx.pages()) console.log(pg.url(), '→', (await pg.textContent('body')).replace(/\s+/g, ' ').slice(0, 300));
  console.log(errors);
  throw err;
} finally {
  await browser.close();
  await srv.close();
}

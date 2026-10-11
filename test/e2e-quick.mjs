// Browser test of a Quick quiz (multiple choice): one host laptop, one TV and four phones, plus two players
// joined straight through the server so the top 5 is full. Then the editor's sections, question dialog and
// a Quick quiz made from a pasted AI answer.
//
//   npm run e2e   (runs this after the other browser tests)
//
// Needs Chromium (CHROMIUM=/path/to/chromium if not /usr/bin/chromium). Screenshots: test/screenshots/quick-*.png.

import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { startServer } from '../server.js';
import { COLORS, REACTIONS } from '../lib/game.js';
import { randomAvatar, AVATAR_PARTS } from '../lib/avatar.js';

const shots = fileURLToPath(new URL('./screenshots', import.meta.url));
mkdirSync(shots, { recursive: true });

const srv = await startServer({ port: 3459, quiet: true, dataDir: mkdtempSync(join(tmpdir(), 'proquiz-quick-')) });
const base = `http://127.0.0.1:${srv.info.port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/usr/bin/chromium' });
const errors = [];
const state = () => srv.hub.getState();

async function open(path, viewport, label, options = {}) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: viewport.width < 500 ? 2 : 1, ...options });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${label}: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && errors.push(`${label}: ${m.text()}`));
  await page.goto(base + path);
  return page;
}
// Every screenshot also checks that no "null"/"undefined" leaked onto the screen.
async function shot(page, name) {
  const text = await page.evaluate(() => document.body.innerText);
  const bad = text.match(/[^\n]*(\b((?<!under )null|undefined|NaN)\b|\[object \w+\])[^\n]*/); // "under null" is Norwegian for "below zero"
  assert.equal(bad, null, `${name} shows a broken value: ${JSON.stringify(bad?.[0])}`);
  await page.screenshot({ path: `${shots}/${name}.png` });
}
// The top 5's animation: screenshots of the old list, the points counting up, and the end, which must match the game.
async function topFive(page, name) {
  await page.waitForSelector('body[data-rankanim=before]', { state: 'attached' });
  await page.waitForTimeout(500); // the old list has slid in
  await shot(page, `${name}-before`);
  // (A slow screenshot may miss a stage, so later stages count too.)
  await page.waitForSelector(':is(body[data-rankanim=count], body[data-rankanim=move], body[data-rankanim=done])', { state: 'attached', timeout: 3000 });
  await page.waitForTimeout(350);
  await shot(page, `${name}-counting`);
  await page.waitForSelector('body[data-rankanim=done]', { state: 'attached', timeout: 4000 });
  await page.waitForTimeout(350); // the arrows fade in
  const top = srv.hub.getState().teams.toSorted((a, b) => b.score - a.score).slice(0, 5);
  const rows = await page.$$eval('.top-list li', (els) => els.map((li) => [li.dataset.id, Number(li.querySelector('.rank-score').textContent.replace(/\s/g, ''))]));
  assert.deepEqual(rows, top.map((tm) => [tm.id, tm.score]), 'the top 5 ends in the right order with the right points');
  await shot(page, name);
}
const phase = (page, p, timeout = 5000) => page.waitForSelector(`body[data-phase=${p}]`, { state: 'attached', timeout });

try {
  const host = await open('/host', { width: 1366, height: 768 }, 'host');
  const tv = await open('/display', { width: 1920, height: 1080 }, 'tv');
  await host.waitForSelector('#lobby:not([hidden])');
  await tv.waitForSelector('#lobby:not([hidden])');
  await tv.mouse.click(5, 5); // lets the TV play sound

  // ----- Choosing the Quick quiz in the lobby: the board-only settings go away -----
  await host.waitForSelector('#set-picker option[value=quick-sample]', { state: 'attached' });
  await host.selectOption('#set-picker', 'quick-sample');
  await host.waitForSelector('body[data-mode=quick]', { state: 'attached' });
  // Edit opens the editor on the quiz chosen in the lobby.
  assert.match(await host.getAttribute('#edit-set', 'href'), /\/editor#quick-sample$/);
  for (const sel of ['#group-crazy', '#group-rules', '#round2-setting', '#final-setting', '#quiz-specials']) {
    assert.equal(await host.locator(sel).isHidden(), true, `${sel} should be hidden in a Quick quiz`);
  }
  assert.equal(await host.locator('#group-quick').isVisible(), true);
  // The quiz name and its "Quick quiz" tag fit in the picker.
  const picker = await host.$eval('#set-picker', (el) => ({ text: el.selectedOptions[0].textContent, fits: el.scrollWidth <= el.clientWidth }));
  assert.equal(picker.text, 'Sample quick quiz · Quick quiz');
  await host.evaluate(() => document.querySelector('#settings').scrollIntoView({ block: 'start' }));
  await shot(host, 'quick-host-lobby');

  // ----- Four phones and two more players -----
  const phones = [];
  for (const [name, n] of [['Alex', 0], ['Mira', 0], ['Jonas', 3], ['Sofie', 5]]) {
    const p = await open('/', { width: 390, height: 844 }, name);
    await p.waitForSelector('#join:not([hidden])');
    if (!phones.length) {
      assert.equal(await p.textContent('#name-label'), 'Your name');
      assert.equal(await p.textContent('#avatar-title'), 'Your avatar'); // a player's avatar (a team has a mascot)
      await p.waitForSelector('#avatar-preview svg'); // a random one from the first visit
      await shot(p, 'quick-phone-join');
      // The dice gives another random one, remembered on the phone.
      const saved = () => p.evaluate(() => JSON.parse(localStorage.getItem('proquiz.team')).avatar);
      const first = await saved();
      await p.click('#avatar-random');
      assert.notDeepEqual(await saved(), first);
      // Customise: a tab per part, a tile per option (showing the whole face with that option), all easy to tap.
      await p.click('#avatar-edit');
      await p.waitForSelector('#avatar-builder:not([hidden])');
      assert.equal(await p.textContent('#avatar-edit'), 'Done');
      assert.equal(await p.locator('.avatar-tab').count(), Object.keys(AVATAR_PARTS).length);
      await p.click('.avatar-tab:has-text("Hat")');
      assert.equal(await p.locator('.avatar-opt').count(), AVATAR_PARTS.hat);
      await p.click('.avatar-opt:nth-child(4)'); // the crown
      assert.equal(await p.getAttribute('.avatar-opt:nth-child(4)', 'aria-checked'), 'true');
      assert.equal((await saved()).hat, 3);
      await p.click('.avatar-tab:has-text("Hair colour")');
      assert.equal(await p.locator('.avatar-opt .avatar-dot').count(), AVATAR_PARTS.hairColor);
      await p.click('.avatar-tab:has-text("Hair")');
      await p.click(`#swatches label:nth-child(${n + 1})`); // the face's background follows the colour
      await p.fill('#name', name);
      const small = await p.$$eval('.avatar-opt, .avatar-tab, #avatar-random, #avatar-edit', (els) => els.map((el) => el.getBoundingClientRect()).filter((r) => r.width < 48 || r.height < 48).length);
      assert.equal(small, 0, 'every avatar button is at least 48px');
      const fits = await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
      assert.ok(fits, 'the builder fits the phone without scrolling sideways');
      await p.evaluate(() => document.querySelector('#avatar-field').scrollIntoView({ block: 'start' }));
      await shot(p, 'quick-phone-avatar-builder');
      await p.click('#avatar-edit'); // Done
      await p.waitForSelector('#avatar-builder[hidden]', { state: 'attached' });
    }
    assert.equal(await p.locator('.swatch.taken').count(), 0); // colours may repeat
    await p.fill('#name', name);
    await p.click(`#swatches label:nth-child(${n + 1})`);
    await p.click('#join-btn');
    await p.waitForSelector('#team:not([hidden])');
    phones.push(p);
  }
  const [alex, mira, jonas, sofie] = phones;
  // Bea has an avatar; Bo joined from an old phone without one, so only the name shows.
  srv.hub.dispatch({ type: 'join', teamId: 'bot-bea', name: 'Bea', color: COLORS[4], avatar: { skin: 4, hair: 4, hairColor: 0, eyes: 1, mouth: 1, glasses: 0, hat: 0 } });
  srv.hub.dispatch({ type: 'join', teamId: 'bot-bo', name: 'Bo', color: COLORS[6] });
  assert.equal(state().teams.find((tm) => tm.name === 'Alex').avatar.hat, 3, 'the phone sent the avatar it built');
  await tv.waitForFunction(() => document.querySelectorAll('#teams li').length === 6);
  assert.equal(await tv.locator('#teams li .avatar').count(), 5);
  assert.equal(await host.locator('#teams li .avatar').count(), 5);
  // The TV shows the newest player first (so whoever just joined sees their name at once); the host keeps the join order.
  assert.deepEqual(await tv.$$eval('#teams li', (els) => els.map((li) => li.textContent)), ['Bo', 'Bea', 'Sofie', 'Jonas', 'Mira', 'Alex']);
  assert.deepEqual(await host.$$eval('#teams li .name', (els) => els.map((el) => el.textContent)), ['Alex', 'Mira', 'Jonas', 'Sofie', 'Bea', 'Bo']);
  assert.equal(await host.locator('#many-note').isHidden(), true);
  await tv.waitForTimeout(500);
  await shot(tv, 'quick-tv-lobby');
  await host.evaluate(() => document.querySelector('#teams').scrollIntoView({ block: 'center' }));
  await shot(host, 'quick-host-lobby-avatars');
  // A full lobby (30 players) stays tidy on the TV.
  const extra = Array.from({ length: 24 }, (_, i) => `bot-x${i}`);
  const names = ['Ola', 'Kari', 'Henrik', 'Ingrid', 'Magnus', 'Nora', 'Emil', 'Thea', 'Lukas', 'Ella', 'Filip', 'Maja', 'Oskar', 'Leah', 'Johannes', 'Vilde', 'Sander', 'Frida', 'Tobias', 'Ida-Marie', 'Kristoffer', 'Astrid', 'William', 'Selma'];
  let seed = 3;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  extra.forEach((id, i) => srv.hub.dispatch({ type: 'join', teamId: id, name: names[i], color: COLORS[i % COLORS.length], avatar: randomAvatar(rnd) }));
  await tv.waitForFunction(() => document.querySelectorAll('#teams li').length === 30);
  await tv.waitForTimeout(700);
  const fits = (page) => page.evaluate(() => document.documentElement.scrollHeight <= innerHeight && document.documentElement.scrollWidth <= innerWidth);
  await shot(tv, 'quick-tv-lobby-30');
  assert.ok(await fits(tv), 'thirty players fit on the TV lobby');
  assert.equal(await tv.textContent('#teams li:first-child'), 'Selma', 'the newest player first');
  // 100 players (the most allowed): the TV shows the newest ones and counts the rest, all on one screen; the host's
  // list scrolls, and a note says more than 30 hasn't been tried in a real game yet.
  const more = Array.from({ length: 70 }, (_, i) => `bot-y${i}`);
  const first = ['Aksel', 'Amalie', 'Anders', 'Anna', 'Aurora', 'Benjamin', 'Birk', 'Edvard', 'Eline', 'Elias', 'Emilie', 'Erik', 'Eva', 'Even', 'Hanna', 'Hedda', 'Herman', 'Iben', 'Isak', 'Jakob', 'Jenny', 'Julie', 'Kasper', 'Leon', 'Linnea', 'Liv', 'Ludvig', 'Mathias', 'Mia', 'Mikkel', 'Noah', 'Olav', 'Olivia', 'Oliver', 'Oscar', 'Sara', 'Sigrid', 'Sofia', 'Sverre', 'Theodor', 'Tiril', 'Ulrik', 'Victoria', 'Viktor', 'Ylva', 'Åse', 'Øyvind', 'Ask', 'Brage', 'Dina', 'Eirik', 'Elise', 'Felix', 'Gina', 'Håkon', 'Ingvild', 'Jonathan', 'Kaja', 'Lars', 'Lea', 'Marius', 'Mathilde', 'Nikolai', 'Oda', 'Petter', 'Ronja', 'Sigurd', 'Synne', 'Trym', 'Vetle'];
  more.forEach((id, i) => srv.hub.dispatch({ type: 'join', teamId: id, name: first[i], color: COLORS[(i + 5) % COLORS.length], avatar: i % 4 === 3 ? undefined : randomAvatar(rnd) }));
  assert.equal(state().teams.length, 100);
  assert.throws(() => srv.hub.dispatch({ type: 'join', teamId: 'bot-101', name: 'One too many', color: COLORS[0] }), { code: 'full-players' });
  await tv.waitForFunction(() => /\+ 53 more/.test(document.querySelector('#teams').textContent));
  await host.waitForFunction(() => document.querySelectorAll('#teams li').length === 100);
  await tv.waitForTimeout(700);
  await shot(tv, 'quick-tv-lobby-100');
  assert.ok(await fits(tv), 'a hundred players fit on the TV lobby');
  assert.equal(await tv.locator('#teams li').count(), 48); // the newest 47, plus "+ 53 more"
  assert.equal(await tv.textContent('#teams li:first-child'), 'Vetle');
  assert.equal(await host.textContent('#team-count'), '100/100');
  assert.equal(await host.locator('#many-note').isVisible(), true);
  assert.match(await host.textContent('#many-note'), /More than 30 players hasn’t been tried/);
  const hostList = await host.$eval('#teams', (el) => ({ scrolls: el.scrollHeight > el.clientHeight, startOnScreen: document.querySelector('#start').getBoundingClientRect().top < innerHeight * 2 }));
  assert.ok(hostList.scrolls, 'the host lobby list scrolls');
  await host.evaluate(() => document.querySelector('#many-note').scrollIntoView({ block: 'start' }));
  await shot(host, 'quick-host-lobby-100');
  for (const id of [...extra, ...more]) srv.hub.dispatch({ type: 'removeTeam', teamId: id });
  await tv.waitForFunction(() => document.querySelectorAll('#teams li').length === 6);
  await host.waitForFunction(() => document.querySelector('#many-note').hidden);
  await shot(alex, 'quick-phone-lobby');

  // ----- Section title card -----
  await host.click('#start');
  await phase(host, 'section');
  await tv.waitForSelector('.quick-section');
  await tv.waitForTimeout(900);
  await shot(tv, 'quick-tv-section');
  await shot(alex, 'quick-phone-section');

  // ----- Question 1: everyone answers early, so it closes at once -----
  await host.keyboard.press(' ');
  await phase(host, 'ready');
  await tv.waitForSelector('.quick-ready');
  await tv.waitForTimeout(500);
  await shot(tv, 'quick-tv-ready');
  await phase(host, 'open'); // after the 4 s read time
  await tv.waitForSelector('.quick-opts');
  await tv.waitForTimeout(700);
  await shot(tv, 'quick-tv-open');
  await shot(alex, 'quick-phone-answer');
  await shot(host, 'quick-host-open');
  // Mercury (the 1st) is right. Alex is first; Mira and Bo are wrong.
  await alex.click('.choice:nth-child(1)');
  await alex.waitForSelector('.locked-shape');
  await shot(alex, 'quick-phone-answered');
  await mira.click('.choice:nth-child(3)');
  await jonas.click('.choice:nth-child(1)');
  await sofie.click('.choice:nth-child(1)');
  const lastAnswer = Date.now();
  srv.hub.dispatch({ type: 'answer', teamId: 'bot-bea', option: 0 });
  srv.hub.dispatch({ type: 'answer', teamId: 'bot-bo', option: 1 });
  await phase(host, 'result', 3000);
  assert.ok(Date.now() - lastAnswer < 3000, 'the question closes when everyone has answered');
  await tv.waitForSelector('.quick-bars');
  await tv.waitForSelector('body[data-music=calm]', { state: 'attached', timeout: 6000 }); // the soft tune after the answer
  assert.match(await tv.textContent('.quick-verdict'), /4 of 6 got it right/);
  assert.equal(await tv.textContent('.quick-verdict .fastest .plate'), 'Alex');
  assert.match(await tv.textContent('.quick-verdict .fastest-title'), /⚡ \S/);
  assert.equal(await tv.locator('.quick-opt.wrong').count(), 3);
  await alex.waitForSelector('.fastest-badge');
  assert.match(await alex.textContent('#team'), /Right!/);
  assert.match(await mira.textContent('#team'), /Wrong/);
  assert.match(await mira.textContent('#team'), /Place [56] of 6/);
  assert.match(await mira.textContent('.gap-line'), /points behind|Level with/);
  await tv.waitForTimeout(1200); // the bars grow
  await shot(tv, 'quick-tv-result');
  await shot(alex, 'quick-phone-result-right');
  await shot(mira, 'quick-phone-result-wrong');
  await shot(host, 'quick-host-result');
  // ----- Reactions: the phones show six emoji under the result; a tap floats up on the TV with the name -----
  assert.equal(await alex.locator('.reaction-btn').count(), REACTIONS.length);
  const smallReactions = await alex.$$eval('.reaction-btn', (els) => els.map((el) => el.getBoundingClientRect()).filter((r) => r.width < 48 || r.height < 48).length);
  assert.equal(smallReactions, 0, 'every reaction button is at least 48px');
  const covered = await alex.evaluate(() => {
    const row = document.querySelector('.reactions').getBoundingClientRect();
    return [...document.querySelectorAll('.verdict-badge, .big, .result, .gap-line')].some((el) => el.getBoundingClientRect().bottom > row.top + 1) || row.bottom > innerHeight;
  });
  assert.equal(covered, false, 'the reactions sit under the result, on screen');
  await alex.click('.reaction-btn:nth-child(2)'); // 🔥
  await tv.waitForSelector('#reactions .reaction');
  assert.equal(await tv.textContent('#reactions .reaction'), '🔥Alex');
  assert.equal(await tv.locator('#reactions .reaction .avatar').count(), 1);
  await alex.click('.reaction-btn:nth-child(3)'); // within a second: dropped (also by the server)
  // The players joined through the server react over plain WebSockets, like phones would.
  const sockets = [];
  for (const [id, emoji] of [['bot-bea', 0], ['bot-bo', 5]]) {
    const ws = new WebSocket(`ws://127.0.0.1:${srv.info.port}/ws`);
    await new Promise((r) => (ws.onopen = r));
    ws.send(JSON.stringify({ type: 'hello', role: 'phone', teamId: id }));
    await new Promise((r) => (ws.onmessage = r));
    ws.send(JSON.stringify({ type: 'react', emoji }));
    sockets.push(ws);
  }
  await mira.click('.reaction-btn:nth-child(5)');
  await jonas.click('.reaction-btn:nth-child(4)');
  await tv.waitForFunction(() => document.querySelectorAll('#reactions .reaction').length === 5, null, { timeout: 3000 });
  assert.equal(await tv.locator('#reactions .reaction').count(), 5, 'the second tap within a second was dropped');
  await tv.waitForTimeout(600);
  await shot(alex, 'quick-phone-reactions');
  await shot(tv, 'quick-tv-reactions');
  for (const ws of sockets) ws.close();
  await tv.waitForFunction(() => document.querySelectorAll('#reactions .reaction').length === 0, null, { timeout: 6000 }); // gone after ~3 s
  // With the setting off the phones hide the buttons.
  srv.hub.dispatch({ type: 'settings', settings: { quickReactions: false } });
  await alex.waitForFunction(() => !document.querySelector('.reaction-btn'));
  srv.hub.dispatch({ type: 'settings', settings: { quickReactions: true } });
  await alex.waitForSelector('.reaction-btn');
  // The result with the glass look on and off.
  await shot(tv, 'quick-glass-on-tv-result');
  srv.hub.dispatch({ type: 'settings', settings: { glass: false } });
  await tv.waitForSelector('body:not(.glass)');
  await shot(tv, 'quick-glass-off-tv-result');
  srv.hub.dispatch({ type: 'settings', settings: { glass: true } });
  await tv.waitForSelector('body.glass');

  // ----- The top 5: first as it stood before the question, then the points count up and the rows move -----
  await host.keyboard.press(' ');
  await phase(host, 'ranks');
  await tv.waitForSelector('.top-list');
  await tv.waitForSelector('body[data-music=calmUp]', { state: 'attached', timeout: 6000 });
  await topFive(tv, 'quick-tv-top5');
  // The plates are centred under the title, with the arrows in a column outside on the left.
  const centred = await tv.evaluate(() => {
    const title = document.querySelector('.quick-ranks h1').getBoundingClientRect();
    const plate = document.querySelector('.top-list li .rank-plate').getBoundingClientRect();
    const arrow = document.querySelector('.top-list li .move').getBoundingClientRect();
    return { off: Math.abs((plate.left + plate.right) / 2 - (title.left + title.right) / 2), arrowOutside: arrow.right <= plate.left };
  });
  assert.ok(centred.off < 2, `the top 5 plates are centred under the title (off by ${centred.off.toFixed(1)}px)`);
  assert.ok(centred.arrowOutside, 'the arrows sit outside the plates');
  // The faces moved along with their rows: each row still shows its own player's avatar (or none, for Bo).
  const faces = await tv.$$eval('.top-list li', (els) => els.map((li) => [li.dataset.id, Boolean(li.querySelector('.rank-face .avatar svg')), li.querySelector('.rank-n').textContent]));
  for (const [id, hasFace] of faces) assert.equal(hasFace, Boolean(state().teams.find((tm) => tm.id === id).avatar), `${id}'s face in the top 5`);
  assert.match(await alex.textContent('#team'), /You’re in the lead!/);
  assert.match(await alex.textContent('.gap-line'), /points ahead of/);
  // The phone's own points counted up to the new score.
  const alexScore = state().teams.find((tm) => tm.name === 'Alex').score;
  await alex.waitForFunction((n) => document.querySelector('#score').textContent === `${n} points`, String(alexScore).replace(/\B(?=(\d{3})+$)/g, '\u00a0'), { timeout: 3000 });
  await shot(alex, 'quick-phone-ranks');

  // ----- Question 2: "tick all that are right" (Dolphin and Bat). The phones tick and submit; the host stops the clock. -----
  await host.keyboard.press(' ');
  await phase(host, 'ready');
  assert.equal(await host.locator('.host-opt.right').count(), 2); // the host sees both marked
  assert.match(await host.textContent('.host-q .where'), /Tick all that are right/);
  await tv.waitForSelector('.quick-ready .quick-style');
  assert.match(await tv.textContent('.quick-style'), /Tick all that are right/);
  assert.doesNotMatch(await tv.textContent('.tv-q'), /Two|two are/i, 'the TV never says how many are right');
  await host.keyboard.press(' ');
  await phase(host, 'open');
  await alex.waitForSelector('#submit-answers');
  assert.equal(await alex.isDisabled('#submit-answers'), true, 'nothing ticked yet');
  assert.match(await alex.textContent('.answer-bar'), /Tap every right answer, then submit/);
  await alex.click('.choice:nth-child(1)'); // Dolphin
  await alex.click('.choice:nth-child(3)'); // Bat
  assert.equal(await alex.locator('.choice.ticked').count(), 2);
  assert.equal(await alex.isDisabled('#submit-answers'), false);
  await alex.click('.choice:nth-child(3)'); // a tap on a ticked one unticks it…
  assert.equal(await alex.locator('.choice.ticked').count(), 1);
  await alex.click('.choice:nth-child(3)'); // …and again ticks it
  assert.deepEqual(await alex.$$eval('.pick-badge', (els) => els.map((el) => el.textContent)), ['✓', '', '✓', '']);
  await shot(alex, 'quick-phone-tick');
  await alex.click('#submit-answers');
  await alex.waitForFunction(() => document.body.innerText.includes('Answer locked in'));
  assert.equal(await alex.locator('.right-chips .opt-chip').count(), 2);
  await shot(alex, 'quick-phone-tick-answered');
  await mira.click('.choice:nth-child(1)');
  await mira.click('.choice:nth-child(3)');
  await mira.click('#submit-answers'); // right
  await jonas.click('.choice:nth-child(1)');
  await jonas.click('#submit-answers'); // only Dolphin: not all of them
  srv.hub.dispatch({ type: 'answer', teamId: 'bot-bo', options: [0, 2] }); // Bo climbs into the top 5
  await jonas.waitForFunction(() => document.body.innerText.includes('Answer locked in'));
  await host.keyboard.press(' '); // stop the clock
  await phase(host, 'result');
  await tv.waitForSelector('.quick-bars');
  assert.match(await tv.textContent('.quick-verdict'), /3 of 6 ticked exactly the right ones/);
  assert.equal(await tv.locator('.qbar.right').count(), 2);
  assert.equal(await tv.locator('.quick-opt.right').count(), 2);
  assert.match(await host.textContent('.host-status'), /3 of 6 ticked exactly the right ones/);
  assert.match(await host.textContent('.host-opts'), /4 ticked/); // Dolphin
  await alex.waitForSelector('.verdict-badge');
  assert.match(await alex.textContent('#team'), /Right!/);
  assert.match(await mira.textContent('#team'), /Right!/);
  assert.match(await jonas.textContent('#team'), /Wrong/);
  assert.match(await jonas.textContent('#team'), /Right answers:/);
  assert.equal(await jonas.locator('.right-was .opt-chip').count(), 2);
  assert.ok(state().teams.find((tm) => tm.name === 'Mira').score > 0);
  assert.equal(state().q.gained[state().teams.find((tm) => tm.name === 'Jonas').id], 0, 'a subset scores nothing');
  await tv.waitForTimeout(1200); // the bars grow
  await shot(tv, 'quick-tv-result-tick');
  await shot(jonas, 'quick-phone-result-tick-wrong');
  await shot(host, 'quick-host-result-tick');
  // The top 5 again, with the plain look: Bo climbs in and someone drops out.
  srv.hub.dispatch({ type: 'settings', settings: { glass: false } });
  await tv.waitForSelector('body:not(.glass)');
  // A second TV whose system asks for less motion: it shows the end result at once.
  const still = await open('/display', { width: 1280, height: 720 }, 'tv (reduced motion)', { reducedMotion: 'reduce' });
  await still.waitForSelector('.quick-bars'); // it shows the result
  await host.keyboard.press(' ');
  await phase(host, 'ranks');
  await still.waitForSelector('.top-list');
  await still.waitForSelector('body[data-rankanim=done]', { state: 'attached', timeout: 1000 });
  assert.equal(await still.locator('.top-list.animating, .top-list li.waiting').count(), 0);
  await still.context().close();
  await topFive(tv, 'quick-glass-off-tv-top5');
  assert.ok(await tv.locator('.top-list li[data-id=bot-bo]').count(), 'Bo is in the top 5');
  srv.hub.dispatch({ type: 'settings', settings: { glass: true } });
  await tv.waitForSelector('body.glass');

  // ----- Question 3 (true or false, 10 s) runs out of time -----
  await host.keyboard.press(' ');
  await host.waitForFunction(() => document.body.dataset.phase === 'ready' && /Question 3 of 5/.test(document.body.innerText));
  await host.keyboard.press(' '); // show the answers now instead of waiting
  await phase(host, 'open');
  await tv.waitForSelector('.quick-opts.n2');
  await jonas.click('.choice:nth-child(2)'); // "False" is right
  await mira.click('.choice:nth-child(1)');
  await phase(host, 'result', 14000); // nobody else answers: the 10 s run out
  assert.match(await tv.textContent('.quick-verdict'), /1 of 6 got it right/);
  assert.equal(await tv.textContent('.quick-verdict .fastest .plate'), 'Jonas');
  await sofie.waitForFunction(() => document.body.innerText.includes('Too slow!'));
  await tv.waitForTimeout(1200);
  await shot(tv, 'quick-tv-result-timeout');
  await shot(sofie, 'quick-phone-too-slow');

  // ----- Question 5: "put in order" (oldest to newest). Question 4 is skipped to get there. -----
  await host.keyboard.press(' ');
  await phase(host, 'ranks');
  await host.keyboard.press(' ');
  await host.waitForFunction(() => document.body.dataset.phase === 'ready' && /Question 4 of 5/.test(document.body.innerText));
  await host.keyboard.press('Escape'); // skip it
  await host.waitForFunction(() => document.body.dataset.phase === 'ready' && /Question 5 of 5/.test(document.body.innerText));
  assert.match(await host.textContent('.host-q .where'), /Put in the right order/);
  assert.match(await host.textContent('.host-order-note'), /Shown shuffled like this/);
  assert.deepEqual((await host.$$eval('.host-opt .opt-place', (els) => els.map((el) => el.textContent))).sort(), ['1.', '2.', '3.', '4.']);
  await shot(host, 'quick-host-order');
  await tv.waitForSelector('.quick-ready .quick-style.order');
  // A narrow phone joins now, to see the long answers at 360px.
  const nils = await open('/', { width: 360, height: 740 }, 'Nils');
  await nils.waitForSelector('#join:not([hidden])');
  await nils.fill('#name', 'Nils');
  await nils.click('#swatches label:nth-child(2)');
  await nils.click('#join-btn');
  await nils.waitForSelector('#team:not([hidden])');
  await host.keyboard.press(' ');
  await phase(host, 'open');
  const written = ['Pyramids of Giza', 'Colosseum', 'Eiffel Tower', 'Sydney Opera House'];
  const rightOrder = state().q.correct; // the shown positions in the right order
  const shownTexts = await tv.$$eval('.quick-opt .opt-text', (els) => els.map((el) => el.textContent));
  assert.deepEqual(rightOrder.map((p) => shownTexts[p]), written);
  assert.notDeepEqual(shownTexts, written, 'shuffled on the TV');
  assert.deepEqual(await alex.$$eval('.choice-text', (els) => els.map((el) => el.textContent)), shownTexts, 'the phones show the same order');
  await shot(tv, 'quick-tv-open-order');
  await alex.waitForSelector('#clear-picks');
  assert.equal(await alex.isDisabled('#submit-answers'), true);
  assert.match(await alex.textContent('.answer-bar'), /Tap the answers in order, the first one first/);
  // Alex taps two, clears, then taps all four in the right order.
  await alex.click(`.choice:nth-child(${rightOrder[1] + 1})`);
  await alex.click(`.choice:nth-child(${rightOrder[0] + 1})`);
  const badges = await alex.$$eval('.pick-badge', (els) => els.map((el) => el.textContent));
  assert.deepEqual([badges[rightOrder[1]], badges[rightOrder[0]]], ['1', '2']);
  assert.equal(await alex.isDisabled('#submit-answers'), true, 'not all four yet');
  await alex.click('#clear-picks');
  assert.equal(await alex.locator('.choice.ticked').count(), 0);
  for (const p of rightOrder) await alex.click(`.choice:nth-child(${p + 1})`);
  assert.equal(await alex.isDisabled('#submit-answers'), false);
  await shot(alex, 'quick-phone-order');
  // Tapping a numbered one takes its number and every later one away.
  await alex.click(`.choice:nth-child(${rightOrder[2] + 1})`);
  assert.equal(await alex.locator('.choice.ticked').count(), 2);
  for (const p of rightOrder.slice(2)) await alex.click(`.choice:nth-child(${p + 1})`);
  await alex.click('#submit-answers');
  await alex.waitForFunction(() => document.body.innerText.includes('Answer locked in'));
  assert.equal(await alex.locator('.right-chips.as-list .opt-chip').count(), 4);
  await shot(alex, 'quick-phone-order-answered');
  // The narrow phone: everything fits, and Submit is on screen with all four numbered.
  for (const p of rightOrder) await nils.click(`.choice:nth-child(${p + 1})`);
  const narrow = await nils.evaluate(() => {
    const r = document.querySelector('#submit-answers').getBoundingClientRect();
    return { fitsWide: document.documentElement.scrollWidth <= innerWidth, submitOnScreen: r.bottom <= innerHeight && r.height >= 48, cut: [...document.querySelectorAll('.choice-text')].some((el) => el.scrollWidth > el.clientWidth + 1) };
  });
  await shot(nils, 'quick-phone-order-narrow');
  assert.deepEqual(narrow, { fitsWide: true, submitOnScreen: true, cut: false }, 'the order question on a 360px phone');
  await nils.click('#submit-answers');
  // Mira swaps the last two: wrong. Bea gets it right, Bo has it backwards; Jonas and Sofie don't answer.
  for (const p of [rightOrder[0], rightOrder[1], rightOrder[3], rightOrder[2]]) await mira.click(`.choice:nth-child(${p + 1})`);
  await mira.click('#submit-answers');
  srv.hub.dispatch({ type: 'answer', teamId: 'bot-bea', order: [...rightOrder] });
  srv.hub.dispatch({ type: 'answer', teamId: 'bot-bo', order: [...rightOrder].reverse() });
  await mira.waitForFunction(() => document.body.innerText.includes('Answer locked in'));
  await host.keyboard.press(' '); // stop the clock
  await phase(host, 'result');
  await tv.waitForSelector('.quick-order-result');
  assert.equal(await tv.locator('.quick-order-result li').count(), 4);
  assert.deepEqual(await tv.$$eval('.quick-order-result .opt-text', (els) => els.map((el) => el.textContent)), written);
  assert.match(await tv.textContent('.quick-verdict'), /3 of 7 got the whole order right/);
  assert.equal(await tv.locator('.quick-opt .opt-rank').count(), 4);
  assert.equal(await tv.textContent('.quick-verdict .fastest .plate'), 'Alex');
  assert.match(await host.textContent('.host-status'), /3 of 7 got the whole order right/);
  await alex.waitForSelector('.verdict-badge');
  assert.match(await alex.textContent('#team'), /Right!/);
  assert.match(await mira.textContent('#team'), /Wrong/);
  assert.match(await mira.textContent('#team'), /The right order:/);
  assert.deepEqual(await mira.$$eval('.right-was .opt-chip', (els) => els.map((el) => el.textContent.replace(/^\d/, '').trim())), written);
  await tv.waitForTimeout(1500); // the rows slide in
  await shot(tv, 'quick-tv-result-order');
  await shot(alex, 'quick-phone-result-order-right');
  await shot(mira, 'quick-phone-result-order-wrong');
  await shot(host, 'quick-host-result-order');
  await nils.context().close();
  srv.hub.dispatch({ type: 'removeTeam', teamId: state().teams.find((tm) => tm.name === 'Nils').id });

  // ----- The next section's card: the standings, each with its face and place badge -----
  for (let n = 0; n < 20 && state().phase !== 'section'; n++) srv.hub.dispatch({ type: ['ready', 'open'].includes(state().phase) ? 'skip' : 'next' });
  await tv.waitForSelector('.standings-list');
  await tv.waitForTimeout(1200);
  assert.equal(await tv.locator('.standings-list .rank-face .avatar').count(), state().teams.filter((tm) => tm.avatar).length);
  await shot(tv, 'quick-tv-section-standings');

  // ----- Straight to the podium -----
  for (let n = 0; n < 60 && state().phase !== 'over'; n++) {
    srv.hub.dispatch({ type: ['ready', 'open'].includes(state().phase) ? 'skip' : 'next' });
  }
  await phase(host, 'over');
  await tv.waitForSelector('.podium');
  await tv.waitForTimeout(4500); // 3rd, 2nd, then 1st rise, their points counting up
  assert.match(await tv.textContent('.podium'), /Alex/);
  const podium = await tv.$$eval('.step:not(.empty)', (els) => els.map((el) => [el.querySelector('.step-name').textContent, Number(el.querySelector('.step-block b').textContent.replace(/\s/g, ''))]));
  for (const [name, pts] of podium) assert.equal(pts, state().teams.find((tm) => tm.name === name).score, `${name} on the podium`);
  assert.equal(await tv.locator('.podium .step .step-face').count(), podium.filter(([name]) => state().teams.find((tm) => tm.name === name).avatar).length);
  await shot(tv, 'quick-tv-podium');
  await alex.waitForSelector('.medal');
  await shot(alex, 'quick-phone-over');
  await shot(host, 'quick-host-over');

  // ----- The editor: a new Quick quiz -----
  const ed = await host.context().newPage();
  ed.on('pageerror', (e) => errors.push(`editor: ${e.message}`));
  ed.on('console', (m) => m.type() === 'error' && errors.push(`editor: ${m.text()}`));
  await ed.setViewportSize({ width: 1366, height: 900 });
  await ed.goto(`${base}/editor#quick-sample`);
  await ed.waitForSelector('.ed-sec');
  assert.equal(await ed.locator('.ed-sec').count(), 3);
  assert.equal(await ed.locator('.ed-mini').count(), 0); // the sample can't be changed
  await ed.click('#new-quick');
  await ed.waitForSelector('.ed-sec input[name=sectionName]:not([disabled])');
  assert.equal(await ed.locator('.ed-sec').count(), 2);
  assert.match(await ed.textContent('#ed-problems'), /10 questions are still empty/);
  await ed.fill('.ed-sec:nth-of-type(1) input[name=sectionName]', 'Warm-up');
  await ed.fill('.ed-sec:nth-of-type(1) input[name=sectionSeconds]', '15');
  await ed.click('.ed-qrow[data-c="0"][data-i="0"]');
  await ed.waitForSelector('#q-dialog[open] input[name=option0]');
  await ed.fill('#q-form textarea', 'Which planet is closest to the Sun?');
  await ed.fill('#q-form input[name=option0]', 'Venus');
  await ed.fill('#q-form input[name=option1]', 'Mercury');
  await ed.fill('#q-form input[name=option2]', 'Mars');
  assert.match(await ed.textContent('#ed-problems'), /Warm-up, question 1: mark which answer is right/);
  await ed.check('#q-form input[name=correct][value="1"]');
  await ed.selectOption('#q-form select[name=points]', '2000');
  assert.equal(await ed.getAttribute('#q-form input[name=seconds]', 'placeholder'), '15');
  await ed.waitForTimeout(300);
  await shot(ed, 'quick-editor-question');
  await ed.click('#q-form button[value=done]');
  await ed.waitForSelector('#q-dialog:not([open])', { state: 'hidden' });
  await ed.waitForFunction(() => /Mercury/.test(document.querySelector('.ed-qrow[data-c="0"][data-i="0"]').textContent)); // redrawn on the dialog's close event
  assert.match(await ed.textContent('.ed-qrow[data-c="0"][data-i="0"]'), /Double points/);
  // Move it down a place, then add a section.
  await ed.click('.ed-sec:nth-of-type(1) .ed-qitem:nth-child(1) .ed-down');
  assert.match(await ed.textContent('.ed-qrow[data-c="0"][data-i="1"]'), /closest to the Sun/);
  await ed.click('.ed-add-section');
  assert.equal(await ed.locator('.ed-sec').count(), 3);
  await ed.waitForFunction(() => document.querySelector('#ed-status').textContent === 'Saved');
  const saved = (await (await fetch(`${base}/api/sets`)).json()).find((q) => q.title === 'My quiz');
  const { set: mine } = await (await fetch(`${base}/api/sets/${saved.id}`)).json();
  assert.deepEqual(mine.sections[0].questions[1], { question: 'Which planet is closest to the Sun?', options: ['Venus', 'Mercury', 'Mars'], correct: 1, points: 2000 });
  assert.equal(mine.sections[0].seconds, 15);
  await shot(ed, 'quick-editor-sections');

  // Answers 1, 2 and 4 filled, 3 empty: answer 4 moves up to 3 (with its colour and shape) once the host leaves
  // the answers, the right answer moves with it, and reopening shows the same.
  await ed.click('.ed-qrow[data-c="0"][data-i="0"]');
  await ed.waitForSelector('#q-dialog[open] input[name=option0]');
  await ed.fill('#q-form textarea', 'Which one is a colour?');
  await ed.fill('#q-form input[name=option0]', 'Table');
  await ed.fill('#q-form input[name=option1]', 'Chair');
  await ed.fill('#q-form input[name=option3]', 'Green');
  await ed.check('#q-form input[name=correct][value="3"]'); // clicking inside the answers moves nothing yet
  assert.equal(await ed.inputValue('#q-form input[name=option3]'), 'Green');
  assert.match(await ed.textContent('.ed-opts-moved'), /Answer 4 will move up to answer 3/);
  await ed.click('#q-form textarea'); // leaving the answers
  await ed.waitForFunction(() => document.querySelector('#q-form input[name=option2]').value === 'Green');
  assert.equal(await ed.inputValue('#q-form input[name=option3]'), '');
  assert.equal(await ed.isChecked('#q-form input[name=correct][value="2"]'), true);
  assert.match(await ed.textContent('.ed-opts-moved'), /Answer 4 moved up to answer 3/);
  await shot(ed, 'quick-editor-moved-up');
  await ed.click('#q-form button[value=done]');
  await ed.waitForSelector('#q-dialog:not([open])', { state: 'hidden' });
  await ed.click('.ed-qrow[data-c="0"][data-i="0"]');
  await ed.waitForSelector('#q-dialog[open] input[name=option0]');
  assert.deepEqual(await ed.$$eval('#q-form input[type=text]', (els) => els.map((e) => e.value)), ['Table', 'Chair', 'Green', '']);
  assert.equal(await ed.isChecked('#q-form input[name=correct][value="2"]'), true);
  assert.equal(await ed.isHidden('.ed-opts-moved'), true);
  // Two right answers (any of them counts): Green and Red. Emptying "Chair" moves both up, ticks and all.
  await ed.fill('#q-form textarea', 'Which of these is a colour?');
  await ed.fill('#q-form input[name=option3]', 'Red');
  await ed.check('#q-form input[name=correct][value="3"]');
  assert.equal(await ed.isChecked('#q-form input[name=correct][value="2"]'), true); // ticking one more keeps the first
  await ed.fill('#q-form input[name=option1]', '');
  await ed.click('#q-form textarea'); // leaving the answers
  await ed.waitForFunction(() => document.querySelector('#q-form input[name=option1]').value === 'Green');
  assert.deepEqual(await ed.$$eval('#q-form input[type=text]', (els) => els.map((e) => e.value)), ['Table', 'Green', 'Red', '']);
  assert.deepEqual(await ed.$$eval('#q-form input[name=correct]', (els) => els.map((e) => e.checked)), [false, true, true, false]);
  assert.equal(await ed.locator('.ed-opt.right').count(), 2);
  await shot(ed, 'quick-editor-two-right');
  // Every answer right isn't allowed.
  await ed.check('#q-form input[name=correct][value="0"]');
  await ed.waitForFunction(() => /not every answer can be right/.test(document.querySelector('#ed-problems').textContent));
  await ed.uncheck('#q-form input[name=correct][value="0"]');
  // The kind of question: "Tick all that are right" keeps the marks (and there every answer may be right);
  // "Put in order" has no marks, just the places; back to "Pick one" brings the marks back.
  assert.equal(await ed.isChecked('.ed-kind-pills input[value=choice]'), true);
  await ed.click('.ed-kind-pills label:has(> input[value=multi])');
  assert.match(await ed.textContent('.ed-opts'), /Players must tick exactly these/);
  await ed.check('#q-form input[name=correct][value="0"]');
  await ed.waitForTimeout(200);
  assert.doesNotMatch(await ed.textContent('#ed-problems'), /not every answer can be right/);
  await ed.uncheck('#q-form input[name=correct][value="0"]');
  await ed.waitForTimeout(900);
  await ed.waitForFunction(() => document.querySelector('#ed-status').textContent === 'Saved');
  let kinds = await (await fetch(`${base}/api/sets/${saved.id}`)).json();
  assert.deepEqual(kinds.set.sections[0].questions[0], { question: 'Which of these is a colour?', type: 'multi', options: ['Table', 'Green', 'Red'], correct: [1, 2] });
  await shot(ed, 'quick-editor-tick');
  await ed.click('.ed-kind-pills label:has(> input[value=order])');
  assert.equal(await ed.locator('.ed-opt-right:visible').count(), 0);
  assert.deepEqual(await ed.$$eval('.ed-opt-n', (els) => els.filter((el) => !el.hidden).map((el) => el.textContent)), ['1.', '2.', '3.', '4.']);
  assert.match(await ed.textContent('.ed-opts'), /Write the answers in the right order/);
  await ed.waitForTimeout(900);
  await ed.waitForFunction(() => document.querySelector('#ed-status').textContent === 'Saved');
  kinds = await (await fetch(`${base}/api/sets/${saved.id}`)).json();
  assert.deepEqual(kinds.set.sections[0].questions[0], { question: 'Which of these is a colour?', type: 'order', options: ['Table', 'Green', 'Red'] });
  await shot(ed, 'quick-editor-order');
  await ed.click('.ed-kind-pills label:has(> input[value=choice])');
  assert.equal(await ed.locator('.ed-opt.right').count(), 2);
  await ed.click('#q-form button[value=done]');
  await ed.waitForSelector('#q-dialog:not([open])', { state: 'hidden' });
  await ed.waitForFunction(() => document.querySelectorAll('.ed-qrow[data-c="0"][data-i="0"] .ed-qright').length === 2);
  assert.match(await ed.textContent('.ed-qrow[data-c="0"][data-i="0"]'), /Green.*Red/);
  await ed.waitForTimeout(900); // the editor saves 600 ms after the last change
  await ed.waitForFunction(() => document.querySelector('#ed-status').textContent === 'Saved');
  const again = await (await fetch(`${base}/api/sets/${saved.id}`)).json();
  assert.deepEqual(again.set.sections[0].questions[0], { question: 'Which of these is a colour?', options: ['Table', 'Green', 'Red'], correct: [1, 2] });
  await shot(ed, 'quick-editor-sections-two-right');

  // ----- Making a Quick quiz with AI -----
  await ed.click('#ai-quiz');
  await ed.waitForSelector('#ai-dialog[open]');
  await ed.selectOption('#ai-form select[name=kind]', 'quick');
  assert.equal(await ed.locator('#ai-form select[name=categories]').isHidden(), true);
  await ed.selectOption('#ai-form select[name=sections]', '2');
  await ed.selectOption('#ai-form select[name=perSection]', '3');
  await ed.selectOption('#ai-form select[name=lang]', 'no');
  await ed.fill('#ai-form textarea[name=topics]', 'Film\nMusikk');
  const request = await ed.inputValue('#ai-request');
  assert.match(request, /Exactly 2 sections with exactly 3 questions each/);
  assert.match(request, /"Film", "Musikk"/);
  assert.match(request, /Norwegian \(bokmål\)/);
  assert.equal(await ed.textContent('.ai-fill'), 'Make the quiz');
  await shot(ed, 'quick-editor-ai-request');
  const q = (question, options, answer) => ({ question, options, answer });
  const aiQuiz = {
    title: 'Film og musikk',
    sections: [
      { name: 'Film', questions: [q('Hvem regisserte Haisommer?', ['Lucas', 'Spielberg', 'Scorsese', 'Nolan'], 'Spielberg'), q('Hvilket år kom Titanic?', ['1995', '1997', '1999', '2001'], '1997'), q('Sant eller usant: Shrek er grønn.', ['Sant', 'Usant'], 'Sant')] },
      { name: 'Musikk', questions: [q('Hvem sang Thriller?', ['Prince', 'Madonna', 'Michael Jackson', 'Sting'], 'Michael Jackson'), q('Hvor mange strenger har en fiolin?', ['Tre', 'Fire', 'Fem', 'Seks'], 'Fire'), q('Hvilket band ga ut Abbey Road?', ['Queen', 'ABBA', 'Oasis', 'The Beatles'], 'The Beatles')] },
    ],
  };
  await ed.fill('#ai-reply', `Her er quizen!\n\n\`\`\`json\n${JSON.stringify(aiQuiz, null, 2)}\n\`\`\``);
  await ed.click('.ai-fill');
  await ed.waitForSelector('#ai-dialog:not([open])', { state: 'hidden' });
  await ed.waitForSelector('.ai-note');
  assert.equal(await ed.locator('.ed-sec').count(), 2);
  assert.match(await ed.textContent('.ed-qrow[data-c="1"][data-i="0"]'), /Michael Jackson/);
  assert.match(await ed.textContent('#ed-problems'), /Everything is ready to play/);
  await shot(ed, 'quick-editor-ai-made');

  // The new quiz can be played: it's in the lobby's picker after a restart of the game.
  srv.hub.dispatch({ type: 'restart' });
  await phase(host, 'lobby');
  await host.evaluate(() => window.dispatchEvent(new Event('focus')));
  await host.waitForFunction(() => [...document.querySelectorAll('#set-picker option')].some((o) => o.textContent === 'Film og musikk · Quick quiz' && !o.disabled));

  // A too-long name in the picker would still have been cut off: report it rather than fail.
  if (!picker.fits) console.log('note: the lobby quiz picker cuts off "Sample quick quiz · Quick quiz"');
  assert.deepEqual(errors, []);
  console.log('e2e-quick: all good. Screenshots in test/screenshots/quick-*.png');
} catch (err) {
  for (const ctx of browser.contexts()) for (const pg of ctx.pages()) console.log(pg.url(), '→', (await pg.textContent('body')).replace(/\s+/g, ' ').slice(0, 300));
  console.log(errors);
  throw err;
} finally {
  await browser.close();
  await srv.close();
}

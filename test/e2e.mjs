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
// Every screenshot also checks that no "null"/"undefined" leaked onto the screen.
async function shot(page, name) {
  const text = await page.evaluate(() => document.body.innerText);
  const bad = text.match(/[^\n]*(\b((?<!under )null|undefined|NaN)\b|\[object \w+\])[^\n]*/); // \"under null\" is Norwegian for \"below zero\"
  assert.equal(bad, null, `${name} shows a broken value: ${JSON.stringify(bad?.[0])}`);
  await page.screenshot({ path: `${shots}/${name}.png` });
}

// Choose one of the lobby's pill buttons (language, wrong answer, Crazy mode).
const pickPill = (page, name, value) => page.click(`label:has(> input[name=${name}][value=${value}])`);

try {
  const host = await open('/host', { width: 1366, height: 768 }, 'host');
  const tv = await open('/display', { width: 1920, height: 1080 }, 'tv');
  await host.waitForSelector('#lobby:not([hidden])');
  await tv.waitForSelector('#lobby:not([hidden])');
  await shot(host, 'host-1-empty');
  await shot(tv, 'tv-0-sound-hint');
  await tv.mouse.click(5, 5); // a click lets the TV play sound; every sound below must play without errors
  await tv.waitForSelector('#sound-unlock[hidden]', { state: 'attached' });
  await tv.waitForSelector('body[data-music=lobby]', { state: 'attached', timeout: 6000 });
  // …and it can actually be heard at the default volume (measured on the TV's audio output).
  const level = await tv.evaluate(async () => {
    const { audioGraph } = await import('/js/sounds.js');
    const g = audioGraph();
    const an = g.ctx.createAnalyser();
    an.fftSize = 2048;
    g.limiter.connect(an);
    const buf = new Float32Array(an.fftSize);
    let sum = 0;
    let n = 0;
    const end = Date.now() + 2500;
    while (Date.now() < end) {
      an.getFloatTimeDomainData(buf);
      for (const x of buf) sum += x * x;
      n += buf.length;
      await new Promise((r) => setTimeout(r, 40));
    }
    g.limiter.disconnect(an);
    return 10 * Math.log10(sum / n);
  });
  assert.ok(level > -40, `the lobby music is too quiet: ${level.toFixed(1)} dB`);

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
  await shot(host, 'host-1b-settings');
  await pickPill(host, 'lang', 'no');
  await phones[0].waitForFunction(() => document.body.textContent.includes('Du er med!'));
  await tv.waitForFunction(() => document.body.textContent.includes('Skann for å bli med'));
  await shot(tv, 'tv-2-lobby-no');
  // The folded sections open, and the Norwegian texts fit.
  await host.click('#group-rules summary');
  await host.click('#group-sound summary');
  await host.click('#music-files summary');
  await host.evaluate(() => document.querySelector('#settings').scrollIntoView({ block: 'start' }));
  await shot(host, 'host-1c-settings-open-no');
  await pickPill(host, 'lang', 'en');

  // A setting changed on the host reaches the game.
  await pickPill(host, 'penalty', 'none');
  await waitFor(() => srv.hub.getState().settings.penalty === 'none');
  await host.waitForSelector('#negative-setting[hidden]', { state: 'attached' }); // nothing to lose, so no "below zero"
  await pickPill(host, 'penalty', 'full');
  await waitFor(() => srv.hub.getState().settings.penalty === 'full');
  await pickPill(host, 'penalty', 'half');
  await host.waitForSelector('#rules-status:has-text("Half the points")');
  // The music volume slider.
  await host.$eval('input[name=musicVolume]', (el) => {
    el.value = '60';
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await waitFor(() => srv.hub.getState().settings.musicVolume === 60);
  // Fairer buzzing: the lobby shows each phone's measured delay, and the rest of this game is played with it on.
  await host.check('input[name=fairBuzz]');
  await waitFor(() => srv.hub.getState().settings.fairBuzz === true);
  await host.waitForSelector('.team-list .ping', { timeout: 4000 });
  await shot(host, 'host-2b-fair-buzz');

  host.on('dialog', (d) => d.accept());
  const score = (name) => srv.hub.getState().teams.find((tm) => tm.name === name).score;
  const [red, blue, yellow] = phones;

  // The flag question (Capitals 300) gets a slowly appearing picture: 6 seconds from blocks to clear.
  const withUnveil = structuredClone(srv.hub.getState().set);
  withUnveil.categories[0].questions[2].unveil = 6;
  // And a round 2: the same board with new names, double points and its own questions.
  withUnveil.round2 = {
    categories: withUnveil.categories.map((cat) => ({
      name: `${cat.name} II`,
      questions: cat.questions.map((q, i) => ({ value: q.value * 2, question: `Round 2 question ${i + 1}?`, answer: `Round 2 answer ${i + 1}` })),
    })),
  };
  srv.hub.dispatch({ type: 'loadSet', set: withUnveil, setId: 'sample' });
  await host.waitForSelector('#round2-setting:not([hidden])');
  assert.match(await host.textContent('#round2-setting'), /Play round 2 \(25 questions/);
  assert.equal(await host.isChecked('#round2-setting input'), true);

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
  await tv.waitForSelector('body[data-music=thinking]', { state: 'attached', timeout: 6000 });
  await shot(host, 'host-4-armed');

  await blue.click('.buzzer');
  await blue.waitForFunction(() => document.body.textContent.includes('You’re first!'));
  await red.waitForFunction(() => document.body.textContent.includes('Blue Steel was first'));
  await tv.waitForSelector('.tv-takeover');
  await tv.waitForSelector('body[data-music=answering]', { state: 'attached', timeout: 6000 });
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
  await tv.waitForSelector('body[data-music=silent]', { state: 'attached', timeout: 6000 });
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
  await tv.waitForSelector('body[data-music=board]', { state: 'attached', timeout: 6000 });
  // B turns the music off and on again.
  await host.keyboard.press('b');
  await tv.waitForSelector('body[data-music=off]', { state: 'attached', timeout: 6000 });
  await host.waitForSelector('.controls button:has-text("Music off")');
  await host.keyboard.press('b');
  await tv.waitForSelector('body[data-music=board]', { state: 'attached', timeout: 6000 });
  assert.match(await tv.textContent('.tv-picks'), /Quizzy Rascals picks on their phone/);
  assert.match(await host.textContent('.board-hint'), /Quizzy Rascals is picking on their phone/);
  await shot(tv, 'tv-8-board-after');

  // Quizzy Rascals picks the next question on their phone: a category, then the points.
  await red.bringToFront(); // a phone in the background barely moves its animations, so the old "first" flash would still show
  await red.waitForFunction(() => !document.getAnimations().some((a) => a.animationName === 'first-flash' && a.playState === 'running'));
  await red.waitForSelector('.pick-board');
  await blue.waitForSelector('#stage :text("Quizzy Rascals is picking")');
  assert.equal(await blue.locator('.pick-board').count(), 0);
  await shot(red, 'phone-9-pick-board');
  await red.click('.pick-cat >> nth=1');
  await red.waitForSelector('.pick-values');
  await shot(red, 'phone-10-pick-values');
  // A category with a question already played shows an empty slot there, like the TV board.
  await red.click('.pick-values ~ button.btn-quiet');
  await red.click('.pick-cat >> nth=0');
  await red.waitForSelector('.pick-tile.used');
  await shot(red, 'phone-10b-pick-used');
  await red.click('.pick-values ~ button.btn-quiet');
  await red.click('.pick-cat >> nth=1');
  await red.click('.pick-tile >> nth=0');
  await host.waitForSelector('.host-q');
  await red.waitForSelector('.pick-board', { state: 'detached' });

  // The host gives up on a question: R shows the answer.
  await host.keyboard.press('r');
  await tv.waitForSelector('.tv-q .answer');
  assert.match(await tv.textContent('.tv-q .band'), /Nobody got it/);
  await host.waitForSelector('.controls button:has-text("Back to the board")');
  await host.keyboard.press('Space');
  await host.waitForSelector('.host-board');

  // A picture question that appears slowly: big blocks while the host reads, sharper once the buzzers are on.
  const step = () => tv.$eval('.tv-q canvas.unveil', (c) => Number(c.dataset.step));
  await host.click('.host-board .col:nth-child(1) .tile:nth-of-type(3)');
  await host.waitForSelector('.host-q .host-img img');
  await tv.waitForSelector('.tv-q canvas.unveil[data-step="0"]');
  assert.equal(await tv.locator('.tv-q img.q-img').count(), 0); // the clear picture isn't on screen
  await tv.waitForTimeout(450);
  await shot(tv, 'tv-10-picture');
  await tv.waitForTimeout(700);
  assert.equal(await step(), 0); // it waits while the host reads
  await host.keyboard.press('Space');
  await host.waitForSelector('body[data-phase=armed]');
  await host.waitForSelector('[data-unveil-pct]');
  await tv.waitForTimeout(2600);
  const mid = await step();
  assert.ok(mid >= 3 && mid < 10, `step ${mid}`);
  await shot(tv, 'tv-16-unveil-mid');
  await shot(host, 'host-7-picture');
  // A buzz freezes it.
  await yellow.click('.buzzer');
  await host.waitForSelector('body[data-phase=answering]');
  const frozen = await step();
  await tv.waitForTimeout(1300);
  assert.equal(await step(), frozen);
  // Wrong: the others may buzz, and it carries on.
  await host.keyboard.press('n');
  await host.waitForSelector('body[data-phase=armed]');
  await tv.waitForFunction((was) => Number(document.querySelector('.tv-q canvas.unveil').dataset.step) > was, frozen);
  // Show the answer: the whole picture.
  await host.keyboard.press('r');
  await tv.waitForSelector('.tv-q img.q-img');
  await tv.waitForFunction(() => document.querySelector('.tv-q .q-img').complete);
  await tv.waitForTimeout(450);
  await shot(tv, 'tv-17-unveil-clear');
  await host.waitForSelector('body[data-phase=revealed]');
  await host.keyboard.press('Space');
  await host.waitForSelector('body[data-phase=board]');

  // A picture that only comes with the answer.
  await host.click('.host-board .col:nth-child(3) .tile:nth-of-type(1)');
  await host.waitForSelector('body[data-phase=reading]');
  assert.equal(await tv.locator('.q-img').count(), 0);
  await host.keyboard.press('r');
  await tv.waitForSelector('.tv-q .q-img.reveal-img');
  await tv.waitForTimeout(500);
  await shot(tv, 'tv-11-answer-picture');
  await host.keyboard.press('Space');
  await host.waitForSelector('body[data-phase=board]');

  // A sound clip question: it plays when the question opens; P pauses, 0 starts it again.
  await host.click('.host-board .col:nth-child(4) .tile:nth-of-type(2)');
  await host.waitForSelector('body[data-phase=reading]');
  await tv.waitForSelector('.clip-viz.on');
  await tv.waitForSelector('body[data-music=silent]', { state: 'attached', timeout: 6000 });
  assert.equal(srv.hub.getState().media.playing, true);
  await tv.waitForTimeout(500);
  await shot(tv, 'tv-15-sound-clip');
  await shot(host, 'host-11-sound-clip');
  await host.keyboard.press('p');
  await tv.waitForSelector('.clip-viz:not(.on)');
  await host.keyboard.press('0');
  await tv.waitForSelector('.clip-viz.on');
  assert.equal(srv.hub.getState().media.seq, 1);
  // A buzz pauses the clip; it plays on at the reveal.
  await host.keyboard.press('Space');
  await yellow.waitForSelector('.buzzer.live');
  await yellow.click('.buzzer');
  await tv.waitForSelector('.clip-viz:not(.on)');
  await host.waitForSelector('body[data-phase=answering]');
  assert.equal(srv.hub.getState().media.playing, false);
  await host.keyboard.press('y');
  await host.waitForSelector('body[data-phase=revealed]');
  await tv.waitForSelector('.clip-viz.on');
  assert.equal(score('Lemon Heads'), 50); // −150 on the flag, +200 here
  await host.keyboard.press('Space');
  await host.waitForSelector('body[data-phase=board]');
  assert.equal(srv.hub.getState().media, null);

  // End the board: round 2 comes first. Blue has the fewest points, so Blue picks first.
  await host.waitForSelector('.controls button:has-text("End the board")');
  await host.keyboard.press('e');
  await host.waitForSelector('body[data-phase=round2]');
  await tv.waitForSelector('.tv-round2');
  assert.match(await tv.textContent('.tv-round2'), /Round 2[\s\S]*up to 1000 points[\s\S]*Blue Steel has the fewest points/);
  await blue.waitForFunction(() => document.body.textContent.includes('you pick first'));
  await red.waitForFunction(() => document.body.textContent.includes('Blue Steel has the fewest points'));
  await tv.waitForTimeout(600);
  await shot(tv, 'tv-18-round2');
  await shot(host, 'host-12-round2');
  await shot(blue, 'phone-12-round2');
  await host.keyboard.press('Space');
  await host.waitForSelector('body[data-phase=board]');
  await tv.waitForSelector('.tv-picks .round-tag');
  assert.match(await tv.textContent('.tv-board'), /Capitals II[\s\S]*1000/);
  assert.doesNotMatch(await tv.textContent('body'), /Round 2 answer/);
  // Blue picks a round 2 question on its phone.
  await blue.click('.pick-board button:has-text("Capitals II")');
  await blue.click('.pick-values button:has-text("1000")');
  await host.waitForSelector('body[data-phase=reading]');
  assert.match(await host.textContent('.host-q'), /Round 2 question 5\?[\s\S]*Round 2 answer 5/);
  assert.match(await tv.textContent('.tv-q'), /Round 2 question 5\?/);
  await shot(tv, 'tv-19-round2-question');
  await host.keyboard.press('r');
  await host.waitForSelector('body[data-phase=revealed]');
  await host.keyboard.press('Space');
  await host.waitForSelector('body[data-phase=board]');
  await shot(tv, 'tv-20-round2-board');

  // End round 2: on to the final round.
  await host.keyboard.press('e');
  await host.waitForSelector('body[data-phase=finalWager]');
  await tv.waitForSelector('.tv-final');
  await tv.waitForSelector('body[data-music=final]', { state: 'attached', timeout: 6000 });
  await red.waitForSelector('#bet');
  // Blue (−100) has nothing to bet: it is told so and bets 0 by itself.
  await blue.waitForFunction(() => document.body.textContent.includes('no points to bet'));
  await shot(red, 'phone-10-wager');
  await red.click('.chip:has-text("Half")');
  await red.click('.final-form button[type=submit]');
  await red.waitForFunction(() => document.body.textContent.includes('Bet placed: 100'));
  await yellow.click('.chip:has-text("Nothing")');
  await yellow.click('.final-form button[type=submit]');
  await yellow.waitForFunction(() => document.body.textContent.includes('Bet placed: 0'));
  await waitFor(() => Object.keys(srv.hub.getState().final.wagers).length === 3);
  await tv.waitForFunction(() => document.querySelectorAll('.final-teams li.waiting').length === 0);
  await shot(tv, 'tv-12-final-wager');
  await shot(host, 'host-8-final-wager');

  // The question: teams type their answers.
  await host.keyboard.press('Space');
  await host.waitForSelector('body[data-phase=finalQuestion]');
  await tv.waitForSelector('.tv-q');
  for (const [p, text] of [[red, 'Sognefjorden'], [yellow, 'Hardangerfjorden']]) {
    await p.waitForSelector('#final-answer');
    await p.fill('#final-answer', text);
    await p.press('#final-answer', 'Enter');
    await p.waitForFunction(() => document.body.textContent.includes('Answer sent'));
  }
  // Typing isn't wiped out when another team sends its answer.
  await blue.fill('#final-answer', 'Not sure');
  await waitFor(() => srv.hub.getState().final.answers[srv.hub.getState().teams[2].id] === 'Hardangerfjorden');
  await blue.waitForTimeout(200);
  assert.equal(await blue.inputValue('#final-answer'), 'Not sure');
  await shot(red, 'phone-11-final-answer');
  await tv.waitForTimeout(450);
  await shot(tv, 'tv-13-final-question');
  await shot(host, 'host-9-final-question');

  // Judging: each team's answer appears on the TV as the host marks it.
  await host.keyboard.press('Space');
  await host.waitForSelector('body[data-phase=finalJudge]');
  await tv.waitForSelector('.tv-judge');
  assert.doesNotMatch(await tv.textContent('.tv-judge'), /Hardangerfjorden/);
  await host.click('.final-row:nth-child(1) .btn-good');
  await tv.waitForSelector('.judge-card.shown.right');
  assert.equal(score('Quizzy Rascals'), 300);
  await host.click('.final-row:nth-child(3) .btn-bad');
  await host.click('.final-row:nth-child(2) .btn-bad');
  await tv.waitForSelector('.judge-answer');
  assert.match(await tv.textContent('.judge-answer'), /Sognefjorden/);
  await red.waitForFunction(() => document.body.textContent.includes('Correct! +100'));
  await tv.waitForTimeout(500);
  await shot(tv, 'tv-14-final-judged');
  await shot(host, 'host-10-final-judge');

  await host.keyboard.press('Space');
  await tv.waitForSelector('.tv-over');
  await tv.waitForSelector('body[data-music=over]', { state: 'attached', timeout: 6000 });
  await red.waitForFunction(() => document.body.textContent.includes('Place 1 of 3'));
  await shot(tv, 'tv-9-over');
  await shot(host, 'host-6-over');
  await shot(red, 'phone-9-over');

  // ----- The question editor -----
  const ed = await host.context().newPage();
  ed.on('pageerror', (e) => errors.push(`editor: ${e.message}`));
  // (The refused .txt upload below makes the browser log one "400 Bad Request"; that one is expected.)
  ed.on('console', (m) => m.type() === 'error' && !/status of 400/.test(m.text()) && errors.push(`editor: ${m.text()}`));
  ed.on('dialog', (d) => d.accept());
  await ed.goto(`${base}/editor`);
  await ed.waitForSelector('.ed-note'); // only the built-in sample so far: it's read-only
  await shot(ed, 'editor-1-sample');

  await ed.click('#new-quiz');
  await ed.waitForSelector('.ed-name input:not([disabled])');
  await ed.fill('.ed-name input', 'Musikkquiz');
  await ed.fill('.ed-col:nth-child(1) .ed-cat input', 'Songs');
  // Write one question, with a picture and a sound clip.
  await ed.click('.ed-col:nth-child(1) .ed-tile:nth-of-type(1)');
  await ed.waitForSelector('#q-dialog[open]');
  await ed.fill('#q-form textarea', 'Name this tune');
  await ed.fill('#q-form .field:nth-of-type(3) input', 'Twinkle, Twinkle');
  const root = new URL('..', import.meta.url).pathname;
  const pickers = ed.locator('#q-form input[type=file]');
  await pickers.nth(0).setInputFiles(join(root, 'sets/files/sample-flag-japan.svg'));
  await ed.waitForSelector('#q-form .ed-media img');
  await ed.check('#q-form input[name=unveil]');
  await ed.fill('#q-form input[name=unveilSeconds]', '20');
  await pickers.nth(2).setInputFiles(join(root, 'sets/files/sample-twinkle.mp3'));
  await ed.waitForSelector('#q-form .ed-media audio');
  await ed.fill('#q-form input[type=number][step="0.5"]', '1.5');
  // A wrong kind of file is refused with a clear message.
  await pickers.nth(1).setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
  await ed.waitForSelector('#q-form .ed-media-status.bad');
  // A special placed by hand.
  await ed.selectOption('#q-form select[name=special]', 'double');
  await shot(ed, 'editor-2-question');
  await ed.click('#q-form button[value=done]');
  await ed.waitForSelector('#q-dialog:not([open])', { state: 'attached' });
  await ed.waitForFunction(() => document.querySelector('#ed-status').textContent === 'Saved');
  await shot(ed, 'editor-3-board');
  assert.match(await ed.textContent('.ed-problems'), /Fix these/);
  assert.equal(await ed.textContent('.ed-tile[data-c="0"][data-i="0"] .ed-special'), '🎲');

  // It's saved on the laptop, with the clip and its start time.
  const list = await (await fetch(`${base}/api/sets`)).json();
  const mine = list.find((x) => x.title === 'Musikkquiz');
  const saved = (await (await fetch(`${base}/api/sets/${mine.id}`)).json()).set;
  assert.equal(saved.categories[0].name, 'Songs');
  assert.equal(saved.categories[0].questions[0].question, 'Name this tune');
  assert.match(saved.categories[0].questions[0].audio, /^[0-9a-f]{16}\.mp3$/);
  assert.match(saved.categories[0].questions[0].image, /^[0-9a-f]{16}\.svg$/);
  assert.equal(saved.categories[0].questions[0].audioStart, 1.5);
  assert.equal(saved.categories[0].questions[0].unveil, 20);
  assert.equal(saved.categories[0].questions[0].special, 'double');

  // Round 2: tick it, and a second board appears with double points. Its tiles open like the others.
  await ed.check('#ed-round2 input[name=hasRound2]');
  await ed.waitForSelector('#ed-round2 .ed-tile[data-r="2"]');
  assert.match(await ed.textContent('#ed-round2 .ed-col:nth-child(1)'), /200[\s\S]*400[\s\S]*600[\s\S]*800[\s\S]*1000/);
  await ed.fill('#ed-round2 .ed-col:nth-child(2) .ed-cat input', 'Bands');
  await ed.click('#ed-round2 .ed-col:nth-child(2) .ed-tile:nth-of-type(1)');
  await ed.waitForSelector('#q-dialog[open]');
  assert.match(await ed.textContent('#q-form h2'), /Round 2: Bands/);
  await ed.fill('#q-form textarea', 'Who sang Yellow Submarine?');
  await ed.click('#q-form button[value=done]');
  await ed.waitForSelector('#q-dialog:not([open])', { state: 'attached' });
  await ed.waitForFunction(() => document.querySelector('#ed-status').textContent === 'Saved');
  assert.match(await ed.textContent('.ed-problems'), /Round 2: Bands 200/); // it still needs an answer
  await ed.locator('#ed-round2').scrollIntoViewIfNeeded();
  await shot(ed, 'editor-8-round2');
  const withR2 = (await (await fetch(`${base}/api/sets/${mine.id}`)).json()).set;
  assert.equal(withR2.round2.categories[1].name, 'Bands');
  assert.equal(withR2.round2.categories[1].questions[0].question, 'Who sang Yellow Submarine?');
  assert.equal(withR2.round2.categories[1].questions[0].value, 200);
  // Unticking removes it again (after asking, since it has a question).
  await ed.uncheck('#ed-round2 input[name=hasRound2]');
  await ed.waitForSelector('#ed-round2 .ed-tile', { state: 'detached' });
  await ed.waitForFunction(() => document.querySelector('#ed-status').textContent === 'Saved');
  assert.equal((await (await fetch(`${base}/api/sets/${mine.id}`)).json()).set.round2, undefined);

  // Make a quiz with AI: choose topics and size, copy the request, paste a (messy) answer, and the board fills in.
  await ed.click('#ai-quiz');
  await ed.waitForSelector('#ai-dialog[open]');
  await ed.fill('#ai-form textarea[name=topics]', 'Hovedsteder\nDyr\nMat\nSport');
  await ed.selectOption('#ai-form select[name=difficulty]', 'kids');
  await ed.selectOption('#ai-form select[name=categories]', '3');
  await ed.selectOption('#ai-form select[name=rows]', '3');
  await ed.selectOption('#ai-form select[name=lang]', 'no');
  const request = await ed.inputValue('#ai-request');
  assert.match(request, /Exactly 3 categories with exactly 3 questions each/);
  assert.match(request, /"Hovedsteder", "Dyr", "Mat"\./);
  assert.match(request, /children aged 5 to 9/);
  assert.match(request, /Norwegian \(bokmål\)/);
  assert.match(await ed.textContent('.ai-too-many'), /first 3 topics/);
  await shot(ed, 'editor-4-ai-request');
  await ed.click('.ai-fill');
  assert.match(await ed.textContent('#ai-error'), /Paste the answer/); // nothing pasted yet
  const aiQuiz = {
    title: 'Barnas quiz',
    categories: ['Hovedsteder', 'Dyr', 'Mat'].map((name, c) => ({
      name,
      questions: [100, 200, 300].map((value, i) => ({ value, question: `Spørsmål ${c + 1}.${i + 1}?`, answer: `Svar ${c + 1}.${i + 1}` })),
    })),
    final: { category: 'Verden', question: 'Hva er verdens største hav?', answer: 'Stillehavet' },
  };
  aiQuiz.categories[1].questions[2].answer = 'Svar 1.1'; // the same answer twice
  await ed.fill('#ai-reply', `Her er quizen din!\n\n\`\`\`json\n${JSON.stringify(aiQuiz, null, 2).replace('"title"', '“title”')}\n\`\`\`\nLykke til!`);
  await ed.click('.ai-fill');
  await ed.waitForSelector('#ai-dialog:not([open])', { state: 'hidden' });
  await ed.waitForFunction(() => document.querySelector('.ed-name input')?.value === 'Barnas quiz');
  assert.equal(await ed.locator('.ed-col').count(), 3);
  assert.match(await ed.textContent('.ed-tile[data-c="0"][data-i="0"]'), /Spørsmål 1\.1/);
  assert.match(await ed.textContent('.ai-note'), /Made with AI/);
  assert.match(await ed.textContent('.ai-note'), /Svar 1\.1/);
  assert.match(await ed.textContent('.ed-problems'), /Everything is ready to play/);
  await shot(ed, 'editor-5-ai-board');
  const aiSaved = (await (await fetch(`${base}/api/sets`)).json()).find((x) => x.title === 'Barnas quiz');
  assert.equal(aiSaved.problems, 0);

  // Fill only the empty spots of a quiz that is started: the AI sees what is there and nothing else changes.
  await ed.click('.ed-item:has-text("Musikkquiz")');
  await ed.waitForFunction(() => document.querySelector('.ed-name input')?.value === 'Musikkquiz');
  await ed.click('.ai-fill-open');
  await ed.waitForSelector('#ai-dialog[open] .ai-gaps');
  assert.match(await ed.textContent('.ai-gaps'), /Empty questions: 24/);
  assert.match(await ed.textContent('.ai-gaps'), /Categories without a name: 4/);
  await ed.fill('#ai-form textarea[name=topics]', 'Rock\nPop');
  const fillRequest = await ed.inputValue('#ai-request');
  assert.match(fillRequest, /"question": "Name this tune"/);
  assert.match(fillRequest, /Use these topics for them, in order: "Rock", "Pop", then choose new topics yourself/);
  assert.ok(!fillRequest.includes('"special"'));
  await shot(ed, 'editor-6-ai-fill-request');
  const sketch = JSON.parse(fillRequest.match(/```json\n([\s\S]*?)\n```/)[1]);
  sketch.categories[0].questions[0].question = 'Changed by the AI';
  sketch.categories[0].questions.slice(1).forEach((q, i) => Object.assign(q, { question: `Sang ${i + 2}?`, answer: `Svar ${i + 2}` }));
  sketch.categories[1].name = 'Rock';
  await ed.fill('#ai-reply', '```json\n' + JSON.stringify(sketch) + '\n```');
  await ed.click('.ai-fill-gaps');
  await ed.waitForSelector('#ai-dialog:not([open])', { state: 'hidden' });
  await ed.waitForSelector('.ed-tile.ai-filled');
  assert.equal(await ed.locator('.ed-tile.ai-filled').count(), 4);
  assert.match(await ed.textContent('.ai-note'), /Filled in with AI: 4 questions/);
  assert.match(await ed.textContent('.ai-note'), /still empty/);
  assert.match(await ed.textContent('.ed-tile[data-c="0"][data-i="0"]'), /Name this tune/); // not changed
  assert.equal(await ed.inputValue('.ed-col:nth-child(2) .ed-cat input'), 'Rock');
  await ed.waitForFunction(() => document.querySelector('#ed-status').textContent === 'Saved');
  await shot(ed, 'editor-7-ai-filled');

  // In the lobby it shows as "needs fixing" and can't be picked yet.
  await host.click('.controls button:has-text("Back to the main menu")');
  await host.waitForSelector('body[data-phase=lobby]');
  await host.evaluate(() => window.dispatchEvent(new Event('focus')));
  await host.waitForFunction(() => [...document.querySelectorAll('#set-picker option')].some((o) => o.textContent.includes('needs fixing') && o.disabled));
  await shot(host, 'host-12-lobby-quizzes');

  // Keyboard help.
  await host.keyboard.press('?');
  await host.waitForSelector('#help:not([hidden]) .help-card');
  await shot(host, 'host-13-help');
  await host.keyboard.press('Escape');
  await host.waitForSelector('#help[hidden]', { state: 'attached' });

  // ----- The same game in Norwegian -----
  await pickPill(host, 'lang', 'no');
  await tv.waitForFunction(() => document.body.textContent.includes('Skann for å bli med'));
  await host.click('#start');
  await host.waitForSelector('body[data-phase=board]');
  await host.click('.host-board .col:nth-child(2) .tile:nth-of-type(2)');
  await host.waitForSelector('body[data-phase=reading]');
  await host.keyboard.press('Space');
  await tv.waitForFunction(() => document.body.textContent.includes('Buzz nå!'));
  await shot(tv, 'no-tv-1-armed');
  await shot(red, 'no-phone-1-armed');
  await blue.click('.buzzer');
  await blue.waitForFunction(() => document.body.textContent.includes('Du er først!'));
  await red.waitForFunction(() => document.body.textContent.includes('Blue Steel var først'));
  await host.waitForSelector('body[data-phase=answering]');
  await shot(host, 'no-host-1-answering');
  await shot(red, 'no-phone-2-other');
  await host.keyboard.press('n');
  await tv.waitForFunction(() => document.body.textContent.includes('De andre kan buzze'));
  await shot(tv, 'no-tv-2-wrong');
  await host.keyboard.press('?');
  await host.waitForSelector('#help:not([hidden])');
  assert.match(await host.textContent('#help'), /Tastatur/);
  await shot(host, 'no-host-2-help');

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

// Browser test of how players join (on this Wi-Fi or over the internet), with a pretend cloudflared so it needs no
// internet: choosing "over the internet" with cloudflared missing (the download offer, the Wi-Fi code as a
// stand-in), starting, on (only the internet code on the laptop and the TV, question text on the phones in a
// Quick quiz), the PIN, a phone and a TV page coming in through the tunnel's own listener, back to Wi-Fi, and
// the tunnel breaking during a game (the warning on the laptop, trying again).
//
//   npm run e2e   (runs this after the other browser tests)
//
// Needs Chromium (CHROMIUM=/path/to/chromium if not /usr/bin/chromium). Screenshots: test/screenshots/remote-*.png.

import { mkdirSync, mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { startServer } from '../server.js';
import { binPath } from '../lib/tunnel.js';

if (process.platform === 'win32') {
  console.log('e2e-remote: skipped on Windows (the pretend cloudflared is a shell script)');
  process.exit(0);
}

const shots = fileURLToPath(new URL('./screenshots', import.meta.url));
mkdirSync(shots, { recursive: true });

const dataDir = mkdtempSync(join(tmpdir(), 'proquiz-remote-e2e-'));
const FAKE_URL = 'https://quiet-river-sample-words.trycloudflare.com';
const srv = await startServer({ port: 3462, quiet: true, dataDir, tunnelOptions: { ready: async () => true } }); // the pretend address can't be looked up
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

async function open(url, viewport, label) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: viewport.width < 500 ? 2 : 1 });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${label}: ${e.message}`));
  // (Pages that came through the tunnel lose their connection when it's turned off at the end; that's expected.)
  page.on('console', (m) => m.type() === 'error' && !/403|WebSocket|ERR_CONNECTION/.test(m.text()) && errors.push(`${label}: ${m.text()}`));
  await page.goto(url);
  return page;
}
const pickPill = (page, name, value) => page.click(`label:has(> input[name=${name}][value=${value}])`);
async function shot(page, name) {
  const text = await page.evaluate(() => document.body.innerText);
  const bad = text.match(/[^\n]*(\b((?<!under )null|undefined|NaN)\b|\[object \w+\])[^\n]*/);
  assert.equal(bad, null, `${name} shows a broken value: ${JSON.stringify(bad?.[0])}`);
  await page.screenshot({ path: `${shots}/${name}.png` });
}

try {
  const host = await open(base + '/host', { width: 1366, height: 900 }, 'host');
  const tv = await open(base + '/display', { width: 1920, height: 1080 }, 'tv');
  await host.waitForSelector('#lobby:not([hidden])');
  await tv.waitForSelector('#lobby:not([hidden])');

  // A Quick quiz, so turning it on also puts the question text on the phones.
  await host.waitForSelector('#set-picker option[value=quick-sample]', { state: 'attached' });
  await host.selectOption('#set-picker', 'quick-sample');
  await host.waitForSelector('body[data-mode=quick]', { state: 'attached' });
  // It's on by default; turn it off to see that going over the internet turns it back on.
  await host.evaluate(() => (document.querySelector('#group-quick').open = true));
  await host.locator('input[name=quickPhoneText]').setChecked(false);
  await host.waitForFunction(() => !document.querySelector('input[name=quickPhoneText]').checked);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(srv.hub.getState().settings.quickPhoneText, false);

  // ----- On this Wi-Fi (the default): one code, the laptop's address -----
  await host.click('#group-remote summary');
  assert.equal(await host.textContent('#remote-status'), 'On this Wi-Fi');
  assert.equal(await host.textContent('#join-label'), 'On this Wi-Fi');
  assert.equal(await host.isHidden('#remote-more'), true);
  assert.equal(await tv.isHidden('#qr-label'), true);
  assert.equal(await tv.locator('#qrs .qr svg').count(), 1);

  // ----- Over the internet, but cloudflared isn't on this computer: the download is offered -----
  await pickPill(host, 'joinMode', 'internet');
  await host.waitForSelector('#remote-missing:not([hidden])');
  assert.equal(srv.hub.getState().settings.joinMode, 'internet');
  assert.match(await host.textContent('#remote-state'), /cloudflared/);
  // Where the code will be: what is happening and the download button, with the Wi-Fi code below as a stand-in.
  await host.waitForSelector('#join-wait:not([hidden]) #join-download:not([hidden])');
  assert.equal(await host.textContent('#join-label'), 'On this Wi-Fi, for now');
  await tv.waitForSelector('#tv-wait:not([hidden])');
  assert.match(await tv.textContent('#tv-wait'), /isn’t working/);
  assert.equal(await tv.textContent('#qr-label'), 'On this Wi-Fi, for now');
  await scrollArea(host, 0);
  await host.waitForTimeout(300); // let the bar's blur catch up before the picture
  await shot(host, 'remote-host-missing');
  await host.evaluate(() => document.querySelector('#group-remote').scrollIntoView({ block: 'start' }));
  await shot(host, 'remote-host-missing-settings');
  await shot(tv, 'remote-tv-missing');

  // ----- "installed" (a pretend one that prints an address): try again -----
  mkdirSync(join(dataDir, 'bin'), { recursive: true });
  writeFileSync(
    binPath(dataDir),
    // Not `exec sleep`, so the test can stop this script by its name to play a tunnel that breaks mid-game.
    `#!/bin/sh\necho 'INF |  ${FAKE_URL}  |' >&2\nsleep 1.2\necho 'INF Registered tunnel connection connIndex=0' >&2\nwhile :; do sleep 1; done\n`,
  );
  chmodSync(binPath(dataDir), 0o755);
  await host.click('#remote-retry');
  // Starting: the TV and the laptop say so where the code will be.
  await tv.waitForFunction(() => /Getting the internet address ready/.test(document.querySelector('#tv-wait').textContent));
  await host.waitForSelector('.join-wait[data-status=starting]');
  await scrollArea(host, 0);
  await host.waitForTimeout(300); // let the bar's blur catch up before the picture
  await shot(host, 'remote-host-starting');
  await shot(tv, 'remote-tv-starting');
  await host.waitForFunction(() => /Over the internet · on/.test(document.querySelector('#remote-status').textContent));
  // Now only the internet code: big, as the main one.
  await host.waitForSelector('#join-wait', { state: 'hidden' });
  assert.equal(await host.textContent('#url'), FAKE_URL.replace('https://', ''));
  assert.equal(await host.getAttribute('#qr', 'data-url'), FAKE_URL);
  assert.equal(await host.textContent('#join-label'), 'Over the internet');
  assert.match(await host.textContent('#remote-tv'), /trycloudflare\.com\/display/);
  assert.equal(await host.locator('.join-card .qr svg').count(), 1);
  // Players elsewhere can't see the TV: the Quick quiz puts the question and answers on the phones, with a note.
  await host.waitForSelector('#remote-note:not([hidden])');
  assert.equal(srv.hub.getState().settings.quickPhoneText, true);
  // The TV shows the internet code only.
  await tv.waitForFunction((url) => document.querySelector('#qr').dataset.url === url, FAKE_URL);
  assert.equal(await tv.locator('#qrs .qr svg').count(), 1);
  assert.equal(await tv.textContent('#url'), FAKE_URL.replace('https://', ''));
  assert.equal(await tv.isHidden('#tv-wait'), true);

  // ----- the PIN -----
  await host.check('#remote-pin-on');
  await host.waitForSelector('#remote-pin-row:not([hidden])');
  const pin = srv.hub.getState().settings.remotePin;
  assert.match(pin, /^\d{4}$/);
  await tv.waitForSelector('#remote-pin:not([hidden])');
  assert.equal(await tv.textContent('#remote-pin'), `PIN ${pin}`);
  assert.equal(await host.textContent('#remote-pin'), `PIN: ${pin}`);
  await scrollArea(host, 0);
  await host.waitForTimeout(300); // let the bar's blur catch up before the picture
  await shot(host, 'remote-host-on');
  await host.evaluate(() => document.querySelector('#group-remote').scrollIntoView({ block: 'start' }));
  await shot(host, 'remote-host-settings');
  await shot(tv, 'remote-tv-lobby');

  // ----- a phone and a TV page through the tunnel's own listener -----
  const far = `http://127.0.0.1:${await srv.openRemote()}`;
  assert.equal((await fetch(far + '/host')).status, 403);
  assert.equal((await fetch(far + '/api/sets')).status, 403);
  const phone = await open(far + '/', { width: 390, height: 844 }, 'far phone');
  await phone.waitForSelector('#pin-field:not([hidden])');
  await phone.fill('#name', 'Faraway');
  await phone.click('#swatches label:nth-child(2)');
  await phone.fill('#pin', pin === '0000' ? '1111' : '0000');
  await phone.click('#join-btn');
  await phone.waitForFunction(() => /PIN/.test(document.querySelector('#join-error').textContent));
  await shot(phone, 'remote-phone-pin');
  await phone.fill('#pin', pin);
  await phone.click('#join-btn');
  await phone.waitForSelector('#team:not([hidden])');
  await host.waitForSelector('#teams .elsewhere');
  // A phone on the Wi-Fi isn't asked.
  const near = await open(base + '/', { width: 390, height: 844 }, 'near phone');
  await near.waitForSelector('#join:not([hidden])');
  assert.equal(await near.isHidden('#pin-field'), true);
  // The TV page over the internet works, but never shows the PIN.
  const farTv = await open(far + '/display', { width: 1280, height: 720 }, 'far tv');
  await farTv.waitForFunction((url) => document.querySelector('#qr').dataset.url === url, FAKE_URL);
  assert.equal(await farTv.isHidden('#remote-pin'), true);
  assert.equal((await farTv.evaluate(() => document.body.innerText)).includes(pin), false);
  // …and doesn't count as the room's TV (the laptop keeps playing the sounds).
  assert.equal(await host.evaluate(() => document.querySelectorAll('#teams li').length), 1);
  await shot(host, 'remote-host-player');

  // ----- back to Wi-Fi: the tunnel stops, one Wi-Fi code again -----
  await pickPill(host, 'joinMode', 'wifi');
  await host.waitForFunction(() => document.querySelector('#remote-status').textContent === 'On this Wi-Fi');
  await host.waitForFunction((url) => document.querySelector('#qr').dataset.url !== url, FAKE_URL);
  assert.equal(await host.textContent('#join-label'), 'On this Wi-Fi');
  assert.equal(await host.isHidden('#remote-pin'), true);
  await tv.waitForFunction((url) => document.querySelector('#qr').dataset.url !== url, FAKE_URL);
  assert.equal(await tv.isHidden('#qr-label'), true);
  assert.equal(srv.tunnel.running(), false);
  await phone.waitForSelector('#offline:not([hidden])'); // its connection went with the tunnel

  // ----- over the internet again, and it breaks during the game: a small warning on the laptop -----
  await pickPill(host, 'joinMode', 'internet');
  await host.waitForFunction(() => /Over the internet · on/.test(document.querySelector('#remote-status').textContent), null, { timeout: 8000 });
  await host.click('#start');
  await host.waitForSelector('body[data-phase=section]', { state: 'attached' });
  assert.equal(await host.isHidden('#remote-warn'), true);
  execFileSync('pkill', ['-f', binPath(dataDir)]); // the pretend cloudflared stops
  await host.waitForSelector('#remote-warn:not([hidden])');
  assert.match(await host.textContent('#remote-warn'), /has stopped/);
  await shot(host, 'remote-host-warn');
  await host.click('#remote-warn button'); // try again: the same pretend address comes back
  await host.waitForSelector('#remote-warn', { state: 'hidden', timeout: 8000 });

  assert.deepEqual(errors, []);
  console.log('e2e-remote: all good');
} finally {
  await browser.close();
  await srv.close();
}

// "A new version is out" (lib/update.js): reading GitHub's answer, comparing versions, the notes excerpt, the
// 6-hour cache and the timeout, all with a pretend fetch (never the real internet); then the real server:
// only the host hears about it, only when a host page connects, never over the tunnel's listener, and not at
// all when the setting is off.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseVersion, compareVersions, excerpt, readRelease, createUpdateCheck, CHECK_EVERY_MS, RELEASES_API } from '../lib/update.js';
import { startServer } from '../server.js';

const TAG_URL = (v) => `https://github.com/dbugger85/proquiz/releases/tag/v${v}`;

// A pretend GitHub: answers with one release (or a problem), and counts the calls.
function fakeGitHub({ tag = 'v9.9.0', url = TAG_URL('9.9.0'), body = 'Faster buzzers.', status = 200, draft = false, prerelease = false, fail = null, json = null } = {}) {
  const calls = [];
  const fetchImpl = (u, opts = {}) => {
    calls.push({ url: u, opts });
    if (fail === 'network') return Promise.reject(new TypeError('fetch failed'));
    if (fail === 'timeout') return new Promise((_, reject) => opts.signal.addEventListener('abort', () => reject(opts.signal.reason)));
    return Promise.resolve({
      status,
      json: async () => {
        if (fail === 'json') throw new SyntaxError('not json');
        return json ?? { tag_name: tag, html_url: url, body, draft, prerelease };
      },
    });
  };
  return { calls, fetchImpl };
}

test('versions: v2.3.0 → 2.3.0, compared number by number, pre-releases and nonsense refused', () => {
  assert.deepEqual(parseVersion('v2.3.0'), [2, 3, 0]);
  assert.deepEqual(parseVersion('2.10.1'), [2, 10, 1]);
  assert.equal(parseVersion('2.3.0-beta.1'), null);
  assert.equal(parseVersion('v2.3'), null);
  assert.equal(parseVersion('latest'), null);
  assert.equal(parseVersion(null), null);
  assert.ok(compareVersions('2.10.0', '2.9.9') > 0); // not a text comparison
  assert.ok(compareVersions('v2.3.0', '2.3.1') < 0);
  assert.equal(compareVersions('2.3.0', 'v2.3.0'), 0);
  assert.equal(compareVersions('2.3.0', 'oops'), null);
});

test('the notes excerpt: the first paragraph as plain text, no markdown or links, at most ~300 letters', () => {
  assert.equal(excerpt('## What’s new\n\n**Faster buzzers** and a [new look](https://x.y) for the TV.\n\n- more\n- stuff'), 'Faster buzzers and a new look for the TV.');
  assert.equal(excerpt('- Fixed a crash\r\n- New sounds\r\n\r\nSecond paragraph'), 'Fixed a crash New sounds');
  assert.equal(excerpt('![shot](https://x.y/a.png)\n\n`code` and <b>html</b> and _italics_'), 'code and html and italics');
  assert.equal(excerpt(''), '');
  assert.equal(excerpt(null), '');
  assert.equal(excerpt('## Only a heading'), '');
  const long = excerpt('word '.repeat(100));
  assert.ok(long.length <= 301 && long.endsWith('…'), long);
});

test('readRelease: newer, same, older, malformed tag, wrong address, drafts and pre-releases', () => {
  const ok = { tag_name: 'v2.3.0', html_url: TAG_URL('2.3.0'), body: 'Nice.' };
  assert.deepEqual(readRelease(ok, '2.2.1'), { version: '2.3.0', url: TAG_URL('2.3.0'), notes: 'Nice.' });
  assert.equal(readRelease(ok, '2.3.0'), null); // the same
  assert.equal(readRelease(ok, '2.4.0'), null); // older than what runs
  assert.equal(readRelease({ ...ok, tag_name: 'release-3' }, '2.2.1'), null);
  assert.equal(readRelease({ ...ok, tag_name: 'v3.0.0-rc.1' }, '2.2.1'), null);
  assert.equal(readRelease({ ...ok, html_url: 'https://github.com/someone-else/proquiz/releases/tag/v2.3.0' }, '2.2.1'), null);
  assert.equal(readRelease({ ...ok, html_url: 'http://github.com/dbugger85/proquiz/releases/tag/v2.3.0' }, '2.2.1'), null); // not https
  assert.equal(readRelease({ ...ok, html_url: 'https://github.com/dbugger85/proquiz/releases/tag/v2.3.0" onclick="x' }, '2.2.1'), null);
  assert.equal(readRelease({ ...ok, html_url: 42 }, '2.2.1'), null);
  assert.equal(readRelease({ ...ok, draft: true }, '2.2.1'), null);
  assert.equal(readRelease({ ...ok, prerelease: true }, '2.2.1'), null);
  assert.equal(readRelease(null, '2.2.1'), null);
  assert.equal(readRelease('v9', '2.2.1'), null);
  assert.equal(readRelease(ok, null), null); // the running version is unknown
  assert.equal(readRelease({ ...ok, body: 7 }, '2.2.1').notes, '');
});

test('check(): asks GitHub with a User-Agent and a timeout, once per 6 hours, and shares a check on its way', async () => {
  const gh = fakeGitHub();
  let now = 1_000_000;
  const u = createUpdateCheck({ version: '2.2.1', fetchImpl: gh.fetchImpl, now: () => now });
  assert.equal(u.current(), null);
  const [a, b] = await Promise.all([u.check(), u.check()]);
  assert.deepEqual(a, { version: '9.9.0', url: TAG_URL('9.9.0'), notes: 'Faster buzzers.' });
  assert.equal(b, a);
  assert.equal(gh.calls.length, 1, 'two checks at once make one request');
  assert.equal(gh.calls[0].url, RELEASES_API);
  assert.match(gh.calls[0].opts.headers['User-Agent'], /^ProQuiz\//);
  assert.ok(gh.calls[0].opts.signal instanceof AbortSignal);
  assert.equal(gh.calls[0].opts.redirect, 'manual');
  assert.equal(u.current(), a);

  now += CHECK_EVERY_MS - 1;
  assert.equal(await u.check(), a);
  assert.equal(gh.calls.length, 1, 'within 6 hours: the remembered answer');
  now += 2;
  await u.check();
  assert.equal(gh.calls.length, 2, 'after 6 hours: asked again');
});

test('check(): same or older version, a bad tag, a wrong address, errors, rate limits and a timeout all give nothing', async () => {
  const quiet = async (opts, version = '2.2.1') => {
    const gh = fakeGitHub(opts);
    const u = createUpdateCheck({ version, fetchImpl: gh.fetchImpl, timeoutMs: 20 });
    const found = await u.check();
    return { found, calls: gh.calls.length, current: u.current() };
  };
  assert.deepEqual(await quiet({}, '9.9.0'), { found: null, calls: 1, current: null }); // the same
  assert.deepEqual(await quiet({}, '10.0.0'), { found: null, calls: 1, current: null }); // older
  assert.deepEqual(await quiet({ tag: 'v10' }), { found: null, calls: 1, current: null });
  assert.deepEqual(await quiet({ url: 'https://evil.example/proquiz/releases/tag/v9.9.0' }), { found: null, calls: 1, current: null });
  assert.deepEqual(await quiet({ fail: 'network' }), { found: null, calls: 1, current: null });
  assert.deepEqual(await quiet({ fail: 'json' }), { found: null, calls: 1, current: null });
  assert.deepEqual(await quiet({ status: 403 }), { found: null, calls: 1, current: null }); // rate limited
  assert.deepEqual(await quiet({ status: 404 }), { found: null, calls: 1, current: null });
  assert.deepEqual(await quiet({ json: [] }), { found: null, calls: 1, current: null });
  const t0 = Date.now();
  assert.deepEqual(await quiet({ fail: 'timeout' }), { found: null, calls: 1, current: null });
  assert.ok(Date.now() - t0 < 2000, 'gave up by the timeout');
  // A running version that isn't known: no request at all.
  const gh = fakeGitHub();
  assert.equal(await createUpdateCheck({ version: null, fetchImpl: gh.fetchImpl }).check(), null);
  assert.equal(gh.calls.length, 0);
});

test('a failed check is not retried until 6 hours later', async () => {
  const gh = fakeGitHub({ fail: 'network' });
  let now = 5;
  const u = createUpdateCheck({ version: '2.2.1', fetchImpl: gh.fetchImpl, now: () => now });
  await u.check();
  await u.check();
  assert.equal(gh.calls.length, 1);
  now += CHECK_EVERY_MS + 1;
  await u.check();
  assert.equal(gh.calls.length, 2);
});

// ----- the real server -----

const dataDir = mkdtempSync(join(tmpdir(), 'proquiz-update-'));
const gh = fakeGitHub({ body: '## New\n\n**Faster buzzers** and a [new look](https://x.y).\n\nMore below.' });
let clock = 10_000_000;
let srv;
let url;
before(async () => {
  srv = await startServer({ port: 3498, quiet: true, dataDir, updateOptions: { fetchImpl: gh.fetchImpl, now: () => clock } });
  url = `ws://127.0.0.1:${srv.info.port}/ws`;
});
after(() => srv.close());

async function client(role, wsUrl = url) {
  const ws = new WebSocket(wsUrl);
  const msgs = [];
  const waiters = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    msgs.push(m);
    for (const w of [...waiters]) if (w.test(m)) {
      waiters.splice(waiters.indexOf(w), 1);
      w.resolve(m);
    }
  };
  await new Promise((r) => (ws.onopen = r));
  const c = {
    ws,
    msgs,
    send: (m) => ws.send(JSON.stringify(m)),
    wait(test, ms = 2000) {
      const found = msgs.find(test);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        waiters.push({ test, resolve });
        setTimeout(() => reject(new Error('timed out waiting')), ms);
      });
    },
    close: () => ws.close(),
  };
  c.send({ type: 'hello', role });
  await c.wait((m) => m.type === 'welcome' || m.type === 'error');
  return c;
}
const settle = () => new Promise((r) => setTimeout(r, 150));

test('nothing is asked when ProQuiz starts; a host page connecting asks once, and only the host gets `update`', async () => {
  assert.equal(gh.calls.length, 0, 'not at start');
  const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const tv = await client('display');
  const phone = await client('phone');
  await settle();
  assert.equal(gh.calls.length, 0, 'a TV or a phone connecting asks nothing');

  const host = await client('host');
  assert.equal(host.msgs.find((m) => m.type === 'welcome').info.version, version, 'the host learns which ProQuiz this is');
  const s = await host.wait((m) => m.type === 'state' && m.update);
  const { canInstall, install, ...release } = s.update;
  assert.deepEqual(release, { version: '9.9.0', url: TAG_URL('9.9.0'), notes: 'Faster buzzers and a new look.' });
  assert.equal(canInstall, false, 'under npm start there is no Update now (lib/selfupdate.js)');
  assert.equal(install.stage, 'idle');
  assert.equal(gh.calls.length, 1);

  await settle();
  assert.ok(tv.msgs.filter((m) => m.type === 'state').length > 0);
  assert.ok(tv.msgs.every((m) => !('update' in m)), 'the TV never hears about it');
  assert.ok(phone.msgs.every((m) => !('update' in m)), 'nor the phones');

  // Another host page within 6 hours: the remembered answer, no new request.
  const host2 = await client('host');
  await host2.wait((m) => m.type === 'state' && m.update?.version === '9.9.0');
  assert.equal(gh.calls.length, 1);

  // Every later state message carries it too (so a reloaded host page always shows the banner).
  srv.hub.dispatch({ type: 'settings', settings: { sound: false } });
  const later = await host.wait((m) => m.type === 'state' && m.view.settings.sound === false);
  assert.equal(later.update.version, '9.9.0');
  srv.hub.dispatch({ type: 'settings', settings: { sound: true } });
  for (const c of [tv, phone, host, host2]) c.close();
});

test('after 6 hours a host page asks again; with the setting off it never asks', async () => {
  clock += CHECK_EVERY_MS + 1;
  srv.hub.dispatch({ type: 'settings', settings: { updateCheck: false } });
  assert.equal(srv.hub.getState().settings.updateCheck, false);
  const off = await client('host');
  await off.wait((m) => m.type === 'state');
  await settle();
  assert.equal(gh.calls.length, 1, 'the setting is off: no request');
  off.close();

  srv.hub.dispatch({ type: 'settings', settings: { updateCheck: true } });
  const on = await client('host');
  await on.wait((m) => m.type === 'state' && m.update);
  assert.equal(gh.calls.length, 2, 'the setting is on and 6 hours have passed: asked again');
  on.close();
});

test('nothing goes over the tunnel’s listener: no host there, and a TV there gets no `update`', async () => {
  const port = await srv.openRemote();
  const remoteUrl = `ws://127.0.0.1:${port}/ws`;
  const host = await client('host', remoteUrl);
  assert.equal(host.msgs.find((m) => m.type === 'error')?.code, 'host-only-on-laptop');
  const tv = await client('display', remoteUrl);
  await tv.wait((m) => m.type === 'state');
  await settle();
  assert.ok(tv.msgs.every((m) => !('update' in m)));
  host.close();
  tv.close();
});

test('the setting is saved with the others and survives a bad value from an old save', async () => {
  const { DEFAULT_SETTINGS, newGame } = await import('../lib/game.js');
  assert.equal(DEFAULT_SETTINGS.updateCheck, true);
  assert.equal(newGame({ categories: [] }, { updateCheck: 'yes' }).settings.updateCheck, true);
  assert.equal(newGame({ categories: [] }, { updateCheck: 0 }).settings.updateCheck, false);
  assert.equal(newGame({ categories: [] }, {}).settings.updateCheck, true);
});

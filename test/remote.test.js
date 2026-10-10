// Players elsewhere: the tunnel-only listener (everything on it counts as coming from outside), the PIN,
// and lib/tunnel.js (finding cloudflared, reading its address, the one-time download), without the internet.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../server.js';
import { COLORS } from '../lib/game.js';
import { parseTunnelUrl, assetFor, candidates, findCloudflared, createTunnel, binPath, RELEASES, dnsReady } from '../lib/tunnel.js';

const dataDir = mkdtempSync(join(tmpdir(), 'proquiz-remote-'));
let srv;
let remotePort;
before(async () => {
  srv = await startServer({ port: 3475, quiet: true, dataDir });
  remotePort = await srv.openRemote();
});
after(() => srv.close());

async function client(port, role, extra = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
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
    msgs,
    send: (m) => ws.send(JSON.stringify(m)),
    wait(test, ms = 2000) {
      const found = msgs.findLast(test);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        waiters.push({ test, resolve });
        setTimeout(() => reject(new Error('timed out waiting')), ms);
      });
    },
    next(test, ms = 2000) {
      return new Promise((resolve, reject) => {
        waiters.push({ test, resolve });
        setTimeout(() => reject(new Error('timed out waiting')), ms);
      });
    },
    close: () => ws.close(),
  };
  c.send({ type: 'hello', role, ...extra });
  await c.wait((m) => m.type === 'welcome' || m.type === 'error');
  return c;
}

const get = (port, path) => fetch(`http://127.0.0.1:${port}${path}`).then(async (r) => ({ status: r.status, text: await r.text() }));

test('the tunnel listener refuses the host screen, the editor and /api/, even from 127.0.0.1', async () => {
  assert.notEqual(remotePort, srv.info.port);
  // The laptop's own address still works as before.
  assert.equal((await get(srv.info.port, '/api/sets')).status, 200);
  assert.equal((await get(srv.info.port, '/host')).status, 200);
  // Through the tunnel: no API (it changes files on the laptop), no host screen, no editor.
  for (const path of ['/api/sets', '/api/sets/sample', '/api/export/sample', '/host', '/editor']) {
    assert.equal((await get(remotePort, path)).status, 403, path);
  }
  const del = await fetch(`http://127.0.0.1:${remotePort}/api/sets/sample`, { method: 'DELETE' });
  assert.equal(del.status, 403);
  // The phone page, the TV page and what they load are there.
  for (const path of ['/', '/display', '/js/phone.js', '/lib/game.js', '/style.css']) assert.equal((await get(remotePort, path)).status, 200, path);

  // A host hello over the tunnel is refused; a TV page and phones are fine.
  const fake = await client(remotePort, 'host');
  assert.equal(fake.msgs.find((m) => m.type === 'error')?.code, 'host-only-on-laptop');
  assert.ok(!fake.msgs.some((m) => m.type === 'state'));
  fake.close();
});

test('players elsewhere: PIN, the TV page over the internet, and who is remote', async () => {
  const host = await client(srv.info.port, 'host');
  host.send({ type: 'cmd', action: { type: 'settings', settings: { remotePin: '4821' } } });
  await host.wait((m) => m.type === 'state' && m.view.settings.remotePin === '4821');

  // A TV page opened over the internet doesn't count as the room's TV (the host keeps playing the sounds, and
  // single-screen mode stays), and never shows the PIN.
  const farTv = await client(remotePort, 'display');
  const tvState = await farTv.wait((m) => m.type === 'state');
  assert.equal(tvState.view.settings.remotePin, '');
  assert.deepEqual(tvState.remote, { status: 'off', url: null });
  // The TV in the room does show it.
  const roomTv = await client(srv.info.port, 'display');
  assert.equal((await roomTv.wait((m) => m.type === 'state')).view.settings.remotePin, '4821');
  const hs = await host.wait((m) => m.type === 'state' && m.displays === 1);
  assert.equal(hs.tvs, 1); // the room's TV only
  assert.equal(hs.remote.status, 'off');
  assert.ok(!host.msgs.some((m) => m.type === 'state' && m.displays > 1));

  // A phone over the internet is asked for the PIN, a wrong one is refused, the right one lets it in.
  const far = await client(remotePort, 'phone');
  const ps = await far.wait((m) => m.type === 'state');
  assert.equal(ps.needPin, true);
  assert.equal(JSON.stringify(ps).includes('4821'), false);
  far.send({ type: 'join', name: 'Far away', color: COLORS[0] });
  assert.equal((await far.next((m) => m.type === 'error')).code, 'bad-pin');
  far.send({ type: 'join', name: 'Far away', color: COLORS[0], pin: '1111' });
  assert.equal((await far.next((m) => m.type === 'error')).code, 'bad-pin');
  far.send({ type: 'join', name: 'Far away', color: COLORS[0], pin: ' 4821 ' });
  const { teamId } = await far.next((m) => m.type === 'joined');
  const after = await far.wait((m) => m.type === 'state'); // the state comes just before "joined"
  assert.equal(after.needPin, undefined);
  // Changing the name later needs no PIN.
  far.send({ type: 'join', name: 'Far Away', color: COLORS[0] });
  await far.next((m) => m.type === 'joined');

  // A phone on the Wi-Fi never needs it.
  const near = await client(srv.info.port, 'phone');
  assert.equal((await near.wait((m) => m.type === 'state')).needPin, undefined);
  near.send({ type: 'join', name: 'In the room', color: COLORS[1] });
  await near.next((m) => m.type === 'joined');

  // The host knows which players are elsewhere.
  const last = await host.wait((m) => m.type === 'state' && m.view.teams.length === 2);
  assert.deepEqual(last.remote.remoteTeams, [teamId]);

  // Too many wrong PINs in a minute: everyone elsewhere has to wait.
  const guesser = await client(remotePort, 'phone');
  for (let k = 0; k < 9; k++) {
    guesser.send({ type: 'join', name: `Guess ${k}`, color: COLORS[2], pin: String(1000 + k) });
    await guesser.next((m) => m.type === 'error');
  }
  guesser.send({ type: 'join', name: 'Guess', color: COLORS[2], pin: '4821' });
  assert.equal((await guesser.next((m) => m.type === 'error')).code, 'pin-wait');

  // No PIN set: nobody is asked.
  host.send({ type: 'cmd', action: { type: 'settings', settings: { remotePin: '' } } });
  await host.wait((m) => m.type === 'state' && m.view.settings.remotePin === '');
  // Only 4 digits (or nothing) are allowed.
  host.send({ type: 'cmd', action: { type: 'settings', settings: { remotePin: '12a4' } } });
  assert.equal((await host.next((m) => m.type === 'error')).code, 'bad-settings');
  for (const c of [host, farTv, roomTv, far, near, guesser]) c.close();
});

// ----- how players join: the setting starts and stops the tunnel -----

test('join mode: choosing "over the internet" starts the tunnel, Wi-Fi stops it; a saved choice waits for the host', { skip: process.platform === 'win32' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'proquiz-joinmode-'));
  const bin = fakeCloudflared(dir, ['INF |  https://join-mode-words.trycloudflare.com  |', 'INF Registered tunnel connection connIndex=0']);
  const tunnelOptions = { ready: async () => true, find: () => bin };
  let one = await startServer({ port: 3477, quiet: true, dataDir: dir, tunnelOptions });
  try {
    const host = await client(one.info.port, 'host');
    const tv = await client(one.info.port, 'display');
    assert.equal(one.hub.getState().settings.joinMode, 'wifi'); // the default
    assert.equal(one.tunnel.status().status, 'off'); // nothing starts by itself
    host.send({ type: 'cmd', action: { type: 'settings', settings: { joinMode: 'internet' } } });
    // The TV hears how far along it is (to say so), and the address once it's on.
    await tv.wait((m) => m.type === 'state' && m.remote.status === 'starting');
    const on = await tv.wait((m) => m.type === 'state' && m.remote.status === 'on');
    assert.equal(on.remote.url, 'https://join-mode-words.trycloudflare.com');
    assert.equal(on.view.settings.joinMode, 'internet');
    host.send({ type: 'cmd', action: { type: 'settings', settings: { joinMode: 'wifi' } } });
    await waitFor(() => one.tunnel.status().status === 'off');
    assert.equal(one.tunnel.running(), false);
    // The old on/off message sets the choice too.
    host.send({ type: 'tunnel', on: true });
    await waitFor(() => one.tunnel.status().status === 'on');
    assert.equal(one.hub.getState().settings.joinMode, 'internet');
    host.send({ type: 'cmd', action: { type: 'settings', settings: { joinMode: 'nope' } } });
    assert.equal((await host.next((m) => m.type === 'error')).code, 'bad-settings');
    for (const c of [host, tv]) c.close();
    await new Promise((r) => setTimeout(r, 400)); // the autosave keeps "internet"
  } finally {
    await one.close();
  }
  // Started again with "internet" saved: no tunnel until the host page opens the lobby (a TV or phone doesn't count).
  one = await startServer({ port: 3477, quiet: true, dataDir: dir, tunnelOptions });
  try {
    assert.equal(one.hub.getState().settings.joinMode, 'internet');
    const phone = await client(one.info.port, 'phone');
    const tv = await client(one.info.port, 'display');
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(one.tunnel.status().status, 'off');
    const host = await client(one.info.port, 'host');
    await waitFor(() => one.tunnel.status().status === 'on');
    for (const c of [host, tv, phone]) c.close();
  } finally {
    await one.close();
  }
});

// ----- lib/tunnel.js -----

test('the tunnel address is read from what cloudflared prints', () => {
  const out = [
    '2026-10-10T14:35:20Z INF Requesting new quick Tunnel on trycloudflare.com...',
    '2026-10-10T14:35:25Z INF +--------------------------------------------------------------------------------------------+',
    '2026-10-10T14:35:25Z INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |',
    '2026-10-10T14:35:25Z INF |  https://stake-operating-desperate-sunday.trycloudflare.com                                |',
  ].join('\n');
  assert.equal(parseTunnelUrl(out), 'https://stake-operating-desperate-sunday.trycloudflare.com');
  // The service's own address in an error line isn't the game's.
  assert.equal(parseTunnelUrl('ERR failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": EOF'), null);
  assert.equal(parseTunnelUrl('Thank you for trying Cloudflare Tunnel. https://www.cloudflare.com/website-terms/'), null);
  assert.equal(parseTunnelUrl('nothing yet'), null);
  assert.equal(parseTunnelUrl('|  HTTPS://Some-Words.TryCloudflare.com  |'), 'https://some-words.trycloudflare.com');
});

test('the right cloudflared download for each computer', () => {
  assert.equal(assetFor('win32', 'x64'), 'cloudflared-windows-amd64.exe');
  assert.equal(assetFor('win32', 'arm64'), 'cloudflared-windows-amd64.exe');
  assert.equal(assetFor('win32', 'ia32'), 'cloudflared-windows-386.exe');
  assert.equal(assetFor('darwin', 'arm64'), 'cloudflared-darwin-arm64.tgz');
  assert.equal(assetFor('darwin', 'x64'), 'cloudflared-darwin-amd64.tgz');
  assert.equal(assetFor('linux', 'x64'), 'cloudflared-linux-amd64');
  assert.equal(assetFor('linux', 'arm64'), 'cloudflared-linux-arm64');
  assert.equal(assetFor('linux', 'arm'), 'cloudflared-linux-arm');
  assert.equal(assetFor('freebsd', 'x64'), null);
  assert.equal(assetFor('linux', 'mips'), null);
  assert.match(RELEASES, /^https:\/\/github\.com\/cloudflare\/cloudflared\/releases\/latest\/download\/$/);
});

test('cloudflared is looked for on PATH, next to the program and in the ProQuiz folder', () => {
  const win = candidates({ platform: 'win32', env: { Path: 'C:\\Tools;C:\\Windows', ProgramFiles: 'C:\\Program Files' }, execPath: 'D:\\ProQuiz\\ProQuiz.exe', dataDir: 'C:\\Users\\me\\ProQuiz' });
  assert.equal(win[0], 'C:\\Tools\\cloudflared.exe');
  assert.ok(win.includes('C:\\Program Files\\cloudflared\\cloudflared.exe'));
  assert.ok(win.includes('D:\\ProQuiz\\cloudflared.exe'));
  const mac = candidates({ platform: 'darwin', env: { PATH: '/usr/bin:/bin' }, execPath: '/Users/me/ProQuiz/ProQuiz', dataDir: '/Users/me/ProQuiz' });
  assert.ok(mac.includes('/opt/homebrew/bin/cloudflared'));
  assert.equal(mac.at(-1), join('/Users/me/ProQuiz', 'bin', 'cloudflared'));

  const dir = mkdtempSync(join(tmpdir(), 'proquiz-find-'));
  const opts = { platform: 'linux', env: { PATH: join(dir, 'nowhere') }, execPath: join(dir, 'ProQuiz'), dataDir: dir };
  // (/usr/local/bin and /usr/bin are searched too; skip the check if this computer really has cloudflared.)
  const real = findCloudflared(opts);
  if (!real) {
    mkdirSync(join(dir, 'bin'));
    writeFileSync(binPath(dir, 'linux'), '');
    assert.equal(findCloudflared(opts), binPath(dir, 'linux'));
    writeFileSync(join(dir, 'cloudflared'), ''); // next to the program comes first
    assert.equal(findCloudflared(opts), join(dir, 'cloudflared'));
  }
});

// A pretend cloudflared: prints what the real one prints, then waits until it is stopped.
function fakeCloudflared(dir, lines, { exitAfter } = {}) {
  const file = join(dir, 'cloudflared');
  const body = lines.map((l) => `echo '${l}' >&2`).join('\n');
  writeFileSync(file, `#!/bin/sh\n${body}\n${exitAfter ? 'exit 1' : 'exec sleep 30'}\n`);
  chmodSync(file, 0o755);
  return file;
}

const waitFor = async (check, ms = 3000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};

test('the tunnel: starting, on with its address, off again; missing; failing', { skip: process.platform === 'win32' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'proquiz-tunnel-'));
  const seen = [];
  let opened = 0;
  let closed = 0;
  const bin = fakeCloudflared(dir, ['INF Requesting new quick Tunnel on trycloudflare.com...', 'INF |  https://happy-test-words.trycloudflare.com  |', 'INF Registered tunnel connection connIndex=0']);
  const tunnel = createTunnel({ ready: async () => true,
    dataDir: dir,
    open: async () => (opened++, 4321),
    close: async () => void closed++,
    onChange: (st) => seen.push(st.status),
    find: () => bin,
  });
  assert.equal(tunnel.status().status, 'off');
  await tunnel.start();
  await waitFor(() => tunnel.status().status === 'on');
  assert.equal(tunnel.status().url, 'https://happy-test-words.trycloudflare.com');
  assert.equal(opened, 1);
  await tunnel.start(); // already on: nothing new
  assert.equal(opened, 1);
  await tunnel.stop();
  await waitFor(() => tunnel.status().status === 'off');
  assert.equal(tunnel.status().url, null);
  assert.equal(closed, 1);
  assert.deepEqual(seen, ['starting', 'on', 'off']);

  // Not found: "missing", and the listener isn't opened.
  const none = createTunnel({ ready: async () => true, dataDir: dir, open: async () => (opened++, 1), close: async () => {}, find: () => null });
  await none.start();
  assert.equal(none.status().status, 'missing');
  assert.equal(opened, 1);

  // The program stops by itself before giving an address: "failed".
  const badDir = mkdtempSync(join(tmpdir(), 'proquiz-tunnel-'));
  const bad = fakeCloudflared(badDir, ['ERR failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": EOF'], { exitAfter: true });
  const failing = createTunnel({ ready: async () => true, dataDir: badDir, open: async () => 1, close: async () => void closed++, find: () => bad });
  await failing.start();
  await waitFor(() => failing.status().status === 'failed');
  assert.equal(failing.status().reason, 'start');
  assert.equal(closed, 2);
});

test('the one-time download puts cloudflared in the ProQuiz folder, then starts it', { skip: process.platform === 'win32' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'proquiz-dl-'));
  const script = `#!/bin/sh\necho 'INF |  https://downloaded-ok.trycloudflare.com  |' >&2\necho 'INF Registered tunnel connection' >&2\nexec sleep 30\n`;
  const body = Buffer.concat([Buffer.from(script), Buffer.alloc(1_200_000, 10)]); // big enough to look real
  const asked = [];
  const fetchImpl = async (url) => {
    asked.push(url);
    return new Response(body, { status: 200, headers: { 'content-length': String(body.length) } });
  };
  const target = binPath(dir, 'linux');
  const tunnel = createTunnel({ ready: async () => true, dataDir: dir, open: async () => 1, close: async () => {}, platform: 'linux', arch: 'x64', fetchImpl, find: () => (existsSync(target) ? target : null) });
  await tunnel.start();
  assert.equal(tunnel.status().status, 'missing');
  await tunnel.download();
  assert.deepEqual(asked, [RELEASES + 'cloudflared-linux-amd64']);
  assert.ok(statSync(target).mode & 0o100, 'can be run');
  await waitFor(() => tunnel.status().status === 'on');
  assert.equal(tunnel.status().url, 'https://downloaded-ok.trycloudflare.com');
  await tunnel.stop();
  await waitFor(() => tunnel.status().status === 'off');

  // No internet (or a broken answer): "failed", reason "download", nothing left behind.
  const dir2 = mkdtempSync(join(tmpdir(), 'proquiz-dl-'));
  const offline = createTunnel({ ready: async () => true, dataDir: dir2, open: async () => 1, close: async () => {}, platform: 'linux', arch: 'x64', fetchImpl: async () => new Response('nope', { status: 404 }), find: () => null });
  await offline.download();
  assert.deepEqual([offline.status().status, offline.status().reason], ['failed', 'download']);
  assert.equal(existsSync(binPath(dir2, 'linux')), false);
});

test('the QR code waits until the new address can be found on the internet', { skip: process.platform === 'win32' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'proquiz-tunnel-'));
  const bin = fakeCloudflared(dir, ['INF |  https://not-yet-there.trycloudflare.com  |', 'INF Registered tunnel connection connIndex=0']);
  let asked = 0;
  const tunnel = createTunnel({ dataDir: dir, open: async () => 1, close: async () => {}, find: () => bin, ready: async () => ++asked >= 2 });
  await tunnel.start();
  await waitFor(() => asked === 1);
  assert.equal(tunnel.status().status, 'starting'); // not findable yet: no address on screen
  await waitFor(() => tunnel.status().status === 'on', 4000);
  assert.equal(asked, 2);
  await tunnel.stop();
  assert.equal(tunnel.status().status, 'off'); // off at once
});

test('dnsReady asks public DNS-over-HTTPS for the address', async () => {
  const urls = [];
  const answer = (body) => async (url) => (urls.push(url), new Response(JSON.stringify(body)));
  assert.equal(await dnsReady('https://some-words.trycloudflare.com', answer({ Status: 0, Answer: [{ data: '104.16.0.1' }] })), true);
  assert.equal(await dnsReady('https://some-words.trycloudflare.com', answer({ Status: 3 })), false); // no such name (yet)
  assert.equal(await dnsReady('https://some-words.trycloudflare.com', answer({ Status: 0 })), false);
  assert.equal(urls[0], 'https://cloudflare-dns.com/dns-query?name=some-words.trycloudflare.com&type=A');
});

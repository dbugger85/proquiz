// The website version against `wrangler dev` (docs/dev/web-plan.md §7): the routes and headers, and rooms over the
// WebSocket as the host page, the TV and phones use them. Not part of `npm test` (wrangler is slow to start):
// `npm run test:web` (test/web.test.mjs, so the `*.test.js` glob leaves it out). Rooms close 3 s after the host leaves here (ROOM_IDLE_MS), so that can be tested too.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { startWebDev } from './web-dev.mjs';
import { startFakeUpstream, FAKE_PORT, TINY_PNG, uuid, OPENVERSE, SONGS } from './fake-upstream.mjs';
import { newKey, codeFor, ROOM_CODE, MAX_ROOM_FILE } from '../lib/room.js';
import { COLORS } from '../lib/game.js';
import { MAX_SET_BYTES } from '../lib/hub.js';
import { MAX_LOGO } from '../lib/brand-core.js';
import { CSP } from '../web/headers.js';

const IDLE_MS = 3000;
const MEDIA_CAP = 200 * 1024; // the room's cap for all files together, small here (48 MB in web/room.js)
let dev;
let base;
let fake; // the pretend Openverse, Wikimedia and Deezer (test/fake-upstream.mjs) the Worker is pointed at
before(async () => {
  fake = await startFakeUpstream({ port: FAKE_PORT });
  dev = await startWebDev({ vars: { ROOM_IDLE_MS: IDLE_MS, ROOM_MEDIA_BYTES: MEDIA_CAP, UPSTREAM: fake.base } });
  base = dev.base;
});
after(async () => {
  if (process.env.WEBLOG) console.error(dev.log().split('\n').filter((l) => /rror|✘|at |PUT/.test(l)).slice(-40).join('\n'));
  await dev?.stop();
  await fake?.stop();
});

const quickSample = JSON.parse(readFileSync(new URL('../sets/quick-sample.json', import.meta.url), 'utf8'));

// A fresh room: the key the host's browser would make, and the code everyone else types.
async function newRoom() {
  const key = newKey();
  return { key, code: await codeFor(key) };
}

// A page's end of the socket: remembers every message, answers the room's keep-alive like net.js does, and can
// wait for a message.
async function client(code) {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/r/${code}/ws`);
  const msgs = [];
  const closed = new Promise((r) => (ws.onclose = (e) => r({ code: e.code, reason: e.reason })));
  ws.onmessage = (e) => {
    if (e.data === '{"type":"ping"}') return ws.send('{"type":"pong"}');
    msgs.push(JSON.parse(e.data));
  };
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('could not connect'));
  });
  return {
    ws,
    msgs,
    closed,
    send: (m) => ws.send(JSON.stringify(m)),
    async wait(check, ms = 3000) {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        const found = msgs.find(check);
        if (found) return found;
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error(`no such message within ${ms} ms; got ${msgs.map((m) => m.type + (m.code ? `:${m.code}` : '')).join(', ')}`);
    },
    last: (type) => msgs.filter((m) => m.type === type).at(-1),
    close: () => ws.close(),
  };
}

const host = async (room) => {
  const c = await client(room.code);
  c.send({ type: 'hello', role: 'host', key: room.key });
  await c.wait((m) => m.type === 'welcome');
  return c;
};
const phone = async (room, name, n = 0) => {
  const c = await client(room.code);
  c.send({ type: 'hello', role: 'phone' });
  await c.wait((m) => m.type === 'welcome');
  if (name) {
    c.send({ type: 'join', name, color: COLORS[n] });
    await c.wait((m) => m.type === 'joined');
  }
  return c;
};
const tv = async (room) => {
  const c = await client(room.code);
  c.send({ type: 'hello', role: 'display' });
  await c.wait((m) => m.type === 'state');
  return c;
};

const get = (path, init) => fetch(base + path, { redirect: 'manual', ...init });

test('pages: the front page, the host and TV pages, and a room’s phone and TV pages', async () => {
  const home = await get('/');
  assert.equal(home.status, 200);
  assert.match(await home.text(), /js\/home\.js/);
  const hostPage = await (await get('/host')).text();
  assert.match(hostPage, /js\/host\.js/);
  assert.match(hostPage, /<meta name="proquiz" content="hosted">/); // so the page knows it is the website version
  assert.match(await (await get('/display')).text(), /js\/display\.js/);
  const join = await get('/r/ABCDEF');
  assert.equal(join.status, 200);
  assert.match(await join.text(), /js\/phone\.js/);
  assert.match(await (await get('/r/ABCDEF/display')).text(), /js\/display\.js/);
  assert.match(await (await get('/r/ABCDEF/display?embedded')).text(), /js\/display\.js/);
  // The pages needn't be reachable under their file names (the Worker's assets drop .html).
  assert.equal((await get('/join.html')).status, 307);
});

test('addresses: a lower-case code is tidied, a wrong one goes back to the front page, /api/ is not here', async () => {
  const lower = await get('/r/abcdef/display');
  assert.equal(lower.status, 302);
  assert.equal(new URL(lower.headers.get('location')).pathname, '/r/ABCDEF/display');
  const bad = await get('/r/0OI1');
  assert.equal(bad.status, 302);
  assert.equal(new URL(bad.headers.get('location')).search, '?bad=1');
  assert.equal((await get('/r/0OI1/ws')).status, 404);
  assert.equal((await get('/r/ABCDEF/nothing')).status, 404);
  assert.equal((await get('/api/sets')).status, 404);
  assert.equal((await get('/api/brand')).status, 404);
  assert.equal((await get('/api/pictures/search?q=x&source=openverse')).status, 404); // the search lives under the room
  assert.equal((await get('/r/ABCDEF/ws')).status, 426); // not a WebSocket
});

test('headers: every page says what it may load, static or served by the Worker', async () => {
  for (const path of ['/', '/host', '/display', '/r/ABCDEF', '/r/ABCDEF/display', '/style.css', '/js/host.js', '/sets/sample.json']) {
    const r = await get(path);
    assert.equal(r.headers.get('content-security-policy'), CSP, path);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff', path);
  }
});

test('files: a built-in quiz’s pictures and clips come from the room’s address; other names don’t', async () => {
  const pic = await get('/r/ABCDEF/files/sample-mercury.svg');
  assert.equal(pic.status, 200);
  assert.match(pic.headers.get('content-type'), /image\/svg\+xml/);
  assert.equal(pic.headers.get('x-content-type-options'), 'nosniff');
  // A clip: served whole or by Range (wrangler's local assets answer a Range request with the whole file; the
  // built-in clips are small. Phase 2 serves the host's own uploads from the room, with Range).
  const clip = await get('/r/ABCDEF/files/sample-twinkle.mp3', { headers: { Range: 'bytes=0-99' } });
  assert.ok([200, 206].includes(clip.status), String(clip.status));
  assert.match(clip.headers.get('content-type'), /audio\/mpeg/);
  assert.equal((await get('/r/ABCDEF/files/nope.exe')).status, 404);
  assert.equal((await get('/r/ABCDEF/files/..%2Fsample.json')).status, 404);
  assert.equal((await get('/r/ABCDEF/files/missing.png')).status, 404);
});

test('a room: the host with its key gets a lobby with the sample quiz; the room’s addresses are in the welcome', async () => {
  const room = await newRoom();
  assert.match(room.code, ROOM_CODE);
  const h = await host(room);
  const w = h.last('welcome');
  assert.equal(w.info.hosted, true);
  assert.equal(w.info.code, room.code);
  assert.equal(w.info.phoneUrl, `${base}/r/${room.code}`);
  assert.equal(w.info.tvUrl, `${base}/r/${room.code}/display`);
  assert.match(w.info.version, /^\d+\.\d+\.\d+$/);
  const st = await h.wait((m) => m.type === 'state');
  assert.equal(st.view.phase, 'lobby');
  assert.equal(st.view.set.title, 'Sample quiz');
  assert.equal(st.remote.status, 'off'); // no tunnel on the website
  h.close();
});

test('the host: only the key the room was made with; the same key again (a refresh) is the same room', async () => {
  const room = await newRoom();
  const h = await host(room);
  // A key for some other code is refused (counted, so keys can't be guessed; hub.test.js covers the limit).
  const stranger = await client(room.code);
  stranger.send({ type: 'hello', role: 'host', key: newKey() });
  assert.equal((await stranger.wait((m) => m.type === 'error')).code, 'bad-host-key');
  assert.equal(stranger.last('welcome'), undefined);
  const noKey = await client(room.code);
  noKey.send({ type: 'hello', role: 'host' });
  assert.equal((await noKey.wait((m) => m.type === 'error')).code, 'bad-host-key');
  // The host page refreshed: hello with the same key, the same lobby.
  h.send({ type: 'cmd', action: { type: 'settings', settings: { buzzSeconds: 7 } } });
  await h.wait((m) => m.type === 'state' && m.view.settings.buzzSeconds === 7);
  const again = await host(room);
  const st = await again.wait((m) => m.type === 'state');
  assert.equal(st.view.settings.buzzSeconds, 7);
  for (const c of [h, stranger, noKey, again]) c.close();
});

test('phones and the TV: joining with the code, the PIN, and the TV never shows the PIN', async () => {
  const room = await newRoom();
  const h = await host(room);
  const screen = await tv(room);
  const p1 = await phone(room, 'Anna', 0);
  const p2 = await phone(room, 'Bo', 1);
  const st = await h.wait((m) => m.type === 'state' && m.view.teams.length === 2);
  assert.deepEqual(st.view.teams.map((t) => t.name), ['Anna', 'Bo']);
  assert.equal(st.connected.length, 2);
  assert.equal(st.displays, 1);
  // Every phone counts as "elsewhere" on the website, so the PIN works as over the tunnel (the host page hides the tag).
  assert.deepEqual(st.remote.remoteTeams.sort(), st.view.teams.map((t) => t.id).sort());
  h.send({ type: 'cmd', action: { type: 'settings', settings: { remotePin: '4321' } } });
  await h.wait((m) => m.type === 'state' && m.view.settings.remotePin === '4321');
  const tvState = await screen.wait((m) => m.type === 'state' && m.view.settings.buzzSeconds !== undefined && m.view.teams.length === 2);
  assert.equal(tvState.view.settings.remotePin, '', 'the TV page never gets the PIN');
  assert.ok(!JSON.stringify(screen.msgs).includes('4321'));
  const late = await phone(room);
  await late.wait((m) => m.type === 'state' && m.needPin === true);
  late.send({ type: 'join', name: 'Cy', color: COLORS[2], pin: '0000' });
  assert.equal((await late.wait((m) => m.type === 'error')).code, 'bad-pin');
  late.send({ type: 'join', name: 'Cy', color: COLORS[2], pin: '4321' });
  await late.wait((m) => m.type === 'joined');
  assert.ok(!JSON.stringify(p1.msgs).includes('4321'), 'phones never get the PIN either');
  for (const c of [h, screen, p1, p2, late]) c.close();
});

test('the quiz comes from the host’s browser: loadSet with a Quick quiz, a quiz with problems, a huge one', async () => {
  const room = await newRoom();
  const h = await host(room);
  h.send({ type: 'cmd', action: { type: 'loadSet', set: quickSample, setId: 'quick-sample' } });
  const st = await h.wait((m) => m.type === 'state' && m.view.mode === 'quick');
  assert.equal(st.view.set.title, quickSample.title);
  h.send({ type: 'cmd', action: { type: 'loadSet', set: { title: 'Broken', categories: [] }, setId: 'x' } });
  assert.equal((await h.wait((m) => m.type === 'error')).code, 'set-has-problems');
  const huge = structuredClone(quickSample);
  huge.pad = 'x'.repeat(MAX_SET_BYTES); // a field the rules don't look at, so only the size is wrong
  h.send({ type: 'cmd', action: { type: 'loadSet', set: huge, setId: 'huge' } });
  assert.equal((await h.wait((m) => m.type === 'error' && m.code !== 'set-has-problems', 5000)).code, 'set-too-big');
  h.close();
});

test('a board question over the room: pick, arm, a phone buzzes, correct', async () => {
  const room = await newRoom();
  const h = await host(room);
  const p1 = await phone(room, 'Anna', 0);
  const p2 = await phone(room, 'Bo', 1);
  await h.wait((m) => m.type === 'state' && m.view.teams.length === 2);
  h.send({ type: 'cmd', action: { type: 'start' } });
  await h.wait((m) => m.type === 'state' && m.view.phase === 'board');
  h.send({ type: 'cmd', action: { type: 'pick', c: 0, i: 1 } });
  await h.wait((m) => m.type === 'state' && m.view.phase === 'reading');
  h.send({ type: 'cmd', action: { type: 'arm' } });
  await p2.wait((m) => m.type === 'state' && m.view.phase === 'armed');
  p2.send({ type: 'buzz', at: performance.now() });
  const answering = await h.wait((m) => m.type === 'state' && m.view.phase === 'answering', 4000);
  assert.equal(answering.view.q.buzzedTeam, answering.view.teams[1].id);
  h.send({ type: 'cmd', action: { type: 'correct' } });
  const revealed = await h.wait((m) => m.type === 'state' && m.view.phase === 'revealed');
  assert.equal(revealed.view.teams[1].score, 200);
  assert.ok(!JSON.stringify(p1.msgs).includes(revealed.view.q.answer), 'phones never get the answer');
  for (const c of [h, p1, p2]) c.close();
});

test('messages: a phone may send 64 KB and no binary, the host a whole quiz', async () => {
  const room = await newRoom();
  const h = await host(room);
  const big = await phone(room);
  big.ws.send('x'.repeat(64 * 1024 + 1));
  assert.equal((await big.closed).code, 1009);
  const bin = await phone(room);
  bin.ws.send(new Uint8Array(4));
  assert.equal((await bin.closed).code, 1003);
  h.ws.send(JSON.stringify({ type: 'nothing', pad: 'x'.repeat(200 * 1024) }));
  h.send({ type: 'cmd', action: { type: 'settings', settings: { buzzSeconds: 9 } } });
  await h.wait((m) => m.type === 'state' && m.view.settings.buzzSeconds === 9);
  assert.equal(h.ws.readyState, WebSocket.OPEN);
  h.close();
});

test('keep-alive: the room asks "ping" as a message (every 30 s) and the page answers "pong"', { timeout: 45_000 }, async () => {
  const room = await newRoom();
  const h = await host(room);
  const pings = [];
  const raw = h.ws;
  const before = raw.onmessage;
  raw.onmessage = (e) => {
    if (e.data === '{"type":"ping"}') pings.push(Date.now());
    before(e);
  };
  const end = Date.now() + 35_000;
  while (!pings.length && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
  assert.equal(pings.length, 1, 'a ping within 35 s (the website pings every 30 s, the laptop every 10 s)');
  assert.equal(raw.readyState, WebSocket.OPEN);
  h.close();
});

// ----- the quiz's pictures and clips in the room (web-plan.md §3) -----
const twinkle = new Uint8Array(readFileSync(new URL('../sets/files/sample-twinkle.mp3', import.meta.url)));
const keyed = (room, init = {}) => ({ ...init, headers: { 'x-proquiz-key': room.key, ...(init.headers ?? {}) } });
const put = (room, name, body, key = room.key) => get(`/r/${room.code}/files/${name}`, { method: 'PUT', headers: { 'x-proquiz-key': key }, body });
const list = async (room) => (await get(`/r/${room.code}/files`, keyed(room))).json();

test('files: the host uploads a quiz’s pictures and clips into the room, lists them, and the TV fetches them, whole or by Range', async () => {
  const room = await newRoom();
  const h = await host(room);
  assert.deepEqual(await list(room), { files: [], bytes: 0, maxFile: MAX_ROOM_FILE, maxTotal: MEDIA_CAP });
  const up = await put(room, 'a1b2c3d4e5f60718.mp3', twinkle);
  assert.equal(up.status, 201);
  assert.deepEqual(await up.json(), { name: 'a1b2c3d4e5f60718.mp3', size: twinkle.length });
  assert.equal((await put(room, 'a1b2c3d4e5f60718.mp3', twinkle)).status, 200); // the same name is the same file
  assert.equal((await put(room, 'pic.png', new Uint8Array([137, 80, 78, 71]))).status, 201);
  const have = await list(room);
  assert.deepEqual(have.files, [{ name: 'a1b2c3d4e5f60718.mp3', size: twinkle.length }, { name: 'pic.png', size: 4 }]);
  assert.equal(have.bytes, twinkle.length + 4);
  // Whole: the type by its extension, never sniffed, no key needed (the TV page has none).
  const whole = await get(`/r/${room.code}/files/a1b2c3d4e5f60718.mp3`);
  assert.equal(whole.status, 200);
  assert.equal(whole.headers.get('content-type'), 'audio/mpeg');
  assert.equal(whole.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(whole.headers.get('accept-ranges'), 'bytes');
  assert.equal(whole.headers.get('content-length'), String(twinkle.length));
  assert.deepEqual(new Uint8Array(await whole.arrayBuffer()), twinkle);
  // By Range, as a clip's <audio> asks: a piece, an open end, the last bytes, and a range past the end.
  const piece = await get(`/r/${room.code}/files/a1b2c3d4e5f60718.mp3`, { headers: { Range: 'bytes=10-19' } });
  assert.equal(piece.status, 206);
  assert.equal(piece.headers.get('content-range'), `bytes 10-19/${twinkle.length}`);
  assert.equal(piece.headers.get('content-length'), '10');
  assert.deepEqual(new Uint8Array(await piece.arrayBuffer()), twinkle.subarray(10, 20));
  const tail = await get(`/r/${room.code}/files/a1b2c3d4e5f60718.mp3`, { headers: { Range: 'bytes=1000-' } });
  assert.equal(tail.status, 206);
  assert.equal(tail.headers.get('content-range'), `bytes 1000-${twinkle.length - 1}/${twinkle.length}`);
  assert.equal((await tail.arrayBuffer()).byteLength, twinkle.length - 1000);
  const last = await get(`/r/${room.code}/files/a1b2c3d4e5f60718.mp3`, { headers: { Range: 'bytes=-5' } });
  assert.equal(last.headers.get('content-range'), `bytes ${twinkle.length - 5}-${twinkle.length - 1}/${twinkle.length}`);
  const past = await get(`/r/${room.code}/files/a1b2c3d4e5f60718.mp3`, { headers: { Range: `bytes=${twinkle.length + 10}-` } });
  assert.equal(past.status, 416);
  assert.equal(past.headers.get('content-range'), `bytes */${twinkle.length}`);
  // A name the room doesn't have still comes from the built-in quizzes' files.
  assert.equal((await get(`/r/${room.code}/files/sample-mercury.svg`)).status, 200);
  assert.equal((await get(`/r/${room.code}/files/0000000000000000.png`)).status, 404);
  // Dropped: gone from the list, and the TV gets a 404.
  assert.equal((await get(`/r/${room.code}/files/pic.png`, keyed(room, { method: 'DELETE' }))).status, 204);
  assert.deepEqual((await list(room)).files.map((f) => f.name), ['a1b2c3d4e5f60718.mp3']);
  assert.equal((await list(room)).bytes, twinkle.length);
  assert.equal((await get(`/r/${room.code}/files/pic.png`)).status, 404);
  h.close();
});

test('files: only the host’s key may upload, list or drop; only picture and clip names; the caps', async () => {
  const room = await newRoom();
  const h = await host(room);
  // Another room's key, no key, a malformed one, and none at all: each a 403 (four misses, under the limit of
  // five a minute that the limiter test below reaches).
  assert.equal((await put(room, 'pic.png', new Uint8Array(4), newKey())).status, 403);
  assert.equal((await get(`/r/${room.code}/files`, { headers: { 'x-proquiz-key': '' } })).status, 403);
  assert.equal((await get(`/r/${room.code}/files/pic.png`, { method: 'DELETE', headers: { 'x-proquiz-key': 'not-a-key' } })).status, 403);
  assert.equal((await get(`/r/${room.code}/files`)).status, 403); // no key at all
  assert.deepEqual(await list(room), { files: [], bytes: 0, maxFile: MAX_ROOM_FILE, maxTotal: MEDIA_CAP });
  for (const name of ['quiz.json', 'evil.html', 'a.exe', '..%2Fx.png', 'a%20b.png', 'x'.repeat(81) + '.png']) assert.equal((await put(room, name, new Uint8Array(4))).status, 404, name);
  assert.equal((await get(`/r/${room.code}/files/pic.png`, keyed(room, { method: 'POST', body: 'x' }))).status, 404);
  // One file over 8 MB is refused before the room's total is looked at.
  const big = await put(room, 'big.png', new Uint8Array(MAX_ROOM_FILE + 1));
  assert.equal(big.status, 413);
  assert.deepEqual(await big.json(), { error: 'media-too-big', max: MAX_ROOM_FILE });
  // All files together at most the room's cap (small in this test).
  assert.equal((await put(room, 'one.png', new Uint8Array(150 * 1024))).status, 201);
  const full = await put(room, 'two.png', new Uint8Array(60 * 1024));
  assert.equal(full.status, 413);
  assert.deepEqual(await full.json(), { error: 'media-full', max: MEDIA_CAP });
  assert.equal((await put(room, 'three.png', new Uint8Array(40 * 1024))).status, 201);
  assert.deepEqual((await list(room)).files.map((f) => f.name), ['one.png', 'three.png']);
  // A key for this room works for uploads before any hello, too (the host page refreshed, say).
  const fresh = await newRoom();
  assert.equal((await put(fresh, 'pic.png', new Uint8Array(4))).status, 201);
  const h2 = await host(fresh);
  assert.deepEqual((await list(fresh)).files.map((f) => f.name), ['pic.png']);
  for (const c of [h, h2]) c.close();
});

// ----- the host's branding (web-plan.md Phase 6): the logo through the file store, the rest as a `brand` message -----
const LOGO = Buffer.from('<?xml version="1.0"?>\n<!-- logo -->\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><script>alert(1)</script><rect width="10" height="10"/></svg>');
const LOGO_NAME = `logo-${createHash('sha256').update(LOGO).digest('hex').slice(0, 16)}.svg`;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

test('branding: the host’s logo goes into the room under its name with the laptop’s rules, and `brand` reaches every screen', async () => {
  const room = await newRoom();
  const h = await host(room);
  const screen = await tv(room);
  const p1 = await phone(room, 'Anna', 0);
  assert.equal((await h.wait((m) => m.type === 'state')).brand, null);
  // The logo: named after its content like on the laptop; served with its real type, nosniff and a policy that
  // blocks an SVG's scripts, to anyone (the TV and phone pages have no key).
  assert.equal((await put(room, LOGO_NAME, LOGO)).status, 201);
  const served = await get(`/r/${room.code}/files/${LOGO_NAME}`);
  assert.equal(served.status, 200);
  assert.equal(served.headers.get('content-type'), 'image/svg+xml');
  assert.equal(served.headers.get('x-content-type-options'), 'nosniff');
  assert.match(served.headers.get('content-security-policy'), /default-src 'none'.*sandbox/);
  assert.deepEqual(Buffer.from(await served.arrayBuffer()), LOGO);
  // The laptop's rules: at most 2 MB (`logo-too-big`, refused by Content-Length before the body is read, and by
  // the bytes), and the bytes must be the kind of picture the name says (`logo-bad-type`).
  const big = await put(room, 'logo-0123456789abcdef.png', new Uint8Array(MAX_LOGO + 1));
  assert.equal(big.status, 413);
  assert.deepEqual(await big.json(), { error: 'logo-too-big', max: MAX_LOGO });
  const wrongKind = await put(room, 'logo-0123456789abcdef.png', LOGO);
  assert.equal(wrongKind.status, 400);
  assert.deepEqual(await wrongKind.json(), { error: 'logo-bad-type' });
  const notAPicture = await put(room, 'logo-0123456789abcdef.svg', Buffer.from('these are my quiz notes'));
  assert.equal(notAPicture.status, 400);
  assert.equal((await put(room, 'logo-0123456789abcdef.png', PNG)).status, 201); // a real PNG under a PNG name
  assert.equal((await get(`/r/${room.code}/files/logo-0123456789abcdef.png`)).headers.get('content-type'), 'image/png');
  assert.equal((await put(room, LOGO_NAME, LOGO, newKey())).status, 403, 'only the host');
  // The rest of the branding as a message: every screen gets it in its next state, the logo's address in the room.
  h.send({ type: 'brand', name: 'Nordlys Christmas Quiz', accent: '#0F9F95', plate: true, logo: LOGO_NAME });
  const want = { name: 'Nordlys Christmas Quiz', accent: '#0f9f95', plate: true, logo: `/r/${room.code}/files/${LOGO_NAME}` };
  assert.deepEqual((await h.wait((m) => m.type === 'state' && m.brand?.logo)).brand, want);
  assert.deepEqual((await screen.wait((m) => m.type === 'state' && m.brand?.logo)).brand, want);
  assert.deepEqual((await p1.wait((m) => m.type === 'state' && m.brand?.logo)).brand, want);
  // A phone that arrives later gets it at once; a phone saying `brand` changes nothing.
  const late = await phone(room);
  assert.deepEqual((await late.wait((m) => m.type === 'state')).brand, want);
  late.send({ type: 'brand', name: 'Hacked', accent: null, plate: false, logo: null });
  h.send({ type: 'cmd', action: { type: 'settings', settings: { buzzSeconds: 8 } } });
  assert.deepEqual((await screen.wait((m) => m.type === 'state' && m.view.settings.buzzSeconds === 8)).brand, want);
  // No logo any more, and the name only.
  h.send({ type: 'brand', name: 'Nordlys Christmas Quiz', accent: null, plate: false, logo: null });
  assert.deepEqual((await p1.wait((m) => m.type === 'state' && m.brand?.name && !m.brand.logo)).brand, { name: 'Nordlys Christmas Quiz', accent: null, plate: false, logo: null });
  for (const c of [h, screen, p1, late]) c.close();
});

test('a forgotten room closes after the host has been gone a while, and the key opens a fresh lobby later', { timeout: 20_000 }, async () => {
  const room = await newRoom();
  const h = await host(room);
  const screen = await tv(room);
  const p1 = await phone(room, 'Anna', 0);
  await h.wait((m) => m.type === 'state' && m.view.teams.length === 1);
  assert.equal((await put(room, 'pic.png', new Uint8Array(4))).status, 201);
  h.close();
  const bye = await p1.wait((m) => m.type === 'bye', IDLE_MS + 4000);
  assert.equal(bye.reason, 'closed'); // the pages say "This room has closed" (the laptop's `bye` has no reason)
  assert.equal(screen.last('bye').reason, 'closed');
  assert.equal((await p1.closed).code, 1000);
  assert.equal((await screen.closed).code, 1000);
  // The host comes back: the same key, a new lobby (the game is gone; the host page brings it back from its autosave,
  // see the restart test below).
  const again = await host(room);
  const st = await again.wait((m) => m.type === 'state');
  assert.equal(st.view.phase, 'lobby');
  assert.equal(st.view.teams.length, 0);
  assert.deepEqual((await list(room)).files, [], 'the files went with the room');
  again.close();
});

test('no host yet: a phone in a room nobody hosts is told so, and told again when the host arrives', async () => {
  const room = await newRoom();
  const p = await phone(room);
  const none = await p.wait((m) => m.type === 'hostHere');
  assert.equal(none.here, false);
  const screen = await tv(room);
  assert.equal((await screen.wait((m) => m.type === 'hostHere')).here, false);
  const h = await host(room);
  assert.equal((await p.wait((m) => m.type === 'hostHere' && m.here === true)).here, true);
  assert.equal((await screen.wait((m) => m.type === 'hostHere' && m.here === true)).here, true);
  assert.equal(h.msgs.filter((m) => m.type === 'hostHere').length, 0, 'the host is never told');
  // A phone that arrives while the host is here isn't told at all.
  const late = await phone(room);
  await late.wait((m) => m.type === 'state');
  assert.equal(late.msgs.filter((m) => m.type === 'hostHere').length, 0);
  for (const c of [p, screen, h, late]) c.close();
});

// ----- the autosave and a restart in the middle of a game (web-plan.md §5) -----

test('autosave: the host gets the game as `save` messages after changes, one per burst, never the phones or the TV', async () => {
  const room = await newRoom();
  const h = await host(room);
  const screen = await tv(room);
  const p1 = await phone(room, 'Anna', 0);
  const saved = await h.wait((m) => m.type === 'save' && m.saved.state.teams.length === 1);
  assert.equal(saved.saved.v, 1);
  assert.ok(Math.abs(saved.saved.savedAt - Date.now()) < 5000);
  assert.equal(saved.saved.state.phase, 'lobby');
  assert.equal(saved.saved.state.set.title, 'Sample quiz');
  assert.deepEqual(saved.saved.state.history, []);
  // Three quick changes: one save with the last of them.
  const before = h.msgs.filter((m) => m.type === 'save').length;
  for (const n of [3, 4, 5]) h.send({ type: 'cmd', action: { type: 'settings', settings: { buzzSeconds: n } } });
  await h.wait((m) => m.type === 'save' && m.saved.state.settings.buzzSeconds === 5);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(h.msgs.filter((m) => m.type === 'save').length, before + 1);
  assert.equal(screen.msgs.filter((m) => m.type === 'save').length, 0);
  assert.equal(p1.msgs.filter((m) => m.type === 'save').length, 0);
  for (const c of [h, screen, p1]) c.close();
});

test('a restart in the middle of a game: the host sends the autosave back, Continue puts the phones back in their teams with their scores', { timeout: 120_000 }, async () => {
  const room = await newRoom();
  let h = await host(room);
  let p1 = await phone(room, 'Anna', 0);
  let p2 = await phone(room, 'Bo', 1);
  const ids = [p1.last('joined').teamId, p2.last('joined').teamId];
  await h.wait((m) => m.type === 'state' && m.view.teams.length === 2);
  h.send({ type: 'cmd', action: { type: 'start' } });
  await h.wait((m) => m.type === 'state' && m.view.phase === 'board');
  h.send({ type: 'cmd', action: { type: 'pick', c: 0, i: 1 } });
  await h.wait((m) => m.type === 'state' && m.view.phase === 'reading');
  h.send({ type: 'cmd', action: { type: 'arm' } });
  await p2.wait((m) => m.type === 'state' && m.view.phase === 'armed');
  p2.send({ type: 'buzz', at: performance.now() });
  await h.wait((m) => m.type === 'state' && m.view.phase === 'answering', 4000);
  h.send({ type: 'cmd', action: { type: 'correct' } });
  await h.wait((m) => m.type === 'state' && m.view.phase === 'revealed');
  // The last autosave the host's browser would hold: the question revealed, Bo on 200.
  const { saved } = await h.wait((m) => m.type === 'save' && m.saved.state.phase === 'revealed');
  assert.equal(saved.state.teams[1].score, 200);
  // The host's branding too (its logo in the room's file store): the host page re-sends it after a restart.
  assert.equal((await put(room, LOGO_NAME, LOGO)).status, 201);
  h.send({ type: 'brand', name: 'Nordlys', accent: '#0f9f95', plate: false, logo: LOGO_NAME });
  await p1.wait((m) => m.type === 'state' && m.brand?.name === 'Nordlys');
  // The whole website restarts (a deploy does this): every room and socket is gone.
  await dev.stop();
  await Promise.all([h.closed, p1.closed, p2.closed]);
  dev = await startWebDev({ vars: { ROOM_IDLE_MS: IDLE_MS, ROOM_MEDIA_BYTES: MEDIA_CAP, UPSTREAM: fake.base } });
  base = dev.base;
  // The phones reconnect first (as they may): a fresh lobby, no host yet, their teams unknown.
  p1 = await client(room.code);
  p1.send({ type: 'hello', role: 'phone', teamId: ids[0] });
  assert.equal((await p1.wait((m) => m.type === 'welcome')).teamId, null);
  assert.equal((await p1.wait((m) => m.type === 'hostHere')).here, false);
  // The host page reconnects: a fresh lobby, nothing to continue, so it sends the autosave back.
  h = await host(room);
  const fresh = await h.wait((m) => m.type === 'state');
  assert.equal(fresh.view.phase, 'lobby');
  assert.deepEqual(fresh.view.teams, []);
  assert.equal(fresh.resume, undefined);
  assert.equal(fresh.brand, null, 'the branding went with the room');
  assert.equal((await get(`/r/${room.code}/files/${LOGO_NAME}`)).status, 404, 'the logo went with the room');
  // The host page puts the logo back and sends the branding again (sendBrand() in host.js), then the game.
  assert.equal((await put(room, LOGO_NAME, LOGO)).status, 201);
  h.send({ type: 'brand', name: 'Nordlys', accent: '#0f9f95', plate: false, logo: LOGO_NAME });
  assert.equal((await p1.wait((m) => m.type === 'state' && m.brand?.name === 'Nordlys')).brand.logo, `/r/${room.code}/files/${LOGO_NAME}`);
  h.send({ type: 'restore', saved });
  const offer = await h.wait((m) => m.type === 'state' && m.resume);
  assert.deepEqual(offer.resume.teams.map((t) => [t.name, t.score]), [['Anna', 0], ['Bo', 200]]);
  assert.equal(offer.resume.played, 1);
  assert.equal(offer.view.set.title, 'Sample quiz');
  assert.equal((await p1.wait((m) => m.type === 'hostHere' && m.here === true)).here, true);
  p2 = await client(room.code);
  p2.send({ type: 'hello', role: 'phone', teamId: ids[1] });
  await p2.wait((m) => m.type === 'welcome');
  // Continue: the game is where it was, and both phones are back in their teams.
  h.send({ type: 'resume' });
  const back = await h.wait((m) => m.type === 'state' && !m.resume && m.view.phase === 'revealed');
  assert.deepEqual(back.view.teams.map((t) => [t.id, t.score]), [[ids[0], 0], [ids[1], 200]]);
  assert.equal((await p1.wait((m) => m.type === 'welcome' && m.teamId === ids[0])).teamId, ids[0]);
  assert.equal((await p2.wait((m) => m.type === 'welcome' && m.teamId === ids[1])).teamId, ids[1]);
  const mine = await p2.wait((m) => m.type === 'state' && m.view.you?.id === ids[1]);
  assert.equal(mine.view.you.score, 200);
  assert.deepEqual(back.connected.sort(), [...ids].sort());
  // And the room saves again from here on.
  h.send({ type: 'cmd', action: { type: 'next' } });
  await h.wait((m) => m.type === 'save' && m.saved.state.phase === 'board');
  // A restore now (in a game) is refused, as on the laptop.
  h.send({ type: 'restore', saved });
  assert.equal((await h.wait((m) => m.type === 'error')).code, 'restore-in-game');
  for (const c of [h, p1, p2]) c.close();
});

// ----- wrong keys and wrong PINs are limited per room (web-plan.md §6) -----

test('wrong host keys: after five in a minute other keys are refused unread for a minute, on the routes and on hellos alike; the right key still works', async () => {
  const room = await newRoom();
  const h = await host(room);
  for (let n = 0; n < 5; n++) {
    const r = await get(`/r/${room.code}/files`, { headers: { 'x-proquiz-key': newKey() } });
    assert.equal(r.status, 403);
    assert.equal((await r.json()).error, 'bad-host-key');
  }
  const stranger = { headers: { 'x-proquiz-key': newKey() } };
  const wait = await get(`/r/${room.code}/files`, stranger);
  assert.equal(wait.status, 429);
  assert.deepEqual(await wait.json(), { error: 'key-wait' });
  assert.equal(wait.headers.get('retry-after'), '60');
  assert.equal((await put({ ...room, key: newKey() }, 'pic.png', new Uint8Array(4))).status, 429);
  assert.equal((await search({ ...room, key: newKey() }, 'songs/search', { q: 'abba' })).status, 429);
  const again = await client(room.code);
  again.send({ type: 'hello', role: 'host', key: newKey() });
  assert.equal((await again.wait((m) => m.type === 'error')).code, 'bad-host-key');
  assert.equal(again.last('welcome'), undefined);
  // The right key is never locked out (a player with the code can't keep the host out): routes and a hello alike.
  assert.equal((await get(`/r/${room.code}/files`, keyed(room))).status, 200);
  assert.equal((await put(room, 'pic.png', new Uint8Array(4))).status, 201);
  const back = await client(room.code);
  back.send({ type: 'hello', role: 'host', key: room.key });
  assert.ok(await back.wait((m) => m.type === 'welcome'));
  // The host that was already in stays in; phones and the TV are untouched.
  h.send({ type: 'cmd', action: { type: 'settings', settings: { buzzSeconds: 6 } } });
  await h.wait((m) => m.type === 'state' && m.view.settings.buzzSeconds === 6);
  const p = await phone(room, 'Anna', 0);
  // Another room is not affected.
  const other = await newRoom();
  assert.equal((await get(`/r/${other.code}/files`, keyed(other))).status, 200);
  for (const c of [h, again, back, p]) c.close();
});

test('wrong PINs: ten in a minute, then even the right one must wait; a search body must be small', async () => {
  const room = await newRoom();
  const h = await host(room);
  h.send({ type: 'cmd', action: { type: 'settings', settings: { remotePin: '2468' } } });
  await h.wait((m) => m.type === 'state' && m.view.settings.remotePin === '2468');
  const p = await phone(room);
  await p.wait((m) => m.type === 'state' && m.needPin === true);
  for (let n = 0; n < 10; n++) {
    p.send({ type: 'join', name: 'Cy', color: COLORS[2], pin: String(1000 + n) });
    await p.wait((m) => m.type === 'error' && m.code === 'bad-pin' && p.msgs.filter((x) => x.code === 'bad-pin').length === n + 1);
  }
  p.send({ type: 'join', name: 'Cy', color: COLORS[2], pin: '2468' });
  assert.equal((await p.wait((m) => m.type === 'error' && m.code === 'pin-wait')).code, 'pin-wait');
  assert.equal(p.last('joined'), undefined);
  assert.equal((await h.wait((m) => m.type === 'state')).view.teams.length, 0);
  // A fetch body is a few fields; a big one is refused unread.
  const big = await fetchOne(room, 'pictures/fetch', { source: 'openverse', id: uuid(1), pad: 'x'.repeat(8192) });
  assert.equal(big.status, 413);
  assert.equal((await big.json()).error, 'too-big');
  for (const c of [h, p]) c.close();
});

// ----- the editor's picture and song search, through the room (web-plan.md §4) -----

const search = (room, path, params, init = {}) => get(`/r/${room.code}/api/${path}?${new URLSearchParams(params)}`, { ...init, headers: { 'x-proquiz-key': room.key, ...init.headers } });
const fetchOne = (room, path, body, init = {}) => get(`/r/${room.code}/api/${path}`, { method: 'POST', body: JSON.stringify(body), ...init, headers: { 'x-proquiz-key': room.key, 'content-type': 'application/json', ...init.headers } });
const credit = (r) => JSON.parse(decodeURIComponent(r.headers.get('x-proquiz-credit')));

test('search: pictures from Openverse and Wikimedia and songs from Deezer, with the host’s key, through the pretend internet', async () => {
  const room = await newRoom();
  fake.calls.length = 0;
  const ov = await search(room, 'pictures/search', { q: 'eiffel tower', source: 'openverse', page: '1', license: 'any', lang: 'en' });
  assert.equal(ov.status, 200);
  const page1 = await ov.json();
  assert.equal(page1.results.length, 12);
  assert.equal(page1.more, true);
  assert.deepEqual(Object.keys(page1.results[0]).sort(), ['author', 'fallback', 'height', 'id', 'license', 'licenseUrl', 'nc', 'provider', 'source', 'sourceUrl', 'thumb', 'title', 'width']);
  assert.equal(page1.results[0].title, 'Eiffel Tower at dusk');
  assert.equal(page1.results[0].license, 'CC BY 2.0');
  assert.match(fake.calls[0], /^https:\/\/api\.openverse\.org\/v1\/images\/\?q=eiffel\+tower&page=1&page_size=20&license=cc0%2Cpdm%2Cby%2Cby-sa&mature=false$/);
  // The same search again is answered from the room's cache (10 minutes), like on the laptop.
  await search(room, 'pictures/search', { q: 'eiffel tower', source: 'openverse', page: '1', license: 'any', lang: 'en' });
  assert.equal(fake.searches().length, 1);
  const wm = await (await search(room, 'pictures/search', { q: 'flag', source: 'wikimedia', page: '1', lang: 'no' })).json();
  assert.deepEqual(wm.results.map((r) => r.title), ['Flag of Norway', 'Flag of Sweden', 'Flag of Denmark']);
  assert.equal(wm.results[0].author, 'Flagmaker');
  assert.match(fake.calls.at(-1), /iiextmetadatalanguage=nb/);
  const dz = await (await search(room, 'songs/search', { q: 'dancing queen', page: '1' })).json();
  assert.equal(dz.results.length, 10);
  assert.equal(dz.more, true);
  assert.equal(dz.results[0].artist, 'ABBA');
  assert.match(dz.results[0].preview, /^https:\/\/cdnt-preview\.dzcdn\.net\//);
  assert.equal((await search(room, 'pictures/search', { q: '', source: 'openverse' })).status, 400);
  assert.equal((await search(room, 'pictures/search', { q: 'x', source: 'nope' })).status, 400);
});

test('search: a chosen picture or song clip comes back as its bytes, with the name to store it under and its credit', async () => {
  const room = await newRoom();
  const pic = await fetchOne(room, 'pictures/fetch', { source: 'openverse', id: uuid(1) });
  assert.equal(pic.status, 201);
  assert.equal(pic.headers.get('content-type'), 'image/png');
  assert.equal(pic.headers.get('x-proquiz-name'), 'picture.png');
  assert.equal(pic.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(credit(pic), { title: 'Eiffel Tower at dusk', author: 'Ann Lee', license: 'CC BY 2.0', licenseUrl: 'https://creativecommons.org/licenses/by/2.0/', source: 'openverse', sourceUrl: 'https://www.flickr.com/photos/test/1' });
  assert.deepEqual(Buffer.from(await pic.arrayBuffer()), TINY_PNG);
  // Wikimedia: the 1920 px render, the credit in the language asked for (Norwegian here: the fake only notes it).
  const flag = await fetchOne(room, 'pictures/fetch', { source: 'wikimedia', id: 'Flag of Norway.svg', lang: 'no' });
  assert.equal(flag.status, 201);
  assert.equal(flag.headers.get('x-proquiz-name'), 'picture.png');
  assert.equal(credit(flag).source, 'wikimedia');
  assert.equal(credit(flag).license, 'Public domain');
  assert.match(fake.calls.find((c) => c.includes('titles=File')), /iiurlwidth=1920/);
  assert.match(fake.calls.find((c) => c.includes('titles=File')), /iiextmetadatalanguage=nb/);
  const song = await fetchOne(room, 'songs/fetch', { id: SONGS[0].id });
  assert.equal(song.status, 201);
  assert.equal(song.headers.get('content-type'), 'audio/mpeg');
  assert.equal(song.headers.get('x-proquiz-name'), 'song.mp3');
  assert.deepEqual(credit(song), { title: 'Dancing Queen', author: 'ABBA', source: 'deezer', sourceUrl: `https://www.deezer.com/track/${SONGS[0].id}` });
  const mp3 = Buffer.from(await song.arrayBuffer());
  assert.equal(mp3.subarray(0, 3).toString(), 'ID3');
  assert.equal(mp3.length, 2010);
});

test('search: only the editor with the host’s key, and the download rules hold (an SVG, a huge file, a hop to an IP, gone, busy)', async () => {
  const room = await newRoom();
  const other = await newRoom();
  const noKey = await get(`/r/${room.code}/api/songs/search?q=abba`);
  assert.equal(noKey.status, 403);
  assert.equal((await noKey.json()).error, 'bad-host-key');
  assert.equal((await search(room, 'songs/search', { q: 'abba' }, { headers: { 'x-proquiz-key': other.key } })).status, 403); // another room's key
  // Another website in the same browser can't start a search (it would spend the site's share of the limits).
  const crossSite = await search(room, 'songs/search', { q: 'abba' }, { headers: { 'sec-fetch-site': 'cross-site' } });
  assert.equal(crossSite.status, 403);
  assert.equal((await crossSite.json()).error, 'forbidden');
  assert.equal((await fetchOne(room, 'pictures/fetch', { source: 'openverse', id: uuid(1) }, { headers: { 'sec-fetch-site': 'same-site' } })).status, 403);
  assert.equal((await search(room, 'songs/search', { q: 'abba' }, { headers: { 'sec-fetch-site': 'same-origin' } })).status, 200);
  // A fetch must be a POST, a search a GET.
  assert.equal((await search(room, 'songs/fetch', { id: '1' })).status, 405);
  // The rules from pictures.js/songs.js, as on the laptop.
  const refused = async (path, body) => {
    const r = await fetchOne(room, path, body);
    return [r.status, (await r.json()).error];
  };
  assert.deepEqual(await refused('pictures/fetch', { source: 'openverse', id: 'not-a-uuid' }), [400, 'bad-id']);
  assert.deepEqual(await refused('pictures/fetch', { source: 'openverse', id: uuid(77) }), [404, 'picture-missing']);
  assert.deepEqual(await refused('pictures/fetch', { source: 'openverse', id: uuid(90) }), [415, 'picture-bad-type']); // an SVG
  assert.deepEqual(await refused('pictures/fetch', { source: 'openverse', id: uuid(91) }), [413, 'picture-too-big']); // says 20 MB
  assert.deepEqual(await refused('pictures/fetch', { source: 'openverse', id: uuid(92) }), [502, 'picture-failed']); // sent to an IP address
  assert.deepEqual(await refused('pictures/fetch', { source: 'wikimedia', id: 'Flag of Mars.svg' }), [404, 'picture-missing']);
  assert.deepEqual(await refused('songs/fetch', { id: 1 }), [404, 'song-missing']);
  assert.deepEqual(await refused('songs/fetch', { id: 'x' }), [400, 'bad-id']);
  fake.mode = 'busy';
  try {
    const busy = await search(room, 'pictures/search', { q: 'busy tower', source: 'openverse' });
    assert.equal(busy.status, 429);
    assert.deepEqual(await busy.json(), { error: 'rate-limited', retryAfter: 60 });
    const quota = await search(room, 'songs/search', { q: 'busy song' });
    assert.equal(quota.status, 429);
    assert.equal((await quota.json()).error, 'rate-limited');
  } finally {
    fake.mode = 'ok';
  }
  // A room that only ever searched is no game: the host's key still opens a plain lobby.
  const h = await host(room);
  assert.equal(h.last('state').view.phase, 'lobby');
  h.close();
});

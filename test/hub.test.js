// lib/hub.js with pretend sockets (no server, no ports): the laptop rules stay as they are, and the options the
// website version will use (docs/dev/web-plan.md §1.1) do what the plan says and nothing when they aren't set.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHub, MAX_SET_BYTES, HOST_KEY_TRIES_PER_MINUTE, CLOCK_EVERY_MS, CLOCK_BURST, louderSettings, looksLikeSave } from '../lib/hub.js';
import { COLORS } from '../lib/game.js';
import { validateSet } from '../lib/validate.js';

const sample = JSON.parse(readFileSync(new URL('../sets/sample.json', import.meta.url), 'utf8'));
const quickSample = JSON.parse(readFileSync(new URL('../sets/quick-sample.json', import.meta.url), 'utf8'));
const info = { port: 1, version: '0.0.0', phoneUrl: 'http://x/', tvUrl: 'http://x/display' };

// A socket as the hub sees one: send(), readyState, on('message' | 'close' | 'pong'), ping(), terminate().
function fakeWs() {
  const handlers = {};
  return {
    readyState: 1,
    sent: [],
    pings: 0,
    send(s) {
      this.sent.push(JSON.parse(s));
    },
    on(ev, fn) {
      (handlers[ev] ??= []).push(fn);
    },
    emit(ev, ...a) {
      for (const fn of handlers[ev] ?? []) fn(...a);
    },
    ping() {
      this.pings += 1;
    },
    terminate() {
      this.readyState = 3;
      this.emit('close');
    },
    say(msg) {
      this.emit('message', JSON.stringify(msg));
    },
    last(type) {
      return this.sent.filter((m) => m.type === type).at(-1);
    },
    count: (type) => 0,
  };
}

// A hub with a connection of each kind. `connect` options as server.js or the website would pass them.
function setup(options = {}, { local = false, remote = false } = {}) {
  const hub = createHub({ set: sample, info, ...options });
  const open = (role, extra = {}, conn = { local, remote }) => {
    const ws = fakeWs();
    hub.connect(ws, null, conn);
    ws.say({ type: 'hello', role, ...extra });
    return ws;
  };
  return { hub, open };
}

test('laptop rules: a host from the laptop is welcome, from elsewhere refused; fromLaptop(req) decides when not told', () => {
  const { hub, open } = setup();
  const host = open('host', {}, { local: true });
  assert.equal(host.last('welcome').info.port, 1);
  const stranger = open('host', {}, { local: false });
  assert.equal(stranger.last('error').code, 'host-only-on-laptop');
  assert.equal(stranger.last('welcome'), undefined);
  // With a key in the hello but no `hostKey` option, the laptop answer stays the same.
  const keyed = open('host', { key: 'anything' }, { local: false });
  assert.equal(keyed.last('error').code, 'host-only-on-laptop');
  hub.stop();

  // server.js passes `fromLaptop(req)`; the hub asks it only when `local` isn't given.
  const asked = [];
  const hub2 = createHub({ set: sample, info, fromLaptop: (req) => (asked.push(req), req.ok) });
  const ws = fakeWs();
  hub2.connect(ws, { ok: true });
  ws.say({ type: 'hello', role: 'host' });
  assert.ok(ws.last('welcome'));
  const ws2 = fakeWs();
  hub2.connect(ws2, { ok: false });
  ws2.say({ type: 'hello', role: 'host' });
  assert.equal(ws2.last('error').code, 'host-only-on-laptop');
  const ws3 = fakeWs();
  hub2.connect(ws3, { ok: true }, { remote: true }); // the tunnel's listener: never the host
  ws3.say({ type: 'hello', role: 'host' });
  assert.equal(ws3.last('error').code, 'host-only-on-laptop');
  assert.deepEqual(asked, [{ ok: true }, { ok: false }]);
  hub2.stop();
});

test('hostKey: the right key makes a host from anywhere, a wrong one is refused and never locks the right one out', () => {
  const { hub, open } = setup({ hostKey: 'secret-key' });
  const host = open('host', { key: 'secret-key' });
  assert.equal(host.last('welcome').info.port, 1);
  assert.equal(host.last('state').view.phase, 'lobby');
  assert.equal(open('host', { key: 'wrong' }).last('error').code, 'bad-host-key');
  assert.equal(open('host', {}).last('error').code, 'bad-host-key');
  assert.equal(open('host', { key: 123 }).last('error').code, 'bad-host-key');
  // Many wrong keys (the room limits them, web/room.js): the right one still works, so nobody can keep the host out.
  for (let i = 3; i < HOST_KEY_TRIES_PER_MINUTE + 2; i++) assert.equal(open('host', { key: 'wrong' }).last('error').code, 'bad-host-key');
  assert.ok(open('host', { key: 'secret-key' }).last('welcome'));
  // The laptop itself never needs the key.
  assert.ok(open('host', {}, { local: true }).last('welcome'));
  hub.stop();
});

test('hostKey as a function: the room decides which key is the host (web/room.js learns it from the first host)', () => {
  let roomKey = null;
  const { hub, open } = setup({ hosted: true, hostKey: (key) => key === roomKey });
  assert.equal(open('host', { key: 'abc' }).last('error').code, 'bad-host-key'); // no key claimed yet
  roomKey = 'abc';
  assert.ok(open('host', { key: 'abc' }).last('welcome'));
  assert.equal(open('host', { key: 'other' }).last('error').code, 'bad-host-key');
  hub.stop();
});

test('hosted: phones count as elsewhere (PIN, needPin), the TV never sees the PIN but still counts as a TV, quit does nothing', () => {
  const { hub, open } = setup({ hosted: true, hostKey: 'k' });
  const host = open('host', { key: 'k' });
  const tv = open('display');
  host.say({ type: 'cmd', action: { type: 'settings', settings: { remotePin: '1234' } } });
  assert.equal(host.last('state').view.settings.remotePin, '1234');
  assert.equal(tv.last('state').view.settings.remotePin, '', 'the TV page must not show the PIN');
  assert.equal(tv.last('state').displays, 1);
  assert.equal(tv.last('state').tvs, 1);

  const phone = open('phone');
  assert.equal(phone.last('state').needPin, true);
  phone.say({ type: 'join', name: 'Red', color: COLORS[0] });
  assert.equal(phone.last('error').code, 'bad-pin');
  phone.say({ type: 'join', name: 'Red', color: COLORS[0], pin: '1234' });
  assert.ok(phone.last('joined'));
  assert.deepEqual(host.last('state').remote.remoteTeams, [phone.last('joined').teamId]);

  const before = host.sent.length;
  host.say({ type: 'quit' });
  assert.equal(host.last('bye'), undefined);
  assert.equal(host.sent.length, before);
  hub.stop();
});

test('not hosted: phones are not elsewhere, and the laptop TV sees the PIN (as today)', () => {
  const { hub, open } = setup();
  const host = open('host', {}, { local: true });
  const tv = open('display');
  host.say({ type: 'cmd', action: { type: 'settings', settings: { remotePin: '1234' } } });
  assert.equal(tv.last('state').view.settings.remotePin, '1234');
  const phone = open('phone');
  assert.equal(phone.last('state').needPin, undefined);
  phone.say({ type: 'join', name: 'Red', color: COLORS[0] });
  assert.ok(phone.last('joined'));
  assert.deepEqual(host.last('state').remote.remoteTeams, []);
  hub.stop();
});

test('cmd loadSet: a quiz with problems or a huge one is refused, a good one is loaded', () => {
  const { hub, open } = setup({ hosted: true, hostKey: 'k' });
  const host = open('host', { key: 'k' });
  const bad = { ...sample, title: '' };
  assert.ok(validateSet(bad).length > 0);
  host.say({ type: 'cmd', action: { type: 'loadSet', set: bad, setId: 'bad' } });
  assert.equal(host.last('error').code, 'set-has-problems');
  assert.equal(hub.getState().setId, 'sample');

  const huge = { ...quickSample, description: 'x'.repeat(10) };
  huge.sections = quickSample.sections.map((s) => ({ ...s, questions: s.questions.map((q) => ({ ...q, question: 'y'.repeat(60_000) })) }));
  assert.ok(JSON.stringify(huge).length > MAX_SET_BYTES);
  host.say({ type: 'cmd', action: { type: 'loadSet', set: huge, setId: 'huge' } });
  assert.equal(host.last('error').code, 'set-too-big');
  assert.equal(hub.getState().setId, 'sample');

  host.say({ type: 'cmd', action: { type: 'loadSet', set: quickSample, setId: 'quick-sample' } });
  assert.equal(hub.getState().setId, 'quick-sample');
  assert.equal(host.last('state').view.mode, 'quick');
  hub.stop();
});

test('restore: the autosave comes back from the host in an empty lobby, then Continue works as after a restart', () => {
  // A game as the autosave would hold it: two teams in the lobby, the music turned down.
  const first = createHub({ set: sample, info });
  first.dispatch({ type: 'join', teamId: 'team-red-00', name: 'Red', color: COLORS[0] });
  first.dispatch({ type: 'join', teamId: 'team-blue-0', name: 'Blue', color: COLORS[1] });
  first.dispatch({ type: 'settings', settings: { musicVolume: 10 } });
  const saved = { v: 1, savedAt: 123, state: { ...first.getState(), history: [] } };
  first.stop();
  assert.ok(looksLikeSave(saved));

  const { hub, open } = setup({ hosted: true, hostKey: 'k' });
  const host = open('host', { key: 'k' });
  assert.equal(host.last('state').resume, undefined);
  host.say({ type: 'restore', saved: { v: 2 } });
  assert.equal(host.last('error').code, 'bad-save');
  host.say({ type: 'restore', saved });
  const st = host.last('state');
  assert.deepEqual(st.resume.teams.map((t) => t.name), ['Red', 'Blue']);
  assert.equal(st.resume.savedAt, 123);
  assert.equal(st.view.settings.musicVolume, 10, 'the settings come back at once');
  assert.deepEqual(st.view.teams, [], 'the lobby stays empty until Continue');

  // A phone that was Red comes back and is Red again after Continue.
  const phone = open('phone', { teamId: 'team-red-00' });
  assert.equal(phone.last('welcome').teamId, null);
  host.say({ type: 'resume' });
  assert.deepEqual(hub.getState().teams.map((t) => t.name), ['Red', 'Blue']);
  assert.equal(phone.last('welcome').teamId, 'team-red-00');
  host.say({ type: 'restore', saved });
  assert.equal(host.last('error').code, 'restore-in-game');
  hub.stop();
});

test('restore: a finished game brings its quiz and settings back but is not offered; a huge quiz is refused; save() reports every change', () => {
  const saves = [];
  const { hub, open } = setup({ hosted: true, hostKey: 'k', save: (st) => saves.push(st) });
  const host = open('host', { key: 'k' });
  const over = { v: 1, savedAt: 5, state: { ...hub.getState(), phase: 'over', teams: [{ id: 'team-red-00', name: 'Red', color: COLORS[0], score: 500 }], settings: { ...hub.getState().settings, buzzSeconds: 9 } } };
  host.say({ type: 'restore', saved: over });
  const st = host.last('state');
  assert.equal(st.resume, undefined, 'a game that is over is not offered');
  assert.equal(st.view.phase, 'lobby');
  assert.equal(st.view.settings.buzzSeconds, 9);
  assert.deepEqual(st.view.teams, []);
  const huge = { v: 1, savedAt: 5, state: { ...hub.getState(), teams: [{ id: 'team-red-00', name: 'Red', color: COLORS[0], score: 0 }], set: { ...sample, pad: 'x'.repeat(MAX_SET_BYTES) } } };
  host.say({ type: 'restore', saved: huge });
  assert.equal(host.last('error').code, 'set-too-big');
  // The hub hands every changed state to save() (the website's room sends it on to the host's browser).
  const before = saves.length;
  host.say({ type: 'cmd', action: { type: 'settings', settings: { buzzSeconds: 4 } } });
  assert.equal(saves.length, before + 1);
  assert.equal(saves.at(-1).settings.buzzSeconds, 4);
  hub.stop();
});

test('brand: the host sends its branding (website only); checked like a save, in every view, only a change is broadcast', () => {
  const { hub, open } = setup({ hosted: true, hostKey: 'k', logoUrl: (name) => `/r/ABCDEF/files/${name}` });
  const host = open('host', { key: 'k' });
  const tv = open('display');
  const phone = open('phone');
  assert.equal(host.last('state').brand, null, 'no branding to begin with');
  host.say({ type: 'brand', name: '  Nordlys\nChristmas  Quiz ', accent: '#0F9F95', plate: true, logo: 'logo-0123456789abcdef.svg', extra: 1 });
  const want = { name: 'Nordlys Christmas Quiz', accent: '#0f9f95', plate: true, logo: '/r/ABCDEF/files/logo-0123456789abcdef.svg' };
  for (const ws of [host, tv, phone]) assert.deepEqual(ws.last('state').brand, want);
  // Only the host; a phone or a TV saying so changes nothing.
  const before = host.sent.length;
  phone.say({ type: 'brand', name: 'Hacked', accent: null, plate: false, logo: null });
  tv.say({ type: 'brand', name: 'Hacked' });
  assert.equal(host.sent.length, before);
  assert.deepEqual(host.last('state').brand, want);
  // The same again: nothing is sent. A bad colour means the default, a bad logo name no logo, a long name is cut.
  host.say({ type: 'brand', name: 'Nordlys Christmas Quiz', accent: '#0f9f95', plate: true, logo: 'logo-0123456789abcdef.svg' });
  assert.equal(host.sent.length, before);
  host.say({ type: 'brand', name: 'x'.repeat(80), accent: 'red', plate: 'yes', logo: '../../etc/passwd' });
  assert.deepEqual(tv.last('state').brand, { name: 'x'.repeat(60), accent: null, plate: false, logo: null });
  host.say({ type: 'brand', logo: 'logo-0123456789abcdef.png' });
  assert.deepEqual(tv.last('state').brand, { name: '', accent: null, plate: false, logo: '/r/ABCDEF/files/logo-0123456789abcdef.png' });
  // Nothing set at all is no branding (the screens then look exactly as without any).
  host.say({ type: 'brand', name: '', accent: null, plate: false, logo: null });
  assert.equal(tv.last('state').brand, null);
  host.say({ type: 'brand' });
  assert.equal(tv.last('state').brand, null);
  hub.stop();

  // The laptop: the message does nothing; brand.js's view is what everyone gets, as before.
  const laptop = { view: () => ({ name: 'Laptop', accent: null, plate: false, logo: '/brand/logo-0123456789abcdef.png' }) };
  const { hub: hub2, open: open2 } = setup({ brand: laptop });
  const h2 = open2('host', {}, { local: true });
  assert.deepEqual(h2.last('state').brand, laptop.view());
  h2.say({ type: 'brand', name: 'Changed' });
  assert.deepEqual(h2.last('state').brand, laptop.view());
  hub2.stop();
});

test('heartbeat: a connection that answers the ping (pong) stays, one that does not is dropped', () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_700_000_000_000 });
  try {
    const { hub, open } = setup();
    const alive = open('phone');
    const gone = open('phone');
    mock.timers.tick(10_000);
    assert.equal(alive.pings, 1);
    assert.equal(gone.pings, 1);
    alive.emit('pong');
    mock.timers.tick(10_000);
    assert.equal(alive.readyState, 1);
    assert.equal(gone.readyState, 3, 'terminated');
    hub.stop();
  } finally {
    mock.timers.reset();
  }
});

test('clockEveryMs and clockBurst: the options set how often phones are measured; the laptop defaults unchanged', async () => {
  assert.equal(CLOCK_EVERY_MS, 5000);
  assert.equal(CLOCK_BURST, 5);
  const clocks = (ws) => ws.sent.filter((m) => m.type === 'clock').length;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  // A Quick quiz measures every phone's clock. `slow` only ever sends its burst within the test; `fast` keeps going.
  const slow = createHub({ set: quickSample, info, hosted: true, clockEveryMs: 100_000, clockBurst: 3 });
  const fast = createHub({ set: quickSample, info, hosted: true, clockEveryMs: 40, clockBurst: 2 });
  const ps = fakeWs();
  const pf = fakeWs();
  slow.connect(ps, null, { local: false });
  fast.connect(pf, null, { local: false });
  ps.say({ type: 'hello', role: 'phone' });
  pf.say({ type: 'hello', role: 'phone' });
  await wait(600); // the burst is spread over clockBurst × 150 ms
  assert.equal(clocks(ps), 3);
  assert.ok(clocks(pf) >= 2 + 5, `fast: ${clocks(pf)}`); // 2 from the burst, then one every 40 ms
  slow.stop();
  fast.stop();
});

test('louderSettings is still exported for the tests that import it from server.js', async () => {
  const server = await import('../server.js');
  assert.equal(server.louderSettings, louderSettings);
  assert.equal(server.createHub, createHub);
});

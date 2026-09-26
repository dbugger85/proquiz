// Starts the real server on a free port and talks to it like phones and the host laptop would.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../server.js';
import { COLORS } from '../lib/game.js';

const dataDir = mkdtempSync(join(tmpdir(), 'proquiz-test-'));
let srv;
let url;
before(async () => {
  srv = await startServer({ port: 3470, quiet: true, dataDir });
  url = `ws://127.0.0.1:${srv.info.port}/ws`;
});
after(() => srv.close());

// A small client that remembers every message and can wait for one.
async function client(role, teamId) {
  const ws = new WebSocket(url);
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
  c.send({ type: 'hello', role, teamId });
  await c.wait((m) => m.type === 'welcome' || m.type === 'error');
  return c;
}

async function phone(name, color) {
  const p = await client('phone');
  p.send({ type: 'join', name, color });
  p.teamId = (await p.wait((m) => m.type === 'joined')).teamId;
  return p;
}

test('host and display get the phone address; phones join and show up as connected', async () => {
  const host = await client('host');
  assert.match(host.msgs.find((m) => m.type === 'welcome').info.phoneUrl ?? 'http://x/', /^http:\/\//);

  const red = await phone('Red', COLORS[0]);
  const blue = await phone('Blue', COLORS[1]);
  const s = await host.wait((m) => m.type === 'state' && m.view.teams.length === 2);
  assert.deepEqual(s.view.teams.map((t) => t.name), ['Red', 'Blue']);
  assert.deepEqual(new Set(s.connected), new Set([red.teamId, blue.teamId]));

  // A taken colour is refused with a reason.
  const late = await client('phone');
  late.send({ type: 'join', name: 'Late', color: COLORS[0] });
  assert.equal((await late.wait((m) => m.type === 'error')).code, 'color-taken');

  // Phones never get the host view.
  const pv = (await red.wait((m) => m.type === 'state' && m.view.you)).view;
  assert.equal(pv.you.name, 'Red');
  assert.equal(pv.set, undefined);

  // Buzzing works end to end: pick, arm, blue buzzes first, red a moment later.
  host.send({ type: 'cmd', action: { type: 'start', picker: red.teamId } });
  host.send({ type: 'cmd', action: { type: 'pick', c: 0, i: 0 } });
  host.send({ type: 'cmd', action: { type: 'arm' } });
  await blue.wait((m) => m.type === 'state' && m.view.status === 'armed');
  blue.send({ type: 'buzz' });
  red.send({ type: 'buzz' });
  const buzzed = await host.wait((m) => m.type === 'state' && m.view.q?.buzzes.length === 2);
  assert.equal(buzzed.view.q.buzzedTeam, blue.teamId);
  assert.equal((await red.wait((m) => m.type === 'state' && m.view.status === 'other')).view.buzzedTeam, blue.teamId);

  host.send({ type: 'cmd', action: { type: 'correct' } });
  const scored = await host.wait((m) => m.type === 'state' && m.view.phase === 'revealed');
  assert.equal(scored.view.teams.find((t) => t.id === blue.teamId).score, 100);

  // A phone can't send host commands.
  red.send({ type: 'cmd', action: { type: 'adjust', teamId: red.teamId, delta: 1000 } });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(srv.hub.getState().teams.find((t) => t.id === red.teamId).score, 0);

  // Reconnecting with the saved team id keeps the team and score.
  blue.close();
  await host.wait((m) => m.type === 'state' && !m.connected.includes(blue.teamId));
  const back = await client('phone', blue.teamId);
  assert.equal(back.msgs.find((m) => m.type === 'welcome').teamId, blue.teamId);
  const again = await back.wait((m) => m.type === 'state' && m.view.you);
  assert.equal(again.view.you.score, 100);

  // An unknown team id gets a welcome without a team, so the phone shows the join form.
  const stranger = await client('phone', 'not-a-real-team-id');
  assert.equal(stranger.msgs.find((m) => m.type === 'welcome').teamId, null);

  for (const c of [host, red, back, late, stranger]) c.close();
});

test('the server runs the timers', async () => {
  const host = await client('host');
  host.send({ type: 'cmd', action: { type: 'restart' } });
  await host.wait((m) => m.type === 'state' && m.view.phase === 'lobby');
  host.msgs.length = 0; // forget the state left over from the test above
  host.send({ type: 'cmd', action: { type: 'settings', settings: { buzzSeconds: 1 } } });
  host.send({ type: 'cmd', action: { type: 'start' } });
  host.send({ type: 'cmd', action: { type: 'pick', c: 1, i: 0 } });
  host.send({ type: 'cmd', action: { type: 'arm' } });
  await host.wait((m) => m.type === 'state' && m.view.phase === 'armed');
  const t = await host.wait((m) => m.type === 'state' && m.view.phase === 'revealed', 3000);
  assert.deepEqual(t.view.q.result, { type: 'timeout' });
  host.close();
});

test('the game is saved, and after a restart the host can continue it', async () => {
  const host = await client('host');
  host.send({ type: 'cmd', action: { type: 'adjust', teamId: srv.hub.getState().teams[0].id, delta: 700 } });
  host.send({ type: 'cmd', action: { type: 'settings', settings: { penalty: 'full' } } });
  await new Promise((r) => setTimeout(r, 400));
  host.close();
  const file = join(dataDir, 'autosave.json');
  assert.ok(existsSync(file));
  const teamId = srv.hub.getState().teams[0].id;
  const before = srv.hub.getState().teams[0].score;
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).state.teams[0].score, before);

  // "Restart" ProQuiz: a new server reading the same folder.
  await srv.close();
  srv = await startServer({ port: 3470, quiet: true, dataDir });
  url = `ws://127.0.0.1:${srv.info.port}/ws`;
  assert.equal(srv.hub.getState().phase, 'lobby');
  assert.equal(srv.hub.getState().teams.length, 0);
  assert.equal(srv.hub.getState().settings.penalty, 'full'); // settings carry over to a new game

  // A phone comes back before the host decides: it doesn't know its team yet.
  const p = await client('phone', teamId);
  assert.equal(p.msgs.find((m) => m.type === 'welcome').teamId, null);

  const host2 = await client('host');
  const offer = await host2.wait((m) => m.type === 'state' && m.resume);
  assert.equal(offer.resume.teams[0].score, before);
  host2.send({ type: 'resume' });
  await host2.wait((m) => m.type === 'state' && !m.resume && m.view.teams.length > 0);
  assert.equal(srv.hub.getState().teams[0].score, before);

  // The waiting phone is put back in its team.
  await p.wait((m) => m.type === 'welcome' && m.teamId === teamId);
  const back = await p.wait((m) => m.type === 'state' && m.view.you);
  assert.equal(back.view.you.id, teamId);
  p.close();
  host2.close();
});

test('the host can turn down the saved game', async () => {
  await srv.close();
  srv = await startServer({ port: 3470, quiet: true, dataDir });
  url = `ws://127.0.0.1:${srv.info.port}/ws`;
  const host = await client('host');
  await host.wait((m) => m.type === 'state' && m.resume);
  host.send({ type: 'discardSave' });
  const s = await host.wait((m) => m.type === 'state' && !m.resume);
  assert.equal(s.view.teams.length, 0);
  host.close();
});

test('question pictures are served, and only plain file names are allowed', async () => {
  const base = `http://127.0.0.1:${srv.info.port}`;
  const ok = await fetch(`${base}/images/sample-flag-japan.svg`);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('content-type'), 'image/svg+xml');
  assert.equal((await fetch(`${base}/images/..%2Fserver.js`)).status, 400);
  assert.equal((await fetch(`${base}/images/missing.png`)).status, 404);
});

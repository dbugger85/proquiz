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

  // Blue answered right, so Blue picks next, on its phone. Only Blue's phone gets the board.
  host.send({ type: 'cmd', action: { type: 'next' } });
  const blueBoard = (await blue.wait((m) => m.type === 'state' && m.view.canPick)).view;
  assert.deepEqual(blueBoard.board[0].used, [true, false, false, false, false]);
  const redBoard = (await red.wait((m) => m.type === 'state' && m.view.phase === 'board' && m.view.picker === blue.teamId)).view;
  assert.equal(redBoard.canPick, false);
  assert.equal(redBoard.board, undefined);
  red.send({ type: 'pick', c: 0, i: 1 }); // not Red's turn
  blue.send({ type: 'pick', c: '0', i: '1' }); // not numbers
  blue.send({ type: 'pick', c: 0, i: 0 }); // already used
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(srv.hub.getState().phase, 'board');
  blue.send({ type: 'pick', c: 0, i: 1 });
  await host.wait((m) => m.type === 'state' && m.view.phase === 'reading' && m.view.q.i === 1);
  assert.deepEqual([srv.hub.getState().q.c, srv.hub.getState().q.i], [0, 1]);

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

test('a busy port is skipped: a second ProQuiz starts on the next one', async () => {
  const second = await startServer({ port: srv.info.port, quiet: true, dataDir: mkdtempSync(join(tmpdir(), 'proquiz-test-')) });
  try {
    assert.equal(second.info.port, srv.info.port + 1);
  } finally {
    second.close();
  }
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
  host.send({ type: 'cmd', action: { type: 'settings', settings: { penalty: 'full', musicFiles: { lobby: '0123456789abcdef.mp3' }, musicVolume: 50 } } });
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
  assert.deepEqual(srv.hub.getState().settings.musicFiles, { lobby: '0123456789abcdef.mp3' }); // and your own music
  assert.equal(srv.hub.getState().settings.musicVolume, 50);

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
  const ok = await fetch(`${base}/files/sample-flag-japan.svg`);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('content-type'), 'image/svg+xml');
  assert.equal((await fetch(`${base}/files/..%2Fserver.js`)).status, 400);
  assert.equal((await fetch(`${base}/files/missing.png`)).status, 404);
});

test('editor API: create, save, list, upload a file, export and import, choose in the lobby', async () => {
  const base = `http://127.0.0.1:${srv.info.port}`;
  const call = async (method, path, body, raw) => {
    const r = await fetch(base + path, { method, body: raw ?? (body && JSON.stringify(body)) });
    return { status: r.status, data: await r.json() };
  };

  // The built-in sample is listed and can't be overwritten.
  let list = (await call('GET', '/api/sets')).data;
  assert.equal(list[0].id, 'sample');
  assert.equal(list[0].builtIn, true);
  assert.equal((await call('PUT', '/api/sets/sample', { set: {} })).status, 400);

  // A new quiz (a copy of the sample) is saved in the data folder.
  const sample = (await call('GET', '/api/sets/sample')).data.set;
  const created = await call('POST', '/api/sets', { set: { ...sample, title: 'Quiz på fjellet' } });
  assert.equal(created.status, 201);
  const id = created.data.id;
  assert.match(id, /^quiz-pa-fjellet-[0-9a-f]{6}$/);

  // Upload a sound clip: it gets a name made from its content.
  const clip = await call('POST', '/api/files?name=My%20Song.MP3', null, Buffer.from('fake mp3 bytes'));
  assert.equal(clip.status, 201);
  assert.match(clip.data.name, /^[0-9a-f]{16}\.mp3$/);
  assert.equal(clip.data.kind, 'audio');
  assert.equal((await call('POST', '/api/files?name=virus.exe', null, Buffer.from('x'))).status, 400);
  const served = await fetch(`${base}/files/${clip.data.name}`, { headers: { Range: 'bytes=5-7' } });
  assert.equal(served.status, 206);
  assert.equal(await served.text(), 'mp3');

  // Save with the clip on a question; a missing answer is reported but still saved (as a draft).
  const set = structuredClone(sample);
  set.title = 'Quiz på fjellet';
  set.categories[0].questions[0].audio = clip.data.name;
  set.categories[0].questions[0].audioStart = 3;
  set.categories[0].questions[2].unveil = 12; // the flag question has a picture: kept
  set.categories[1].questions[0].unveil = 12; // no picture: dropped
  set.categories[0].questions[1].answer = '';
  let saved = await call('PUT', `/api/sets/${id}`, { set });
  assert.deepEqual(saved.data.problems, [{ code: 'no-answer', c: 0, i: 1 }]);
  const back = (await call('GET', `/api/sets/${id}`)).data.set;
  assert.equal(back.categories[0].questions[0].audioStart, 3);
  assert.equal(back.categories[0].questions[2].unveil, 12);
  assert.equal(back.categories[1].questions[0].unveil, undefined);

  // A round 2 board is kept, with its own pictures listed for export, and its problems are marked as round 2.
  const withRound2 = { ...set, round2: { categories: [{ name: 'Extra', questions: [{ value: 200, question: 'q', answer: '', image: 'flag.svg', hint: 'x' }] }] } };
  saved = await call('PUT', `/api/sets/${id}`, { set: withRound2 });
  assert.deepEqual(saved.data.problems.at(-1), { code: 'no-answer', c: 0, i: 0, r: 2 });
  assert.deepEqual((await call('GET', `/api/sets/${id}`)).data.set.round2, { categories: [{ name: 'Extra', questions: [{ value: 200, question: 'q', answer: '', image: 'flag.svg' }] }] });
  const { round2, ...without } = set;
  saved = await call('PUT', `/api/sets/${id}`, { set: without });
  assert.equal((await call('GET', `/api/sets/${id}`)).data.set.round2, undefined);
  list = (await call('GET', '/api/sets')).data;
  assert.equal(list.find((x) => x.id === id).problems, 1);

  // A quiz with problems can't be chosen in the lobby; once fixed it can, and edits show up straight away.
  const host = await client('host');
  host.send({ type: 'cmd', action: { type: 'restart' } });
  host.send({ type: 'chooseSet', id });
  assert.equal((await host.wait((m) => m.type === 'error')).code, 'set-has-problems');
  set.categories[0].questions[1].answer = 'Rome';
  saved = await call('PUT', `/api/sets/${id}`, { set });
  assert.deepEqual(saved.data.problems, []);
  host.send({ type: 'chooseSet', id });
  await host.wait((m) => m.type === 'state' && m.view.setId === id);
  set.title = 'Quiz på fjellet 2';
  await call('PUT', `/api/sets/${id}`, { set });
  await host.wait((m) => m.type === 'state' && m.view.set.title === 'Quiz på fjellet 2');

  // Export packs the clip inside; importing it gives a new quiz with the same files.
  const pkg = await (await fetch(`${base}/api/export/${id}`)).json();
  assert.equal(pkg.proquiz, 1);
  assert.equal(Buffer.from(pkg.files[clip.data.name], 'base64').toString(), 'fake mp3 bytes');
  const imported = await call('POST', '/api/import', null, JSON.stringify(pkg));
  assert.equal(imported.status, 201);
  assert.notEqual(imported.data.id, id);
  assert.equal((await call('POST', '/api/import', null, 'not json')).status, 400);

  // Delete.
  await call('DELETE', `/api/sets/${imported.data.id}`);
  assert.equal((await call('GET', `/api/sets/${imported.data.id}`)).status, 404);
  host.close();
});

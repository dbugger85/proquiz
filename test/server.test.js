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
  const info = host.msgs.find((m) => m.type === 'welcome').info;
  if (info.phoneUrl) assert.equal(info.tvUrl, info.phoneUrl + 'display'); // the TV page's Wi-Fi address

  const red = await phone('Red', COLORS[0]);
  const blue = await phone('Blue', COLORS[1]);
  const s = await host.wait((m) => m.type === 'state' && m.view.teams.length === 2);
  assert.deepEqual(s.view.teams.map((t) => t.name), ['Red', 'Blue']);
  assert.deepEqual(new Set(s.connected), new Set([red.teamId, blue.teamId]));

  // A taken colour is refused with a reason.
  const late = await client('phone');
  late.send({ type: 'join', name: 'Late', color: COLORS[0] });
  assert.equal((await late.wait((m) => m.type === 'error')).code, 'color-taken');

  // An avatar (a team's mascot) comes along with the join; a broken one is refused.
  const odd = await client('phone');
  odd.send({ type: 'join', name: 'Odd', color: COLORS[2], avatar: { skin: 99 } });
  assert.equal((await odd.wait((m) => m.type === 'error')).code, 'bad-avatar');
  const mascot = { skin: 1, hair: 2, hairColor: 3, eyes: 4, mouth: 0, glasses: 1, hat: 5 };
  odd.send({ type: 'join', name: 'Odd', color: COLORS[2], avatar: mascot });
  await odd.wait((m) => m.type === 'joined');
  const seen = await host.wait((m) => m.type === 'state' && m.view.teams.some((t) => t.name === 'Odd'));
  assert.deepEqual(seen.view.teams.find((t) => t.name === 'Odd').avatar, mascot);
  host.send({ type: 'cmd', action: { type: 'removeTeam', teamId: srv.hub.getState().teams.find((t) => t.name === 'Odd').id } });
  await host.wait((m) => m.type === 'state' && !m.view.teams.some((t) => t.name === 'Odd'));
  odd.close();

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
  srv.hub.dispatch({ type: 'join', teamId: srv.hub.getState().teams[0].id, name: srv.hub.getState().teams[0].name, color: srv.hub.getState().teams[0].color, avatar: { skin: 0, hair: 1, hairColor: 2, eyes: 3, mouth: 4, glasses: 0, hat: 1 } });
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
  assert.equal(offer.resume.teams[0].avatar.hat, 1); // the mascot is saved and shown in the resume list
  host2.send({ type: 'resume' });
  await host2.wait((m) => m.type === 'state' && !m.resume && m.view.teams.length > 0);
  assert.equal(srv.hub.getState().teams[0].score, before);

  // The waiting phone is put back in its team.
  await p.wait((m) => m.type === 'welcome' && m.teamId === teamId);
  const back = await p.wait((m) => m.type === 'state' && m.view.you);
  assert.equal(back.view.you.id, teamId);
  assert.equal(back.view.you.avatar.hat, 1);
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

test('the host can go back to the main menu mid-game, let a new team join, and continue', async () => {
  // Waits for a message that arrives from now on (wait() also looks at earlier ones).
  const fresh = (c, check) => {
    const from = c.msgs.length;
    return c.wait((m) => c.msgs.indexOf(m) >= from && check(m));
  };
  const host = await client('host');
  await host.wait((m) => m.type === 'state');
  const red = await phone('Menu Red', COLORS[0]);
  const blue = await phone('Menu Blue', COLORS[1]);
  const started = fresh(host, (m) => m.type === 'state' && m.view.phase === 'board');
  host.send({ type: 'cmd', action: { type: 'start', picker: red.teamId } });
  await started;
  const adjusted = fresh(host, (m) => m.type === 'state' && m.view.teams.some((t) => t.score === 300));
  host.send({ type: 'cmd', action: { type: 'adjust', teamId: red.teamId, delta: 300 } });
  await adjusted;

  // Main menu: an empty lobby with the game offered, as after closing and starting ProQuiz again.
  const toMenu = fresh(host, (m) => m.type === 'state' && m.view.phase === 'lobby' && m.resume);
  const redOut = fresh(red, (m) => m.type === 'welcome' && m.teamId === null);
  host.send({ type: 'mainMenu' });
  const menu = await toMenu;
  assert.equal(menu.view.teams.length, 0);
  assert.equal(menu.resume.teams.find((t) => t.name === 'Menu Red').score, 300);
  await redOut;

  // Red joins again with its saved id; a new team takes Blue's colour.
  const rejoined = fresh(red, (m) => m.type === 'joined');
  red.send({ type: 'join', name: 'Menu Red', color: COLORS[0], teamId: red.teamId });
  await rejoined;
  const green = await phone('Menu Green', COLORS[1]);

  const resumed = fresh(host, (m) => m.type === 'state' && !m.resume && m.view.phase === 'board');
  const blueBack = fresh(blue, (m) => m.type === 'welcome' && m.teamId === blue.teamId);
  host.send({ type: 'resume' });
  const back = await resumed;
  const teams = back.view.teams;
  assert.equal(teams.length, 3);
  assert.equal(teams.find((t) => t.id === red.teamId).score, 300);
  const g = teams.find((t) => t.id === green.teamId);
  assert.equal(g.score, 0);
  assert.notEqual(g.color, COLORS[1]); // Blue still has it, so Green gets a free colour
  // Blue (never rejoined) is put back in its team, and Green plays on.
  await blueBack;
  assert.equal((await green.wait((m) => m.type === 'state' && m.view.you)).view.you.id, green.teamId);
  for (const c of [host, red, blue, green]) c.close();
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

test('a Quick quiz end to end: answers with press times, scores, the top 5 on the TV, places on the phones', async () => {
  // Its own server, so the game above doesn't matter.
  const own = await startServer({ port: 3480, quiet: true, dataDir: mkdtempSync(join(tmpdir(), 'proquiz-quick-')) });
  const ownUrl = `ws://127.0.0.1:${own.info.port}/ws`;
  // Like client() above, but it answers the server's clock questions the way net.js does.
  async function measured(role) {
    const ws = new WebSocket(ownUrl);
    const msgs = [];
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.type === 'clock') return ws.send(JSON.stringify({ type: 'clock', id: m.id, t: performance.now() }));
      msgs.push(m);
    };
    await new Promise((r) => (ws.onopen = r));
    const c = {
      msgs,
      send: (m) => ws.send(JSON.stringify(m)),
      async wait(fn, ms = 3000) {
        for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 10))) {
          const found = msgs.findLast(fn);
          if (found) return found;
        }
        throw new Error('timed out waiting');
      },
      close: () => ws.close(),
    };
    c.send({ type: 'hello', role });
    await c.wait((m) => m.type === 'welcome');
    return c;
  }
  const host = await measured('host');
  const tv = await measured('display');
  host.send({ type: 'cmd', action: { type: 'settings', settings: { quickReadSeconds: 0, quickPhoneText: false } } });
  host.send({ type: 'chooseSet', id: 'quick-sample' });
  await host.wait((m) => m.type === 'state' && m.view.mode === 'quick' && m.view.settings.quickReadSeconds === 0);

  // Three players, two of them with the same colour.
  const players = [];
  for (const [name, color] of [['Ann', COLORS[0]], ['Bo', COLORS[0]], ['Cy', COLORS[1]]]) {
    const p = await measured('phone');
    assert.equal((await p.wait((m) => m.type === 'state')).view.mode, 'quick', 'the join screen knows the mode');
    p.send({ type: 'join', name, color });
    p.teamId = (await p.wait((m) => m.type === 'joined')).teamId;
    players.push(p);
  }
  const [ann, bo, cy] = players;
  await new Promise((r) => setTimeout(r, 1000)); // the clock measurements after joining (5 × 150 ms)
  const ids = Object.keys((await host.wait((m) => m.type === 'state' && Object.keys(m.latency ?? {}).length === 3)).latency);
  assert.equal(ids.length, 3, 'phones are measured in a Quick quiz even with fair buzzing off');

  host.send({ type: 'cmd', action: { type: 'start' } });
  await tv.wait((m) => m.type === 'state' && m.view.phase === 'section');
  host.send({ type: 'cmd', action: { type: 'next' } });
  await ann.wait((m) => m.type === 'state' && m.view.status === 'ready');
  host.send({ type: 'cmd', action: { type: 'next' } });
  await Promise.all(players.map((p) => p.wait((m) => m.type === 'state' && m.view.status === 'answer')));

  // Mercury (0) is right. Ann and Cy press it, Bo presses Venus; everyone answered, so the result comes at once.
  ann.send({ type: 'answer', option: 0, at: performance.now() });
  ann.send({ type: 'answer', option: 1, at: performance.now() }); // a second press doesn't count
  bo.send({ type: 'answer', option: 1, at: performance.now() });
  await new Promise((r) => setTimeout(r, 300));
  cy.send({ type: 'answer', option: 0, at: performance.now() });
  const result = await host.wait((m) => m.type === 'state' && m.view.phase === 'result');
  const score = (id) => result.view.teams.find((t) => t.id === id).score;
  assert.ok(score(ann.teamId) > score(cy.teamId), 'faster is more');
  assert.ok(score(ann.teamId) >= 990 && score(ann.teamId) <= 1000);
  assert.ok(score(cy.teamId) > 900 && score(cy.teamId) < 1000);
  assert.equal(score(bo.teamId), 0);
  assert.deepEqual(result.view.q.counts, [2, 1, 0, 0]);
  assert.equal(result.view.q.answers[ann.teamId].option, 0);
  const tvResult = await tv.wait((m) => m.type === 'state' && m.view.phase === 'result');
  assert.deepEqual(tvResult.view.q.correct, [0]); // the right options, as a list (several may be right)
  const annResult = await ann.wait((m) => m.type === 'state' && m.view.status === 'result');
  assert.deepEqual([annResult.view.q.mine, annResult.view.q.correct, annResult.view.q.gained], [{ option: 0 }, [0], score(ann.teamId)]);
  assert.equal(annResult.view.q.question, undefined, 'no texts on the phones when the host turned them off');

  // The top 5 on the TV, and each phone its place.
  host.send({ type: 'cmd', action: { type: 'next' } });
  const ranks = await tv.wait((m) => m.type === 'state' && m.view.phase === 'ranks');
  assert.deepEqual(ranks.view.ranks.top.map((r) => r.id), [ann.teamId, cy.teamId, bo.teamId]);
  assert.equal((await bo.wait((m) => m.type === 'state' && m.view.status === 'ranks')).view.rank, 3);
  assert.equal((await cy.wait((m) => m.type === 'state' && m.view.status === 'ranks')).view.rank, 2);

  // Skip the next question; then leave for the main menu while one is open, and continue: it starts again.
  host.send({ type: 'cmd', action: { type: 'next' } });
  await host.wait((m) => m.type === 'state' && m.view.phase === 'ready' && m.view.pos.i === 1);
  host.send({ type: 'cmd', action: { type: 'skip' } });
  await host.wait((m) => m.type === 'state' && m.view.phase === 'ready' && m.view.pos.i === 2);
  host.send({ type: 'cmd', action: { type: 'next' } });
  await host.wait((m) => m.type === 'state' && m.view.phase === 'open' && m.view.pos.i === 2);
  bo.send({ type: 'answer', option: 1 });
  await host.wait((m) => m.type === 'state' && Object.keys(m.view.q?.answers ?? {}).length === 1);
  host.send({ type: 'mainMenu' });
  const menu = await host.wait((m) => m.type === 'state' && m.view.phase === 'lobby' && m.resume);
  assert.deepEqual([menu.resume.mode, menu.resume.played, menu.resume.total], ['quick', 2, 15]);
  host.send({ type: 'resume' });
  const back = await host.wait((m) => m.type === 'state' && !m.resume && m.view.phase === 'ready');
  assert.deepEqual(back.view.q.answers, {});
  assert.equal(back.view.teams.find((t) => t.id === ann.teamId).score, score(ann.teamId));
  for (const c of [host, tv, ...players]) c.close();
  await own.close();
});

test('a Quick quiz with 100 phones, and reactions: allowed only at the result or top 5, once a second, with the setting on', async () => {
  const own = await startServer({ port: 3481, quiet: true, dataDir: mkdtempSync(join(tmpdir(), 'proquiz-crowd-')) });
  const ownUrl = `ws://127.0.0.1:${own.info.port}/ws`;
  async function one(role, teamId) {
    const ws = new WebSocket(ownUrl);
    const msgs = [];
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.type === 'clock') return ws.send(JSON.stringify({ type: 'clock', id: m.id, t: performance.now() }));
      msgs.push(m);
    };
    await new Promise((r) => (ws.onopen = r));
    const c = {
      msgs,
      send: (m) => ws.send(JSON.stringify(m)),
      async wait(fn, ms = 5000) {
        for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 10))) {
          const found = msgs.findLast(fn);
          if (found) return found;
        }
        throw new Error('timed out waiting');
      },
      count: (fn) => msgs.filter(fn).length,
      close: () => ws.close(),
    };
    c.send({ type: 'hello', role, teamId });
    await c.wait((m) => m.type === 'welcome');
    return c;
  }
  const host = await one('host');
  const tv = await one('display');
  host.send({ type: 'cmd', action: { type: 'settings', settings: { quickReadSeconds: 0 } } });
  host.send({ type: 'chooseSet', id: 'quick-sample' });
  await host.wait((m) => m.type === 'state' && m.view.mode === 'quick' && m.view.settings.quickReadSeconds === 0);

  // 100 phones join (every colour in use); the 101st is told the game is full.
  const phones = [];
  for (let n = 0; n < 100; n++) {
    const p = await one('phone');
    p.send({ type: 'join', name: `Player ${n + 1}`, color: COLORS[n % COLORS.length] });
    phones.push(p);
  }
  for (const p of phones) p.teamId = (await p.wait((m) => m.type === 'joined')).teamId;
  const full = await host.wait((m) => m.type === 'state' && m.view.teams.length === 100);
  assert.equal(full.connected.length, 100);
  assert.equal(new Set(full.view.teams.map((t) => t.color)).size, 16);
  const late = await one('phone');
  late.send({ type: 'join', name: 'Late', color: COLORS[0] });
  assert.equal((await late.wait((m) => m.type === 'error')).code, 'full-players');
  late.close();

  // In the lobby a reaction does nothing (not even for a player).
  phones[0].send({ type: 'react', emoji: 0 });
  host.send({ type: 'cmd', action: { type: 'start' } });
  await tv.wait((m) => m.type === 'state' && m.view.phase === 'section');
  host.send({ type: 'cmd', action: { type: 'next' } });
  await tv.wait((m) => m.type === 'state' && m.view.phase === 'ready');
  host.send({ type: 'cmd', action: { type: 'next' } });
  await tv.wait((m) => m.type === 'state' && m.view.phase === 'open');
  phones[1].send({ type: 'react', emoji: 1 }); // not while the answers are open
  // Everyone answers: the question closes by itself, and the TV sees the right counts.
  for (const [n, p] of phones.entries()) p.send({ type: 'answer', option: n % 2, at: performance.now() });
  const result = await tv.wait((m) => m.type === 'state' && m.view.phase === 'result', 8000);
  assert.deepEqual(result.view.q.counts, [50, 50, 0, 0]);
  assert.equal(result.view.q.nRight, 50);
  assert.equal(result.view.teams.length, 100);
  assert.equal(tv.count((m) => m.type === 'reaction'), 0, 'nothing got through before the result');

  // At the result: a reaction reaches the TV with the player's name and colour; a second one within a second is
  // dropped; a bad index, an unknown phone and a phone that isn't a player are ignored.
  phones[2].send({ type: 'react', emoji: 3 });
  const r = await tv.wait((m) => m.type === 'reaction');
  assert.deepEqual(r, { type: 'reaction', emoji: '👏', name: 'Player 3', color: COLORS[2] });
  phones[2].send({ type: 'react', emoji: 4 }); // too soon
  phones[3].send({ type: 'react', emoji: 6 }); // no such emoji
  phones[3].send({ type: 'react', emoji: '2' });
  const stranger = await one('phone');
  stranger.send({ type: 'react', emoji: 0 });
  await new Promise((res) => setTimeout(res, 150));
  assert.equal(tv.count((m) => m.type === 'reaction'), 1);
  assert.equal(host.count((m) => m.type === 'reaction'), 0, 'the host page gets nothing while a TV is open');
  await new Promise((res) => setTimeout(res, 1000));
  phones[2].send({ type: 'react', emoji: 4 }); // a second later it's fine
  await tv.wait((m) => m.type === 'reaction' && m.emoji === '😭');
  // At the top 5 too; with the setting off, nothing.
  host.send({ type: 'cmd', action: { type: 'next' } });
  await tv.wait((m) => m.type === 'state' && m.view.phase === 'ranks');
  assert.equal((await tv.wait((m) => m.type === 'state' && m.view.phase === 'ranks')).view.ranks.top.length, 5);
  phones[4].send({ type: 'react', emoji: 5 });
  await tv.wait((m) => m.type === 'reaction' && m.name === 'Player 5');
  host.send({ type: 'cmd', action: { type: 'settings', settings: { quickReactions: false } } });
  await tv.wait((m) => m.type === 'state' && m.view.settings.quickReactions === false);
  phones[5].send({ type: 'react', emoji: 0 });
  await new Promise((res) => setTimeout(res, 150));
  assert.equal(tv.count((m) => m.type === 'reaction'), 3);
  // Nothing about reactions is in the game or its save.
  assert.equal(JSON.stringify(own.hub.getState()).includes('reaction'), false);
  stranger.close();
  for (const c of [host, tv, ...phones]) c.close();
  await own.close();
});

test('another website open in the laptop browser can not use the editor API or become the host', async () => {
  const http = await import('node:http');
  const { WebSocket: WS } = await import('ws');
  const base = `http://127.0.0.1:${srv.info.port}`;
  const post = (headers) => fetch(`${base}/api/sets`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ set: { title: 'x', categories: [] } }) });
  assert.equal((await post({ Origin: 'http://evil.example' })).status, 403);
  assert.equal((await post({ Origin: 'null' })).status, 403);
  assert.equal((await post({ 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await post({ 'Sec-Fetch-Site': 'same-site' })).status, 403); // another program on this laptop
  const ok = await post({ Origin: base, 'Sec-Fetch-Site': 'same-origin' });
  assert.equal(ok.status, 201);
  await fetch(`${base}/api/sets/${(await ok.json()).id}`, { method: 'DELETE' });

  // A website's own name pointed at this laptop (DNS rebinding) can't even read the quizzes.
  const status = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: srv.info.port, path: '/api/sets', headers: { Host: `evil.example:${srv.info.port}` } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    }).on('error', reject);
  });
  assert.equal(status, 403);

  // The host's WebSocket from another website's page counts as not on the laptop.
  const ws = new WS(url, { origin: 'http://evil.example' });
  const reply = await new Promise((resolve, reject) => {
    ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', role: 'host' })));
    ws.on('message', (raw) => {
      const m = JSON.parse(raw);
      if (m.type === 'welcome' || m.type === 'error') resolve(m);
    });
    ws.on('error', reject);
  });
  ws.close();
  assert.equal(reply.type, 'error');
});

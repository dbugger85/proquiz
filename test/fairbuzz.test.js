// Fair buzzing against the real server: pretend phones with wrong clocks and slow Wi-Fi.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../server.js';
import { COLORS } from '../lib/game.js';

let srv;
let url;
before(async () => {
  srv = await startServer({ port: 3490, quiet: true, dataDir: mkdtempSync(join(tmpdir(), 'proquiz-fair-')) });
  url = `ws://127.0.0.1:${srv.info.port}/ws`;
});
after(() => srv.close());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A pretend client. `clock` is how far its stopwatch is off, `lag` the Wi-Fi delay each way (ms),
// and `measured: false` makes it ignore the server's clock questions, like an old phone page.
async function client(role, { clock = 0, lag = 0, measured = true } = {}) {
  const ws = new WebSocket(url);
  const msgs = [];
  const stopwatch = () => performance.now() + clock;
  const send = (m) => (lag ? setTimeout(() => ws.send(JSON.stringify(m)), lag) : ws.send(JSON.stringify(m)));
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.type === 'clock') {
      // The question arrives `lag` late, and the answer takes `lag` to get back.
      if (measured) setTimeout(() => send({ type: 'clock', id: m.id, t: stopwatch() }), lag);
      return;
    }
    msgs.push(m);
  };
  await new Promise((r) => (ws.onopen = r));
  const c = {
    msgs,
    send,
    // Pressing the button: the phone notes its stopwatch now, and the buzz travels for `lag`.
    press: () => send({ type: 'buzz', at: stopwatch() }),
    async wait(fn, ms = 3000) {
      for (const end = Date.now() + ms; Date.now() < end; await sleep(10)) {
        const found = msgs.findLast(fn);
        if (found) return found;
      }
      throw new Error('timed out waiting');
    },
    close: () => ws.close(),
  };
  ws.send(JSON.stringify({ type: 'hello', role }));
  await c.wait((m) => m.type === 'welcome');
  return c;
}

async function phone(name, color, opts) {
  const p = await client('phone', opts);
  p.send({ type: 'join', name, color });
  p.teamId = (await p.wait((m) => m.type === 'joined')).teamId;
  return p;
}

const teamOf = (host, id) => host.msgs.findLast((m) => m.type === 'state').view.teams.find((t) => t.id === id).name;

// Opens a fresh question and waits until the buzzers are on.
async function armed(host, c) {
  host.msgs.length = 0;
  host.send({ type: 'cmd', action: { type: 'pick', c, i: 0 } });
  host.send({ type: 'cmd', action: { type: 'arm' } });
  await host.wait((m) => m.type === 'state' && m.view.phase === 'armed');
  await sleep(150);
}

async function winner(host) {
  const s = await host.wait((m) => m.type === 'state' && m.view.phase === 'answering');
  return teamOf(host, s.view.q.buzzedTeam);
}

test('fair buzzing: the phone that pressed first wins, even with a wrong clock and slow Wi-Fi', async () => {
  const host = await client('host');
  host.send({ type: 'cmd', action: { type: 'settings', settings: { fairBuzz: true, buzzSeconds: 0 } } });
  const fast = await phone('Fast', COLORS[0], { clock: 5_000_000 });
  const slow = await phone('Slow', COLORS[1], { clock: -3000, lag: 60 });
  const old = await phone('Old', COLORS[2], { measured: false });
  host.send({ type: 'cmd', action: { type: 'start', picker: fast.teamId } });

  // The host's lobby list gets each phone's measured delay.
  const lat = await host.wait((m) => m.type === 'latency' && m.latency[slow.teamId] !== undefined, 7000);
  assert.ok(lat.latency[slow.teamId] >= 110 && lat.latency[slow.teamId] < 200, `slow phone ${lat.latency[slow.teamId]} ms`);
  assert.ok(lat.latency[fast.teamId] < 50);
  assert.equal(lat.latency[old.teamId], undefined);

  // Slow presses first; its buzz arrives 60 ms later, after Fast's (pressed 40 ms after Slow).
  await armed(host, 0);
  slow.press();
  await sleep(40);
  fast.press();
  assert.equal(await winner(host), 'Slow');
  host.send({ type: 'cmd', action: { type: 'correct' } });
  host.send({ type: 'cmd', action: { type: 'next' } });

  // Turned off: whoever arrives first wins, as before.
  host.send({ type: 'cmd', action: { type: 'settings', settings: { fairBuzz: false } } });
  await armed(host, 1);
  slow.press();
  await sleep(40);
  fast.press();
  assert.equal(await winner(host), 'Fast');
  host.send({ type: 'cmd', action: { type: 'correct' } });
  host.send({ type: 'cmd', action: { type: 'next' } });
  host.send({ type: 'cmd', action: { type: 'settings', settings: { fairBuzz: true } } });
  await sleep(1000); // the phones are measured again

  // A phone that claims it pressed an hour ago is told it was too early, and the honest phone wins.
  await armed(host, 2);
  fast.send({ type: 'buzz', at: performance.now() + 5_000_000 - 3_600_000 });
  await sleep(30);
  slow.press();
  assert.equal(await winner(host), 'Slow');
  assert.ok(host.msgs.some((m) => m.type === 'state' && m.view.event?.type === 'early' && m.view.event.teamId === fast.teamId));
  // A phone can't pass its own allowance in either.
  assert.equal(srv.hub.getState().q.buzzes.length, 1);
  host.send({ type: 'cmd', action: { type: 'correct' } });
  host.send({ type: 'cmd', action: { type: 'next' } });

  // A phone that never answers the clock questions counts by arrival: here it is first.
  await armed(host, 3);
  old.press();
  await sleep(30);
  fast.press();
  assert.equal(await winner(host), 'Old');

  for (const c of [host, fast, slow, old]) c.close();
});

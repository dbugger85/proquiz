// ProQuiz server: serves the pages and keeps the phones, the host laptop and the TV in sync.
// Runs with `npm start` (Node) or as a single packaged program (Deno compile), so it only
// uses node:* modules plus `ws`, and finds its files relative to this file.
//
//   PORT=3000 node server.js

import http from 'node:http';
import { spawn } from 'node:child_process';
import os from 'node:os';
import { isIP } from 'node:net';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { FILE_NAME, validateSet } from './lib/validate.js';
import { createStore, apiHandler, SAMPLE_ID } from './store.js';
import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { apply, newGame, hostView, displayView, phoneView, GameError, DEFAULT_SETTINGS, nextTimerAt, MAX_SLACK_MS, MAX_REMOTE_SLACK_MS, COLORS, MAX_TEAMS, MAX_PLAYERS, newColor, resumeFix, reactionFor } from './lib/game.js';
import { createTunnel } from './lib/tunnel.js';
import { createBrand, logoHeaders } from './brand.js';
import { createPictures } from './pictures.js';

const ROOT = new URL('./', import.meta.url);
const START_PORT = Number(process.env.PORT) || 3000;
// Where the autosave (and later the question sets) live: a ProQuiz folder in the user's home folder.
const DATA_DIR = process.env.PROQUIZ_DATA || path.join(os.homedir(), 'ProQuiz');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.woff2': 'font/woff2',
};

// Short addresses for the pages. Everything else is looked up in public/ (or lib/ for shared code).
const PAGES = {
  '/favicon.ico': 'public/icon.svg',
  '/': 'public/index.html',
  '/host': 'public/host.html',
  '/display': 'public/display.html',
  '/editor': 'public/editor.html',
};

// Question pictures and sound clips: the user's own (in the data folder) first, then the ones that come with
// ProQuiz. Supports "Range" requests, which browsers use to jump around in audio.
async function serveUserFile(req, res, name, store) {
  if (!FILE_NAME.test(name)) return send(res, 400, 'Bad file name');
  const body = await store.readUserFile(name);
  if (body) {
    const headers = {
      'Content-Type': TYPES[name.slice(name.lastIndexOf('.')).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'max-age=3600',
      'Accept-Ranges': 'bytes',
    };
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (range && (range[1] || range[2])) {
      let start = range[1] ? Number(range[1]) : body.length - Number(range[2]);
      let end = range[1] && range[2] ? Number(range[2]) : body.length - 1;
      start = Math.max(0, start);
      end = Math.min(end, body.length - 1);
      if (start > end) {
        res.writeHead(416, { 'Content-Range': `bytes */${body.length}` });
        return res.end();
      }
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${body.length}`, 'Content-Length': end - start + 1 });
      return res.end(body.subarray(start, end + 1));
    }
    res.writeHead(200, { ...headers, 'Content-Length': body.length });
    return res.end(body);
  }
  send(res, 404, 'Not found');
}

// The pages that only make sense on the laptop running ProQuiz (the host screen shows the answers).
const LAPTOP_ONLY = new Set(['/host', '/editor']);

// `remote` is true on the listener only the internet tunnel uses: everything there comes from outside,
// even though it arrives from 127.0.0.1 (see openRemote() in startServer()).
async function serveFile(req, res, { store, api, brand, remote = false }) {
  let url, path;
  try {
    url = new URL(req.url, 'http://x');
    path = decodeURIComponent(url.pathname);
  } catch {
    return send(res, 400, 'Bad path');
  }
  if (path.startsWith('/files/')) return serveUserFile(req, res, path.slice('/files/'.length), store);
  // The host's logo (brand.js): for every screen, also over the internet. Changing it is under /api/ (laptop only).
  if (path.startsWith('/brand/')) {
    const name = path.slice('/brand/'.length);
    const body = await brand?.readLogo(name);
    if (!body) return send(res, 404, 'Not found');
    res.writeHead(200, { ...logoHeaders(name), 'Content-Length': body.length });
    return res.end(body);
  }
  if (path.startsWith('/api/')) {
    // The editor's API changes files on this laptop, so only the laptop itself may use it.
    if (remote || !fromLaptop(req, { changes: !['GET', 'HEAD'].includes(req.method) })) return send(res, 403, 'Only on the laptop running ProQuiz');
    return api(req, res, url);
  }
  if (remote && LAPTOP_ONLY.has(path)) return send(res, 403, 'Only on the laptop running ProQuiz');
  let file = PAGES[path];
  if (!file) {
    if (path.includes('..') || path.includes('\0')) return send(res, 400, 'Bad path');
    file = path.startsWith('/lib/') ? path.slice(1) : 'public' + path;
  }
  try {
    const body = await readFile(new URL(file, ROOT));
    const ext = file.slice(file.lastIndexOf('.'));
    res.writeHead(200, { 'Content-Type': TYPES[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(body);
  } catch {
    send(res, 404, 'Not found');
  }
}

function send(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

// The address phones should use: the laptop's Wi-Fi/Ethernet IP, skipping Docker and VPN-ish ones.
export function lanAddresses() {
  const found = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    if (/^(docker|br-|veth|virbr|lo|tun|tap|wg)/.test(name)) continue;
    for (const a of addrs || []) if (a.family === 'IPv4' && !a.internal) found.push(a.address);
  }
  const rank = (ip) => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : ip.startsWith('172.') ? 2 : 3);
  return found.sort((a, b) => rank(a) - rank(b));
}

// Try 3000, then 3001, … if the port is busy.
function listen(server, port, tries = 10) {
  return new Promise((resolve, reject) => {
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE' && tries > 1) resolve(listen(server, port + 1, tries - 1));
      else reject(err);
    });
    server.listen(port, '0.0.0.0', () => resolve(port));
  });
}

// What the host laptop may do, and what a phone may do (always for its own team).
const HOST_ACTIONS = new Set([
  'settings', 'loadSet', 'start', 'setPicker', 'pick', 'arm', 'correct', 'wrong', 'reveal', 'cancel',
  'next', 'end', 'judgeFinal', 'adjust', 'undo', 'restart', 'removeTeam', 'mediaToggle', 'mediaRestart', 'freeze', 'bet',
  'skip', // Quick quiz
]);
const PHONE_ACTIONS = new Set(['buzz', 'wager', 'finalAnswer', 'pick', 'freezePick', 'bet', 'answer']);

// Quick quiz reactions: a phone may send one this often; extra ones are dropped (100 players can't flood the TV).
const REACT_EVERY_MS = 1000;

// Fair buzzing: how the server measures each phone's clock (see clockSample() and pressTime() below).
const CLOCK_EVERY_MS = 5000; // one measurement per phone this often, while the setting is on
const CLOCK_BURST = 5; // measurements right after a phone connects (or the setting is turned on)
const CLOCK_KEEP_MS = 20_000; // older measurements are forgotten
const CLOCK_MAX_RTT_MS = 2000; // a reply slower than this is useless

const isLocal = (addr) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(addr);

// A request from this laptop's own ProQuiz pages, not from another website open in the same browser.
// The address must be a plain IP or "localhost" (so a website can't point its own name at this laptop),
// and the browser's Origin and Sec-Fetch-Site headers, when sent, must say "this same site".
function sameSite(req, { changes = true } = {}) {
  const host = req.headers.host ?? '';
  let name;
  try {
    name = new URL(`http://${host}`).hostname;
  } catch {
    return false;
  }
  if (name !== 'localhost' && !isIP(name.replace(/^\[|\]$/g, ''))) return false;
  const origin = req.headers.origin;
  if (origin !== undefined) {
    try {
      if (new URL(origin).host !== host) return false;
    } catch {
      return false; // "null" (a sandboxed frame or a file) or nonsense
    }
  }
  const site = req.headers['sec-fetch-site'];
  return !changes || site === undefined || site === 'same-origin' || site === 'none';
}
const fromLaptop = (req, opts) => isLocal(req.socket.remoteAddress) && sameSite(req, opts);

// Settings from a save, but only the ones this version knows (so an old save can't break a new game).
function pickSettings(saved) {
  if (!saved) return {};
  const out = {};
  for (const key of Object.keys(DEFAULT_SETTINGS)) if (key in saved) out[key] = saved[key];
  try {
    newGame({ categories: [] }, out);
    return out;
  } catch {
    return {};
  }
}

// What the host sees before deciding to resume: when, who, and how far the game got.
// For a Quick quiz `played`/`total` count questions (a question counts once its result has been shown).
function summary(saved) {
  const st = saved.state;
  const quick = st.mode === 'quick';
  return {
    savedAt: saved.savedAt,
    title: st.set?.title ?? '',
    mode: quick ? 'quick' : 'board',
    teams: st.teams.map((t) => ({ name: t.name, color: newColor(t.color), ...(t.avatar && { avatar: t.avatar }), score: t.score })),
    played: quick ? quickPlayed(st) : st.used?.flat().filter(Boolean).length ?? 0,
    total: quick ? (st.set.sections ?? []).reduce((n, sec) => n + sec.questions.length, 0) : st.used?.flat().length ?? 0,
    phase: st.phase,
    round: st.round ?? 1,
  };
}

function quickPlayed(st) {
  const sections = st.set.sections ?? [];
  if (st.phase === 'over') return sections.reduce((n, sec) => n + sec.questions.length, 0);
  if (!st.pos) return 0;
  const before = sections.slice(0, st.pos.s).reduce((n, sec) => n + sec.questions.length, 0) + st.pos.i;
  return before + (['result', 'ranks'].includes(st.phase) ? 1 : 0);
}

// Writes the game to <dir>/autosave.json shortly after each change (at most a few times a second).
function autosaver(dir) {
  const file = path.join(dir, 'autosave.json');
  let pending = null;
  let writing = Promise.resolve();
  return {
    file,
    save(state) {
      pending = state;
      setTimeout(() => {
        if (!pending) return;
        const { history, ...toSave } = pending;
        pending = null;
        writing = writing
          .then(async () => {
            await mkdir(dir, { recursive: true });
            await writeFile(file + '.tmp', JSON.stringify({ v: 1, savedAt: Date.now(), state: { ...toSave, history: [] } }));
            await rename(file + '.tmp', file);
          })
          .catch((err) => console.error('Could not save the game:', err.message));
      }, 250);
    },
    async load() {
      try {
        const data = JSON.parse(await readFile(file, 'utf8'));
        return data?.v === 1 && Array.isArray(data.state?.teams) && data.state.set ? data : null;
      } catch {
        return null;
      }
    },
    flush: () => writing,
  };
}

// Players elsewhere: wrong PINs allowed per minute (for all remote phones together), so nobody can try them all.
const PIN_TRIES_PER_MINUTE = 10;

// Holds the one game and everyone connected to it. `tunnel` (lib/tunnel.js) is the internet tunnel, if any.
export function createHub({ set, info, saved = null, save = () => {}, store = null, tunnel = null, brand = null }) {
  // A new game keeps the settings and the quiz from last time. A saved game with teams can be resumed from the lobby.
  const lastSet = saved?.state?.set && validateSet(saved.state.set).length === 0 ? saved.state : null;
  let state = newGame(lastSet ? lastSet.set : set, pickSettings(saved?.state?.settings), lastSet ? lastSet.setId : SAMPLE_ID);
  let resumable = saved?.state?.teams?.length ? saved : null;
  const clients = new Set(); // { ws, role: 'host' | 'display' | 'phone', local, remote, teamId, askedTeamId, alive, pings, samples }
  let pinMisses = []; // times of wrong PINs (players elsewhere)
  let timer = null;
  let pingId = 0;

  const send = (ws, msg) => ws.readyState === 1 && ws.send(JSON.stringify(msg));
  // Phone clocks are measured for fair buzzing, and always in a Quick quiz (faster answers score more).
  const fairOn = (st = state) => Boolean(st.settings.fairBuzz || st.mode === 'quick');

  function connectedTeams() {
    const ids = new Set();
    for (const c of clients) if (c.role === 'phone' && c.teamId) ids.add(c.teamId);
    return [...ids];
  }

  // ----- fair buzzing: measuring each phone's clock -----
  // The server asks "what does your stopwatch say?" and times the answer. Half the round trip after asking is
  // roughly when the phone answered, which gives the gap between the phone's stopwatch and the server's clock.
  // The quickest answer of the last few is the most trustworthy one.

  function ping(c) {
    if (c.ws.readyState !== 1) return;
    const now = Date.now();
    for (const [id, sent] of c.pings) if (now - sent > CLOCK_MAX_RTT_MS) c.pings.delete(id);
    pingId += 1;
    c.pings.set(pingId, now);
    send(c.ws, { type: 'clock', id: pingId });
  }

  function burst(c) {
    for (let k = 0; k < CLOCK_BURST; k++) setTimeout(() => clients.has(c) && ping(c), k * 150);
    setTimeout(sendLatency, CLOCK_BURST * 150 + 400);
  }

  const phones = () => [...clients].filter((c) => c.role === 'phone');

  function clockSample(c, { id, t }) {
    const sent = c.pings.get(id);
    if (sent === undefined || !Number.isFinite(t)) return;
    c.pings.delete(id);
    const now = Date.now();
    const rtt = now - sent;
    if (rtt > CLOCK_MAX_RTT_MS) return;
    c.samples = [...c.samples.filter((x) => now - x.at < CLOCK_KEEP_MS), { offset: t - (sent + rtt / 2), rtt, at: now }].slice(-8);
  }

  function bestSample(c) {
    const now = Date.now();
    const fresh = c.samples.filter((x) => now - x.at < CLOCK_KEEP_MS);
    return fresh.length ? fresh.reduce((a, b) => (b.rtt < a.rtt ? b : a)) : null;
  }

  // A phone over the internet may be a lot slower than one on the Wi-Fi, so its cap is higher.
  const slackCap = (c) => (c.remote ? MAX_REMOTE_SLACK_MS : MAX_SLACK_MS);

  // A buzz's press time on the server clock, and how much earlier than its arrival it may count
  // (the rules check both). A phone that hasn't been measured counts by arrival. `lead` is half the round trip,
  // roughly how long a message from the server takes to reach the phone (used for Quick quiz answers).
  function pressTime(c, at) {
    const best = bestSample(c);
    if (!Number.isFinite(at) || !best) return {};
    const slack = Math.min(Math.ceil(best.rtt) + 5, slackCap(c));
    return { at: at - best.offset, slack, lead: Math.min(Math.round(best.rtt / 2), slackCap(c) / 2) };
  }

  // Fair buzzing: after the first buzz, how long to wait for the others. A slow phone (one elsewhere) can
  // need longer than the usual short wait for its press to arrive.
  function buzzWait(except) {
    let wait = 0;
    for (const c of phones()) {
      const best = c !== except && c.teamId && bestSample(c);
      if (best) wait = Math.max(wait, Math.min(Math.ceil(best.rtt) + 5, slackCap(c)));
    }
    return wait;
  }

  // Quick quiz: when time runs out, answers from phones elsewhere may still be on their way.
  function answerGrace() {
    let grace = 0;
    for (const c of phones()) {
      const best = c.remote && c.teamId && bestSample(c);
      if (best) grace = Math.max(grace, Math.min(Math.ceil(best.rtt / 2) + 20, slackCap(c) / 2));
    }
    return grace;
  }

  // The host lobby shows each phone's measured delay (round trip, ms) while the setting is on.
  function latency() {
    const out = {};
    for (const c of phones()) {
      const best = c.teamId && bestSample(c);
      if (best) out[c.teamId] = Math.round(best.rtt);
    }
    return out;
  }

  function sendLatency() {
    if (!fairOn()) return;
    for (const c of clients) if (c.role === 'host') send(c.ws, { type: 'latency', latency: latency() });
  }

  function viewFor(c) {
    if (c.role === 'host') return hostView(state);
    if (c.role === 'display') {
      const view = displayView(state);
      // The TV page opened over the internet must not show the PIN (whoever has the address could read it).
      return c.remote ? { ...view, settings: { ...view.settings, remotePin: '' } } : view;
    }
    return phoneView(state, c.teamId);
  }

  // Players elsewhere: what the screens need to know about the internet tunnel.
  function remoteFor(c) {
    const st = tunnel?.status() ?? { status: 'off', url: null };
    if (c.role === 'host') return { ...st, remoteTeams: phones().filter((p) => p.remote && p.teamId).map((p) => p.teamId) };
    // The TV: how far along it is (so it can say "getting the internet address ready"), and the address once it's on.
    if (c.role === 'display') return { status: st.status, url: st.status === 'on' ? st.url : null };
    return null;
  }

  function broadcast() {
    const connected = connectedTeams();
    // `displays` counts every TV screen in the room (the host plays the sounds when there is none); `tvs` leaves out
    // the one shown inside the host page when there is no separate TV screen (single-screen mode). A TV page opened
    // over the internet (by a player elsewhere) counts in neither.
    const displays = [...clients].filter((c) => c.role === 'display' && !c.remote).length;
    const tvs = [...clients].filter((c) => c.role === 'display' && !c.embedded && !c.remote).length;
    const serverNow = Date.now();
    const resume = resumable && summary(resumable);
    const brandView = brand?.view() ?? null; // the host's logo, event name and accent colour (the same for everyone)
    for (const c of clients) {
      if (!c.role) continue;
      const msg = { type: 'state', view: viewFor(c), connected, displays, tvs, serverNow, brand: brandView };
      if (c.role === 'host' && resume) msg.resume = resume;
      if (c.role === 'host' && fairOn()) msg.latency = latency();
      if (c.role !== 'phone') msg.remote = remoteFor(c);
      // A phone joining over the internet types the PIN when the host has set one.
      if (c.role === 'phone' && c.remote && state.settings.remotePin && !c.teamId) msg.needPin = true;
      send(c.ws, msg);
    }
  }

  // Something that isn't part of the game (a sound, a player's reaction): goes to the TV screens (the one inside
  // the host page too), or to the host laptop if no TV is open in the room. TV pages opened elsewhere always get it.
  function toRoom(msg) {
    const tvs = [...clients].filter((c) => c.role === 'display' && !c.remote);
    const targets = tvs.length ? tvs : [...clients].filter((c) => c.role === 'host');
    targets.push(...[...clients].filter((c) => c.role === 'display' && c.remote));
    for (const c of targets) send(c.ws, msg);
  }
  const soundToRoom = (sound) => toRoom({ type: 'sound', ...sound });

  // Players elsewhere: wrong PINs, at most PIN_TRIES_PER_MINUTE a minute for everyone together.
  function checkPin(c, pin) {
    const want = state.settings.remotePin;
    if (!c.remote || !want || c.teamId) return;
    const now = Date.now();
    pinMisses = pinMisses.filter((at) => now - at < 60_000);
    if (pinMisses.length >= PIN_TRIES_PER_MINUTE) throw new GameError('pin-wait');
    if (String(pin ?? '').trim() !== want) {
      pinMisses.push(now);
      throw new GameError('bad-pin');
    }
  }

  // The host picks which quiz to play (lobby only). Quizzes with problems can't be played.
  async function chooseSet(c, id) {
    const found = await store.get(String(id));
    if (!found) return send(c.ws, { type: 'error', code: 'set-missing' });
    if (validateSet(found.set).length) return send(c.ws, { type: 'error', code: 'set-has-problems' });
    dispatch({ type: 'loadSet', set: found.set, setId: String(id) });
  }

  // When the quiz on show in the lobby is edited, the lobby gets the new version.
  function setSaved(id, set, problems) {
    if (state.phase === 'lobby' && state.setId === id && problems.length === 0) dispatch({ type: 'loadSet', set, setId: id });
    broadcast(); // the host's list of quizzes may have changed
  }

  // Back to the main menu in the middle of a game, just as if ProQuiz had been closed and started again:
  // the game is kept as the one to continue, and the lobby starts empty with the same quiz and settings.
  function mainMenu() {
    if (state.phase === 'lobby') return;
    resumable = { v: 1, savedAt: Date.now(), state: { ...state, history: [] } };
    state = newGame(state.set, state.settings, state.setId);
    for (const c of clients) {
      if (c.role !== 'phone') continue;
      c.askedTeamId = c.teamId ?? c.askedTeamId; // so "Continue" puts the phone back in its team
      c.teamId = null;
      send(c.ws, { type: 'welcome', teamId: null });
    }
    schedule();
    broadcast(); // not saved: the file keeps the game until something new happens in the lobby
  }

  // Continue the saved game. Phones that are already back get their team again.
  function resume() {
    if (!resumable) return;
    const lobbyTeams = state.teams;
    const { joinMode, remotePin } = state.settings; // how players join is chosen in the lobby, not saved with the game
    state = { round: 1, ...resumable.state, deadline: null }; // games saved before round 2 existed are in round 1
    state.settings = { ...state.settings, joinMode, remotePin };
    state.teams = state.teams.map((t) => ({ ...t, color: newColor(t.color) })); // saved with the colours before 1.7
    // Teams that joined in the lobby meanwhile play on with zero points (a free colour if theirs is taken;
    // in a Quick quiz colours may repeat).
    const quick = state.mode === 'quick';
    for (const t of lobbyTeams) {
      if (state.teams.length >= (quick ? MAX_PLAYERS : MAX_TEAMS)) break;
      if (state.teams.some((o) => o.id === t.id || o.name.toLowerCase() === t.name.toLowerCase())) continue;
      const taken = !quick && state.teams.some((o) => o.color === t.color);
      const color = taken ? COLORS.find((col) => !state.teams.some((o) => o.color === col)) : t.color;
      state.teams = [...state.teams, { ...t, color, score: 0 }];
      if (state.final) state.final = { ...state.final, base: { ...state.final.base, [t.id]: 0 } };
    }
    const playing = new Set(state.teams.map((t) => t.id));
    for (const c of clients) if (c.role === 'phone' && c.teamId && !playing.has(c.teamId)) c.teamId = null;
    // A picture that was appearing carries on from where it was, not from the old clock.
    if (state.q?.unveil?.since != null) state.q = { ...state.q, unveil: { ...state.q.unveil, since: Date.now() } };
    state = resumeFix(state, Date.now()); // Quick quiz: a question that was showing starts again
    resumable = null;
    for (const c of clients) {
      if (c.role === 'phone' && c.askedTeamId && state.teams.some((t) => t.id === c.askedTeamId)) {
        c.teamId = c.askedTeamId;
        send(c.ws, { type: 'welcome', teamId: c.teamId });
      }
    }
    schedule();
    save(state);
    broadcast();
  }

  // How players join (setting `joinMode`): the internet tunnel runs while it says 'internet'. Choosing it starts
  // the tunnel and choosing Wi-Fi stops it. A saved 'internet' never starts a tunnel by itself when ProQuiz starts:
  // only when the host page opens the lobby (`hostHello`), and not again after it failed (the host retries).
  function syncTunnel({ hostHello = false } = {}) {
    if (!tunnel) return;
    const st = tunnel.status().status;
    if (state.settings.joinMode !== 'internet') {
      if (st !== 'off') tunnel.stop().catch(() => {});
    } else if (!hostHello || (st === 'off' && state.phase === 'lobby')) {
      tunnel.start().catch(() => {});
    }
  }

  // Runs one action through the rules; everyone gets the new state if something changed.
  function dispatch(action) {
    const before = state;
    state = apply(state, { ...action, now: Date.now() });
    if (state.settings.joinMode !== before.settings.joinMode) syncTunnel();
    // Fair buzzing was just turned on (or a Quick quiz chosen): measure every phone now rather than in a few seconds.
    if (fairOn() && !fairOn(before)) phones().forEach(burst);
    schedule();
    if (state !== before) {
      save(state);
      broadcast();
    }
  }

  // One timer for whatever deadline the game has right now.
  function schedule() {
    clearTimeout(timer);
    timer = null;
    let at = nextTimerAt(state); // the end of a fair-buzz wait, or the running timer
    if (at != null && state.mode === 'quick' && state.phase === 'open') at += answerGrace();
    if (at != null) {
      timer = setTimeout(() => dispatch({ type: 'timeout' }), Math.max(0, at - Date.now()) + 5);
    }
  }

  function handle(c, msg) {
    if (msg.type === 'hello') {
      // Over the internet nobody is the host (the host screen shows the answers).
      if (msg.role === 'host' && !c.local) return send(c.ws, { type: 'error', code: 'host-only-on-laptop' });
      if (!['host', 'display', 'phone'].includes(msg.role)) return;
      c.role = msg.role;
      c.embedded = c.role === 'display' && msg.embedded === true;
      if (c.role === 'phone') {
        c.askedTeamId = typeof msg.teamId === 'string' ? msg.teamId : null;
        const known = state.teams.some((t) => t.id === msg.teamId);
        c.teamId = known ? msg.teamId : null;
        send(c.ws, { type: 'welcome', teamId: c.teamId });
        c.samples = []; // a new connection, maybe a reloaded page: measure the clock again
        if (fairOn()) burst(c);
      } else {
        send(c.ws, { type: 'welcome', info });
        if (c.role === 'host') syncTunnel({ hostHello: true });
      }
      return broadcast();
    }
    if (c.role === 'phone' && msg.type === 'join') {
      checkPin(c, msg.pin);
      // Keep the phone's saved id if it has one, so it stays the same team after a server restart.
      const saved = typeof msg.teamId === 'string' && /^[\w-]{8,40}$/.test(msg.teamId) ? msg.teamId : null;
      const teamId = c.teamId || saved || randomUUID();
      const previous = c.teamId;
      c.teamId = teamId; // before dispatch, so the new team is never shown as offline
      try {
        dispatch({ type: 'join', teamId, name: msg.name, color: msg.color, avatar: msg.avatar });
      } catch (err) {
        c.teamId = previous;
        throw err;
      }
      send(c.ws, { type: 'joined', teamId });
    }
    // In the lobby a buzz just plays that team's tone, so everyone can hear what theirs sounds like.
    if (c.role === 'phone' && msg.type === 'buzz' && c.teamId && state.phase === 'lobby') {
      return soundToRoom({ name: 'buzz', teamId: c.teamId });
    }
    if (c.role === 'host' && msg.type === 'testSound') return soundToRoom({ name: 'fanfare' });
    if (c.role === 'host' && msg.type === 'chooseSet' && store) return chooseSet(c, msg.id);
    if (c.role === 'phone' && msg.type === 'clock') return clockSample(c, msg);
    if (c.role === 'phone' && msg.type === 'resync') {
      c.samples = [];
      if (fairOn()) burst(c);
      return;
    }
    if (c.role === 'phone' && msg.type === 'buzz' && c.teamId) {
      // Only the server's own measurement decides how early a press may count, never the phone.
      const { at, slack } = pressTime(c, msg.at);
      return dispatch({ type: 'buzz', teamId: c.teamId, at, slack, wait: buzzWait(c) });
    }
    // Quick quiz: a player's emoji reaction after a question (`emoji` is an index into REACTIONS). Not a game
    // action: the rules (reactionFor) say whether it is allowed right now, and it only goes to the TV.
    if (c.role === 'phone' && msg.type === 'react') {
      const now = Date.now();
      if (!c.teamId || now - (c.reactedAt ?? 0) < REACT_EVERY_MS) return;
      const reaction = reactionFor(state, c.teamId, msg.emoji);
      if (!reaction) return;
      c.reactedAt = now;
      return toRoom({ type: 'reaction', ...reaction });
    }
    if (c.role === 'phone' && msg.type === 'answer' && c.teamId) {
      // Quick quiz: the press time counts like a buzz's (faster answers score more).
      // `option`, `options` or `order` by the question's kind; the rules check the shape.
      return dispatch({ type: 'answer', teamId: c.teamId, option: msg.option, options: msg.options, order: msg.order, ...pressTime(c, msg.at) });
    }
    if (c.role === 'phone' && PHONE_ACTIONS.has(msg.type) && c.teamId) {
      return dispatch({ ...msg, teamId: c.teamId });
    }
    // Players join over the internet (on) or on this Wi-Fi (off). The same as choosing it in the settings, and
    // `on` while it already says internet tries again (after a failure).
    if (c.role === 'host' && msg.type === 'tunnel' && tunnel) {
      const joinMode = msg.on ? 'internet' : 'wifi';
      if (state.settings.joinMode !== joinMode) return dispatch({ type: 'settings', settings: { joinMode } });
      return msg.on ? tunnel.start() : tunnel.stop();
    }
    if (c.role === 'host' && msg.type === 'tunnelDownload' && tunnel) return tunnel.download();
    if (c.role === 'host' && msg.type === 'resume') return resume();
    if (c.role === 'host' && msg.type === 'mainMenu') return mainMenu();
    if (c.role === 'host' && msg.type === 'discardSave') {
      resumable = null;
      return broadcast();
    }
    if (c.role === 'host' && msg.type === 'cmd' && HOST_ACTIONS.has(msg.action?.type)) {
      const action = { ...msg.action };
      if (action.type === 'start') {
        resumable = null; // a new game replaces the one waiting to be continued
        if (!action.picker && state.teams.length) action.picker = state.teams[Math.floor(Math.random() * state.teams.length)].id;
        action.seed = Math.floor(Math.random() * 2 ** 32); // Kaosmodus: where the specials go
        delete action.specials; // only tests place specials by hand
      }
      // Fair buzzing: a fresh measurement of every phone just as the buzzers open.
      if (action.type === 'arm' && state.settings.fairBuzz) phones().forEach(ping);
      // Quick quiz: the same just before a question's answers can appear.
      if (action.type === 'next' && state.mode === 'quick' && ['section', 'ready', 'ranks'].includes(state.phase)) phones().forEach(ping);
      return dispatch(action);
    }
  }

  // `remote`: the connection came through the internet tunnel's own listener (never the host, whatever its address).
  function connect(ws, req, { remote = false } = {}) {
    const c = { ws, role: null, local: !remote && fromLaptop(req, { changes: false }), remote, teamId: null, alive: true, pings: new Map(), samples: [] };
    clients.add(c);
    ws.on('pong', () => (c.alive = true));
    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      try {
        handle(c, msg);
      } catch (err) {
        if (!(err instanceof GameError)) throw err;
        send(ws, { type: 'error', code: err.code });
      }
    });
    ws.on('close', () => {
      clients.delete(c);
      if (c.role === 'phone' || c.role === 'display') broadcast();
    });
  }

  // Phones that vanish without closing (Wi-Fi drop, battery) are noticed within ~20 s.
  const heartbeat = setInterval(() => {
    for (const c of clients) {
      if (!c.alive) c.ws.terminate();
      else {
        c.alive = false;
        c.ws.ping();
      }
    }
  }, 10_000);

  // Fair buzzing: keep every phone's clock measurement fresh.
  const clockTimer = setInterval(() => {
    if (!fairOn()) return;
    phones().forEach(ping);
    sendLatency(); // for the host's lobby
  }, CLOCK_EVERY_MS);

  return {
    connect,
    setSaved,
    broadcast, // the internet tunnel's status changed
    dispatch, // for tests (e.g. placing Kaosmodus specials by hand)
    getState: () => state,
    stop() {
      clearTimeout(timer);
      clearInterval(heartbeat);
      clearInterval(clockTimer);
    },
  };
}

// `tunnelOptions` is for tests (e.g. a pretend DNS check for a pretend cloudflared), and `pictureOptions` too
// (a pretend `fetchImpl` instead of Openverse and Wikimedia Commons, see pictures.js).
export async function startServer({ port = START_PORT, quiet = false, dataDir = DATA_DIR, tunnelOptions = {}, pictureOptions = {} } = {}) {
  const sets = createStore(dataDir);
  const brand = createBrand(dataDir);
  await brand.load();
  const set = (await sets.get(SAMPLE_ID)).set;
  const store = autosaver(dataDir);
  const saved = await store.load();
  let hub = null;
  const getLang = () => hub?.getState().settings.lang ?? 'en';
  // The editor's "Find a free picture": the only thing that goes on the internet, and only from the editor.
  const pictures = createPictures({ store: sets, lang: getLang, ...pictureOptions });
  const api = apiHandler(sets, {
    onSetSaved: (...a) => hub?.setSaved(...a),
    getLang,
    brand,
    pictures,
    onBrand: () => hub?.broadcast(), // every screen shows the new logo, name or colour at once
  });
  const server = http.createServer((req, res) => serveFile(req, res, { store: sets, api, brand }));
  const actual = await listen(server, port);
  // Only after listening: the WebSocket server passes the server's errors on, and "port busy" would crash it.
  const wss = new WebSocketServer({ server, path: '/ws' });
  const ip = lanAddresses()[0];
  const info = {
    port: actual,
    hostUrl: `http://localhost:${actual}/host`,
    displayUrl: `http://localhost:${actual}/display`,
    phoneUrl: ip ? `http://${ip}:${actual}/` : null,
    // The TV page also works on any other device on the same Wi-Fi (an iPad, a smart TV's browser, another computer).
    tvUrl: ip ? `http://${ip}:${actual}/display` : null,
  };
  // Players elsewhere. The tunnel program (cloudflared) runs on this laptop, so everything it passes on would
  // arrive from 127.0.0.1 and look like the laptop itself. So it gets its own listener, on 127.0.0.1 and a free
  // port, where every connection counts as coming from outside: no host screen, no editor, no /api/.
  let remote = null;
  async function openRemote() {
    if (remote) return remote.port;
    const rs = http.createServer((req, res) => serveFile(req, res, { store: sets, api, brand, remote: true }));
    const port = await new Promise((resolve, reject) => {
      rs.once('error', reject);
      rs.listen(0, '127.0.0.1', () => resolve(rs.address().port));
    });
    const rwss = new WebSocketServer({ server: rs, path: '/ws' });
    rwss.on('connection', (ws, req) => hub.connect(ws, req, { remote: true }));
    remote = { server: rs, wss: rwss, port };
    return port;
  }
  async function closeRemote() {
    if (!remote) return;
    const { server: rs, wss: rwss } = remote;
    remote = null;
    for (const ws of rwss.clients) ws.terminate();
    rwss.close();
    await new Promise((r) => {
      rs.close(r);
      rs.closeAllConnections?.();
    });
  }
  const tunnel = createTunnel({ dataDir, open: openRemote, close: closeRemote, onChange: () => hub?.broadcast(), ...tunnelOptions });
  hub = createHub({ set, info, saved, save: store.save, store: sets, tunnel, brand });
  wss.on('connection', (ws, req) => hub.connect(ws, req));
  if (!quiet) {
    console.log('\n  ProQuiz is running!\n');
    console.log(`  Host (this laptop):  ${info.hostUrl}`);
    console.log(`  TV screen:           ${info.displayUrl}`);
    if (info.tvUrl) console.log(`  TV (other device):   ${info.tvUrl}`);
    console.log(`  Phones:              ${info.phoneUrl ?? '(no Wi-Fi network found — connect to Wi-Fi and restart)'}`);
    console.log(`  Game is saved in:    ${store.file}`);
    console.log('\n  Keep this window open while you play. Close it (or press Ctrl+C) to stop.\n');
  }
  const close = () =>
    new Promise(async (resolve) => {
      await new Promise((r) => setTimeout(r, 300)); // let a pending autosave start
      await store.flush();
      await tunnel.stop();
      await closeRemote();
      hub.stop();
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      server.close(resolve);
      server.closeAllConnections?.();
    });
  // openRemote is for tests: the tunnel's listener without the tunnel.
  return { server, info, hub, close, openRemote, tunnel };
}

// Opens a page in the default web browser (so a double-click is all it takes).
function openBrowser(url) {
  const [cmd, args] =
    process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {}
}

// Start only when run directly (not when a test imports this file). Works in Node and Deno.
// PROQUIZ_NO_OPEN=1 stops it opening the browser.
if (import.meta.main) {
  const { info } = await startServer();
  if (!process.env.PROQUIZ_NO_OPEN) openBrowser(info.hostUrl);
}

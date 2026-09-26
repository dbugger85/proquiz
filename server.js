// ProQuiz server: serves the pages and keeps the phones, the host laptop and the TV in sync.
// Runs with `npm start` (Node) or as a single packaged program (Deno compile), so it only
// uses node:* modules plus `ws`, and finds its files relative to this file.
//
//   PORT=3000 node server.js

import http from 'node:http';
import os from 'node:os';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { apply, newGame, hostView, displayView, phoneView, GameError, DEFAULT_SETTINGS } from './lib/game.js';

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
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.woff2': 'font/woff2',
};

// Short addresses for the pages. Everything else is looked up in public/ (or lib/ for shared code).
const PAGES = { '/favicon.ico': 'public/icon.svg', '/': 'public/index.html', '/host': 'public/host.html', '/display': 'public/display.html' };

async function serveFile(req, res) {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
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
  'next', 'end', 'judgeFinal', 'adjust', 'undo', 'restart', 'removeTeam',
]);
const PHONE_ACTIONS = new Set(['buzz', 'wager', 'finalAnswer']);

const isLocal = (addr) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(addr);

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
function summary(saved) {
  const st = saved.state;
  return {
    savedAt: saved.savedAt,
    title: st.set?.title ?? '',
    teams: st.teams.map((t) => ({ name: t.name, color: t.color, score: t.score })),
    played: st.used?.flat().filter(Boolean).length ?? 0,
    total: st.used?.flat().length ?? 0,
    phase: st.phase,
  };
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

// Holds the one game and everyone connected to it.
export function createHub({ set, info, saved = null, save = () => {} }) {
  // A new game keeps the settings from last time. A saved game with teams can be resumed from the lobby.
  let state = newGame(set, pickSettings(saved?.state?.settings));
  let resumable = saved?.state?.teams?.length ? saved : null;
  const clients = new Set(); // { ws, role: 'host' | 'display' | 'phone', local, teamId, askedTeamId, alive }
  let timer = null;

  const send = (ws, msg) => ws.readyState === 1 && ws.send(JSON.stringify(msg));

  function connectedTeams() {
    const ids = new Set();
    for (const c of clients) if (c.role === 'phone' && c.teamId) ids.add(c.teamId);
    return [...ids];
  }

  function viewFor(c) {
    if (c.role === 'host') return hostView(state);
    if (c.role === 'display') return displayView(state);
    return phoneView(state, c.teamId);
  }

  function broadcast() {
    const connected = connectedTeams();
    const displays = [...clients].filter((c) => c.role === 'display').length; // the host plays the sounds when there is no TV screen
    const serverNow = Date.now();
    const resume = resumable && summary(resumable);
    for (const c of clients) {
      if (!c.role) continue;
      const msg = { type: 'state', view: viewFor(c), connected, displays, serverNow };
      if (c.role === 'host' && resume) msg.resume = resume;
      send(c.ws, msg);
    }
  }

  // A sound that isn't part of the game: goes to the TV screens, or to the host laptop if no TV is open.
  function soundToRoom(sound) {
    const tvs = [...clients].filter((c) => c.role === 'display');
    const targets = tvs.length ? tvs : [...clients].filter((c) => c.role === 'host');
    for (const c of targets) send(c.ws, { type: 'sound', ...sound });
  }

  // Continue the saved game. Phones that are already back get their team again.
  function resume() {
    if (!resumable) return;
    state = { ...resumable.state, deadline: null };
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

  // Runs one action through the rules; everyone gets the new state if something changed.
  function dispatch(action) {
    const before = state;
    state = apply(state, { ...action, now: Date.now() });
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
    if (state.deadline !== null) {
      timer = setTimeout(() => dispatch({ type: 'timeout' }), Math.max(0, state.deadline - Date.now()) + 5);
    }
  }

  function handle(c, msg) {
    if (msg.type === 'hello') {
      if (msg.role === 'host' && !c.local) return send(c.ws, { type: 'error', code: 'host-only-on-laptop' });
      if (!['host', 'display', 'phone'].includes(msg.role)) return;
      c.role = msg.role;
      if (c.role === 'phone') {
        c.askedTeamId = typeof msg.teamId === 'string' ? msg.teamId : null;
        const known = state.teams.some((t) => t.id === msg.teamId);
        c.teamId = known ? msg.teamId : null;
        send(c.ws, { type: 'welcome', teamId: c.teamId });
      } else {
        send(c.ws, { type: 'welcome', info });
      }
      return broadcast();
    }
    if (c.role === 'phone' && msg.type === 'join') {
      // Keep the phone's saved id if it has one, so it stays the same team after a server restart.
      const saved = typeof msg.teamId === 'string' && /^[\w-]{8,40}$/.test(msg.teamId) ? msg.teamId : null;
      const teamId = c.teamId || saved || randomUUID();
      const previous = c.teamId;
      c.teamId = teamId; // before dispatch, so the new team is never shown as offline
      try {
        dispatch({ type: 'join', teamId, name: msg.name, color: msg.color });
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
    if (c.role === 'phone' && PHONE_ACTIONS.has(msg.type) && c.teamId) {
      return dispatch({ ...msg, teamId: c.teamId });
    }
    if (c.role === 'host' && msg.type === 'resume') return resume();
    if (c.role === 'host' && msg.type === 'discardSave') {
      resumable = null;
      return broadcast();
    }
    if (c.role === 'host' && msg.type === 'cmd' && HOST_ACTIONS.has(msg.action?.type)) {
      const action = { ...msg.action };
      if (action.type === 'start' && !action.picker && state.teams.length) {
        action.picker = state.teams[Math.floor(Math.random() * state.teams.length)].id;
      }
      return dispatch(action);
    }
  }

  function connect(ws, req) {
    const c = { ws, role: null, local: isLocal(req.socket.remoteAddress), teamId: null, alive: true };
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

  return {
    connect,
    getState: () => state,
    stop() {
      clearTimeout(timer);
      clearInterval(heartbeat);
    },
  };
}

export async function startServer({ port = START_PORT, quiet = false, dataDir = DATA_DIR } = {}) {
  const set = JSON.parse(await readFile(new URL('sets/sample.json', ROOT), 'utf8'));
  const store = autosaver(dataDir);
  const saved = await store.load();
  const server = http.createServer(serveFile);
  const wss = new WebSocketServer({ server, path: '/ws' });
  const actual = await listen(server, port);
  const ip = lanAddresses()[0];
  const info = {
    port: actual,
    hostUrl: `http://localhost:${actual}/host`,
    displayUrl: `http://localhost:${actual}/display`,
    phoneUrl: ip ? `http://${ip}:${actual}/` : null,
  };
  const hub = createHub({ set, info, saved, save: store.save });
  wss.on('connection', (ws, req) => hub.connect(ws, req));
  if (!quiet) {
    console.log('\n  ProQuiz is running!\n');
    console.log(`  Host (this laptop):  ${info.hostUrl}`);
    console.log(`  TV screen:           ${info.displayUrl}`);
    console.log(`  Phones:              ${info.phoneUrl ?? '(no Wi-Fi network found — connect to Wi-Fi and restart)'}`);
    console.log(`  Game is saved in:    ${store.file}`);
    console.log('\n  Press Ctrl+C to stop.\n');
  }
  const close = () =>
    new Promise(async (resolve) => {
      await new Promise((r) => setTimeout(r, 300)); // let a pending autosave start
      await store.flush();
      hub.stop();
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      server.close(resolve);
      server.closeAllConnections?.();
    });
  return { server, info, hub, close };
}

// Start only when run directly (not when a test imports this file). Works in Node and Deno.
if (import.meta.main) await startServer();

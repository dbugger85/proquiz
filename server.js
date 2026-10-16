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
import { FILE_NAME } from './lib/validate.js';
import { createStore, apiHandler, SAMPLE_ID } from './store.js';
import { WebSocketServer } from 'ws';
import { createHub, louderSettings } from './lib/hub.js';
import { TYPES, typeFor, logoHeaders } from './lib/mime.js';
import { createTunnel } from './lib/tunnel.js';
import { createBrand } from './brand.js';
import { createPictures } from './pictures.js';
import { createSongs } from './songs.js';
import { createUpdateCheck, parseVersion } from './lib/update.js';
import { createSelfUpdate, isCompiled, cleanupOld } from './lib/selfupdate.js';

const ROOT = new URL('./', import.meta.url);

// The hub (the game, the protocol, fair buzzing, resume, the PIN) lives in lib/hub.js so the website version can use
// it too; the tests still import `louderSettings` from here.
export { createHub, louderSettings };

// Which ProQuiz this is, from package.json (packed into the program by scripts/build.mjs with `--include package.json`).
// Null if it can't be read: then the lobby shows no version and no new-version check is made.
export async function readVersion() {
  try {
    const { version } = JSON.parse(await readFile(new URL('./package.json', ROOT), 'utf8'));
    return typeof version === 'string' && /^\d+\.\d+\.\d+$/.test(version) ? version : null;
  } catch {
    return null;
  }
}
const START_PORT = Number(process.env.PORT) || 3000;
// Where the autosave (and later the question sets) live: a ProQuiz folder in the user's home folder.
const DATA_DIR = process.env.PROQUIZ_DATA || path.join(os.homedir(), 'ProQuiz');

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
      'Content-Type': typeFor(name),
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

// Test-only: with PROQUIZ_TEST_UPDATE=1, PROQUIZ_UPDATE_API and PROQUIZ_UPDATE_BASE point the new-version check and
// the "Update now" download at a pretend release on this computer (http://127.0.0.1:…). Without that flag the two
// addresses are ignored, so a compiled program can only ever download from ProQuiz's own GitHub release page.
function testUpdateOverrides() {
  if (process.env.PROQUIZ_TEST_UPDATE !== '1') return { check: {}, self: {} };
  const out = { check: {}, self: {} };
  const api = process.env.PROQUIZ_UPDATE_API;
  const base = process.env.PROQUIZ_UPDATE_BASE;
  if (api) out.check.url = api;
  if (base) {
    try {
      out.self = { base, hosts: [new URL(base).hostname] };
    } catch {}
  }
  return out;
}

// `tunnelOptions` is for tests (e.g. a pretend DNS check for a pretend cloudflared), and `pictureOptions` too
// (a pretend `fetchImpl` instead of Openverse and Wikimedia Commons, see pictures.js) and `songOptions` (the same
// for Deezer, see songs.js), as is `updateOptions`
// (a pretend `fetchImpl` and clock instead of GitHub's releases, see lib/update.js) and `selfUpdateOptions`
// (a pretend compiled program, release and restart for "Update now", see lib/selfupdate.js). `onQuit` runs once the
// host's Quit ProQuiz has saved and closed everything: the main program passes `process.exit(0)`; tests pass nothing,
// so the server just closes.
export async function startServer({ port = START_PORT, quiet = false, dataDir = DATA_DIR, tunnelOptions = {}, pictureOptions = {}, songOptions = {}, updateOptions = {}, selfUpdateOptions = {}, onQuit = () => {} } = {}) {
  const version = await readVersion();
  const sets = createStore(dataDir, { version }); // exports say which ProQuiz wrote them
  const brand = createBrand(dataDir);
  await brand.load();
  const overrides = testUpdateOverrides();
  const updates = createUpdateCheck({ version, ...overrides.check, ...updateOptions });
  // "Update now" (the compiled program only): before it restarts, the game is saved and this server lets go of its
  // ports (prepareExit below). When this program was itself just started by an update, the host hears about it.
  let hub = null;
  let close = null;
  const prepareExit = async () => {
    hub?.saveForExit();
    await close?.();
  };
  const selfUpdate = createSelfUpdate({
    version,
    beforeRestart: prepareExit,
    onStatus: () => hub?.sendUpdate(),
    log: (msg) => !quiet && console.log(msg),
    initialError: process.env.PROQUIZ_UPDATE_ERROR === 'restart' ? 'restart' : null,
    ...overrides.self,
    ...selfUpdateOptions,
  });
  const updatedFrom = parseVersion(process.env.PROQUIZ_UPDATED_FROM) ? process.env.PROQUIZ_UPDATED_FROM : null;
  const set = (await sets.get(SAMPLE_ID)).set;
  const store = autosaver(dataDir);
  const saved = await store.load();
  const getLang = () => hub?.getState().settings.lang ?? 'en';
  // The editor's "Find a free picture" and "Find a song clip": the things that go on the internet, only from the editor.
  const pictures = createPictures({ store: sets, lang: getLang, ...pictureOptions });
  const songs = createSongs({ store: sets, ...songOptions });
  const api = apiHandler(sets, {
    onSetSaved: (...a) => hub?.setSaved(...a),
    getLang,
    brand,
    pictures,
    songs,
    onBrand: () => hub?.broadcast(), // every screen shows the new logo, name or colour at once
  });
  const server = http.createServer((req, res) => serveFile(req, res, { store: sets, api, brand }));
  const actual = await listen(server, port);
  // Only after listening: the WebSocket server passes the server's errors on, and "port busy" would crash it.
  const wss = new WebSocketServer({ server, path: '/ws' });
  const ip = lanAddresses()[0];
  const info = {
    port: actual,
    version, // shown small in the host lobby
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
  // The host's welcome also says when this program was just started by "Update now" (the banner says so).
  const hostInfo = updatedFrom ? { updatedFrom } : {};
  // Quit ProQuiz (the host's button): the hub has saved and said goodbye; close the listeners (the tunnel too) and,
  // in the real program, end the process. Under an update's waiter (see lib/selfupdate.js) exit code 0 ends both.
  const quit = () => close().then(() => setTimeout(() => onQuit(0), 300));
  // The hub never reads a request itself: `fromLaptop` tells it which connections may be the host.
  hub = createHub({ set, info, hostInfo, saved, save: store.save, store: sets, tunnel, brand, updates, selfUpdate, onQuit: quit, fromLaptop: (req) => fromLaptop(req, { changes: false }) });
  wss.on('connection', (ws, req) => hub.connect(ws, req));
  if (!quiet) {
    console.log(`\n  ProQuiz${version ? ` ${version}` : ''} is running!${updatedFrom ? ` (updated from ${updatedFrom})` : ''}\n`);
    console.log(`  Host (this laptop):  ${info.hostUrl}`);
    console.log(`  TV screen:           ${info.displayUrl}`);
    if (info.tvUrl) console.log(`  TV (other device):   ${info.tvUrl}`);
    console.log(`  Phones:              ${info.phoneUrl ?? '(no Wi-Fi network found — connect to Wi-Fi and restart)'}`);
    console.log(`  Game is saved in:    ${store.file}`);
    console.log('\n  Keep this window open while you play. Close it (or press Ctrl+C) to stop.\n');
  }
  // Closing twice (a test's cleanup after Quit ProQuiz) waits for the same close.
  let closing = null;
  close = () =>
    (closing ??= new Promise(async (resolve) => {
      await new Promise((r) => setTimeout(r, 300)); // let a pending autosave start (and a goodbye reach the screens)
      await store.flush();
      await tunnel.stop();
      await closeRemote();
      hub.stop();
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      server.close(resolve);
      server.closeAllConnections?.();
    }));
  // openRemote is for tests: the tunnel's listener without the tunnel.
  return { server, info, hub, close, openRemote, tunnel, selfUpdate, store: sets };
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
// PROQUIZ_NO_OPEN=1 stops it opening the browser. `--version` prints the version and ends ("Update now" runs the
// freshly downloaded program with it before putting it in place).
if (import.meta.main) {
  if (process.argv.slice(1).includes('--version')) {
    process.stdout.write(`${(await readVersion()) ?? 'unknown'}\n`, () => process.exit(0));
  } else {
    // Leftovers of an earlier "Update now", but not when this start *is* the update's restart: the old program
    // (ProQuiz.old) must stay until we know the new one runs, so it can be put back if not.
    if (isCompiled() && !process.env.PROQUIZ_UPDATED_FROM && !process.env.PROQUIZ_UPDATE_ERROR) await cleanupOld(process.execPath);
    // The host's Quit ProQuiz button ends the program (code 0, so an update's waiter ends too).
    const { info } = await startServer({ onQuit: (code = 0) => process.exit(code) });
    // Started by "Update now" on the same port as before: the host page that asked for it connects again by itself,
    // so no second browser tab.
    const sameTab = process.env.PROQUIZ_UPDATED_FROM && info.port === Number(process.env.PORT);
    if (!process.env.PROQUIZ_NO_OPEN && !sameTab) openBrowser(info.hostUrl);
  }
}

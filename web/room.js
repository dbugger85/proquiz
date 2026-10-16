// A game room on the website version: one Durable Object per room code, holding one hub (lib/hub.js) in memory.
// Nothing is stored: the room starts as an empty lobby with the sample quiz, the host's browser sends the quiz it
// wants (`cmd loadSet`) and, later, the autosave to continue (`restore`). docs/dev/web-plan.md §1.3–1.4.
//
// Who is the host: the room's code is made from the host's secret key (lib/room.js), so the first host hello whose
// key gives this code claims the room; from then on only that key is the host. A host with another key for the
// same code gets `room-taken` (the host page makes a new key). The room forgets the key when it closes.
//
// Sockets use the hibernation API (ctx.acceptWebSocket + webSocketMessage/webSocketClose), but the hub keeps the
// game in memory and runs timers (the heartbeat, the clock pings), so the room doesn't hibernate while a hub is
// alive. If the object is ever restarted anyway (a deploy, an eviction), the sockets that outlived it are closed
// so every page reconnects and says hello again, and the host gets a fresh lobby, into which the host page sends
// the game back from its autosave (`save` messages from here, `restore` from there, web-plan.md §5). Phones and
// TVs that arrive before the host are told `hostHere: false` and wait on the same connection. A room nobody hosts
// for ROOM_IDLE_MS closes: `bye` with reason `closed`. setWebSocketAutoResponse isn't used: the keep-alive goes the
// other way (the room pings, the page answers), and the pong must reach the hub.
//
// Wrong host keys (hellos and the key-checked routes together) are limited per room (keyBlocked()); the hub itself
// only asks `hostKey(key)`, which is answered from the key this room has claimed.
//
// Pictures and clips (web-plan.md §3): the host's browser uploads the quiz's files into the room (`PUT /files/<name>`
// with the key in `x-proquiz-key`), the room keeps them in memory (`this.files`) and the TV and host pages fetch
// them from `/r/<code>/files/<name>`, with Range for clips. `GET /files` lists what the room has (so the host only
// uploads what is missing) and `DELETE /files/<name>` drops one (the host makes room for another quiz's files).
// Caps: MAX_ROOM_FILE per file, MAX_ROOM_MEDIA for all files together (lib/room.js). The files go when the room
// closes. The host's logo (branding, web-plan.md Phase 6) goes into the same store under its `logo-<hash>.<ext>`
// name, with the laptop's rules (MAX_LOGO, and the bytes must really be that kind of picture); the hub gets the
// rest of the branding as a `brand` message and points every screen at `/r/<code>/files/<logo>`.
//
// The editor's picture search and song search (web-plan.md §4) run here too, under `/r/<code>/api/pictures/…` and
// `/r/<code>/api/songs/…` with the host's key, so the download of a chosen picture gets the Durable Object's CPU
// budget (30 s a request on the free plan) instead of the stateless Worker's 10 ms, which a 15 MB picture could
// pass. `fetch` answers the bytes (`store: null` in pictures.js/songs.js); the browser shrinks and stores them.
// The editor uses the host's own room (the key in `localStorage proquiz.room`, made by the editor itself when the
// host page hasn't yet); a room that only ever searched holds no hub and is evicted as usual once idle.

import { DurableObject } from 'cloudflare:workers';
import { createHub, HOST_KEY_TRIES_PER_MINUTE, HEARTBEAT_MS } from '../lib/hub.js';
import { codeFor, KEY, normalizeCode, MAX_ROOM_FILE, MAX_ROOM_MEDIA } from '../lib/room.js';
import { FILE_NAME } from '../lib/validate.js';
import { typeFor, logoKind } from '../lib/mime.js';
import { LOGO_FILE, MAX_LOGO } from '../lib/brand-core.js';
import { createPictures } from '../pictures.js';
import { createSongs } from '../songs.js';
import { wrap } from './socket.js';
import sample from '../sets/sample.json';
import pkg from '../package.json';

// A forgotten room (no host connected) closes after this long: everyone gets `bye` and the sockets are closed.
export const ROOM_IDLE_MS = 30 * 60 * 1000;
// A room with nobody connected at all and nothing in it (an empty lobby: the host just looked and left) closes
// sooner. Nothing is lost: the host page sends its quiz, files and branding again when it comes back. A hub's
// timers keep the Durable Object awake, which the free plan counts (web-plan.md §9), so this is what a visitor costs.
export const ROOM_EMPTY_IDLE_MS = 5 * 60 * 1000;
// Fair buzzing on the website: a clock measurement per phone this often (5 s on the laptop; owner's decision 7).
export const CLOCK_EVERY_MS = 20_000;
// The keep-alive ping to every page: every answer is an incoming message the free plan counts, so less often than
// the laptop's 10 s (a phone that vanished is noticed within a minute).
export const ROOM_HEARTBEAT_MS = 3 * HEARTBEAT_MS;
// The autosave (web-plan.md §5): the game goes to the host's browser as a `save` message this long after a change
// (the laptop writes its file after the same wait), so a burst of changes is one message.
export const SAVE_AFTER_MS = 250;
// A search's `fetch` body is a few fields ({source, id, lang}); anything bigger is refused unread.
const MAX_SEARCH_BODY = 4096;

// A request refused before its body was read: read the body and throw it away first (cancelling isn't enough), or
// workerd drops the connection ("can't read from request stream after response has been sent") and the page's
// next request on it fails. Chunk by chunk, so a big body costs no memory.
export async function drain(req) {
  try {
    const reader = req.body?.getReader();
    if (!reader) return;
    while (!(await reader.read()).done);
  } catch {
    // nothing to drain
  }
}

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff', ...headers } });
// A key-checked request that isn't the host's: a wrong key, or no key accepted for a minute after too many wrong ones.
const keyRefused = (verdict) => (verdict === 'wait' ? json({ error: 'key-wait' }, 429, { 'Retry-After': '60' }) : json({ error: 'bad-host-key' }, 403));

// Where the picture and song search go on the internet: the real sites, or (only when the `UPSTREAM` variable
// points at this machine, as the tests do with a pretend Openverse, Wikimedia and Deezer) a local server that gets
// the real address as `?u=`. pictures.js and songs.js still check every address as the real one, so the rules are
// tested as they are; a deployed Worker never has the variable (it isn't in wrangler.toml).
export function upstreamFetch(env) {
  const base = String(env?.UPSTREAM ?? '');
  if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(base)) return globalThis.fetch.bind(globalThis);
  return (url, opts) => fetch(`${base}/?u=${encodeURIComponent(String(url))}`, opts);
}

// Headers for a picture or clip from the room: the type by its extension, never sniffed, and (should one be
// opened as a page) nothing it may run or load, like the laptop's logo (lib/mime.js).
const fileHeaders = (name, size) => ({
  'Content-Type': typeFor(name),
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox",
  'Cache-Control': 'private, max-age=3600',
  'Accept-Ranges': 'bytes',
  'Content-Length': String(size),
});

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.hub = null;
    this.key = null; // the host's key, once the first host has claimed the room
    this.code = null;
    this.origin = null; // https://<site>, from the first request
    this.sockets = new Map(); // WebSocket → adapter (web/socket.js)
    this.idle = null;
    this.idleSince = null; // when the last host connection went (the idle timer counts from here)
    this.idleMs = Number(env.ROOM_IDLE_MS) || ROOM_IDLE_MS; // tests pass a short one
    this.files = new Map(); // name → {bytes: Uint8Array, type}: the quiz's pictures and clips, from the host's browser
    this.fileBytes = 0; // the size of all of them together
    this.maxMedia = Number(env.ROOM_MEDIA_BYTES) || MAX_ROOM_MEDIA; // tests pass a small cap
    this.upstream = upstreamFetch(env);
    this.pictures = null; // the search services, made on first use
    this.songs = null;
    this.keyMisses = []; // when wrong host keys came (hellos and the key-checked routes together, web-plan.md §6)
    this.saveTimer = null; // the autosave on its way to the host's browser
    this.pendingSave = null;
    // Sockets from before a restart of this object: the game they were in is gone, so they reconnect and start over.
    for (const ws of ctx.getWebSockets()) {
      try {
        ws.close(1012, 'room restarted');
      } catch {
        // already gone
      }
    }
  }

  // The hub, made on the first request (it needs the site's address for the welcome's info).
  room() {
    if (this.hub) return this.hub;
    const info = {
      version: pkg.version,
      hosted: true,
      code: this.code,
      phoneUrl: `${this.origin}/r/${this.code}`,
      tvUrl: `${this.origin}/r/${this.code}/display`,
    };
    this.hub = createHub({
      set: sample,
      info,
      hosted: true,
      hostKey: (key) => key === this.key, // claimKey() ran before the hub sees a host hello, so the room already knows
      clockEveryMs: CLOCK_EVERY_MS,
      heartbeatMs: ROOM_HEARTBEAT_MS,
      save: (state) => this.autosave(state),
      logoUrl: (name) => `/r/${this.code}/files/${name}`, // the host's logo, from this room's file store
    });
    this.watchIdle();
    return this.hub;
  }

  // ----- the autosave: the game goes to the host's browser (web-plan.md §5) -----

  // The hub saves after every change; the latest state goes to every host connection as one `save` message, shaped
  // like the laptop's autosave.json ({v: 1, savedAt, state} without the undo history), SAVE_AFTER_MS after the
  // first change of a burst. The host page keeps it in IndexedDB and sends it back with `restore` when the room
  // comes up fresh (a deploy, an eviction, or a new room days later).
  autosave(state) {
    this.pendingSave = state;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      const st = this.pendingSave;
      this.pendingSave = null;
      if (!st) return;
      const text = JSON.stringify({ type: 'save', saved: { v: 1, savedAt: Date.now(), state: { ...st, history: [] } } });
      for (const a of this.sockets.values()) if (a.role === 'host') a.send(text);
    }, SAVE_AFTER_MS);
  }

  // ----- wrong host keys: a limit per room (web-plan.md §6) -----

  // Too many wrong keys in the last minute (from hellos or the key-checked routes): for a minute, a key that isn't
  // the room's own is refused without being looked at (no hash computed). The right key always works, so a player
  // who knows the code can't keep the host out by sending wrong keys.
  keyBlocked() {
    const now = Date.now();
    this.keyMisses = this.keyMisses.filter((at) => now - at < 60_000);
    return this.keyMisses.length >= HOST_KEY_TRIES_PER_MINUTE;
  }

  keyMissed() {
    this.keyMisses.push(Date.now());
    return false;
  }

  async fetch(req) {
    const url = new URL(req.url);
    const code = normalizeCode(req.headers.get('x-proquiz-room') ?? '');
    if (!code) return new Response('no room', { status: 400 });
    this.code ??= code;
    this.origin ??= url.origin;
    if (url.pathname.endsWith('/ws')) {
      if (req.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('expected a WebSocket', { status: 426 });
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      const adapter = wrap(server, {
        onClosed: () => {
          this.sockets.delete(server);
          this.watchIdle(); // the host left, or the room is empty now
        },
      });
      this.sockets.set(server, adapter);
      this.room().connect(adapter, null, { remote: false, local: false });
      return new Response(null, { status: 101, webSocket: client });
    }
    const f = /\/files(?:\/([^/]+))?$/.exec(url.pathname);
    if (f) {
      let name = null;
      if (f[1] !== undefined) {
        try {
          name = decodeURIComponent(f[1]);
        } catch {
          name = '';
        }
        if (!FILE_NAME.test(name)) return json({ error: 'bad-name' }, 404);
      }
      if (name && req.method === 'GET') return this.serveFile(name, req.headers.get('Range'));
      const verdict = await this.hostRequest(req);
      if (verdict !== true) {
        await drain(req);
        return keyRefused(verdict);
      }
      if (!name && req.method === 'GET') return this.listFiles();
      if (name && req.method === 'PUT') return this.putFile(name, req);
      if (name && req.method === 'DELETE') return this.dropFile(name);
      return json({ error: 'not-allowed' }, 405);
    }
    const s = /\/api\/(pictures|songs)\/(search|fetch)$/.exec(url.pathname);
    if (s) return this.searchRequest(req, s[1], s[2]);
    return new Response('not found', { status: 404 });
  }

  // ----- the editor's picture and song search -----

  // The same routes as the laptop's /api/pictures/* and /api/songs/* (store.js), with the same rule that only the
  // editor itself may use them (`Sec-Fetch-Site` same-origin: a search costs the site's share of the upstream
  // limits), plus the host's key. A search answers JSON; a fetch answers the picture's or clip's bytes with the
  // name the browser should store them under and the credit (JSON, URL-encoded) in headers.
  async searchRequest(req, what, action) {
    const site = req.headers.get('sec-fetch-site');
    if (site && !['same-origin', 'none'].includes(site)) {
      await drain(req);
      return json({ error: 'forbidden' }, 403);
    }
    const verdict = await this.hostRequest(req);
    if (verdict !== true) {
      await drain(req);
      return keyRefused(verdict);
    }
    if (Number(req.headers.get('Content-Length')) > MAX_SEARCH_BODY) {
      await drain(req);
      return json({ error: 'too-big' }, 413);
    }
    const pictures = what === 'pictures';
    const service = pictures ? (this.pictures ??= createPictures({ store: null, fetchImpl: this.upstream })) : (this.songs ??= createSongs({ store: null, fetchImpl: this.upstream }));
    try {
      if (action === 'search' && req.method === 'GET') {
        const p = new URL(req.url).searchParams;
        const q = { q: p.get('q'), page: p.get('page') };
        return json(await service.search(pictures ? { ...q, source: p.get('source'), license: p.get('license'), lang: p.get('lang') } : q), 200, { 'Cache-Control': 'no-store' });
      }
      if (action === 'fetch' && req.method === 'POST') {
        let body = null;
        try {
          body = await req.json();
        } catch {
          body = {};
        }
        const { bytes, kind, credit } = await service.fetch(body ?? {});
        const name = pictures ? `picture.${kind}` : 'song.mp3';
        return new Response(bytes, {
          status: 201,
          headers: {
            'Content-Type': typeFor(name),
            'Content-Length': String(bytes.length),
            'X-Content-Type-Options': 'nosniff',
            'Content-Security-Policy': "default-src 'none'; sandbox",
            'Cache-Control': 'no-store',
            'x-proquiz-name': name,
            'x-proquiz-credit': encodeURIComponent(JSON.stringify(credit)),
          },
        });
      }
      await drain(req);
      return json({ error: 'not-allowed' }, 405);
    } catch (err) {
      if (err?.status) return json({ error: err.code, ...(err.retryAfter && { retryAfter: err.retryAfter }) }, err.status);
      console.error(err);
      return json({ error: pictures ? 'picture-failed' : 'song-failed' }, 502);
    }
  }

  // ----- the quiz's pictures and clips -----

  // Only the host (its key in `x-proquiz-key`) may list, upload or drop files, or search. The key claims the room
  // like a host hello does, so uploads work right after a restart too. true = the host; 'wait' = too many wrong
  // keys lately (429 `key-wait`); false = not this room's key (403 `bad-host-key`, counted).
  async hostRequest(req) {
    const claim = await this.claimKey(req.headers.get('x-proquiz-key') ?? '');
    return claim === true || claim === 'wait' ? claim : false;
  }

  listFiles() {
    return json({ files: [...this.files].map(([name, f]) => ({ name, size: f.bytes.length })), bytes: this.fileBytes, maxFile: MAX_ROOM_FILE, maxTotal: this.maxMedia });
  }

  // 201 with the file kept, 200 when the room already has that name (uploads are named by their content, so the
  // same name is the same file), 413 `media-too-big` (one file over MAX_ROOM_FILE) or `media-full` (the room's
  // files together would pass the cap). The host's logo (a `logo-…` name) has the laptop's own rules instead:
  // 413 `logo-too-big` over MAX_LOGO, 400 `logo-bad-type` when the bytes aren't the picture kind the name says.
  async putFile(name, req) {
    const have = this.files.get(name);
    const logo = LOGO_FILE.test(name);
    const maxFile = logo ? MAX_LOGO : MAX_ROOM_FILE;
    const tooBig = () => (logo ? json({ error: 'logo-too-big', max: MAX_LOGO }, 413) : json({ error: 'media-too-big', max: MAX_ROOM_FILE }, 413));
    const said = Number(req.headers.get('Content-Length'));
    const early = have ? json({ name, size: have.bytes.length }, 200) : said > maxFile ? tooBig() : said > 0 && this.fileBytes + said > this.maxMedia ? json({ error: 'media-full', max: this.maxMedia }, 413) : null;
    if (early) {
      await drain(req);
      return early;
    }
    const bytes = new Uint8Array(await req.arrayBuffer());
    if (bytes.length > maxFile) return tooBig();
    if (this.fileBytes + bytes.length > this.maxMedia) return json({ error: 'media-full', max: this.maxMedia }, 413);
    if (logo && logoKind(bytes) !== name.slice(name.lastIndexOf('.') + 1)) return json({ error: 'logo-bad-type' }, 400);
    this.files.set(name, { bytes, type: typeFor(name) });
    this.fileBytes += bytes.length;
    return json({ name, size: bytes.length }, 201);
  }

  dropFile(name) {
    const f = this.files.get(name);
    if (f) {
      this.files.delete(name);
      this.fileBytes -= f.bytes.length;
    }
    return new Response(null, { status: 204 });
  }

  // A picture or clip from memory, whole or by Range (a clip's `<audio>` asks for pieces); 404 when the room
  // doesn't have it (the Worker then tries the built-in files).
  serveFile(name, range) {
    const f = this.files.get(name);
    if (!f) return json({ error: 'not-found' }, 404);
    const body = f.bytes;
    const m = /^bytes=(\d*)-(\d*)$/.exec(range ?? '');
    if (m && (m[1] || m[2])) {
      let start = m[1] ? Number(m[1]) : body.length - Number(m[2]);
      let end = m[1] && m[2] ? Number(m[2]) : body.length - 1;
      start = Math.max(0, start);
      end = Math.min(end, body.length - 1);
      if (start > end) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${body.length}` } });
      return new Response(body.subarray(start, end + 1), { status: 206, headers: { ...fileHeaders(name, end - start + 1), 'Content-Range': `bytes ${start}-${end}/${body.length}` } });
    }
    return new Response(body, { status: 200, headers: fileHeaders(name, body.length) });
  }

  // A message from a page. Messages from one socket are handled one after the other (claiming the key waits on a
  // hash), so a host's first command can't overtake its hello.
  async webSocketMessage(ws, message) {
    const a = this.sockets.get(ws);
    if (!a) {
      try {
        ws.close(1012, 'room restarted');
      } catch {
        // already gone
      }
      return;
    }
    a.queue = (a.queue ?? Promise.resolve()).then(() => this.deliver(a, message)).catch(() => {});
    await a.queue;
  }

  async deliver(a, message) {
    if (a.readyState !== 1) return;
    let msg = null;
    if (typeof message === 'string' && message.length < 4096 && message.includes('"hello"')) {
      try {
        msg = JSON.parse(message);
      } catch {
        msg = null;
      }
    }
    if (msg?.type === 'hello') {
      a.helloRole = ['host', 'display', 'phone'].includes(msg.role) ? msg.role : null;
      if (msg.role === 'host') {
        const claim = await this.claimKey(msg.key);
        if (claim === 'taken') {
          a.helloRole = null;
          return a.send(JSON.stringify({ type: 'error', code: 'room-taken' }));
        }
        // A key for another code: the hub refuses it (`bad-host-key`) and counts the miss.
      }
    }
    a.receive(message);
    if (a.role === 'host') this.stopIdle();
    else if (msg?.type === 'hello' && a.role && !this.key) a.send('{"type":"hostHere","here":false}');
  }

  // The first host whose key gives this room's code claims the room. true = this is the host's key, 'taken' =
  // another host already has the room, 'wait' = too many wrong keys lately (this one wasn't looked at), false =
  // not a key for this room (counted as a miss, see keyBlocked()).
  async claimKey(key) {
    if (typeof key !== 'string' || !KEY.test(key)) return this.keyMissed();
    if (this.key === key) return true;
    if (this.keyBlocked()) return 'wait';
    if ((await codeFor(key)) !== this.code) return this.keyMissed();
    if (this.key === key) return true; // claimed meanwhile by the same key from another tab (the hash takes a moment)
    if (this.key) return 'taken';
    this.key = key;
    this.hostHere();
    return true;
  }

  // Phones and TVs that arrive before any host has claimed the room (a wrong code, or a room that just came up
  // fresh and whose host is still reconnecting) are told so, and told again when the host is here, so the page can
  // show "no host here yet" without giving up the connection.
  hostHere() {
    for (const a of this.sockets.values()) if (a.role && a.role !== 'host') a.send('{"type":"hostHere","here":true}');
  }

  webSocketClose(ws) {
    this.sockets.get(ws)?.closed();
  }

  webSocketError(ws) {
    this.sockets.get(ws)?.closed();
  }

  // No host connected: close the room after a while (ROOM_IDLE_MS from when the host left), so a forgotten room
  // doesn't live on; sooner (ROOM_EMPTY_IDLE_MS) once nobody is connected and the lobby is empty.
  watchIdle() {
    if (!this.hub) return;
    if ([...this.sockets.values()].some((a) => a.role === 'host' && a.readyState === 1)) return this.stopIdle();
    this.idleSince ??= Date.now();
    const st = this.hub.getState();
    const empty = this.sockets.size === 0 && st.phase === 'lobby' && st.teams.length === 0;
    const wait = empty ? Math.min(this.idleMs, ROOM_EMPTY_IDLE_MS) : this.idleMs;
    clearTimeout(this.idle);
    this.idle = setTimeout(() => this.closeRoom(), Math.max(0, this.idleSince + wait - Date.now()));
  }

  stopIdle() {
    clearTimeout(this.idle);
    this.idle = null;
    this.idleSince = null;
  }

  // Everyone gets `bye` with the reason (the pages say "This room has closed" and stop reconnecting), the game and
  // the files go, and the room forgets its host; the same key opens a fresh room next time.
  closeRoom() {
    this.stopIdle();
    if (!this.hub) return;
    const open = [...this.sockets.entries()];
    for (const [, a] of open) a.send('{"type":"bye","reason":"closed"}');
    this.hub.stop();
    this.hub = null;
    this.key = null;
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.pendingSave = null;
    this.files.clear();
    this.fileBytes = 0;
    for (const [ws, a] of open) {
      a.closed();
      try {
        ws.close(1000, 'room closed');
      } catch {
        // already gone
      }
    }
    this.sockets.clear();
  }
}

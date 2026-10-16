// "Find a song clip" in the editor: searching Deezer for songs and copying the chosen song's 30-second preview into
// the files folder (like an uploaded clip), with the song's title and artist as its credit.
//
// Like the picture search (pictures.js), this is a place where ProQuiz goes on the internet itself, and only for the
// editor (on the laptop the routes live under /api/, which the tunnel's listener and other devices never reach; on
// the website the room's Durable Object runs the same code with `store: null`, so `fetch()` hands the bytes back
// and the browser stores them). The game never needs it: a clip found here is a normal file from then on, and the
// editor's trim bar cuts it. No Node modules here.
//
// The browser never gives the server an address to fetch. It sends words to search for, or a song's number, and
// the server asks Deezer itself where that song's preview is. The preview address is signed and expires, so it is
// never kept: "Use this clip" fetches the song again. The bytes must really be an MP3 and at most MAX_SONG.
//
// Deezer's public API needs no key. Checked on 2026-10-11:
//   GET https://api.deezer.com/search?q=<words>&limit=10&index=<n>   → { data: [track…], total, next? }
//   GET https://api.deezer.com/track/<id>                          → the track, with `preview`
//   A track: { id, title, link, duration (s), preview (https://cdnt-preview.dzcdn.net/…mp3?hdnea=…),
//              artist: { name }, album: { title, cover_medium (https://cdn-images.dzcdn.net/…) } }.
//   Errors come as { error: { type, message, code } }, often with status 200: code 4 is "quota limit exceeded",
//   800 "no data" (a track that doesn't exist), 500 a bad parameter.
//   The previews are 30 s MP3s of about 0.5 MB, for private, non-commercial use (Deezer's terms).

import { safeUrl } from './lib/safeurl.js';
import { readBody } from './pictures.js';

export const USER_AGENT = 'ProQuiz/2 (https://github.com/dbugger85/proquiz; quiz editor song search)';
export const MAX_SONG = 2 * 1024 * 1024;
export const PAGE_SIZE = 10;
export const MAX_PAGE = 20;
export const MAX_QUERY = 200;
const SEARCH_TIMEOUT_MS = 10_000;
const FETCH_TIMEOUT_MS = 30_000;
const CACHE_MS = 10 * 60_000;
const CACHE_MAX = 200;
const MAX_REDIRECTS = 3;
const RETRY_MS = 600;

const DEEZER = 'https://api.deezer.com/';
export const PREVIEW_HOSTS = ['cdnt-preview.dzcdn.net'];
export const COVER_HOSTS = ['cdn-images.dzcdn.net', 'e-cdns-images.dzcdn.net'];
const NO_INTERNET = ['ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'ECONNREFUSED', 'ENETDOWN'];
const QUOTA_CODES = [4]; // Deezer: "Quota limit exceeded"
const MISSING_CODES = [800]; // Deezer: "no data"

// ----- small pure helpers (exported for the tests) -----

// Whether the bytes are an MP3: an ID3 tag, or straight away an MPEG audio frame (sync bits 0xFFE, with a valid
// MPEG version and layer).
export function isMp3(bytes) {
  if (!bytes || bytes.length < 4) return false;
  if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) return true; // "ID3"
  return bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0 && (bytes[1] & 0x18) !== 0x08 && (bytes[1] & 0x06) !== 0;
}

const clean = (s, max) =>
  String(s ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

// safeUrl() (lib/safeurl.js): https, a real name (no IP address, no local names) and only the given hosts.
export { safeUrl };

const trackLink = (track) => safeUrl(track.link) ?? (Number.isInteger(track.id) ? `https://www.deezer.com/track/${track.id}` : '');

// One Deezer track as a search result: what the editor shows, plus the preview address for the ▶ button in the
// dialog (never stored: it expires). Null for anything that isn't a playable track.
export function parseTrack(track) {
  if (!track || typeof track !== 'object' || !Number.isInteger(track.id) || track.id <= 0) return null;
  const preview = safeUrl(track.preview, PREVIEW_HOSTS);
  if (!preview) return null; // no preview: nothing to copy
  const title = clean(track.title ?? track.title_short, 200);
  const artist = clean(track.artist?.name, 120);
  if (!title) return null;
  return {
    id: track.id,
    title,
    artist,
    album: clean(track.album?.title, 200),
    cover: safeUrl(track.album?.cover_medium ?? track.album?.cover_small, COVER_HOSTS),
    duration: Number.isFinite(track.duration) && track.duration > 0 ? Math.round(track.duration) : null,
    preview,
    link: trackLink(track),
  };
}

export function parseSearch(json, page = 1) {
  const results = (Array.isArray(json?.data) ? json.data : []).map(parseTrack).filter(Boolean);
  return { results, page, more: Boolean(json?.next) };
}

function httpError(status, code, extra = {}) {
  return Object.assign(new Error(code), { status, code, ...extra });
}

// A failed request as one of our error codes: no internet, too many searches, or "didn't work".
function upstream(err) {
  if (err?.status) return err;
  const code = err?.cause?.code ?? err?.code;
  const text = `${err?.message ?? ''} ${err?.cause?.message ?? ''}`;
  if (NO_INTERNET.includes(code) || /ENOTFOUND|EAI_AGAIN|getaddrinfo|dns error|network is unreachable/i.test(text)) return httpError(503, 'no-internet');
  return httpError(502, 'song-failed');
}

function rateLimited(res) {
  const secs = Number(res?.headers?.get('retry-after'));
  return httpError(429, 'rate-limited', { retryAfter: Number.isFinite(secs) && secs > 0 ? Math.min(Math.ceil(secs), 3600) : 60 });
}

// ----- the service -----

export function createSongs({ store, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  const cache = new Map(); // key → { at, value }
  const headers = { 'User-Agent': USER_AGENT, Accept: 'application/json' };

  // A JSON answer from Deezer. A busy moment upstream (a 5xx) is tried once more after a short pause. Deezer puts
  // its own errors in the body, usually with status 200.
  async function getJson(url, timeout = SEARCH_TIMEOUT_MS, retry = true) {
    let res;
    try {
      res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeout) });
    } catch (err) {
      throw upstream(err);
    }
    if (res.status >= 500 && retry) {
      res.body?.cancel().catch(() => {});
      await new Promise((r) => setTimeout(r, RETRY_MS));
      return getJson(url, timeout, false);
    }
    if (res.status === 429) throw rateLimited(res);
    let data = null;
    try {
      data = await res.json();
    } catch {}
    if (!res.ok) throw httpError(res.status === 404 ? 404 : 502, res.status === 404 ? 'song-missing' : 'song-failed', { upstreamStatus: res.status });
    if (data === null || typeof data !== 'object') throw httpError(502, 'song-failed');
    if (data.error) {
      const code = Number(data.error.code);
      if (QUOTA_CODES.includes(code)) throw rateLimited(res);
      if (MISSING_CODES.includes(code)) throw httpError(404, 'song-missing');
      throw httpError(502, 'song-failed');
    }
    return data;
  }

  async function search({ q, page = 1 } = {}) {
    const words = String(q ?? '').replace(/\s+/g, ' ').trim();
    if (!words || words.length > MAX_QUERY) throw httpError(400, 'bad-query');
    const n = Number(page ?? 1);
    if (!Number.isInteger(n) || n < 1 || n > MAX_PAGE) throw httpError(400, 'bad-query');
    const key = `${words.toLowerCase()}|${n}`;
    const hit = cache.get(key);
    if (hit && now() - hit.at < CACHE_MS) return hit.value;

    const url = new URL('search', DEEZER);
    url.search = new URLSearchParams({ q: words, limit: String(PAGE_SIZE), index: String((n - 1) * PAGE_SIZE) }).toString();
    const value = parseSearch(await getJson(url.href), n);
    cache.set(key, { at: now(), value });
    while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    return value;
  }

  // The bytes of a preview: https only, Deezer's preview servers only, redirects checked one by one, at most MAX_SONG.
  async function download(address) {
    let url = safeUrl(address, PREVIEW_HOSTS);
    for (let hop = 0; ; hop++) {
      if (!url) throw httpError(502, 'song-failed');
      let res;
      try {
        res = await fetchImpl(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'audio/mpeg, audio/*' }, redirect: 'manual', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      } catch (err) {
        throw upstream(err);
      }
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        res.body?.cancel().catch(() => {});
        if (hop >= MAX_REDIRECTS) throw httpError(502, 'song-failed');
        url = safeUrl(new URL(res.headers.get('location'), url).href, PREVIEW_HOSTS);
        continue;
      }
      if (res.status === 429) throw rateLimited(res);
      if (!res.ok) {
        res.body?.cancel().catch(() => {});
        throw httpError(res.status === 404 || res.status === 410 || res.status === 403 ? 404 : 502, res.status === 404 || res.status === 410 || res.status === 403 ? 'song-missing' : 'song-failed');
      }
      if (Number(res.headers.get('content-length')) > MAX_SONG) {
        res.body?.cancel().catch(() => {});
        throw httpError(413, 'song-too-big');
      }
      try {
        return await readBody(res, MAX_SONG, 'song-too-big');
      } catch (err) {
        throw upstream(err);
      }
    }
  }

  // "Use this clip": ask Deezer for the song again (the preview address from the search has expired by now, or
  // soon will), download the preview, check it and keep it.
  async function fetchSong({ id } = {}) {
    const n = Number(id);
    if (!Number.isInteger(n) || n <= 0 || n > Number.MAX_SAFE_INTEGER) throw httpError(400, 'bad-id');
    const track = parseTrack(await getJson(`${DEEZER}track/${n}`, FETCH_TIMEOUT_MS));
    if (!track) throw httpError(404, 'song-missing');
    const bytes = await download(track.preview);
    if (!isMp3(bytes)) throw httpError(415, 'song-bad-type');
    const credit = { title: track.title, author: track.artist, source: 'deezer', ...(track.link && { sourceUrl: track.link }) };
    if (!store) return { bytes, kind: 'audio', credit };
    const saved = await store.addFile('song.mp3', bytes);
    return { ...saved, credit };
  }

  return { search, fetch: fetchSong };
}

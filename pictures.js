// "Find a free picture" in the editor: searching Openverse and Wikimedia Commons for freely licensed pictures, and
// downloading the chosen one into the files folder (like an upload), with who made it and its licence.
//
// This is the one place where ProQuiz goes on the internet itself, and only for the editor on the laptop (the routes
// live under /api/, which the tunnel's listener and other devices never reach). The game never needs it: a picture
// found here is a normal file from then on.
//
// The browser never gives the server an address to fetch. It sends words to search for, or "picture <id> from
// <source>", and the server asks the source itself where that picture is. The bytes must really be a PNG, JPG, GIF
// or WebP (never SVG: Wikimedia's PNG renders are used instead) and at most MAX_PICTURE.
//
// Upstream, checked on 2026-10-11:
//   Openverse  GET https://api.openverse.org/v1/images/?q&page&page_size&license&mature   (anonymous: 20 a minute,
//              200 a day; the thumbnails, /v1/images/<id>/thumb/, 1000 a day). Detail: /v1/images/<id>/.
//   Commons    GET https://commons.wikimedia.org/w/api.php (generator=search in the File namespace, imageinfo with
//              extmetadata). Thumbnails come from thumb.wikimedia.org, small originals from upload.wikimedia.org.

import { isIP } from 'node:net';
import { logoKind } from './brand.js';
import { PICTURE_SOURCES } from './lib/validate.js';

export const USER_AGENT = 'ProQuiz/2 (https://github.com/dbugger85/proquiz; quiz editor picture search)';
export const MAX_PICTURE = 15 * 1024 * 1024;
export const PAGE_SIZE = 20;
export const MAX_PAGE = 50;
export const MAX_QUERY = 200;
export const LICENSE_CHOICES = ['any', 'nc']; // free for any use (also commercial), or also non-commercial only
const SEARCH_TIMEOUT_MS = 10_000;
const FETCH_TIMEOUT_MS = 30_000;
const CACHE_MS = 10 * 60_000;
const CACHE_MAX = 200;
const MAX_REDIRECTS = 3;
const RETRY_MS = 600;

const OPENVERSE = 'https://api.openverse.org/v1/images/';
const COMMONS = 'https://commons.wikimedia.org/w/api.php';
// Openverse licences. "No derivatives" ones are left out: ProQuiz crops pictures and can show them as blocks
// that slowly become clear (unveil), which such a licence doesn't allow.
const OPENVERSE_LICENSES = { any: 'cc0,pdm,by,by-sa', nc: 'cc0,pdm,by,by-sa,by-nc,by-nc-sa' };
const OPENVERSE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const COMMONS_HOSTS = ['upload.wikimedia.org', 'thumb.wikimedia.org'];
const COMMONS_MIMES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml'];
const COMMONS_META = 'LicenseShortName|LicenseUrl|Artist|ObjectName';
const NO_INTERNET = ['ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'ECONNREFUSED', 'ENETDOWN'];

// ----- small pure helpers (exported for the tests) -----

// What a downloaded file really is: the logo check (PNG, JPG, WebP, SVG) plus GIF.
export function imageKind(bytes) {
  if (bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(bytes.toString('latin1', 0, 6))) return 'gif';
  return logoKind(bytes);
}

// Openverse's licence codes as people write them: "CC BY-SA 4.0", "CC0", "Public domain".
export function licenseLabel(code, version) {
  const c = String(code ?? '').toLowerCase();
  if (!c) return '';
  if (c === 'cc0') return 'CC0';
  if (c === 'pdm') return 'Public domain';
  return `CC ${c.toUpperCase()}${version ? ` ${version}` : ''}`;
}

// Wikimedia's author field is HTML ("<a href=…>Name</a>"): just the text.
export function stripHtml(s) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return String(s ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) =>
      e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : (named[e.toLowerCase()] ?? m),
    )
    .replace(/[\u0000-\u001f\u007f -​]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const https = (u) => (typeof u === 'string' ? u.replace(/^http:\/\//i, 'https://') : '');
const PROVIDERS = { flickr: 'Flickr', wikimedia: 'Wikimedia Commons', smithsonian: 'Smithsonian', met: 'The Met', nasa: 'NASA', europeana: 'Europeana' };
const providerName = (p) => (p ? (PROVIDERS[p] ?? p.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase())) : '');

export function parseOpenverse(json) {
  const results = (Array.isArray(json?.results) ? json.results : [])
    .filter((r) => r && OPENVERSE_ID.test(r.id) && r.thumbnail && !r.mature)
    .map((r) => ({
      id: r.id,
      title: stripHtml(r.title).slice(0, 200),
      author: stripHtml(r.creator).slice(0, 120),
      license: licenseLabel(r.license, r.license_version),
      nc: /nc/.test(r.license ?? ''),
      licenseUrl: https(r.license_url),
      source: 'openverse',
      sourceUrl: https(r.foreign_landing_url),
      thumb: r.thumbnail,
      fallback: r.url ?? null, // the original, if the thumbnail service says no (it has its own daily limit)
      width: r.width ?? null,
      height: r.height ?? null,
      provider: providerName(r.provider ?? r.source),
    }));
  const page = Number(json?.page) || 1;
  return { results, page, more: page < (Number(json?.page_count) || 0) };
}

const fileTitle = (title) => String(title ?? '').replace(/^File:/, '');
const withoutExt = (name) => name.replace(/\.[a-z0-9]{2,5}$/i, '');

export function parseWikimedia(json, page = 1) {
  const pages = Array.isArray(json?.query?.pages) ? [...json.query.pages] : [];
  pages.sort((a, b) => (a.index ?? 0) - (b.index ?? 0)); // the order the search ranked them
  const results = [];
  for (const p of pages) {
    const ii = p?.imageinfo?.[0];
    if (!ii || !COMMONS_MIMES.includes(ii.mime) || !ii.thumburl) continue;
    const meta = (k) => stripHtml(ii.extmetadata?.[k]?.value);
    const id = fileTitle(p.title);
    results.push({
      id,
      title: (meta('ObjectName') || withoutExt(id)).slice(0, 200),
      author: meta('Artist').slice(0, 120),
      license: meta('LicenseShortName').slice(0, 60),
      nc: false, // Wikimedia Commons only keeps pictures anyone may use
      licenseUrl: https(meta('LicenseUrl')),
      source: 'wikimedia',
      sourceUrl: https(ii.descriptionurl || ii.descriptionshorturl),
      thumb: ii.thumburl,
      fallback: null,
      width: ii.width ?? null,
      height: ii.height ?? null,
      provider: '',
    });
  }
  return { results, page, more: Boolean(json?.continue) };
}

function httpError(status, code, extra = {}) {
  return Object.assign(new Error(code), { status, code, ...extra });
}

// An address the server may download from: https, a real name (no IP address, no local names), and for Wikimedia
// only its own picture servers.
export function safeUrl(u, hosts = null) {
  let url;
  try {
    url = new URL(u);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (url.protocol !== 'https:' || url.username || url.password) return null;
  if (isIP(host) || host === 'localhost' || !host.includes('.') || /\.(local|localhost|internal|lan|home|arpa)$/.test(host)) return null;
  if (hosts && !hosts.includes(host)) return null;
  return url.href;
}

// A failed request as one of our error codes: no internet, too many searches, or "didn't work".
function upstream(err) {
  if (err?.status) return err;
  const code = err?.cause?.code ?? err?.code;
  const text = `${err?.message ?? ''} ${err?.cause?.message ?? ''}`;
  if (NO_INTERNET.includes(code) || /ENOTFOUND|EAI_AGAIN|getaddrinfo|dns error|network is unreachable/i.test(text)) return httpError(503, 'no-internet');
  return httpError(502, 'picture-failed');
}

function rateLimited(res) {
  const secs = Number(res?.headers?.get('retry-after'));
  return httpError(429, 'rate-limited', { retryAfter: Number.isFinite(secs) && secs > 0 ? Math.min(Math.ceil(secs), 3600) : 60 });
}

// ----- the service -----

export function createPictures({ store, fetchImpl = globalThis.fetch, now = Date.now, lang = () => 'en' } = {}) {
  const cache = new Map(); // key → { at, value }
  const headers = { 'User-Agent': USER_AGENT, Accept: 'application/json' };

  // A JSON answer. A busy moment upstream (a 5xx) is tried once more after a short pause.
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
    if (!res.ok) throw httpError(res.status === 404 ? 404 : 502, res.status === 404 ? 'picture-missing' : 'picture-failed', { upstreamStatus: res.status });
    if (data === null) throw httpError(502, 'picture-failed');
    // Wikimedia says "too many" in the answer, sometimes with status 200.
    if (['ratelimited', 'maxlag'].includes(data?.error?.code)) throw rateLimited(res);
    if (data?.error) throw httpError(502, 'picture-failed');
    return data;
  }

  async function search({ q, source, page = 1, license = 'any', lang: wanted } = {}) {
    const words = String(q ?? '').replace(/\s+/g, ' ').trim();
    if (!PICTURE_SOURCES.includes(source)) throw httpError(400, 'bad-source');
    if (!words || words.length > MAX_QUERY) throw httpError(400, 'bad-query');
    const n = Number(page ?? 1);
    if (!Number.isInteger(n) || n < 1 || n > MAX_PAGE) throw httpError(400, 'bad-query');
    const lic = LICENSE_CHOICES.includes(license) ? license : 'any';
    const lg = ['en', 'no'].includes(wanted) ? wanted : lang() === 'no' ? 'no' : 'en';
    const key = `${source}|${source === 'openverse' ? lic : '-'}|${source === 'wikimedia' ? lg : '-'}|${words.toLowerCase()}|${n}`;
    const hit = cache.get(key);
    if (hit && now() - hit.at < CACHE_MS) return hit.value;

    let value;
    if (source === 'openverse') {
      const url = new URL(OPENVERSE);
      url.search = new URLSearchParams({ q: words, page: String(n), page_size: String(PAGE_SIZE), license: OPENVERSE_LICENSES[lic], mature: 'false' }).toString();
      try {
        value = parseOpenverse(await getJson(url.href));
      } catch (err) {
        // Without an account Openverse only goes so deep; a page past that just means "no more".
        if (n > 1 && [400, 401].includes(err.upstreamStatus)) value = { results: [], page: n, more: false };
        else throw err;
      }
    } else {
      const url = new URL(COMMONS);
      url.search = new URLSearchParams({
        action: 'query',
        format: 'json',
        formatversion: '2',
        generator: 'search',
        gsrsearch: `filetype:bitmap|drawing ${words}`,
        gsrnamespace: '6',
        gsrlimit: String(PAGE_SIZE),
        gsroffset: String((n - 1) * PAGE_SIZE),
        prop: 'imageinfo',
        iiprop: 'url|extmetadata|size|mime',
        iiurlwidth: '320',
        iiextmetadatafilter: COMMONS_META,
        iiextmetadatalanguage: lg === 'no' ? 'nb' : 'en',
      }).toString();
      value = parseWikimedia(await getJson(url.href), n);
    }
    cache.set(key, { at: now(), value });
    while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    return value;
  }

  // The bytes of a picture: https only, redirects checked one by one, at most MAX_PICTURE.
  async function download(address, hosts) {
    let url = safeUrl(address, hosts);
    for (let hop = 0; ; hop++) {
      if (!url) throw httpError(502, 'picture-failed');
      let res;
      try {
        res = await fetchImpl(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'image/*' }, redirect: 'manual', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      } catch (err) {
        throw upstream(err);
      }
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        res.body?.cancel().catch(() => {});
        if (hop >= MAX_REDIRECTS) throw httpError(502, 'picture-failed');
        url = safeUrl(new URL(res.headers.get('location'), url).href, hosts);
        continue;
      }
      if (res.status === 429) throw rateLimited(res);
      if (!res.ok) {
        res.body?.cancel().catch(() => {});
        throw httpError(res.status === 404 || res.status === 410 ? 404 : 502, res.status === 404 || res.status === 410 ? 'picture-missing' : 'picture-failed');
      }
      if (Number(res.headers.get('content-length')) > MAX_PICTURE) {
        res.body?.cancel().catch(() => {});
        throw httpError(413, 'picture-too-big');
      }
      const chunks = [];
      let size = 0;
      try {
        for await (const chunk of res.body ?? []) {
          size += chunk.length;
          if (size > MAX_PICTURE) {
            await res.body.cancel().catch(() => {});
            throw httpError(413, 'picture-too-big');
          }
          chunks.push(Buffer.from(chunk));
        }
      } catch (err) {
        throw upstream(err);
      }
      return Buffer.concat(chunks);
    }
  }

  // Download, check and store. Several addresses are tried in turn (Openverse: the original, then its own copy).
  async function keep(addresses, hosts, credit) {
    let last = httpError(502, 'picture-failed');
    for (const address of addresses.filter(Boolean)) {
      try {
        const bytes = await download(address, hosts);
        const kind = imageKind(bytes);
        if (!kind || kind === 'svg') throw httpError(415, 'picture-bad-type');
        const saved = await store.addFile(`picture.${kind}`, bytes);
        return { ...saved, credit };
      } catch (err) {
        if (['no-internet', 'rate-limited'].includes(err.code)) throw err;
        last = err;
      }
    }
    throw last;
  }

  async function fetchPicture({ source, id } = {}) {
    if (!PICTURE_SOURCES.includes(source)) throw httpError(400, 'bad-source');
    if (source === 'openverse') {
      if (typeof id !== 'string' || !OPENVERSE_ID.test(id)) throw httpError(400, 'bad-id');
      const d = await getJson(`${OPENVERSE}${id}/`, FETCH_TIMEOUT_MS);
      const credit = {
        title: stripHtml(d.title).slice(0, 200),
        author: stripHtml(d.creator).slice(0, 120),
        license: licenseLabel(d.license, d.license_version),
        licenseUrl: https(d.license_url),
        source: 'openverse',
        sourceUrl: https(d.foreign_landing_url),
      };
      return keep([d.url, `${OPENVERSE}${id}/thumb/?full_size=true`], null, credit);
    }
    // Wikimedia Commons: the id is the file's name ("Flag of Norway.svg"). "|" would ask for several files at once.
    if (typeof id !== 'string' || id.length < 1 || id.length > 250 || /[|#<>[\]{}\u0000-\u001f\u007f]/.test(id)) throw httpError(400, 'bad-id');
    const url = new URL(COMMONS);
    url.search = new URLSearchParams({
      action: 'query',
      format: 'json',
      formatversion: '2',
      titles: `File:${id}`,
      prop: 'imageinfo',
      iiprop: 'url|extmetadata|size|mime',
      iiurlwidth: '1920', // a picture at most 1920 wide (a drawing comes as a PNG), so files stay small
      iiextmetadatafilter: COMMONS_META,
      iiextmetadatalanguage: lang() === 'no' ? 'nb' : 'en',
    }).toString();
    const data = await getJson(url.href, FETCH_TIMEOUT_MS);
    const page = data?.query?.pages?.[0];
    const ii = page?.imageinfo?.[0];
    if (!page || page.missing || page.invalid || !ii) throw httpError(404, 'picture-missing');
    if (!COMMONS_MIMES.includes(ii.mime)) throw httpError(415, 'picture-bad-type');
    const [found] = parseWikimedia({ query: { pages: [{ ...page, imageinfo: [{ ...ii, thumburl: ii.thumburl || ii.url }] }] } }).results;
    const credit = { title: found.title, author: found.author, license: found.license, licenseUrl: found.licenseUrl, source: 'wikimedia', sourceUrl: found.sourceUrl };
    // The render (thumburl) is never an SVG; a small original may be the file itself (refused if it is an SVG).
    return keep([ii.thumburl || ii.url], COMMONS_HOSTS, credit);
  }

  return { search, fetch: fetchPicture };
}

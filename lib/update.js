// "A new version is out": asks GitHub for the latest ProQuiz release and compares it with the one running.
// Only the host laptop ever sees the answer (server.js puts it in the host's state messages), and only when the
// setting `updateCheck` is on. One request at most every CHECK_EVERY_MS, no retries, and any problem (offline,
// rate limit, odd answer) silently means "nothing to show". No node:* imports: it only needs `fetch`.

export const REPO = 'dbugger85/proquiz';
export const RELEASES_API = `https://api.github.com/repos/${REPO}/releases/latest`;
export const RELEASES_PAGE = `https://github.com/${REPO}/releases/`; // the only place a "Download" link may point to
export const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
export const TIMEOUT_MS = 5000;
export const MAX_NOTES = 300;
const USER_AGENT = 'ProQuiz/2 (https://github.com/dbugger85/proquiz; new-version check)';

// "v2.3.0" or "2.3.0" → [2, 3, 0]; anything else (pre-releases like "2.3.0-beta" too) → null.
export function parseVersion(tag) {
  const m = /^v?(\d{1,5})\.(\d{1,5})\.(\d{1,5})$/.exec(String(tag ?? '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

// Negative when a is older than b, 0 when the same, positive when newer. Null when either doesn't parse.
export function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

// The release notes as one short plain-text line: the first paragraph, with the markdown taken out.
export function excerpt(body) {
  if (typeof body !== 'string') return '';
  const plainText = (p) =>
    p
      .replace(/^#.*$/gm, '') // headings
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<[^>]+>/g, '') // html
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '') // pictures
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // links: keep the words
      .replace(/^\s*(?:[-*+]|\d+\.)\s+/gm, '') // list bullets
      .replace(/^\s*>\s?/gm, '') // quotes
      .replace(/(\*\*|__|[*_~`])/g, '') // bold, italics, code
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  const plain = body
    .replace(/\r\n?/g, '\n')
    .replace(/```[\s\S]*?```/g, '')
    .split(/\n\s*\n/)
    .map(plainText)
    .find(Boolean);
  if (!plain) return '';
  if (plain.length <= MAX_NOTES) return plain;
  const cut = plain.slice(0, MAX_NOTES);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), MAX_NOTES - 40)).trimEnd()}…`;
}

// Reads GitHub's answer. Null unless it is a proper, published release that is newer than `version`,
// with a page address on ProQuiz's own releases page.
export function readRelease(data, version) {
  if (!data || typeof data !== 'object' || data.draft || data.prerelease) return null;
  const tag = parseVersion(data.tag_name);
  if (!tag) return null;
  const latest = tag.join('.');
  const cmp = compareVersions(latest, version);
  if (cmp === null || cmp <= 0) return null;
  const url = typeof data.html_url === 'string' ? data.html_url : '';
  if (!url.startsWith(RELEASES_PAGE) || /[\s<>"'\\]/.test(url)) return null;
  return { version: latest, url, notes: excerpt(data.body) };
}

// `check()` asks (at most once per CHECK_EVERY_MS; a check already on its way is shared) and resolves to the
// newer release or null; `current()` is the last answer without asking. Tests pass `fetchImpl` and `now`.
export function createUpdateCheck({ version, fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = TIMEOUT_MS, url = RELEASES_API } = {}) {
  let checkedAt = null;
  let latest = null;
  let inflight = null;

  async function ask() {
    try {
      const res = await fetchImpl(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/vnd.github+json' },
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res || res.status !== 200) return null; // 403/429 = rate limited, 404 = no release yet: nothing to show
      return readRelease(await res.json(), version);
    } catch {
      return null; // offline, timed out, not JSON
    }
  }

  return {
    current: () => latest,
    check() {
      if (!parseVersion(version)) return Promise.resolve(null); // the running version is unknown: nothing to compare with
      if (inflight) return inflight;
      const t = now();
      if (checkedAt !== null && t - checkedAt < CHECK_EVERY_MS) return Promise.resolve(latest);
      checkedAt = t;
      inflight = ask().then((found) => {
        latest = found;
        inflight = null;
        return found;
      });
      return inflight;
    },
  };
}

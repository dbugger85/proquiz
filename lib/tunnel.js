// Players elsewhere: a Cloudflare "quick tunnel" gives the game a public https address (no account needed).
// ProQuiz runs the free `cloudflared` program and points it at a second listener on 127.0.0.1 that only
// the tunnel uses, where every connection counts as coming from outside (see openRemote() in server.js).
// If cloudflared isn't on this computer, the host can let ProQuiz download it once into <data dir>/bin/.
//
// Status (what the host lobby shows): off → starting → on, or missing (not found), downloading, failed.
import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { mkdir, writeFile, chmod, rename, rm } from 'node:fs/promises';
import path from 'node:path';

export const RELEASES = 'https://github.com/cloudflare/cloudflared/releases/latest/download/';
const START_TIMEOUT_MS = 60_000; // no address by then: give up
const SETTLE_MS = 15_000; // the address is known but no "connected" line yet: go on anyway
const READY_MAX_MS = 30_000; // waiting for the new address to be findable on the internet (DNS)
const READY_EVERY_MS = 1500;
const KILL_AFTER_MS = 3000; // cloudflared waits for open connections when asked to stop; don't wait long

// Is the new address findable on the internet yet? Asked through Cloudflare's public DNS-over-HTTPS, so this
// laptop's (and the router's) DNS doesn't remember "no such address" from asking too early. A phone that scans
// the QR code before the address exists may get stuck on "not found" for a minute, so the QR code waits for this.
export async function dnsReady(url, fetchImpl = globalThis.fetch) {
  const host = new URL(url).hostname;
  const res = await fetchImpl(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=A`, {
    headers: { accept: 'application/dns-json' },
    signal: AbortSignal.timeout(4000),
  });
  const data = await res.json();
  return data.Status === 0 && Array.isArray(data.Answer) && data.Answer.length > 0;
}

// The official release file for this computer, or null when there is none.
export function assetFor(platform, arch) {
  if (platform === 'win32') return arch === 'ia32' ? 'cloudflared-windows-386.exe' : 'cloudflared-windows-amd64.exe'; // Windows on Arm runs the Intel one
  if (platform === 'darwin') return arch === 'arm64' ? 'cloudflared-darwin-arm64.tgz' : 'cloudflared-darwin-amd64.tgz';
  if (platform === 'linux') {
    const name = { x64: 'amd64', arm64: 'arm64', arm: 'arm', ia32: '386' }[arch];
    return name ? `cloudflared-linux-${name}` : null;
  }
  return null;
}

export const exeName = (platform) => (platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');

// The public address in cloudflared's output ("https://some-random-words.trycloudflare.com"), or null.
// Its error lines mention api.trycloudflare.com, which isn't the game's address.
export function parseTunnelUrl(text) {
  for (const m of String(text).matchAll(/https:\/\/([a-z0-9-]+)\.trycloudflare\.com\b/gi)) {
    const sub = m[1].toLowerCase();
    if (sub !== 'api' && !sub.startsWith('-') && !sub.endsWith('-')) return `https://${sub}.trycloudflare.com`;
  }
  return null;
}

// Where to look for cloudflared, in order: the folders on PATH (plus the usual install folders, because a
// program started by double-clicking may get a short PATH), next to the ProQuiz program, and <data dir>/bin/.
export function candidates({ platform = process.platform, env = process.env, execPath = process.execPath, dataDir }) {
  const exe = exeName(platform);
  const sep = platform === 'win32' ? ';' : ':';
  const dirs = String(env.PATH ?? env.Path ?? '').split(sep).filter(Boolean);
  if (platform === 'darwin') dirs.push('/opt/homebrew/bin', '/usr/local/bin');
  if (platform === 'linux') dirs.push('/usr/local/bin', '/usr/bin');
  if (platform === 'win32') {
    for (const pf of [env['ProgramFiles(x86)'], env.ProgramFiles]) if (pf) dirs.push(path.win32.join(pf, 'cloudflared'));
  }
  const p = platform === 'win32' ? path.win32 : path.posix;
  const list = dirs.map((d) => p.join(d, exe));
  if (execPath) list.push(p.join(p.dirname(execPath), exe));
  if (dataDir) list.push(p.join(dataDir, 'bin', exe));
  return [...new Set(list)];
}

export const binPath = (dataDir, platform = process.platform) => path.join(dataDir, 'bin', exeName(platform));

export function findCloudflared(opts) {
  for (const file of candidates(opts)) {
    try {
      if (statSync(file).isFile()) return file;
    } catch {}
  }
  return null;
}

// Runs one tunnel at a time. `open()` starts the tunnel-only listener and gives its port, `close()` stops it;
// `onChange()` runs whenever status() changes (the server sends it to the screens).
// Findable (see dnsReady()), and Cloudflare already passes requests on (for a second or two after that it
// answers with an error page). Throws when it can't ask at all.
async function reachable(url, fetchImpl) {
  if (!(await dnsReady(url, fetchImpl))) return false;
  try {
    return (await fetchImpl(url + '/icon.svg', { signal: AbortSignal.timeout(4000) })).ok;
  } catch {
    return false;
  }
}

// `ready(url)` says whether the address can be found yet (dnsReady() by default; tests pass their own).
export function createTunnel({
  dataDir,
  open,
  close,
  onChange = () => {},
  platform = process.platform,
  arch = process.arch,
  find = () => findCloudflared({ dataDir, platform }),
  fetchImpl = globalThis.fetch,
  ready = (url) => reachable(url, fetchImpl),
}) {
  let state = { status: 'off', url: null, reason: null, progress: null };
  let child = null;
  let timers = [];
  let cleanupHooked = false;

  const set = (patch) => {
    state = { ...state, ...patch };
    onChange(status());
  };
  const status = () => ({ ...state });
  const clearTimers = () => {
    timers.forEach(clearTimeout);
    timers = [];
  };

  // cloudflared must not keep running after ProQuiz closes.
  function hookCleanup() {
    if (cleanupHooked) return;
    cleanupHooked = true;
    process.on('exit', () => child?.kill('SIGKILL'));
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
      try {
        process.on(sig, () => {
          child?.kill('SIGKILL');
          process.exit(130);
        });
      } catch {} // not every system has every signal (Windows)
    }
  }

  async function start() {
    if (['starting', 'on', 'downloading'].includes(state.status)) return;
    const bin = find();
    if (!bin) return set({ status: 'missing', url: null, reason: null, progress: null });
    set({ status: 'starting', url: null, reason: null, progress: null });
    let port;
    try {
      port = await open();
    } catch {
      return set({ status: 'failed', reason: 'start' });
    }
    if (state.status !== 'starting') return close().catch(() => {}); // turned off meanwhile
    hookCleanup();
    let proc;
    try {
      proc = spawn(bin, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch {
      await close().catch(() => {});
      return set({ status: 'failed', reason: 'start' });
    }
    child = proc;
    let url = null;
    let text = '';
    let live = false;
    // Connected: wait until the address can be found on the internet, then show it.
    const goLive = async () => {
      if (live) return;
      live = true;
      const end = Date.now() + READY_MAX_MS;
      while (child === proc && Date.now() < end) {
        let ok;
        try {
          ok = await ready(url);
        } catch {
          ok = null; // can't ask (no DNS-over-HTTPS here): give it a few seconds instead
        }
        if (ok === null) await new Promise((r) => setTimeout(r, 5000));
        if (ok !== false) break;
        await new Promise((r) => setTimeout(r, READY_EVERY_MS));
      }
      if (child === proc && state.status === 'starting') set({ status: 'on', url });
    };
    const read = (chunk) => {
      if (child !== proc) return;
      text = (text + chunk).slice(-4000);
      if (!url) {
        url = parseTunnelUrl(text);
        if (url) timers.push(setTimeout(() => child === proc && goLive(), SETTLE_MS));
      }
      if (url && /Registered tunnel connection/.test(text)) goLive();
    };
    proc.stdout.setEncoding('utf8').on('data', read);
    proc.stderr.setEncoding('utf8').on('data', read);
    proc.on('error', () => finish(proc, 'start'));
    proc.on('exit', () => finish(proc, url ? 'stopped' : 'start'));
    timers.push(setTimeout(() => child === proc && state.status === 'starting' && (proc.kill(), finish(proc, 'timeout')), START_TIMEOUT_MS));
  }

  // The program ended: on purpose (turned off) or not (a failure the host should see).
  async function finish(proc, reason) {
    if (child !== proc) return;
    child = null;
    clearTimers();
    await close().catch(() => {});
    set({ status: 'failed', url: null, reason });
  }

  async function stop() {
    clearTimers();
    if (child) {
      // Off at once: the players' connections close with the listener, and cloudflared is stopped
      // (forced if it is still waiting for connections after a few seconds).
      const proc = child;
      child = null;
      proc.kill();
      const force = setTimeout(() => proc.kill('SIGKILL'), KILL_AFTER_MS);
      force.unref?.();
      proc.once('exit', () => clearTimeout(force));
      await close().catch(() => {});
      set({ status: 'off', url: null, reason: null, progress: null });
      return;
    }
    if (state.status === 'downloading') return; // the download finishes, then nothing starts
    await close().catch(() => {});
    set({ status: 'off', url: null, reason: null, progress: null });
  }

  // One-time download of the official program from Cloudflare's GitHub page into <data dir>/bin/, then start.
  async function download() {
    if (state.status === 'downloading' || child) return;
    const asset = assetFor(platform, arch);
    if (!asset || !fetchImpl) return set({ status: 'failed', reason: 'download' });
    set({ status: 'downloading', url: null, reason: null, progress: 0 });
    const dir = path.join(dataDir, 'bin');
    const part = path.join(dir, `${asset}.part`);
    try {
      await mkdir(dir, { recursive: true });
      const res = await fetchImpl(RELEASES + asset);
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const total = Number(res.headers.get('content-length')) || 0;
      const chunks = [];
      let got = 0;
      let shown = 0;
      for await (const chunk of res.body) {
        chunks.push(chunk);
        got += chunk.length;
        const pct = total ? Math.floor((got / total) * 100) : null;
        if (pct !== null && pct >= shown + 5) {
          shown = pct;
          set({ progress: pct });
        }
      }
      if (got < 1_000_000) throw new Error('too small');
      await writeFile(part, Buffer.concat(chunks));
      if (asset.endsWith('.tgz')) {
        await untar(part, dir);
        await rm(part, { force: true });
      } else {
        await rename(part, binPath(dataDir, platform));
      }
      if (platform !== 'win32') await chmod(binPath(dataDir, platform), 0o755);
    } catch {
      await rm(part, { force: true }).catch(() => {});
      return set({ status: 'failed', reason: 'download', progress: null });
    }
    set({ status: 'off', progress: null });
    return start();
  }

  return { start, stop, download, status, running: () => Boolean(child) };
}

// The Mac download is a .tgz with the program inside; every Mac has `tar`.
function untar(file, dir) {
  return new Promise((resolve, reject) => {
    const p = spawn('tar', ['-xzf', file, '-C', dir], { stdio: 'ignore' });
    p.on('error', reject);
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`tar ${code}`))));
  });
}

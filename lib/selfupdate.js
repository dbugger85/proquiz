// "Update now": the downloaded ProQuiz program replaces itself with the newest release and restarts.
// Only in the compiled program (never under `npm start`), only started by the host from the lobby (server.js
// checks that), and built so a failure at any step leaves a ProQuiz that still starts:
//
//   1. download  ProQuiz-<v>-<system>.zip from ProQuiz's own GitHub release page (https only, allowed hosts only,
//                size cap, timeout) and SHA256SUMS.txt from the same release; the zip's sha256 must match
//   2. checking  unzip the program file (pure JS, deflate through node:zlib) next to the running one as
//                ProQuiz.new, run it with --version, and only then rename: running → ProQuiz.old, new → ProQuiz
//                (a failed rename is renamed back)
//   3. restarting the server saves and closes its listeners, then starts the new program as a child that
//                inherits this window (same folder, same arguments, PORT = the port it was on); the old process
//                only waits and exits with the child's code, so the console/Terminal window still belongs to a
//                running ProQuiz and closing it or Ctrl+C still stops everything. A child that dies right away is
//                rolled back (ProQuiz.old becomes ProQuiz again) and the old program is started with the error.
//   On the next start, leftover .old/.new/.failed files are deleted (cleanupOld).
//
// Test doubles: fetchImpl, spawnImpl, relaunchImpl, beforeRestart, exit, exe, compiled, system, base, hosts.

import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { writeFile, rename, rm, chmod } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { REPO, parseVersion } from './update.js';

export const RELEASE_BASE = `https://github.com/${REPO}/releases/download/`;
// Where a download may be fetched from: the release page and the hosts GitHub redirects release files to.
export const ALLOWED_HOSTS = ['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com'];
export const SUMS_FILE = 'SHA256SUMS.txt';
export const MAX_ZIP = 200 * 1024 * 1024;
export const MAX_SUMS = 64 * 1024;
export const MAX_HOPS = 4; // redirects
export const IDLE_MS = 30_000; // no data for this long = the download failed
export const TOTAL_MS = 10 * 60_000;
export const VERSION_CHECK_MS = 20_000; // the new program must answer --version within this
export const EARLY_EXIT_MS = 15_000; // a new program that ends with an error within this is rolled back
const USER_AGENT = 'ProQuiz/2 (https://github.com/dbugger85/proquiz; update)';

export class UpdateError extends Error {
  constructor(code, detail = '') {
    super(detail ? `${code}: ${detail}` : code);
    this.code = code; // download | checksum | unpack | start | swap
  }
}

// ----- names -----

// The release's name for this computer (the same names as scripts/build.mjs), or null for a system we don't build for.
export function systemFor(platform, arch) {
  if (platform === 'win32') return arch === 'x64' ? 'windows' : null;
  if (platform === 'darwin') return arch === 'arm64' ? 'mac-apple-silicon' : arch === 'x64' ? 'mac-intel' : null;
  if (platform === 'linux') return arch === 'x64' ? 'linux-x64' : arch === 'arm64' ? 'linux-arm64' : null;
  return null;
}
export const programFile = (system) => (system === 'windows' ? 'ProQuiz.exe' : 'ProQuiz');
export const noteFile = (system) => (system === 'windows' ? 'START HERE.txt' : 'START-HERE.txt');
export const assetName = (version, system) => `ProQuiz-${version}-${system}.zip`;
export const assetUrl = (version, system, base = RELEASE_BASE) => `${base}v${version}/${assetName(version, system)}`;
export const sumsUrl = (version, base = RELEASE_BASE) => `${base}v${version}/${SUMS_FILE}`;

// The files next to the running program: ProQuiz.new / ProQuiz.old / ProQuiz.failed (with .exe kept at the end on Windows).
export function programNames(exe) {
  const ext = /\.exe$/i.test(exe) ? exe.slice(-4) : '';
  const stem = exe.slice(0, exe.length - ext.length);
  return { exe, newFile: `${stem}.new${ext}`, oldFile: `${stem}.old${ext}`, failedFile: `${stem}.failed${ext}` };
}

// True inside a `deno compile`d program: Deno is there and the program's own path isn't the deno command.
export function isCompiled({ deno = globalThis.Deno, execPath = process.execPath } = {}) {
  if (!deno || typeof execPath !== 'string' || !execPath) return false;
  return !/^deno(\.exe)?$/i.test(execPath.split(/[\\/]/).pop()); // the file name, on Windows too
}

// ----- download -----

// https and an allowed host only (http is only for 127.0.0.1/localhost, and only when a test put it in `hosts`).
export function allowedUrl(url, hosts = ALLOWED_HOSTS) {
  let u;
  try {
    u = new URL(String(url));
  } catch {
    return false;
  }
  if (u.username || u.password) return false;
  if (!hosts.includes(u.hostname)) return false;
  if (u.protocol === 'https:') return true;
  return u.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(u.hostname);
}

function timeLimit(promise, ms, onTimeout) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new UpdateError('download', 'timed out')); // before onTimeout, so this is the error that comes out
        onTimeout?.();
      }, ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

// Fetches a release file, following GitHub's redirects by hand (each hop must be allowed), with a size cap and
// timeouts. `onProgress(pct)` gets whole percentages (pct is null when the size isn't known).
export async function download(url, { fetchImpl = globalThis.fetch, maxBytes = MAX_ZIP, onProgress = () => {}, hosts = ALLOWED_HOSTS, idleMs = IDLE_MS, totalMs = TOTAL_MS } = {}) {
  const deadline = Date.now() + totalMs;
  const ctrl = new AbortController();
  let current = String(url);
  let res = null;
  for (let hop = 0; ; hop++) {
    if (!allowedUrl(current, hosts)) throw new UpdateError('download', `not an allowed address: ${current}`);
    try {
      res = await timeLimit(
        fetchImpl(current, { redirect: 'manual', headers: { 'User-Agent': USER_AGENT, Accept: 'application/octet-stream' }, signal: ctrl.signal }),
        idleMs,
        () => ctrl.abort(),
      );
    } catch (err) {
      throw err instanceof UpdateError ? err : new UpdateError('download', err?.message ?? 'fetch failed');
    }
    if (!res) throw new UpdateError('download', 'no answer');
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const location = res.headers?.get?.('location');
      if (!location || hop >= MAX_HOPS) throw new UpdateError('download', 'too many redirects');
      try {
        current = new URL(location, current).href;
      } catch {
        throw new UpdateError('download', 'bad redirect');
      }
      continue;
    }
    if (res.status !== 200) throw new UpdateError('download', `HTTP ${res.status}`);
    break;
  }
  const total = Number(res.headers?.get?.('content-length')) || 0;
  if (total > maxBytes) throw new UpdateError('download', 'too big');
  if (!res.body) throw new UpdateError('download', 'empty answer');
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  let shown = -1;
  onProgress(total ? 0 : null);
  for (;;) {
    const { done, value } = await timeLimit(reader.read(), idleMs, () => {
      ctrl.abort();
      reader.cancel().catch(() => {});
    });
    if (done) break;
    const chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    got += chunk.length;
    if (got > maxBytes || (total && got > total)) {
      ctrl.abort();
      throw new UpdateError('download', 'too big');
    }
    if (Date.now() > deadline) {
      ctrl.abort();
      throw new UpdateError('download', 'took too long');
    }
    chunks.push(chunk);
    const pct = total ? Math.floor((got / total) * 100) : null;
    if (pct !== null && pct !== shown) {
      shown = pct;
      onProgress(pct);
    }
  }
  if (total && got !== total) throw new UpdateError('download', 'cut short');
  return Buffer.concat(chunks);
}

// ----- checksums -----

// SHA256SUMS.txt (sha256sum's format: "<64 hex>  <file name>" per line, "*" before the name allowed) → Map name → hex.
export function parseSums(text) {
  const out = new Map();
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64})\s+\*?(\S.*?)\s*$/.exec(line.trim());
    if (m) out.set(m[2], m[1].toLowerCase());
  }
  return out;
}
export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
export function verifySum(sums, name, buf) {
  const want = sums.get(name);
  return typeof want === 'string' && want === sha256(buf);
}

// ----- a small zip reader (stored and deflated entries only) -----

const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
export function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// A name we are willing to take out: relative, no "..", no backslashes, no drive letters, no control characters.
export function safeZipName(name) {
  if (typeof name !== 'string' || !name || name.length > 255) return false;
  if (/[\\\0-\x1f]/.test(name) || name.startsWith('/') || /^[a-zA-Z]:/.test(name)) return false;
  return name.split('/').every((part) => part !== '..' && part !== '');
}

// The list of files in a zip: {name, method, size, compressedSize, crc, offset (of the local header)}.
export function readZip(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new UpdateError('unpack', 'not a zip');
  // The end-of-central-directory record is in the last 22 bytes plus a comment of up to 65535.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new UpdateError('unpack', 'no central directory');
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdStart = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdStart === 0xffffffff) throw new UpdateError('unpack', 'zip64 is not supported');
  if (cdStart + cdSize > buf.length) throw new UpdateError('unpack', 'central directory out of range');
  const entries = [];
  let p = cdStart;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new UpdateError('unpack', 'bad central directory');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compressedSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    if (size === 0xffffffff || compressedSize === 0xffffffff || offset === 0xffffffff) throw new UpdateError('unpack', 'zip64 is not supported');
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    entries.push({ name, flags, method, crc, compressedSize, size, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

// One file's bytes, checked against its CRC. Only stored (0) and deflated (8) entries, and never encrypted ones.
export function unzipEntry(buf, entry) {
  if (entry.flags & 0x1) throw new UpdateError('unpack', 'encrypted');
  if (entry.method !== 0 && entry.method !== 8) throw new UpdateError('unpack', `compression ${entry.method} is not supported`);
  const p = entry.offset;
  if (p + 30 > buf.length || buf.readUInt32LE(p) !== 0x04034b50) throw new UpdateError('unpack', 'bad local header');
  const nameLen = buf.readUInt16LE(p + 26);
  const extraLen = buf.readUInt16LE(p + 28);
  const start = p + 30 + nameLen + extraLen;
  const end = start + entry.compressedSize;
  if (end > buf.length) throw new UpdateError('unpack', 'entry out of range');
  const raw = buf.subarray(start, end);
  let data;
  try {
    data = entry.method === 0 ? Buffer.from(raw) : inflateRawSync(raw, { maxOutputLength: Math.max(entry.size, 1) });
  } catch {
    throw new UpdateError('unpack', 'bad deflate data');
  }
  if (data.length !== entry.size || crc32(data) !== entry.crc) throw new UpdateError('unpack', `${entry.name} is damaged`);
  return data;
}

// The program file (and the START HERE note, if there) out of a release zip: "ProQuiz-<v>-<system>/ProQuiz" or
// at the top. Exactly one program file, else the zip isn't ours.
export function pickFromZip(buf, system) {
  const entries = readZip(buf).filter((e) => !e.name.endsWith('/'));
  for (const e of entries) if (!safeZipName(e.name)) throw new UpdateError('unpack', `unsafe name ${JSON.stringify(e.name)}`);
  const atTop = (e) => e.name.split('/').length <= 2;
  const programs = entries.filter((e) => path.posix.basename(e.name) === programFile(system) && atTop(e));
  if (programs.length !== 1) throw new UpdateError('unpack', 'no program file in the zip');
  const note = entries.find((e) => path.posix.basename(e.name) === noteFile(system) && atTop(e));
  const program = unzipEntry(buf, programs[0]);
  if (program.length < 1_000_000) throw new UpdateError('unpack', 'program file too small');
  return { program, note: note ? unzipEntry(buf, note) : null };
}

// ----- the swap -----

// Runs a program with --version and gives what it printed (or rejects: didn't start, said nothing, took too long).
export function checkVersion(file, { spawnImpl = spawn, timeoutMs = VERSION_CHECK_MS } = {}) {
  return new Promise((resolve, reject) => {
    let out = '';
    let done = false;
    const finish = (fn, v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fn(v);
    };
    let child;
    try {
      child = spawnImpl(file, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, PROQUIZ_NO_OPEN: '1' } });
    } catch (err) {
      return finish(reject, err);
    }
    const timer = setTimeout(() => {
      child.kill?.('SIGKILL');
      finish(reject, new Error('took too long'));
    }, timeoutMs);
    child.stdout?.on('data', (d) => (out += d));
    child.on('error', (err) => finish(reject, err));
    child.on('exit', (code) => (code === 0 ? finish(resolve, out.trim()) : finish(reject, new Error(`exit ${code}`))));
  });
}

// Writes the new program next to the running one, makes sure it starts and says the right version, then swaps
// the files (and swaps back if that fails). Throws UpdateError 'start' (nothing changed) or 'swap'.
export async function installProgram({ exe, program, version, note = null, system, platform = process.platform, check = checkVersion, spawnImpl = spawn }) {
  const names = programNames(exe);
  await rm(names.newFile, { force: true }).catch(() => {});
  try {
    await writeFile(names.newFile, program);
    if (platform !== 'win32') await chmod(names.newFile, 0o755);
  } catch (err) {
    await rm(names.newFile, { force: true }).catch(() => {});
    throw new UpdateError('swap', `could not write the new program: ${err.message}`);
  }
  let said;
  try {
    said = await check(names.newFile, { spawnImpl });
  } catch (err) {
    await rm(names.newFile, { force: true }).catch(() => {});
    throw new UpdateError('start', err?.message ?? 'the new program did not start');
  }
  if (!String(said ?? '').split(/\s+/).includes(version)) {
    await rm(names.newFile, { force: true }).catch(() => {});
    throw new UpdateError('start', `the new program says ${JSON.stringify(said)}, not ${version}`);
  }
  // The note is only words: nice to have, never a reason to fail.
  if (note) await writeFile(path.join(path.dirname(exe), noteFile(system)), note).catch(() => {});
  await rm(names.oldFile, { force: true }).catch(() => {});
  try {
    await rename(exe, names.oldFile);
  } catch (err) {
    await rm(names.newFile, { force: true }).catch(() => {});
    throw new UpdateError('swap', `could not move the running program aside: ${err.message}`);
  }
  try {
    await rename(names.newFile, exe);
  } catch (err) {
    await rename(names.oldFile, exe).catch(() => {}); // back as it was
    await rm(names.newFile, { force: true }).catch(() => {});
    throw new UpdateError('swap', `could not put the new program in place: ${err.message}`);
  }
  return names;
}

// After a swap whose new program didn't start: the old program becomes ProQuiz again (the new one is kept as .failed).
export async function rollbackProgram(exe) {
  const names = programNames(exe);
  await rm(names.failedFile, { force: true }).catch(() => {});
  try {
    await rename(exe, names.failedFile);
    await rename(names.oldFile, exe);
    return true;
  } catch {
    await rename(names.failedFile, exe).catch(() => {});
    return false;
  }
}

// On start: leftovers of an earlier update (ignored when a file is busy, e.g. the old program still waiting on Windows).
export async function cleanupOld(exe) {
  const names = programNames(exe);
  for (const f of [names.oldFile, names.newFile, names.failedFile]) await rm(f, { force: true }).catch(() => {});
}

// Starts a program as a child that takes over this window (not detached: closing the window or Ctrl+C still stops
// everything). `onExit({early, code, signal})` says how it ended; `early` = ended with an error within earlyExitMs.
export function relaunch({ exe, args = [], env = process.env, extraEnv = {}, spawnImpl = spawn, onExit = () => {}, earlyExitMs = EARLY_EXIT_MS, now = Date.now }) {
  const started = now();
  // What an earlier restart told this process must not be passed on by accident.
  const { PROQUIZ_UPDATED_FROM, PROQUIZ_UPDATE_ERROR, ...inherited } = env;
  let child;
  try {
    child = spawnImpl(exe, args, { stdio: 'inherit', env: { ...inherited, ...extraEnv } });
  } catch (err) {
    queueMicrotask(() => onExit({ early: true, code: null, signal: null, error: err }));
    return null;
  }
  let done = false;
  child.on('error', (err) => {
    if (done) return;
    done = true;
    onExit({ early: true, code: null, signal: null, error: err });
  });
  child.on('exit', (code, signal) => {
    if (done) return;
    done = true;
    onExit({ early: code !== 0 && code !== null && now() - started < earlyExitMs, code, signal, error: null });
  });
  return child;
}

// ----- putting it together -----

// `available()`: this ProQuiz can update itself (compiled, a known system and version). `status()`: {stage, progress,
// error} for the host's banner (stage idle | downloading | checking | restarting | failed). `run(release)` does
// the whole thing; it never throws (the status says what went wrong) and resolves when the new program has been
// started (or the attempt failed). `beforeRestart` is the server's: save and close the listeners.
export function createSelfUpdate({
  version,
  exe = process.execPath,
  platform = process.platform,
  arch = process.arch,
  system = systemFor(platform, arch),
  compiled = isCompiled(),
  fetchImpl = globalThis.fetch,
  spawnImpl = spawn,
  relaunchImpl = relaunch,
  check = checkVersion,
  base = RELEASE_BASE,
  hosts = ALLOWED_HOSTS,
  args = process.argv.slice(2),
  env = process.env,
  beforeRestart = async () => {},
  exit = (code) => process.exit(code),
  onStatus = () => {},
  log = (msg) => console.log(msg),
  initialError = null,
} = {}) {
  let status = { stage: initialError ? 'failed' : 'idle', progress: null, error: initialError };
  const set = (patch) => {
    status = { ...status, ...patch };
    onStatus(status);
  };
  const available = () => Boolean(compiled && system && parseVersion(version) && exe);
  const busy = () => ['downloading', 'checking', 'restarting'].includes(status.stage);

  // The new program ended: pass its exit code on, or, when it died at once, put the old one back and start that.
  function handleExit({ early, code, error }, { port, rolledBack = false }) {
    if (!early || rolledBack) return exit(code ?? 0);
    log(`\n  The new ProQuiz did not start${error ? ` (${error.message})` : ''}. Putting the old one back…\n`);
    rollbackProgram(exe).then((ok) => {
      if (!ok) {
        log('  Could not put the old ProQuiz back. Please download ProQuiz again.');
        return exit(1);
      }
      const child = relaunchImpl({
        exe,
        args,
        env,
        extraEnv: { PORT: String(port), PROQUIZ_UPDATE_ERROR: 'restart' },
        spawnImpl,
        onExit: (r) => handleExit(r, { port, rolledBack: true }),
      });
      if (!child) exit(1);
    });
  }

  async function run(release, { port } = {}) {
    if (!available() || busy()) return false;
    const target = release?.version;
    if (!parseVersion(target)) return false;
    const asset = assetName(target, system);
    try {
      set({ stage: 'downloading', progress: 0, error: null });
      const sums = parseSums((await download(sumsUrl(target, base), { fetchImpl, hosts, maxBytes: MAX_SUMS })).toString('utf8'));
      if (!sums.has(asset)) throw new UpdateError('checksum', `${SUMS_FILE} has no line for ${asset}`);
      const zip = await download(assetUrl(target, system, base), { fetchImpl, hosts, maxBytes: MAX_ZIP, onProgress: (pct) => set({ progress: pct }) });
      set({ stage: 'checking', progress: null });
      if (!verifySum(sums, asset, zip)) throw new UpdateError('checksum', 'sha256 does not match');
      const { program, note } = pickFromZip(zip, system);
      await installProgram({ exe, program, note, version: target, system, platform, check, spawnImpl });
    } catch (err) {
      const code = err instanceof UpdateError ? err.code : 'download';
      log(`  Update failed: ${err?.message ?? err}`);
      set({ stage: 'failed', progress: null, error: code });
      return false;
    }
    set({ stage: 'restarting', progress: null });
    await beforeRestart().catch(() => {});
    log(`\n  Starting ProQuiz ${target}…\n`);
    const child = relaunchImpl({
      exe,
      args,
      env,
      extraEnv: { PORT: String(port ?? ''), PROQUIZ_UPDATED_FROM: String(version) },
      spawnImpl,
      onExit: (r) => handleExit(r, { port }),
    });
    return Boolean(child);
  }

  return { available, status: () => status, run, system, exe };
}

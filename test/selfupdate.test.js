// "Update now" (lib/selfupdate.js): the names per system, the download (allowed addresses and redirects only, size
// cap, timeout, progress), the checksum file, the zip reader (good zips from the zip command and hand-made bad ones),
// the swap and its rollback in a temporary folder with little shell scripts as "programs" (the real --version
// spawn), the restart with a pretend spawn, the whole run with a pretend release, and the real server: refused
// under npm start, outside the lobby, with no newer version, and never from the TV or over the tunnel's listener.
// Nothing here touches the internet.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  systemFor, programFile, noteFile, assetName, assetUrl, sumsUrl, programNames, isCompiled, allowedUrl, download, parseSums, sha256, verifySum,
  crc32, safeZipName, readZip, unzipEntry, pickFromZip, checkVersion, installProgram, rollbackProgram, cleanupOld, relaunch, createSelfUpdate,
  UpdateError, RELEASE_BASE, ALLOWED_HOSTS, MAX_ZIP, SUMS_FILE,
} from '../lib/selfupdate.js';
import { startServer } from '../server.js';
import { COLORS } from '../lib/game.js';

const tmp = mkdtempSync(join(tmpdir(), 'proquiz-selfupdate-'));
let n = 0;
const fresh = (name = 'd') => {
  const d = join(tmp, `${name}-${n++}`);
  mkdirSync(d, { recursive: true });
  return d;
};
// A "program": a shell script that answers --version with `says` (and exits with `code`), padded past 1 MB like a real one.
const script = (says, { code = 0, pad = true } = {}) => `#!/bin/sh\necho "${says}"\nexit ${code}\n` + (pad ? `# ${'x'.repeat(1_100_000)}\n` : '');
const writeExe = (file, text) => {
  writeFileSync(file, text);
  execFileSync('chmod', ['755', file]);
};

// A zip written by hand (stored, or deflated with method 8), so bad ones can be made too.
function makeZip(files, { method = 0, badCrc = false, flags = 0, zip64 = false } = {}) {
  const parts = [];
  const cd = [];
  let offset = 0;
  for (const f of files) {
    const data = Buffer.from(f.data);
    const comp = method === 8 ? deflateRawSync(data) : data;
    const crc = badCrc ? (crc32(data) ^ 1) >>> 0 : crc32(data);
    const name = Buffer.from(f.name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(f.method ?? method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, comp);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(flags, 8);
    c.writeUInt16LE(f.method ?? method, 10);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(comp.length, 20);
    c.writeUInt32LE(zip64 ? 0xffffffff : data.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(offset, 42);
    cd.push(c, name);
    offset += 30 + name.length + comp.length;
  }
  const cdBuf = Buffer.concat(cd);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cdBuf, eocd]);
}

// A pretend release on a pretend GitHub: SHA256SUMS.txt and the zip, with GitHub's redirect to the file host.
// `slow` streams the zip in small pieces; `sums` and `status` can be wrong on purpose.
function fakeRelease({ zip, version = '9.9.0', system = 'linux-x64', sums = null, status = 200, redirectTo = 'https://objects.githubusercontent.com/x/y', slow = false, chunk = 0 } = {}) {
  const calls = [];
  const asset = assetName(version, system);
  const sumsText = sums ?? `${sha256(zip)}  ${asset}\n0000000000000000000000000000000000000000000000000000000000000000  ProQuiz-${version}-windows.zip\n`;
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url, opts });
    if (url.endsWith(`/${SUMS_FILE}`)) return new Response(sumsText, { status: 200 });
    if (url.endsWith(`/${asset}`)) return redirectTo ? new Response(null, { status: 302, headers: { location: redirectTo } }) : body();
    if (redirectTo && url === redirectTo) return body();
    return new Response('nope', { status: 404 });
  };
  function body() {
    if (status !== 200) return new Response('nope', { status });
    const size = chunk || Math.max(1, Math.ceil(zip.length / 20));
    let at = 0;
    const stream = new ReadableStream({
      async pull(controller) {
        if (at >= zip.length) return controller.close();
        if (slow) await new Promise((r) => setTimeout(r, 5));
        controller.enqueue(new Uint8Array(zip.subarray(at, at + size)));
        at += size;
      },
    });
    return new Response(stream, { status: 200, headers: { 'content-length': String(zip.length) } });
  }
  return { calls, fetchImpl, asset };
}

// A pretend spawn for relaunch(): remembers what it was asked and gives a child whose exit the test decides.
// The --version check of a freshly written program still really runs it (a little shell script here).
function fakeSpawn({ throwOn = false } = {}) {
  const calls = [];
  const spawnImpl = (file, args, opts) => {
    if (args[0] === '--version') {
      calls.push({ file, args, opts, child: null });
      return spawn(file, args, opts);
    }
    if (throwOn) throw new Error('spawn EACCES');
    const child = new EventEmitter();
    calls.push({ file, args, opts, child });
    return child;
  };
  return { calls, spawnImpl };
}

test('names: the release name for each system, the asset and its address, the files next to the program', () => {
  assert.equal(systemFor('win32', 'x64'), 'windows');
  assert.equal(systemFor('darwin', 'arm64'), 'mac-apple-silicon');
  assert.equal(systemFor('darwin', 'x64'), 'mac-intel');
  assert.equal(systemFor('linux', 'x64'), 'linux-x64');
  assert.equal(systemFor('linux', 'arm64'), 'linux-arm64');
  assert.equal(systemFor('win32', 'arm64'), null);
  assert.equal(systemFor('freebsd', 'x64'), null);
  assert.equal(programFile('windows'), 'ProQuiz.exe');
  assert.equal(programFile('linux-x64'), 'ProQuiz');
  assert.equal(noteFile('windows'), 'START HERE.txt');
  assert.equal(noteFile('mac-intel'), 'START-HERE.txt');
  assert.equal(assetName('2.3.0', 'mac-intel'), 'ProQuiz-2.3.0-mac-intel.zip');
  assert.equal(assetUrl('2.3.0', 'windows'), 'https://github.com/dbugger85/proquiz/releases/download/v2.3.0/ProQuiz-2.3.0-windows.zip');
  assert.equal(sumsUrl('2.3.0'), 'https://github.com/dbugger85/proquiz/releases/download/v2.3.0/SHA256SUMS.txt');
  assert.deepEqual(programNames('C:\\Users\\me\\ProQuiz\\ProQuiz.exe'), {
    exe: 'C:\\Users\\me\\ProQuiz\\ProQuiz.exe',
    newFile: 'C:\\Users\\me\\ProQuiz\\ProQuiz.new.exe',
    oldFile: 'C:\\Users\\me\\ProQuiz\\ProQuiz.old.exe',
    failedFile: 'C:\\Users\\me\\ProQuiz\\ProQuiz.failed.exe',
  });
  assert.deepEqual(programNames('/home/me/ProQuiz/ProQuiz'), { exe: '/home/me/ProQuiz/ProQuiz', newFile: '/home/me/ProQuiz/ProQuiz.new', oldFile: '/home/me/ProQuiz/ProQuiz.old', failedFile: '/home/me/ProQuiz/ProQuiz.failed' });
});

test('isCompiled: Deno with the program as its own path, never plain Node or the deno command', () => {
  assert.equal(isCompiled({ deno: {}, execPath: '/Users/me/ProQuiz/ProQuiz' }), true);
  assert.equal(isCompiled({ deno: {}, execPath: 'C:\\Users\\me\\ProQuiz\\ProQuiz.exe' }), true);
  assert.equal(isCompiled({ deno: {}, execPath: '/usr/bin/deno' }), false);
  assert.equal(isCompiled({ deno: {}, execPath: 'C:\\tools\\deno.exe' }), false);
  assert.equal(isCompiled({ deno: undefined, execPath: '/usr/bin/node' }), false);
  assert.equal(isCompiled({ deno: {}, execPath: '' }), false);
  assert.equal(isCompiled(), false, 'the tests run in Node');
});

test('allowedUrl: https on the allowed hosts only; http only for a test’s own 127.0.0.1', () => {
  assert.equal(allowedUrl('https://github.com/dbugger85/proquiz/releases/download/v2.3.0/x.zip'), true);
  assert.equal(allowedUrl('https://objects.githubusercontent.com/a/b'), true);
  assert.equal(allowedUrl('https://release-assets.githubusercontent.com/a/b'), true);
  assert.equal(allowedUrl('http://github.com/x'), false);
  assert.equal(allowedUrl('https://evil.example/x'), false);
  assert.equal(allowedUrl('https://github.com.evil.example/x'), false);
  assert.equal(allowedUrl('https://user:pw@github.com/x'), false);
  assert.equal(allowedUrl('https://127.0.0.1/x'), false);
  assert.equal(allowedUrl('http://127.0.0.1:8080/x', ['127.0.0.1']), true);
  assert.equal(allowedUrl('http://evil.example/x', ['evil.example']), false, 'http only for this computer');
  assert.equal(allowedUrl('not a url'), false);
  assert.deepEqual(ALLOWED_HOSTS, ['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']);
});

test('download: follows GitHub’s redirect, sends a User-Agent, reports whole percentages, gives the bytes', async () => {
  const zip = Buffer.alloc(5000, 7);
  const rel = fakeRelease({ zip, slow: true });
  const pcts = [];
  const got = await download(assetUrl('9.9.0', 'linux-x64'), { fetchImpl: rel.fetchImpl, onProgress: (p) => pcts.push(p) });
  assert.ok(got.equals(zip));
  assert.equal(rel.calls.length, 2);
  assert.equal(rel.calls[0].opts.redirect, 'manual');
  assert.match(rel.calls[0].opts.headers['User-Agent'], /^ProQuiz\//);
  assert.equal(rel.calls[1].url, 'https://objects.githubusercontent.com/x/y');
  assert.equal(pcts[0], 0);
  assert.equal(pcts.at(-1), 100);
  assert.ok(pcts.every((p, i) => i === 0 || p > pcts[i - 1]), 'only goes up');
  assert.ok(pcts.length > 5 && pcts.length <= 101);
});

test('download: refuses a redirect off the allowed hosts, http, too many hops, errors and files too big', async () => {
  const zip = Buffer.alloc(3000, 1);
  const code = async (p) => {
    try {
      await p;
      return 'ok';
    } catch (err) {
      assert.ok(err instanceof UpdateError, String(err));
      return err.message; // "<code>: <why>"
    }
  };
  assert.match(await code(download(assetUrl('9.9.0', 'linux-x64'), { fetchImpl: fakeRelease({ zip, redirectTo: 'https://evil.example/x.zip' }).fetchImpl })), /^download: not an allowed/);
  assert.match(await code(download(assetUrl('9.9.0', 'linux-x64'), { fetchImpl: fakeRelease({ zip, redirectTo: 'http://objects.githubusercontent.com/x' }).fetchImpl })), /^download: not an allowed/);
  assert.match(await code(download('http://github.com/x.zip', { fetchImpl: fakeRelease({ zip }).fetchImpl })), /^download: not an allowed/);
  assert.match(await code(download(assetUrl('9.9.0', 'linux-x64'), { fetchImpl: fakeRelease({ zip, status: 404 }).fetchImpl })), /^download: HTTP 404/);
  assert.match(await code(download(assetUrl('9.9.0', 'windows'), { fetchImpl: fakeRelease({ zip }).fetchImpl })), /^download: HTTP 404/, 'no such file');
  // Redirects that never end.
  const loop = async (url) => new Response(null, { status: 302, headers: { location: url.endsWith('/9') ? url : url + '/9' } });
  assert.match(await code(download('https://github.com/a', { fetchImpl: loop })), /^download: too many redirects/);
  // Too big: said up front, or while streaming.
  assert.match(await code(download(assetUrl('9.9.0', 'linux-x64'), { fetchImpl: fakeRelease({ zip }).fetchImpl, maxBytes: 2999 })), /^download: too big/);
  const lying = async () => new Response(new ReadableStream({ start: (c) => (c.enqueue(new Uint8Array(4000)), c.close()) }), { status: 200, headers: { 'content-length': '10' } });
  assert.match(await code(download('https://github.com/a', { fetchImpl: lying })), /^download: too big/);
  // Network trouble and an answer that never comes.
  assert.match(await code(download('https://github.com/a', { fetchImpl: async () => Promise.reject(new TypeError('fetch failed')) })), /^download: fetch failed/);
  const never = (url, opts) => new Promise((_, reject) => opts.signal.addEventListener('abort', () => reject(new Error('aborted'))));
  const t0 = Date.now();
  assert.match(await code(download('https://github.com/a', { fetchImpl: never, idleMs: 30 })), /^download: timed out/);
  assert.ok(Date.now() - t0 < 2000);
  // A stream that stops sending.
  const stalls = async () => new Response(new ReadableStream({ pull: () => new Promise(() => {}) }), { status: 200, headers: { 'content-length': '100' } });
  assert.match(await code(download('https://github.com/a', { fetchImpl: stalls, idleMs: 30 })), /^download: timed out/);
  // Cut short.
  const short = async () => new Response(new ReadableStream({ start: (c) => (c.enqueue(new Uint8Array(5)), c.close()) }), { status: 200, headers: { 'content-length': '10' } });
  assert.match(await code(download('https://github.com/a', { fetchImpl: short })), /^download: cut short/);
  assert.equal(MAX_ZIP, 200 * 1024 * 1024);
});

test('checksums: sha256sum’s format is read, and only an exact match passes', () => {
  const data = Buffer.from('hello');
  const h = sha256(data);
  assert.equal(h, '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  const sums = parseSums(`${h}  ProQuiz-9.9.0-linux-x64.zip\r\n${h.toUpperCase()} *ProQuiz-9.9.0-windows.zip\nnot a line\n\n`);
  assert.deepEqual([...sums.keys()], ['ProQuiz-9.9.0-linux-x64.zip', 'ProQuiz-9.9.0-windows.zip']);
  assert.equal(sums.get('ProQuiz-9.9.0-windows.zip'), h);
  assert.equal(verifySum(sums, 'ProQuiz-9.9.0-linux-x64.zip', data), true);
  assert.equal(verifySum(sums, 'ProQuiz-9.9.0-linux-x64.zip', Buffer.from('hellp')), false);
  assert.equal(verifySum(sums, 'ProQuiz-9.9.0-mac-intel.zip', data), false);
  assert.equal(parseSums(null).size, 0);
});

test('zip reader: a real zip from the zip command (deflated text, a stored big file, a folder) and the names', () => {
  const dir = fresh('zip');
  const folder = join(dir, 'ProQuiz-9.9.0-linux-x64');
  mkdirSync(folder);
  const program = Buffer.from(script('9.9.0'));
  writeFileSync(join(folder, 'ProQuiz'), program);
  writeFileSync(join(folder, 'START-HERE.txt'), 'ProQuiz 9.9.0\n\n1. Run ./ProQuiz\n'.repeat(20));
  execFileSync('zip', ['-q', '-r', '-X', 'out.zip', 'ProQuiz-9.9.0-linux-x64'], { cwd: dir });
  const zip = readFileSync(join(dir, 'out.zip'));
  const entries = readZip(zip);
  const names = entries.map((e) => e.name).sort();
  assert.deepEqual(names, ['ProQuiz-9.9.0-linux-x64/', 'ProQuiz-9.9.0-linux-x64/ProQuiz', 'ProQuiz-9.9.0-linux-x64/START-HERE.txt']);
  const note = entries.find((e) => e.name.endsWith('START-HERE.txt'));
  assert.equal(note.method, 8, 'repeated text is deflated');
  assert.equal(unzipEntry(zip, note).toString(), 'ProQuiz 9.9.0\n\n1. Run ./ProQuiz\n'.repeat(20));
  const prog = entries.find((e) => e.name.endsWith('/ProQuiz'));
  assert.ok(unzipEntry(zip, prog).equals(program));
  const picked = pickFromZip(zip, 'linux-x64');
  assert.ok(picked.program.equals(program));
  assert.match(picked.note.toString(), /^ProQuiz 9\.9\.0/);
  assert.throws(() => pickFromZip(zip, 'windows'), /no program file/);

  assert.equal(safeZipName('ProQuiz-9.9.0-linux-x64/ProQuiz'), true);
  assert.equal(safeZipName('ProQuiz'), true);
  assert.equal(safeZipName('../ProQuiz'), false);
  assert.equal(safeZipName('a/../../ProQuiz'), false);
  assert.equal(safeZipName('/etc/passwd'), false);
  assert.equal(safeZipName('C:/Windows/x'), false);
  assert.equal(safeZipName('a\\b'), false);
  assert.equal(safeZipName('a\u0000b'), false);
  assert.equal(safeZipName(''), false);
});

test('zip reader: hand-made zips, stored and deflated, and every kind of bad one is refused', () => {
  const program = script('9.9.0');
  const good = [
    { name: 'ProQuiz-9.9.0-linux-x64/ProQuiz', data: program },
    { name: 'ProQuiz-9.9.0-linux-x64/START-HERE.txt', data: 'hi' },
  ];
  for (const method of [0, 8]) {
    const picked = pickFromZip(makeZip(good, { method }), 'linux-x64');
    assert.equal(picked.program.toString(), program);
    assert.equal(picked.note.toString(), 'hi');
  }
  // Windows: the program at the top of the zip, note with a space in its name.
  const win = pickFromZip(makeZip([{ name: 'ProQuiz.exe', data: program }, { name: 'START HERE.txt', data: 'win' }]), 'windows');
  assert.equal(win.note.toString(), 'win');
  // No note is fine.
  assert.equal(pickFromZip(makeZip([{ name: 'ProQuiz', data: program }]), 'linux-x64').note, null);
  const refused = (zip, system = 'linux-x64') => {
    try {
      pickFromZip(zip, system);
      return 'ok';
    } catch (err) {
      assert.ok(err instanceof UpdateError);
      return err.message;
    }
  };
  assert.match(refused(makeZip([{ name: '../ProQuiz', data: program }])), /^unpack: unsafe name/);
  assert.match(refused(makeZip([{ name: '/ProQuiz', data: program }])), /^unpack: unsafe name/);
  assert.match(refused(makeZip([{ name: 'a/b/ProQuiz', data: program }])), /^unpack: no program file/, 'too deep');
  assert.match(refused(makeZip([{ name: 'x/ProQuiz', data: program }, { name: 'y/ProQuiz', data: program }])), /^unpack: no program file/, 'two of them');
  assert.match(refused(makeZip([{ name: 'ProQuiz', data: 'tiny' }])), /^unpack: program file too small/);
  assert.match(refused(makeZip(good, { badCrc: true })), /^unpack: .* is damaged/);
  assert.match(refused(makeZip(good, { flags: 1 })), /^unpack: encrypted/);
  assert.match(refused(makeZip([{ name: 'ProQuiz', data: program, method: 12 }])), /^unpack: compression 12/);
  assert.match(refused(makeZip(good, { zip64: true })), /^unpack: zip64/);
  assert.match(refused(Buffer.from('PK not really a zip')), /^unpack: not a zip/);
  assert.match(refused(Buffer.alloc(100)), /^unpack: no central directory/);
  // Deflated data that is garbage.
  const broken = makeZip(good, { method: 8 });
  const entry = readZip(broken).find((e) => e.name.endsWith('/ProQuiz'));
  broken.fill(0xff, entry.offset + 30 + entry.name.length, entry.offset + 30 + entry.name.length + 40);
  assert.match(refused(broken), /^unpack: (bad deflate data|.* is damaged)/);
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
});

test('checkVersion: what the program printed, or a refusal when it fails, says nothing useful or hangs', async () => {
  const dir = fresh('ver');
  writeExe(join(dir, 'ok'), script('9.9.0', { pad: false }));
  writeExe(join(dir, 'bad'), script('oops', { code: 2, pad: false }));
  writeExe(join(dir, 'hang'), '#!/bin/sh\nsleep 5\n');
  assert.equal(await checkVersion(join(dir, 'ok')), '9.9.0');
  await assert.rejects(checkVersion(join(dir, 'bad')), /exit 2/);
  await assert.rejects(checkVersion(join(dir, 'missing')), /ENOENT/);
  const t0 = Date.now();
  await assert.rejects(checkVersion(join(dir, 'hang'), { timeoutMs: 100 }), /took too long/);
  assert.ok(Date.now() - t0 < 3000);
});

test('installProgram: writes ProQuiz.new, runs --version, then swaps; the old one is kept as ProQuiz.old', async () => {
  const dir = fresh('swap');
  const exe = join(dir, 'ProQuiz');
  writeExe(exe, script('2.2.1'));
  const program = Buffer.from(script('9.9.0'));
  const names = await installProgram({ exe, program, version: '9.9.0', note: Buffer.from('new note'), system: 'linux-x64' });
  assert.ok(readFileSync(exe).equals(program), 'the new program is in place');
  assert.equal(readFileSync(names.oldFile, 'utf8'), script('2.2.1'), 'the old one is kept');
  assert.equal(existsSync(names.newFile), false);
  assert.ok(statSync(exe).mode & 0o100, 'executable');
  assert.equal(readFileSync(join(dir, 'START-HERE.txt'), 'utf8'), 'new note');
  assert.equal(await checkVersion(exe), '9.9.0', 'and it runs');
  // Again: the old .old is replaced, not a problem.
  await installProgram({ exe, program: Buffer.from(script('9.9.1')), version: '9.9.1', system: 'linux-x64' });
  assert.ok(readFileSync(names.oldFile).equals(program));
  await cleanupOld(exe);
  assert.deepEqual(readdirSync(dir).sort(), ['ProQuiz', 'START-HERE.txt']);
});

test('installProgram: a new program that says the wrong version, fails or hangs changes nothing', async () => {
  const dir = fresh('swapbad');
  const exe = join(dir, 'ProQuiz');
  writeExe(exe, script('2.2.1'));
  const unchanged = () => {
    assert.equal(readFileSync(exe, 'utf8'), script('2.2.1'));
    assert.deepEqual(readdirSync(dir), ['ProQuiz'], 'no .new or .old left behind');
  };
  const code = async (p) => {
    try {
      await p;
      return 'ok';
    } catch (err) {
      assert.ok(err instanceof UpdateError, String(err));
      return err.code;
    }
  };
  assert.equal(await code(installProgram({ exe, program: Buffer.from(script('9.9.1')), version: '9.9.0', system: 'linux-x64' })), 'start');
  unchanged();
  assert.equal(await code(installProgram({ exe, program: Buffer.from(script('9.9.0', { code: 1 })), version: '9.9.0', system: 'linux-x64' })), 'start');
  unchanged();
  assert.equal(await code(installProgram({ exe, program: Buffer.from('#!/bin/sh\nsleep 5\n'), version: '9.9.0', system: 'linux-x64', check: (f) => checkVersion(f, { timeoutMs: 100 }) })), 'start');
  unchanged();
  assert.equal(await code(installProgram({ exe, program: Buffer.from('not a program at all'), version: '9.9.0', system: 'linux-x64' })), 'start');
  unchanged();
  // The running program can't be moved aside (something sits where ProQuiz.old would go): nothing changes.
  mkdirSync(join(dir, 'ProQuiz.old'));
  writeFileSync(join(dir, 'ProQuiz.old', 'busy'), 'x');
  assert.equal(await code(installProgram({ exe, program: Buffer.from(script('9.9.0')), version: '9.9.0', system: 'linux-x64' })), 'swap');
  assert.equal(readFileSync(exe, 'utf8'), script('2.2.1'));
  assert.equal(existsSync(join(dir, 'ProQuiz.new')), false);
});

test('rollbackProgram: the old program comes back and the new one is kept as .failed; cleanupOld tidies', async () => {
  const dir = fresh('rb');
  const exe = join(dir, 'ProQuiz');
  writeFileSync(exe, 'new');
  writeFileSync(`${exe}.old`, 'old');
  assert.equal(await rollbackProgram(exe), true);
  assert.equal(readFileSync(exe, 'utf8'), 'old');
  assert.equal(readFileSync(`${exe}.failed`, 'utf8'), 'new');
  assert.equal(existsSync(`${exe}.old`), false);
  // Nothing to roll back to: the program stays as it is.
  assert.equal(await rollbackProgram(exe), false);
  assert.equal(readFileSync(exe, 'utf8'), 'old');
  writeFileSync(`${exe}.new`, 'x');
  await cleanupOld(exe);
  assert.deepEqual(readdirSync(dir), ['ProQuiz']);
  await cleanupOld(join(dir, 'nothing', 'here')); // never throws
});

test('relaunch: the new program takes over this window with the port and the old version in its environment', async () => {
  const sp = fakeSpawn();
  const exits = [];
  const env = { PATH: '/bin', PROQUIZ_UPDATED_FROM: '1.0.0', PROQUIZ_UPDATE_ERROR: 'restart', HOME: '/h' };
  let now = 1000;
  const child = relaunch({ exe: '/x/ProQuiz', args: ['--flag'], env, extraEnv: { PORT: '3000', PROQUIZ_UPDATED_FROM: '2.2.1' }, spawnImpl: sp.spawnImpl, onExit: (r) => exits.push(r), now: () => now });
  assert.equal(sp.calls.length, 1);
  const [call] = sp.calls;
  assert.equal(call.file, '/x/ProQuiz');
  assert.deepEqual(call.args, ['--flag']);
  assert.equal(call.opts.stdio, 'inherit', 'the same window');
  assert.equal(call.opts.detached, undefined);
  assert.deepEqual(call.opts.env, { PATH: '/bin', HOME: '/h', PORT: '3000', PROQUIZ_UPDATED_FROM: '2.2.1' }, 'an earlier restart’s notes are not passed on');
  assert.equal(child, call.child);
  // Ended with an error right away: early. Ended fine, or long after: not.
  child.emit('exit', 1, null);
  assert.deepEqual(exits, [{ early: true, code: 1, signal: null, error: null }]);
  child.emit('exit', 1, null);
  assert.equal(exits.length, 1, 'once');
  const fine = relaunch({ exe: '/x/ProQuiz', spawnImpl: sp.spawnImpl, env: {}, onExit: (r) => exits.push(r), now: () => now });
  fine.emit('exit', 0, null);
  assert.equal(exits.at(-1).early, false);
  const later = relaunch({ exe: '/x/ProQuiz', spawnImpl: sp.spawnImpl, env: {}, onExit: (r) => exits.push(r), now: () => now });
  now += 60_000;
  later.emit('exit', 1, null);
  assert.equal(exits.at(-1).early, false, 'an error after a minute is not a failed start');
  const killed = relaunch({ exe: '/x/ProQuiz', spawnImpl: sp.spawnImpl, env: {}, onExit: (r) => exits.push(r), now: () => now });
  killed.emit('exit', null, 'SIGINT');
  assert.deepEqual(exits.at(-1), { early: false, code: null, signal: 'SIGINT', error: null });
  // Could not be started at all.
  const failing = relaunch({ exe: '/x/ProQuiz', spawnImpl: sp.spawnImpl, env: {}, onExit: (r) => exits.push(r), now: () => now });
  failing.emit('error', new Error('EACCES'));
  assert.equal(exits.at(-1).early, true);
  assert.equal(exits.at(-1).error.message, 'EACCES');
  const none = relaunch({ exe: '/x/ProQuiz', spawnImpl: fakeSpawn({ throwOn: true }).spawnImpl, env: {}, onExit: (r) => exits.push(r) });
  assert.equal(none, null);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(exits.at(-1).error.message, 'spawn EACCES');
});

// A self-update wired to a pretend release, a real swap in a temporary folder and a pretend restart.
function setup({ version = '2.2.1', newVersion = '9.9.0', zip = null, compiled = true, system = 'linux-x64', ...rest } = {}) {
  const dir = fresh('run');
  const exe = join(dir, 'ProQuiz');
  writeExe(exe, script(version));
  const program = script(newVersion);
  zip ??= makeZip([{ name: `ProQuiz-${newVersion}-${system}/ProQuiz`, data: program }, { name: `ProQuiz-${newVersion}-${system}/START-HERE.txt`, data: 'note' }], { method: 8 });
  const rel = fakeRelease({ zip, version: newVersion, system, ...rest.release });
  const sp = fakeSpawn();
  const statuses = [];
  const exits = [];
  const before = [];
  const logs = [];
  const su = createSelfUpdate({
    version,
    exe,
    platform: 'linux',
    arch: 'x64',
    system,
    compiled,
    fetchImpl: rel.fetchImpl,
    spawnImpl: sp.spawnImpl,
    args: ['--x'],
    env: { PATH: '/bin' },
    beforeRestart: async () => before.push(Date.now()),
    exit: (code) => exits.push(code),
    onStatus: (s) => statuses.push(s),
    log: (m) => logs.push(m),
    ...rest.options,
  });
  return { dir, exe, program, zip, rel, sp, statuses, exits, before, logs, su };
}
const release = (version = '9.9.0') => ({ version, url: `https://github.com/dbugger85/proquiz/releases/tag/v${version}`, notes: '' });

test('run(): download → checking → swap → restarting, the server saves and closes first, the new program is started', async () => {
  const s = setup();
  assert.equal(s.su.available(), true);
  assert.deepEqual(s.su.status(), { stage: 'idle', progress: null, error: null });
  assert.equal(await s.su.run(release(), { port: 3456 }), true);
  const stages = [...new Set(s.statuses.map((x) => x.stage))];
  assert.deepEqual(stages, ['downloading', 'checking', 'restarting']);
  const pcts = s.statuses.filter((x) => x.stage === 'downloading').map((x) => x.progress);
  assert.equal(pcts[0], 0);
  assert.equal(pcts.at(-1), 100);
  assert.deepEqual(s.su.status(), { stage: 'restarting', progress: null, error: null });
  assert.equal(readFileSync(s.exe, 'utf8'), s.program, 'swapped');
  assert.equal(readFileSync(`${s.exe}.old`, 'utf8'), script('2.2.1'));
  assert.equal(readFileSync(join(s.dir, 'START-HERE.txt'), 'utf8'), 'note');
  assert.equal(s.before.length, 1, 'the server saved and closed');
  assert.equal(s.sp.calls.length, 2, 'the --version check, then the restart');
  assert.deepEqual(s.sp.calls[0].args, ['--version']);
  const start = s.sp.calls[1];
  assert.equal(start.file, s.exe);
  assert.deepEqual(start.args, ['--x']);
  assert.equal(start.opts.stdio, 'inherit');
  assert.deepEqual(start.opts.env, { PATH: '/bin', PORT: '3456', PROQUIZ_UPDATED_FROM: '2.2.1' });
  assert.equal(s.rel.calls[0].url, sumsUrl('9.9.0'), 'the checksums first');
  // The new program runs for a long time and then ends: the old one ends the same way.
  assert.deepEqual(s.exits, []);
  start.child.emit('exit', 0, null);
  assert.deepEqual(s.exits, [0]);
  // A second run while one is on its way does nothing.
  assert.equal(await s.su.run(release(), { port: 3456 }), false);
});

test('run(): the new program dies at once → the old one is put back and started with the error', async () => {
  const s = setup();
  await s.su.run(release(), { port: 3456 });
  const start = s.sp.calls[1];
  start.child.emit('exit', 1, null);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(readFileSync(s.exe, 'utf8'), script('2.2.1'), 'the old program is back');
  assert.equal(readFileSync(`${s.exe}.failed`, 'utf8'), s.program);
  assert.equal(existsSync(`${s.exe}.old`), false);
  assert.equal(s.sp.calls.length, 3);
  const again = s.sp.calls[2];
  assert.equal(again.file, s.exe);
  assert.deepEqual(again.opts.env, { PATH: '/bin', PORT: '3456', PROQUIZ_UPDATE_ERROR: 'restart' });
  assert.deepEqual(s.exits, []);
  again.child.emit('exit', 1, null); // even if that one fails too, it isn't rolled back again
  assert.deepEqual(s.exits, [1]);
  assert.ok(s.logs.some((l) => /did not start/.test(l)));
});

test('run(): a wrong checksum, a missing line, a failed download, a bad zip or a program that won’t start change nothing', async () => {
  const failed = async (opts) => {
    const s = setup(opts);
    assert.equal(await s.su.run(release(), { port: 1 }), false);
    assert.equal(s.su.status().stage, 'failed');
    assert.equal(readFileSync(s.exe, 'utf8'), script('2.2.1'), 'untouched');
    assert.deepEqual(readdirSync(s.dir), ['ProQuiz'], 'nothing left behind');
    assert.equal(s.before.length, 0, 'the server kept running');
    assert.equal(s.sp.calls.filter((c) => c.args[0] !== '--version').length, 0, 'nothing restarted');
    return s.su.status().error;
  };
  const program = script('9.9.0');
  const zip = makeZip([{ name: 'ProQuiz-9.9.0-linux-x64/ProQuiz', data: program }]);
  assert.equal(await failed({ zip, release: { sums: `${sha256(Buffer.from('other'))}  ProQuiz-9.9.0-linux-x64.zip\n` } }), 'checksum');
  assert.equal(await failed({ zip, release: { sums: 'nothing here\n' } }), 'checksum');
  assert.equal(await failed({ zip, release: { status: 500 } }), 'download');
  assert.equal(await failed({ zip, release: { redirectTo: 'https://evil.example/x' } }), 'download');
  assert.equal(await failed({ zip: Buffer.from('garbage'.repeat(200)) }), 'unpack');
  assert.equal(await failed({ zip: makeZip([{ name: '../ProQuiz', data: program }]) }), 'unpack');
  assert.equal(await failed({ zip: makeZip([{ name: 'ProQuiz', data: script('9.9.1') }]) }), 'start', 'says the wrong version');
  assert.equal(await failed({ zip: makeZip([{ name: 'ProQuiz', data: script('9.9.0', { code: 3 }) }]) }), 'start');
  // After a failure a new try starts again.
  const s = setup();
  s.su.run(release(), { port: 1 });
  assert.equal(s.su.status().stage, 'downloading');
});

test('run(): not available under Node (not compiled), without a system or a version, or for a nonsense release', async () => {
  assert.equal(setup({ compiled: false }).su.available(), false);
  assert.equal(await setup({ compiled: false }).su.run(release(), { port: 1 }), false);
  assert.equal(setup({ system: null }).su.available(), false);
  assert.equal(setup({ version: 'dev' }).su.available(), false);
  assert.equal(createSelfUpdate({ version: '2.2.1', compiled: true, system: 'linux-x64', exe: '' }).available(), false);
  const s = setup();
  assert.equal(await s.su.run({ version: 'latest' }, { port: 1 }), false);
  assert.equal(await s.su.run(null, { port: 1 }), false);
  assert.equal(s.rel.calls.length, 0);
  // Told by the previous program that the update failed: the banner starts with that error.
  const told = createSelfUpdate({ version: '2.2.1', compiled: true, system: 'linux-x64', exe: '/x', initialError: 'restart' });
  assert.deepEqual(told.status(), { stage: 'failed', progress: null, error: 'restart' });
  assert.equal(RELEASE_BASE, 'https://github.com/dbugger85/proquiz/releases/download/');
});

// ----- the real server -----

const dataDir = join(tmp, 'data');
const TAG_URL = (v) => `https://github.com/dbugger85/proquiz/releases/tag/v${v}`;
const fakeGitHub = (tag) => async () => ({ status: 200, json: async () => ({ tag_name: tag, html_url: TAG_URL(tag.slice(1)), body: 'New.' }) });

async function client(url, role) {
  const ws = new WebSocket(url);
  const msgs = [];
  const waiters = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    msgs.push(m);
    for (const w of [...waiters]) if (w.test(m)) {
      waiters.splice(waiters.indexOf(w), 1);
      w.resolve(m);
    }
  };
  await new Promise((r) => (ws.onopen = r));
  const c = {
    ws,
    msgs,
    send: (m) => ws.send(JSON.stringify(m)),
    wait(test, ms = 3000) {
      const found = msgs.find(test);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        waiters.push({ test, resolve });
        setTimeout(() => reject(new Error('timed out waiting')), ms);
      });
    },
    close: () => ws.close(),
  };
  c.send({ type: 'hello', role });
  await c.wait((m) => m.type === 'welcome' || m.type === 'error');
  return c;
}
const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));
const WS = (srv) => `ws://127.0.0.1:${srv.info.port}/ws`;

test('server: under npm start (not compiled) the host sees no Update now, and updateNow is refused', async () => {
  const srv = await startServer({ port: 3521, quiet: true, dataDir: join(dataDir, 'node'), updateOptions: { fetchImpl: fakeGitHub('v9.9.0') } });
  try {
    const host = await client(WS(srv), 'host');
    const s = await host.wait((m) => m.type === 'state' && m.update);
    assert.equal(s.update.version, '9.9.0');
    assert.equal(s.update.canInstall, false);
    assert.equal(s.update.install.stage, 'idle');
    host.send({ type: 'updateNow' });
    assert.equal((await host.wait((m) => m.type === 'error')).code, 'update-not-here');
    host.close();
  } finally {
    await srv.close();
  }
});

test('server: compiled, but no newer version → refused; in a game → refused; the TV and the tunnel’s listener can’t ask', async () => {
  const dir = fresh('srv');
  const exe = join(dir, 'ProQuiz');
  writeExe(exe, script('2.2.1'));
  const sp = fakeSpawn();
  const same = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  const srv = await startServer({
    port: 3522,
    quiet: true,
    dataDir: join(dataDir, 'same'),
    updateOptions: { fetchImpl: fakeGitHub(`v${same}`) },
    selfUpdateOptions: { compiled: true, exe, system: 'linux-x64', fetchImpl: fakeRelease({ zip: Buffer.alloc(10) }).fetchImpl, spawnImpl: sp.spawnImpl, beforeRestart: async () => {} },
  });
  try {
    assert.equal(srv.selfUpdate.available(), true);
    const host = await client(WS(srv), 'host');
    await host.wait((m) => m.type === 'state');
    await settle();
    assert.ok(host.msgs.every((m) => !m.update), 'the same version: nothing to install');
    host.send({ type: 'updateNow' });
    assert.equal((await host.wait((m) => m.type === 'error')).code, 'update-none');
    // A TV asking is simply ignored.
    const tv = await client(WS(srv), 'display');
    tv.send({ type: 'updateNow' });
    await settle();
    assert.ok(tv.msgs.every((m) => m.type !== 'error'));
    // Over the tunnel's listener nobody is the host at all.
    const port = await srv.openRemote();
    const remote = await client(`ws://127.0.0.1:${port}/ws`, 'host');
    assert.equal(remote.msgs.find((m) => m.type === 'error')?.code, 'host-only-on-laptop');
    remote.send({ type: 'updateNow' });
    await settle();
    assert.equal(remote.msgs.filter((m) => m.type === 'error').length, 1);
    // During a game: refused even when a newer version were known.
    srv.hub.dispatch({ type: 'join', teamId: 'team-aaaaaaaa', name: 'Red', color: COLORS[0] });
    srv.hub.dispatch({ type: 'start', picker: 'team-aaaaaaaa', seed: 1 });
    assert.notEqual(srv.hub.getState().phase, 'lobby');
    host.send({ type: 'updateNow' });
    const errs = [];
    await host.wait((m) => m.type === 'error' && errs.push(m.code) && errs.length === 2);
    assert.equal(errs[1], 'update-in-game');
    assert.equal(sp.calls.length, 0, 'nothing was downloaded, checked or started');
    assert.equal(readFileSync(exe, 'utf8'), script('2.2.1'));
    for (const c of [host, tv, remote]) c.close();
  } finally {
    await srv.close();
  }
});

test('server: the whole thing with a pretend release: Update now in the state, progress messages to the host only, the swap, the restart', async () => {
  const dir = fresh('srvrun');
  const exe = join(dir, 'ProQuiz');
  writeExe(exe, script('2.2.1'));
  const program = script('9.9.0');
  const zip = makeZip([{ name: 'ProQuiz-9.9.0-linux-x64/ProQuiz', data: program }], { method: 8 });
  const rel = fakeRelease({ zip, slow: true });
  const sp = fakeSpawn();
  const saved = [];
  const srv = await startServer({
    port: 3523,
    quiet: true,
    dataDir: join(dataDir, 'run'),
    updateOptions: { fetchImpl: fakeGitHub('v9.9.0') },
    selfUpdateOptions: { compiled: true, exe, system: 'linux-x64', fetchImpl: rel.fetchImpl, spawnImpl: sp.spawnImpl, beforeRestart: async () => saved.push(1) },
  });
  try {
    const host = await client(WS(srv), 'host');
    const tv = await client(WS(srv), 'display');
    const phone = await client(WS(srv), 'phone');
    const s = await host.wait((m) => m.type === 'state' && m.update);
    assert.equal(s.update.canInstall, true);
    assert.deepEqual(s.update.install, { stage: 'idle', progress: null, error: null });
    host.send({ type: 'updateNow' });
    const restarting = await host.wait((m) => m.type === 'update' && m.update.install.stage === 'restarting', 5000);
    assert.equal(restarting.update.version, '9.9.0');
    const stages = host.msgs.filter((m) => m.type === 'update').map((m) => m.update.install);
    assert.ok(stages.some((x) => x.stage === 'downloading' && x.progress > 0 && x.progress < 100), 'progress on the way');
    assert.ok(stages.some((x) => x.stage === 'checking'));
    assert.equal(saved.length, 1, 'saved and closed before the restart');
    assert.equal(readFileSync(exe, 'utf8'), program, 'swapped');
    assert.equal(readFileSync(`${exe}.old`, 'utf8'), script('2.2.1'));
    const start = sp.calls.find((c) => c.args[0] !== '--version');
    assert.equal(start.opts.env.PORT, String(srv.info.port), 'the same port');
    assert.equal(start.opts.env.PROQUIZ_UPDATED_FROM, JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
    await settle();
    assert.ok(tv.msgs.every((m) => m.type !== 'update' && !m.update), 'the TV hears nothing');
    assert.ok(phone.msgs.every((m) => m.type !== 'update' && !m.update), 'nor the phones');
    // Busy: a second press is refused.
    host.send({ type: 'updateNow' });
    assert.equal((await host.wait((m) => m.type === 'error')).code, 'update-busy');
    // The state messages carry the stage too (a reloaded host page sees it).
    const host2 = await client(WS(srv), 'host');
    const s2 = await host2.wait((m) => m.type === 'state' && m.update);
    assert.equal(s2.update.install.stage, 'restarting');
    for (const c of [host, host2, tv, phone]) c.close();
  } finally {
    await srv.close();
  }
});

test('server: saveForExit puts the game waiting to be continued (Main menu) into the autosave; a host started by an update is told', async () => {
  const dd = join(dataDir, 'save');
  const srv = await startServer({ port: 3524, quiet: true, dataDir: dd, updateOptions: { fetchImpl: fakeGitHub('v9.9.0') } });
  try {
    srv.hub.dispatch({ type: 'join', teamId: 'team-bbbbbbbb', name: 'Blue', color: COLORS[1] });
    srv.hub.dispatch({ type: 'start', picker: 'team-bbbbbbbb', seed: 1 });
    srv.hub.dispatch({ type: 'adjust', teamId: 'team-bbbbbbbb', delta: 700 });
    const host = await client(WS(srv), 'host');
    host.send({ type: 'mainMenu' });
    await host.wait((m) => m.type === 'state' && m.view.phase === 'lobby' && m.resume);
    srv.hub.dispatch({ type: 'settings', settings: { sound: false } }); // the lobby's autosave would hide the game
    await settle(400);
    assert.equal(JSON.parse(readFileSync(join(dd, 'autosave.json'), 'utf8')).state.teams.length, 0);
    srv.hub.saveForExit();
    await settle(400);
    const file = JSON.parse(readFileSync(join(dd, 'autosave.json'), 'utf8'));
    assert.equal(file.state.teams[0].score, 700, 'the game is what the new program will offer to continue');
    host.close();
  } finally {
    await srv.close();
  }
  // The new program, started by an update, tells its host so (the banner says "updated to").
  process.env.PROQUIZ_UPDATED_FROM = '2.2.1';
  process.env.PROQUIZ_UPDATE_ERROR = 'restart';
  try {
    const srv2 = await startServer({ port: 3525, quiet: true, dataDir: dd, updateOptions: { fetchImpl: fakeGitHub('v9.9.0') }, selfUpdateOptions: { compiled: true, exe: '/x/ProQuiz', system: 'linux-x64' } });
    try {
      const host = await client(WS(srv2), 'host');
      assert.equal(host.msgs.find((m) => m.type === 'welcome').info.updatedFrom, '2.2.1');
      const tv = await client(WS(srv2), 'display');
      assert.equal(tv.msgs.find((m) => m.type === 'welcome').info.updatedFrom, undefined, 'the host only');
      const s = await host.wait((m) => m.type === 'state' && m.update);
      assert.deepEqual(s.update.install, { stage: 'failed', progress: null, error: 'restart' });
      host.close();
      tv.close();
    } finally {
      await srv2.close();
    }
  } finally {
    delete process.env.PROQUIZ_UPDATED_FROM;
    delete process.env.PROQUIZ_UPDATE_ERROR;
  }
});

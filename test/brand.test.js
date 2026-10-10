// Branding (brand.js): the host's logo, event name and accent colour. Uploading and changing them works only on the
// laptop (never over the internet tunnel's listener), the logo is checked and served safely, and every screen gets
// the branding in its state messages.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../server.js';
import { logoKind, cleanBrand, createBrand, MAX_LOGO } from '../brand.js';
import { filesOf } from '../store.js';

const dataDir = mkdtempSync(join(tmpdir(), 'proquiz-brand-'));
let srv;
let base;
let remotePort;
before(async () => {
  srv = await startServer({ port: 3485, quiet: true, dataDir });
  base = `http://127.0.0.1:${srv.info.port}`;
  remotePort = await srv.openRemote();
});
after(() => srv.close());

// A real 1×1 PNG, a small SVG (with a script that must never run), and things that aren't pictures.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const SVG = Buffer.from('<?xml version="1.0"?>\n<!-- logo -->\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><script>alert(1)</script><rect width="10" height="10"/></svg>');
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]);

const call = (method, path, body, port = srv.info.port) =>
  fetch(`http://127.0.0.1:${port}${path}`, { method, body }).then(async (r) => ({ status: r.status, data: await r.json().catch(() => null), headers: r.headers }));

async function phone(port = srv.info.port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const msgs = [];
  ws.onmessage = (e) => msgs.push(JSON.parse(e.data));
  await new Promise((r) => (ws.onopen = r));
  ws.send(JSON.stringify({ type: 'hello', role: 'phone' }));
  return {
    msgs,
    async state(check = () => true, ms = 2000) {
      const end = Date.now() + ms;
      for (;;) {
        const s = msgs.findLast((m) => m.type === 'state');
        if (s && check(s)) return s;
        if (Date.now() > end) throw new Error('timed out waiting for a state');
        await new Promise((r) => setTimeout(r, 20));
      }
    },
    close: () => ws.close(),
  };
}

test('what a logo really is comes from its bytes, not its name', () => {
  assert.equal(logoKind(PNG), 'png');
  assert.equal(logoKind(JPG), 'jpg');
  assert.equal(logoKind(WEBP), 'webp');
  assert.equal(logoKind(SVG), 'svg');
  assert.equal(logoKind(Buffer.from('﻿<svg>')), 'svg');
  assert.equal(logoKind(Buffer.from('<html><svg></svg></html>')), null);
  assert.equal(logoKind(Buffer.from('GIF89a')), null);
  assert.equal(logoKind(Buffer.from('MZ\x90\x00')), null);
  assert.equal(logoKind(Buffer.alloc(0)), null);
});

test('settings are tidied: a short name, a real colour or the default, a yes/no plate', () => {
  assert.deepEqual(cleanBrand({ name: '  Cardo\nPartners   Christmas  ', accent: '#3B82F6', plate: true, logo: 'x', extra: 1 }), {
    name: 'Cardo Partners Christmas',
    accent: '#3b82f6',
    plate: true,
    logo: null,
  });
  assert.equal(cleanBrand({ name: 'x'.repeat(200) }).name.length, 60);
  for (const accent of ['red', '#fff', 'url(x)', '#12345g', null, 5]) assert.equal(cleanBrand({ accent }).accent, null, String(accent));
  assert.equal(cleanBrand({ plate: 'yes' }).plate, false);
  // Fields that aren't given keep what was there.
  assert.deepEqual(cleanBrand({ name: 'A' }, { name: 'B', accent: '#000000', plate: true, logo: null }), { name: 'A', accent: '#000000', plate: true, logo: null });
});

test('no branding to begin with, and every screen is told so', async () => {
  const p = await phone();
  const s = await p.state();
  assert.deepEqual(s.brand, { name: '', accent: null, plate: false, logo: null });
  assert.deepEqual((await call('GET', '/api/brand')).data, s.brand);
  p.close();
});

test('upload a logo, set a name and colour, and every screen gets them at once', async () => {
  const p = await phone();
  await p.state();
  const up = await call('POST', '/api/brand/logo', PNG);
  assert.equal(up.status, 201);
  assert.match(up.data.logo, /^\/brand\/logo-[0-9a-f]{16}\.png$/);
  let s = await p.state((m) => m.brand?.logo === up.data.logo);
  assert.equal(s.brand.logo, up.data.logo);

  const put = await call('PUT', '/api/brand', JSON.stringify({ name: 'Cardo Partners Christmas Quiz', accent: '#14B8A6', plate: true }));
  assert.equal(put.status, 200);
  s = await p.state((m) => m.brand?.name === 'Cardo Partners Christmas Quiz');
  assert.deepEqual(s.brand, { name: 'Cardo Partners Christmas Quiz', accent: '#14b8a6', plate: true, logo: up.data.logo });

  // Served to everyone, with the right type, safe headers and a long cache (the name changes with the content).
  const r = await fetch(base + up.data.logo);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'image/png');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.match(r.headers.get('content-security-policy'), /default-src 'none'.*sandbox/);
  assert.match(r.headers.get('cache-control'), /immutable/);
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), PNG);

  // Kept in the data folder, and still there after a restart (a new brand store reading the same folder).
  const saved = JSON.parse(readFileSync(join(dataDir, 'brand', 'brand.json'), 'utf8'));
  assert.equal(saved.name, 'Cardo Partners Christmas Quiz');
  const again = createBrand(dataDir);
  await again.load();
  assert.deepEqual(again.view(), s.brand);
  p.close();
});

test('an SVG logo is only ever shown as a picture: its type and a policy that blocks its scripts', async () => {
  const up = await call('POST', '/api/brand/logo', SVG);
  assert.equal(up.status, 201);
  assert.match(up.data.logo, /\.svg$/);
  const r = await fetch(base + up.data.logo);
  assert.equal(r.headers.get('content-type'), 'image/svg+xml');
  assert.match(r.headers.get('content-security-policy'), /default-src 'none'/);
  assert.match(r.headers.get('content-security-policy'), /sandbox/);
  // A new logo replaces the old one: only one logo file is kept.
  const logos = readdirSync(join(dataDir, 'brand')).filter((n) => n.startsWith('logo-'));
  assert.deepEqual(logos, [up.data.logo.slice('/brand/'.length)]);
});

test('too big or not a picture is refused, and the logo stays as it was', async () => {
  const before = (await call('GET', '/api/brand')).data;
  const big = Buffer.concat([PNG, Buffer.alloc(MAX_LOGO)]);
  const tooBig = await call('POST', '/api/brand/logo', big);
  assert.equal(tooBig.status, 413);
  assert.equal(tooBig.data.error, 'logo-too-big');
  for (const bytes of [Buffer.from('GIF89a....'), Buffer.from('<html><script>alert(1)</script></html>'), Buffer.from('MZ')]) {
    const bad = await call('POST', '/api/brand/logo', bytes);
    assert.equal(bad.status, 400);
    assert.equal(bad.data.error, 'logo-bad-type');
  }
  assert.deepEqual((await call('GET', '/api/brand')).data, before);
});

test('only logo files are served from /brand/', async () => {
  for (const path of ['/brand/brand.json', '/brand/..%2Fbrand.json', '/brand/../server.js', '/brand/logo-0000000000000000.png', '/brand/']) {
    assert.equal((await fetch(base + path)).status, 404, path);
  }
});

test('over the internet: the logo is served, but nothing can be changed', async () => {
  const { logo } = (await call('GET', '/api/brand')).data;
  assert.ok(logo);
  assert.equal((await fetch(`http://127.0.0.1:${remotePort}${logo}`)).status, 200);
  for (const [method, path, body] of [
    ['GET', '/api/brand'],
    ['PUT', '/api/brand', JSON.stringify({ name: 'Hacked' })],
    ['POST', '/api/brand/logo', PNG],
    ['DELETE', '/api/brand/logo'],
  ]) {
    assert.equal((await call(method, path, body, remotePort)).status, 403, `${method} ${path}`);
  }
  assert.notEqual((await call('GET', '/api/brand')).data.name, 'Hacked');
  // Phones and TV pages over the internet still get the branding.
  const p = await phone(remotePort);
  assert.equal((await p.state()).brand.logo, logo);
  p.close();
});

test('another website open in the browser cannot change the branding; odd input changes nothing', async () => {
  const before = (await call('GET', '/api/brand')).data;
  const r = await fetch(`${base}/api/brand/logo`, { method: 'POST', body: PNG, headers: { 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(r.status, 403);
  for (const body of ['null', '"text"', '[1,2]', '42']) assert.equal((await call('PUT', '/api/brand', body)).status, 200, body);
  assert.deepEqual((await call('GET', '/api/brand')).data, before);
});

test('removing the logo deletes its file; the name and colour stay; a bad colour goes back to the default', async () => {
  const p = await phone();
  const { logo } = (await p.state()).brand;
  const del = await call('DELETE', '/api/brand/logo');
  assert.equal(del.status, 200);
  assert.equal(del.data.logo, null);
  assert.equal(del.data.name, 'Cardo Partners Christmas Quiz');
  await p.state((m) => m.brand.logo === null);
  assert.equal((await fetch(base + logo)).status, 404);
  assert.ok(!existsSync(join(dataDir, 'brand', logo.slice('/brand/'.length))));
  const put = await call('PUT', '/api/brand', JSON.stringify({ accent: 'javascript:alert(1)' }));
  assert.equal(put.data.accent, null);
  p.close();
});

test('branding is never part of a quiz or its export', async () => {
  await call('POST', '/api/brand/logo', PNG);
  const pkg = (await call('GET', '/api/export/sample')).data;
  assert.ok(!JSON.stringify(pkg).includes('logo-'));
  assert.ok(!('brand' in pkg) && !('brand' in pkg.set));
  assert.ok(!filesOf(pkg.set).some((n) => n.startsWith('logo-')));
});

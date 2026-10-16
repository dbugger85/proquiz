import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { STRINGS, pts } from '../public/js/i18n.js';

test('every text exists in both English and Norwegian', () => {
  const en = Object.keys(STRINGS.en);
  const no = Object.keys(STRINGS.no);
  assert.deepEqual(en.filter((k) => !no.includes(k)), [], 'missing in Norwegian');
  assert.deepEqual(no.filter((k) => !en.includes(k)), [], 'missing in English');
  for (const k of en) {
    const params = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    assert.deepEqual(params(STRINGS.no[k]), params(STRINGS.en[k]), `placeholders differ for ${k}`);
  }
});

test('every text used in the pages and scripts exists', () => {
  const dir = new URL('../public/', import.meta.url);
  const sources = [
    ...readdirSync(dir).filter((f) => f.endsWith('.html')).map((f) => readFileSync(new URL(f, dir), 'utf8')),
    ...readdirSync(new URL('js/', dir)).filter((f) => f !== 'i18n.js').map((f) => readFileSync(new URL(`js/${f}`, dir), 'utf8')),
  ].join('\n');
  const used = new Set([
    ...[...sources.matchAll(/data-t(?:-[\w-]+)?="([\w-]+)"/g)].map((m) => m[1]),
    ...[...sources.matchAll(/\bt\('([\w-]+)'/g)].map((m) => m[1]),
  ]);
  const missing = [...used].filter((k) => !(k in STRINGS.en));
  assert.deepEqual(missing, []);
  // Error codes the server can send are all translated.
  const server = ['../server.js', '../lib/hub.js', '../lib/game.js', '../web/room.js', '../web/worker.js'].map((f) => readFileSync(new URL(f, import.meta.url), 'utf8')).join('\n');
  const codes = new Set([...server.matchAll(/(?:code: |GameError\()'([\w-]+)'/g)].map((m) => m[1]));
  const untranslated = [...codes].filter((c) => c !== 'unknown-action' && !(`err-${c}` in STRINGS.en));
  assert.deepEqual(untranslated, []);
});

test('points get a no-break space between the thousands', () => {
  const nb = ' ';
  assert.equal(pts(0), '0');
  assert.equal(pts(957), '957');
  assert.equal(pts(1250), `1${nb}250`);
  assert.equal(pts(12500), `12${nb}500`);
  assert.equal(pts(1234567), `1${nb}234${nb}567`);
  assert.equal(pts(-1500), `-1${nb}500`);
  assert.equal(pts(-500), '-500');
  assert.equal(pts(undefined), '');
});

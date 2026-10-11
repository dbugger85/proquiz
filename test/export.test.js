// Export and import (lib/fileformat.js, store.js): a quiz with everything in it goes out and comes back the same,
// files byte for byte; the file-format version rules (newer refused, older upgraded step by step); "Export all
// quizzes" and its import; archiving (archived.json); and the louder defaults for saves from before 2.3 (server.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../store.js';
import { FORMAT_VERSION, UPGRADES, upgradeExport, formatVersionOf, FormatError } from '../lib/fileformat.js';
import { validateSet, usedFiles } from '../lib/validate.js';
import { startServer, louderSettings } from '../server.js';
import { DEFAULT_SETTINGS } from '../lib/game.js';

const dir = () => mkdtempSync(join(tmpdir(), 'proquiz-export-'));
const bytes = (seed, n = 300) => Buffer.from(Array.from({ length: n }, (_, i) => (i * 31 + seed * 7) % 256));
const credit = (title) => ({ title, author: 'Ada', license: 'CC BY 4.0', licenseUrl: 'https://creativecommons.org/licenses/by/4.0/', source: 'openverse', sourceUrl: 'https://openverse.org/image/1' });
const small = (title, extra = {}) => ({ v: 1, title, categories: [{ name: 'A', questions: [{ value: 100, question: 'q', answer: 'a' }] }], ...extra });
const filesIn = (store, names) => Object.fromEntries(names.map((n) => [n, readFileSync(join(store.filesDir, n))]));

// A board quiz with everything: round 2, final, specials, pictures (question and answer), a clip with a start time,
// a slowly appearing picture, credits, a description and a cover.
async function fullBoard(store) {
  const pic = (n, ext = 'png') => store.addFile(`p${n}.${ext}`, bytes(n));
  const [cover, q1, a1, r2, fin, finA] = await Promise.all([pic(1, 'jpg'), pic(2), pic(3), pic(4, 'webp'), pic(5), pic(6)]);
  const clip = await store.addFile('tune.mp3', bytes(7, 2000));
  const set = {
    v: 1,
    title: 'Everything',
    description: 'Line one.\nLine two.',
    cover: cover.name,
    categories: [
      {
        name: 'A',
        questions: [
          { value: 100, question: 'q1', answer: 'a1', image: q1.name, answerImage: a1.name, unveil: 10 },
          { value: 200, question: 'q2', answer: 'a2', audio: clip.name, audioStart: 2.5, special: 'triple' },
        ],
      },
      { name: 'B', questions: [{ value: 100, question: 'q3', answer: 'a3', special: 'bomb' }] },
    ],
    round2: { categories: [{ name: 'R2', questions: [{ value: 400, question: 'r', answer: 'ra', image: r2.name, special: 'double' }] }] },
    final: { category: 'F', question: 'fq', answer: 'fa', image: fin.name, answerImage: finA.name, audio: clip.name, audioStart: 1 },
    credits: { [cover.name]: credit('Cover'), [q1.name]: credit('Q1'), [r2.name]: credit('R2') },
  };
  assert.deepEqual(validateSet(set), []);
  return { set, names: [cover.name, q1.name, a1.name, r2.name, fin.name, finA.name, clip.name] };
}

// A Quick quiz with all three kinds of question, pictures, a clip, a cover and a description.
async function fullQuick(store) {
  const [cover, p1, p2] = await Promise.all([store.addFile('c.png', bytes(11)), store.addFile('p1.gif', bytes(12)), store.addFile('p2.png', bytes(13))]);
  const clip = await store.addFile('clip.ogg', bytes(14, 1500));
  const set = {
    v: 1,
    kind: 'quick',
    title: 'Quick everything',
    description: 'Three kinds of question.',
    cover: cover.name,
    sections: [
      {
        name: 'S',
        seconds: 15,
        questions: [
          { question: 'pick', options: ['a', 'b', 'c'], correct: 1, image: p1.name },
          { question: 'tick', type: 'multi', options: ['a', 'b', 'c', 'd'], correct: [0, 2], points: 2000, audio: clip.name, audioStart: 1 },
          { question: 'order', type: 'order', options: ['1', '2', '3'], image: p2.name, seconds: 30 },
        ],
      },
    ],
    credits: { [cover.name]: credit('Cover') },
  };
  assert.deepEqual(validateSet(set), []);
  return { set, names: [cover.name, p1.name, p2.name, clip.name] };
}

test('a board quiz with everything survives export and import, its files byte for byte', async () => {
  const from = createStore(dir(), { version: '2.3.0' });
  const { set, names } = await fullBoard(from);
  const id = await from.create(set);
  const saved = (await from.get(id)).set;
  assert.equal(saved.description, 'Line one.\nLine two.');
  assert.equal(saved.cover, set.cover);
  assert.deepEqual(Object.keys(saved).slice(0, 4), ['v', 'title', 'description', 'cover']);
  assert.deepEqual(usedFiles(saved).sort(), [...names].sort()); // the cover counts as a file in use
  assert.deepEqual(Object.keys(saved.credits).sort(), [set.cover, names[1], names[3]].sort());

  const pkg = await from.exportPackage(id);
  assert.equal(pkg.proquiz, FORMAT_VERSION);
  assert.equal(pkg.app, '2.3.0');
  assert.match(pkg.exported, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/);
  assert.deepEqual(Object.keys(pkg.files).sort(), [...names].sort());
  assert.deepEqual(pkg.set, saved);

  const to = createStore(dir());
  const { ids } = await to.importPackage(JSON.parse(JSON.stringify(pkg)));
  assert.equal(ids.length, 1);
  assert.deepEqual((await to.get(ids[0])).set, saved);
  const before = filesIn(from, names);
  const after = filesIn(to, names);
  for (const n of names) assert.ok(before[n].equals(after[n]), `${n} changed on the way`);
});

test('a Quick quiz with every kind of question survives export and import the same way', async () => {
  const from = createStore(dir(), { version: '2.3.0' });
  const { set, names } = await fullQuick(from);
  const id = await from.create(set);
  const saved = (await from.get(id)).set;
  assert.deepEqual(Object.keys(saved).slice(0, 5), ['v', 'kind', 'title', 'description', 'cover']);
  assert.deepEqual(saved.sections[0].questions.map((q) => q.type), [undefined, 'multi', 'order']);
  const pkg = await from.exportPackage(id);
  assert.deepEqual(Object.keys(pkg.files).sort(), [...names].sort());
  const to = createStore(dir());
  const { ids } = await to.importPackage(JSON.parse(JSON.stringify(pkg)));
  assert.deepEqual((await to.get(ids[0])).set, saved);
  for (const n of names) assert.ok(readFileSync(join(from.filesDir, n)).equals(readFileSync(join(to.filesDir, n))), n);
});

test('a file from a newer ProQuiz is refused with a clear code; a plain quiz and odd files are handled', async () => {
  const store = createStore(dir());
  await assert.rejects(store.importPackage({ proquiz: FORMAT_VERSION + 1, app: '9.0.0', exported: '2030-01-01T00:00:00Z', set: small('Future') }), { status: 400, code: 'quiz-too-new' });
  assert.throws(() => upgradeExport({ proquiz: 99 }), (e) => e instanceof FormatError && e.code === 'quiz-too-new' && e.version === 99);
  assert.equal(formatVersionOf({ title: 'x' }), null);
  assert.equal(formatVersionOf({ proquiz: '1' }), null);
  assert.equal(formatVersionOf({ proquiz: 0 }), null);
  assert.equal(formatVersionOf({ proquiz: 1 }), 1);
  // A plain quiz (no files) still imports, as before.
  const { ids } = await store.importPackage(small('Plain'));
  assert.equal((await store.get(ids[0])).set.title, 'Plain');
  // Current files that aren't quizzes.
  await assert.rejects(store.importPackage({ proquiz: 1, set: { title: 'no board' } }), { code: 'not-a-quiz' });
  await assert.rejects(store.importPackage({ proquiz: 1, sets: [] }), { code: 'not-a-quiz' });
  await assert.rejects(store.importPackage({ proquiz: 1, sets: [{ set: small('ok') }, { set: null }] }), { code: 'not-a-quiz' });
  await assert.rejects(store.importPackage('hello'), { code: 'not-a-quiz' });
});

test('an older file goes through the upgrade steps one by one, also when importing', async () => {
  assert.deepEqual(UPGRADES, {}); // format 1 is the first, so no step is needed yet
  const calls = [];
  const upgrades = {
    1: (d) => (calls.push(1), { ...d, proquiz: 2, set: { ...d.set, title: `${d.set.title} +1` } }),
    2: (d) => (calls.push(2), { ...d, proquiz: 3, set: { ...d.set, title: `${d.set.title} +2` } }),
  };
  const out = upgradeExport({ proquiz: 1, set: small('Old') }, { upgrades, target: 3 });
  assert.deepEqual(calls, [1, 2]);
  assert.equal(out.proquiz, 3);
  assert.equal(out.set.title, 'Old +1 +2');
  // Already current: untouched. A step that forgets to bump the version is a bug, and a missing step can't be read.
  const current = { proquiz: 3, set: small('Now') };
  assert.equal(upgradeExport(current, { upgrades, target: 3 }), current);
  assert.throws(() => upgradeExport({ proquiz: 1, set: small('x') }, { upgrades: { 1: (d) => d }, target: 2 }), /must return format 2/);
  assert.throws(() => upgradeExport({ proquiz: 1, set: small('x') }, { upgrades: {}, target: 2 }), (e) => e instanceof FormatError && e.code === 'not-a-quiz');
  // The store runs the same chain on import (and refuses what is newer than its target).
  const store = createStore(dir(), { format: { upgrades, target: 3 } });
  calls.length = 0;
  const { ids } = await store.importPackage({ proquiz: 1, set: small('Stored') });
  assert.deepEqual(calls, [1, 2]);
  assert.equal((await store.get(ids[0])).set.title, 'Stored +1 +2');
  await assert.rejects(store.importPackage({ proquiz: 4, set: small('x') }), { code: 'quiz-too-new' });
});

test('Export all quizzes: every quiz the host made (archived too, built-ins not), shared files once, and back again', async () => {
  const from = createStore(dir(), { version: '2.3.0' });
  const b = await fullBoard(from);
  const q = await fullQuick(from);
  const shared = small('Shares a picture');
  shared.categories[0].questions[0].image = b.names[1]; // the same picture as the first quiz
  const idB = await from.create(b.set);
  const idQ = await from.create(q.set);
  await from.create(shared);
  await from.setArchived(idQ, true);
  await from.setArchived('sample', true); // a built-in: archived, but never exported

  const pkg = await from.exportAll();
  assert.equal(pkg.proquiz, FORMAT_VERSION);
  assert.equal(pkg.app, '2.3.0');
  assert.equal(pkg.set, undefined);
  assert.deepEqual(pkg.sets.map((s) => s.set.title).sort(), ['Everything', 'Quick everything', 'Shares a picture']);
  assert.equal(pkg.sets.find((s) => s.set.title === 'Quick everything').archived, true);
  assert.equal(pkg.sets.find((s) => s.set.title === 'Everything').archived, undefined);
  const all = [...new Set([...b.names, ...q.names])];
  assert.deepEqual(Object.keys(pkg.files).sort(), [...all].sort()); // the shared picture is in once

  const to = createStore(dir());
  const { ids } = await to.importPackage(JSON.parse(JSON.stringify(pkg)));
  assert.equal(ids.length, 3);
  const mine = (await to.list()).filter((x) => !x.builtIn);
  assert.equal(mine.length, 3);
  assert.equal(mine.find((x) => x.title === 'Quick everything').archived, true);
  assert.equal(mine.find((x) => x.title === 'Everything').archived, false);
  assert.equal(mine.find((x) => x.title === 'Everything').description, 'Line one.'); // the list shows the first line
  assert.equal(mine.find((x) => x.title === 'Everything').cover, b.set.cover);
  assert.equal((await to.list()).find((x) => x.id === 'sample').archived, false);
  for (const [i, s] of pkg.sets.entries()) assert.deepEqual((await to.get(ids[i])).set, s.set); // the new ids follow the file's order
  const everything = ids[pkg.sets.findIndex((s) => s.set.title === 'Everything')];
  assert.deepEqual((await to.get(everything)).set, (await from.get(idB)).set);
  for (const n of all) assert.ok(readFileSync(join(from.filesDir, n)).equals(readFileSync(join(to.filesDir, n))), n);
});

test('archiving is personal to this computer: archived.json in the data folder, built-ins too, gone with a deleted quiz', async () => {
  const d = dir();
  const store = createStore(d);
  const id = await store.create(small('Mine'));
  assert.ok((await store.list()).every((q) => q.archived === false));
  assert.equal(await store.setArchived(id, true), true);
  assert.equal(await store.setArchived('sample', true), true);
  assert.deepEqual(JSON.parse(readFileSync(join(d, 'archived.json'), 'utf8')), { v: 1, ids: [id, 'sample'] });
  const list = await store.list();
  assert.equal(list.find((q) => q.id === id).archived, true);
  assert.equal(list.find((q) => q.id === 'sample').archived, true);
  assert.equal(list.find((q) => q.id === 'eksempel').archived, false);
  assert.equal((await store.get(id)).set.archived, undefined); // never in the quiz file
  assert.equal(await store.setArchived('sample', false), false);
  assert.equal(await store.setArchived('sample', false), false); // twice is fine
  await assert.rejects(store.setArchived('nope-123', true), { status: 404 });
  await store.remove(id);
  assert.deepEqual(await store.archivedIds(), []);
  // A broken archived.json means nothing is archived.
  writeFileSync(join(d, 'archived.json'), '{oops');
  assert.deepEqual(await store.archivedIds(), []);
});

test('the description and cover are checked and kept, for both kinds of quiz', async () => {
  const store = createStore(dir());
  const { name: cover } = await store.addFile('c.png', bytes(21));
  assert.deepEqual(validateSet(small('x', { description: 'a'.repeat(300), cover })), []);
  assert.deepEqual(validateSet(small('x', { description: 'a'.repeat(301) })), [{ code: 'bad-description' }]);
  assert.deepEqual(validateSet(small('x', { description: 42 })), [{ code: 'bad-description' }]);
  assert.deepEqual(validateSet(small('x', { cover: 'virus.exe' })), [{ code: 'bad-cover' }]);
  assert.deepEqual(validateSet({ v: 1, kind: 'quick', title: 'q', cover: 'nope.mp3', sections: [{ name: 'S', questions: [{ question: 'q', options: ['a', 'b'], correct: 0 }] }] }), [{ code: 'bad-cover' }]);
  // Saving trims and cuts the description, drops a broken cover, and leaves empty ones out of the file.
  const id = await store.create(small('Kept', { description: '  Hello\r\nthere  ', cover }));
  let saved = (await store.get(id)).set;
  assert.equal(saved.description, 'Hello\nthere');
  assert.equal(saved.cover, cover);
  await store.save(id, small('Kept', { description: 'x'.repeat(400), cover: 'nope.exe' }));
  saved = (await store.get(id)).set;
  assert.equal(saved.description.length, 300);
  assert.equal(saved.cover, undefined);
  await store.save(id, small('Kept', { description: '   ' }));
  assert.equal((await store.get(id)).set.description, undefined);
  // The cover's credit survives saving (the cover is a picture in use).
  const credited = await store.create(small('Credited', { cover, credits: { [cover]: credit('C') } }));
  assert.deepEqual((await store.get(credited)).set.credits, { [cover]: credit('C') });
});

test('the API: archive and bring back, export all, import one or several, refuse a newer file', async () => {
  const srv = await startServer({ port: 3497, quiet: true, dataDir: dir() });
  try {
    const base = `http://127.0.0.1:${srv.info.port}`;
    const call = async (method, path, body) => {
      const r = await fetch(base + path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: r.status, data: await r.json(), headers: r.headers };
    };
    const { data: created } = await call('POST', '/api/sets', { set: small('Mine', { description: 'About it\nMore' }) });
    const id = created.id;
    assert.deepEqual((await call('PUT', `/api/sets/${id}/archived`, { archived: true })).data, { archived: true });
    let list = (await call('GET', '/api/sets')).data;
    assert.equal(list.find((q) => q.id === id).archived, true);
    assert.equal(list.find((q) => q.id === id).description, 'About it');
    assert.equal((await call('PUT', '/api/sets/sample/archived', { archived: true })).status, 200);
    assert.equal((await call('PUT', '/api/sets/nope-1/archived', { archived: true })).status, 404);
    assert.deepEqual((await call('PUT', `/api/sets/${id}/archived`, { archived: false })).data, { archived: false });
    assert.equal((await call('GET', '/api/sets')).data.find((q) => q.id === id).archived, false);
    // Deleting a quiz takes it off the archived list too.
    await call('PUT', `/api/sets/${id}/archived`, { archived: true });
    const { data: other } = await call('POST', '/api/sets', { set: small('Other') });
    await call('DELETE', `/api/sets/${id}`);
    assert.deepEqual(await srv.store.archivedIds(), ['sample']);

    const all = await call('GET', '/api/export');
    assert.match(all.headers.get('content-disposition'), /proquiz-all-\d{4}-\d\d-\d\d\.proquiz\.json/);
    assert.equal(all.data.proquiz, FORMAT_VERSION);
    assert.equal(all.data.app, srv.info.version);
    assert.deepEqual(all.data.sets.map((s) => s.set.title), ['Other']);
    const one = await call('GET', `/api/export/${other.id}`);
    assert.equal(one.data.app, srv.info.version);
    assert.equal(one.data.set.title, 'Other');

    const imported = await call('POST', '/api/import', { ...all.data, sets: [all.data.sets[0], { set: small('Second'), archived: true }] });
    assert.equal(imported.status, 201);
    assert.equal(imported.data.count, 2);
    assert.equal(imported.data.ids.length, 2);
    assert.equal(imported.data.id, imported.data.ids[0]);
    list = (await call('GET', '/api/sets')).data;
    assert.equal(list.find((q) => q.title === 'Second').archived, true);
    const single = await call('POST', '/api/import', one.data);
    assert.equal(single.data.count, 1);
    const tooNew = await call('POST', '/api/import', { proquiz: FORMAT_VERSION + 1, set: small('x') });
    assert.equal(tooNew.status, 400);
    assert.equal(tooNew.data.error, 'quiz-too-new');
  } finally {
    await srv.close();
  }
});

test('an old save still at the old music default (35) moves to 80, once; other values stay', async () => {
  assert.equal(DEFAULT_SETTINGS.musicVolume, 80);
  assert.equal(DEFAULT_SETTINGS.soundVolume, 80);
  assert.deepEqual(louderSettings({ musicVolume: 35, sound: true }), { musicVolume: 80, sound: true });
  assert.deepEqual(louderSettings({ musicVolume: 50 }), { musicVolume: 50 });
  assert.deepEqual(louderSettings({ musicVolume: 35, soundVolume: 80 }), { musicVolume: 35, soundVolume: 80 }); // chosen after 2.3: kept
  assert.equal(louderSettings(null), null);
  // Through the real server: an autosave from before 2.3 (no soundVolume yet), music at the old default.
  const d = dir();
  const sample = JSON.parse(readFileSync(new URL('../sets/sample.json', import.meta.url), 'utf8'));
  const settings = { ...DEFAULT_SETTINGS, musicVolume: 35, penalty: 'full' };
  delete settings.soundVolume;
  writeFileSync(join(d, 'autosave.json'), JSON.stringify({ v: 1, savedAt: 1, state: { phase: 'lobby', teams: [], set: sample, setId: 'sample', settings } }));
  const srv = await startServer({ port: 3498, quiet: true, dataDir: d });
  try {
    const st = srv.hub.getState().settings;
    assert.equal(st.musicVolume, 80);
    assert.equal(st.soundVolume, 80);
    assert.equal(st.penalty, 'full');
  } finally {
    await srv.close();
  }
});

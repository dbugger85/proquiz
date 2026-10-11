// "Find a song clip" (songs.js): searching Deezer, downloading the chosen song's 30-second preview safely, its
// credit kept in the quiz, the routes only for the editor on the laptop, and the TV's credit line only after the
// answer. Never on the real internet: every test uses a pretend `fetchImpl`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSongs, parseTrack, parseSearch, isMp3, safeUrl, MAX_SONG, USER_AGENT, PAGE_SIZE } from '../songs.js';
import { createStore } from '../store.js';
import { cleanCredits } from '../lib/validate.js';
import { apply, newGame, COLORS, displayView, phoneView, hostView } from '../lib/game.js';
import { startServer } from '../server.js';

// A tiny MP3: an ID3 tag, and one with a bare frame header (0xFFFB: MPEG-1 layer III).
const MP3_ID3 = Buffer.concat([Buffer.from('ID3\x04\x00\x00\x00\x00\x00\x00'), Buffer.alloc(400)]);
const MP3_FRAME = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(400)]);
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

// Deezer answers, shaped like the real ones (checked on 2026-10-11).
const preview = (id) => `https://cdnt-preview.dzcdn.net/api/1/1/9/1/6/0/${String(id).padStart(32, '0')}.mp3?hdnea=exp=1791718203~acl=/api/*~hmac=abc`;
const track = (id, extra = {}) => ({
  id,
  readable: true,
  title: `Song ${id}`,
  title_short: `Song ${id}`,
  link: `https://www.deezer.com/track/${id}`,
  duration: 200 + id,
  preview: preview(id),
  artist: { id: 1, name: 'ABBA', link: 'https://www.deezer.com/artist/1', type: 'artist' },
  album: { id: 2, title: 'Gold', cover_medium: `https://cdn-images.dzcdn.net/images/cover/${id}/250x250-000000-80-0-0.jpg`, type: 'album' },
  type: 'track',
  ...extra,
});
const searchAnswer = (ids, more = true) => ({ data: ids.map((id) => track(id)), total: 185, ...(more && { next: 'https://api.deezer.com/search?q=abba&limit=10&index=10' }) });

// A pretend internet: `routes` is a list of [test(url) → boolean, answer(url, opts) → Response | throws].
function fakeNet(routes) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    for (const [match, answer] of routes) if (match(String(url))) return answer(String(url), opts);
    throw new Error(`no pretend answer for ${url}`);
  };
  return { calls, fetchImpl };
}
const json = (data, init = {}) => new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' }, ...init });
const bytes = (b, headers = {}) => new Response(b, { status: 200, headers });
const has = (s) => (u) => u.includes(s);
const offline = () => {
  throw new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND api.deezer.com'), { code: 'ENOTFOUND' }) });
};

function service(routes, opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'proquiz-songs-'));
  const net = fakeNet(routes);
  const store = createStore(dir);
  return { ...net, dir, store, songs: createSongs({ store, fetchImpl: net.fetchImpl, ...opts }) };
}

test('small helpers: MP3 by its bytes, safe addresses, one track', () => {
  assert.equal(isMp3(MP3_ID3), true);
  assert.equal(isMp3(MP3_FRAME), true);
  assert.equal(isMp3(Buffer.from([0xff, 0xe3, 0x00, 0x00])), true); // MPEG 2.5 layer I: still a frame
  assert.equal(isMp3(PNG), false);
  assert.equal(isMp3(Buffer.from('OggS')), false);
  assert.equal(isMp3(Buffer.from([0xff, 0xe8, 0x00, 0x00])), false); // reserved MPEG version
  assert.equal(isMp3(Buffer.from([0xff, 0xf9, 0x00, 0x00])), false); // reserved layer
  assert.equal(isMp3(Buffer.alloc(2)), false);
  assert.equal(safeUrl(preview(1), ['cdnt-preview.dzcdn.net']), preview(1));
  assert.equal(safeUrl('https://evil.example/x.mp3', ['cdnt-preview.dzcdn.net']), null);
  assert.equal(safeUrl('http://cdnt-preview.dzcdn.net/x.mp3', ['cdnt-preview.dzcdn.net']), null);
  assert.equal(safeUrl('https://127.0.0.1/x.mp3'), null);

  const t = parseTrack(track(884025));
  assert.deepEqual(t, {
    id: 884025,
    title: 'Song 884025',
    artist: 'ABBA',
    album: 'Gold',
    cover: 'https://cdn-images.dzcdn.net/images/cover/884025/250x250-000000-80-0-0.jpg',
    duration: 884225,
    preview: preview(884025),
    link: 'https://www.deezer.com/track/884025',
  });
  // No preview, a preview elsewhere, no title, a bad id: not a result. A cover elsewhere is just left out.
  assert.equal(parseTrack(track(1, { preview: '' })), null);
  assert.equal(parseTrack(track(1, { preview: 'https://evil.example/a.mp3' })), null);
  assert.equal(parseTrack(track(1, { title: '', title_short: '' })), null);
  assert.equal(parseTrack(track('abc')), null);
  assert.equal(parseTrack(track(1, { album: { cover_medium: 'https://evil.example/c.jpg' } })).cover, null);
  assert.equal(parseTrack(track(1, { link: 'javascript:alert(1)' })).link, 'https://www.deezer.com/track/1');
  assert.equal(parseTrack(track(1, { title: ' A\n\tB ' })).title, 'A B');
});

test('a search: ten songs a page, "more" from Deezer’s next link, cached for ten minutes', async () => {
  let clock = 1000;
  const { songs, calls } = service(
    [
      [has('/search?'), (u) => json(new URL(u).searchParams.get('index') === '0' ? searchAnswer([1, 2, 3]) : searchAnswer([4, 5], false))],
    ],
    { now: () => clock },
  );
  const first = await songs.search({ q: '  abba   dancing queen ' });
  assert.equal(first.page, 1);
  assert.equal(first.more, true);
  assert.deepEqual(first.results.map((r) => r.id), [1, 2, 3]);
  const asked = new URL(calls[0].url);
  assert.equal(asked.origin + asked.pathname, 'https://api.deezer.com/search');
  assert.equal(asked.searchParams.get('q'), 'abba dancing queen');
  assert.equal(asked.searchParams.get('limit'), String(PAGE_SIZE));
  assert.equal(asked.searchParams.get('index'), '0');
  assert.equal(calls[0].opts.headers['User-Agent'], USER_AGENT);
  const second = await songs.search({ q: 'abba dancing queen', page: 2 });
  assert.equal(new URL(calls[1].url).searchParams.get('index'), '10');
  assert.equal(second.more, false);
  assert.deepEqual(second.results.map((r) => r.id), [4, 5]);
  // The same words again (other spacing and case): from the cache.
  await songs.search({ q: 'ABBA Dancing  Queen' });
  assert.equal(calls.length, 2);
  clock += 11 * 60_000;
  await songs.search({ q: 'abba dancing queen' });
  assert.equal(calls.length, 3);
  // Nothing found is a plain empty answer.
  const none = service([[has('/search?'), () => json({ data: [], total: 0 })]]);
  assert.deepEqual(await none.songs.search({ q: 'zzz' }), { results: [], page: 1, more: false });
  // Bad input.
  for (const bad of [{ q: '' }, { q: 'x'.repeat(201) }, { q: 'a', page: 0 }, { q: 'a', page: 'x' }, { q: 'a', page: 99 }]) {
    await assert.rejects(songs.search(bad), { status: 400, code: 'bad-query' });
  }
});

test('search errors: no internet, Deezer’s quota (code 4 in a 200), a 429, a broken answer', async () => {
  await assert.rejects(service([[has('/search?'), offline]]).songs.search({ q: 'a' }), { status: 503, code: 'no-internet' });
  const quota = service([[has('/search?'), () => json({ error: { type: 'Exception', message: 'Quota limit exceeded', code: 4 } })]]);
  await assert.rejects(quota.songs.search({ q: 'a' }), { status: 429, code: 'rate-limited', retryAfter: 60 });
  const busy = service([[has('/search?'), () => json({}, { status: 429, headers: { 'retry-after': '30' } })]]);
  await assert.rejects(busy.songs.search({ q: 'a' }), { status: 429, code: 'rate-limited', retryAfter: 30 });
  const odd = service([[has('/search?'), () => new Response('<html>', { status: 200 })]]);
  await assert.rejects(odd.songs.search({ q: 'a' }), { status: 502, code: 'song-failed' });
  const bad = service([[has('/search?'), () => json({ error: { type: 'ParameterException', message: 'empty parameter', code: 500 } })]]);
  await assert.rejects(bad.songs.search({ q: 'a' }), { status: 502, code: 'song-failed' });
  // A busy moment (5xx) is tried once more.
  let n = 0;
  const flaky = service([[has('/search?'), () => (n++ === 0 ? new Response('', { status: 503 }) : json(searchAnswer([7], false)))]]);
  assert.deepEqual((await flaky.songs.search({ q: 'a' })).results.map((r) => r.id), [7]);
  assert.equal(n, 2);
});

test('"Use this clip": the song asked for again, its preview downloaded from Deezer’s preview servers only, kept as an MP3 with its credit', async () => {
  const { songs, calls, dir, store } = service([
    [has('/track/884025'), () => json(track(884025))],
    [has('cdnt-preview.dzcdn.net'), () => bytes(MP3_ID3, { 'content-type': 'audio/mpeg' })],
  ]);
  const got = await songs.fetch({ id: 884025 });
  assert.match(got.name, /^[0-9a-f]{16}\.mp3$/);
  assert.equal(got.kind, 'audio');
  assert.deepEqual(got.credit, { title: 'Song 884025', author: 'ABBA', source: 'deezer', sourceUrl: 'https://www.deezer.com/track/884025' });
  assert.deepEqual(await store.readUserFile(got.name), MP3_ID3);
  assert.equal(calls[0].url, 'https://api.deezer.com/track/884025');
  assert.equal(calls[1].opts.redirect, 'manual');
  assert.equal(calls[1].opts.headers['User-Agent'], USER_AGENT);
  // A frame without a tag is an MP3 too; the id may come as a string of digits.
  const frame = service([[has('/track/5'), () => json(track(5))], [has('cdnt-preview'), () => bytes(MP3_FRAME)]]);
  assert.equal((await frame.songs.fetch({ id: '5' })).kind, 'audio');
  // A redirect within the preview servers is followed.
  const hop = service([
    [has('/track/5'), () => json(track(5))],
    [(u) => u.includes('cdnt-preview') && u.includes('?hdnea'), () => new Response(null, { status: 302, headers: { location: 'https://cdnt-preview.dzcdn.net/other.mp3' } })],
    [has('cdnt-preview.dzcdn.net/other.mp3'), () => bytes(MP3_ID3)],
  ]);
  assert.equal((await hop.songs.fetch({ id: 5 })).kind, 'audio');
  assert.equal(readdirSync(join(dir, 'files')).length, 1);
  for (const bad of [{ id: 0 }, { id: -1 }, { id: 'x' }, { id: 1.5 }, {}]) await assert.rejects(songs.fetch(bad), { status: 400, code: 'bad-id' });
});

test('refusals: a preview elsewhere (also by redirect), not an MP3, too big, missing, no internet, the quota', async () => {
  const foreign = service([[has('/track/5'), () => json(track(5, { preview: 'https://evil.example/5.mp3' }))], [has('evil.example'), () => assert.fail('asked a foreign host')]]);
  await assert.rejects(foreign.songs.fetch({ id: 5 }), { status: 404, code: 'song-missing' });
  const hop = service([
    [has('/track/5'), () => json(track(5))],
    [has('cdnt-preview'), () => new Response(null, { status: 302, headers: { location: 'https://evil.example/5.mp3' } })],
    [has('evil.example'), () => assert.fail('followed a redirect to a foreign host')],
  ]);
  await assert.rejects(hop.songs.fetch({ id: 5 }), { status: 502, code: 'song-failed' });
  for (const body of [PNG, Buffer.from('OggS not an mp3'), Buffer.alloc(0)]) {
    const s = service([[has('/track/5'), () => json(track(5))], [has('cdnt-preview'), () => bytes(body)]]);
    await assert.rejects(s.songs.fetch({ id: 5 }), { status: 415, code: 'song-bad-type' });
    assert.deepEqual(readdirSync(s.dir).filter((n) => n === 'files'), [], 'nothing was kept');
  }
  // Too big: said up front, or only found out while reading.
  const big = service([[has('/track/5'), () => json(track(5))], [has('cdnt-preview'), () => bytes(MP3_ID3, { 'content-length': String(MAX_SONG + 1) })]]);
  await assert.rejects(big.songs.fetch({ id: 5 }), { status: 413, code: 'song-too-big' });
  const chunk = Buffer.alloc(256 * 1024);
  let sent = 0;
  const endless = new ReadableStream({
    pull(ctrl) {
      sent++;
      ctrl.enqueue(sent === 1 ? Buffer.concat([MP3_ID3, chunk]) : chunk);
    },
  });
  const sneaky = service([[has('/track/5'), () => json(track(5))], [has('cdnt-preview'), () => new Response(endless)]]);
  await assert.rejects(sneaky.songs.fetch({ id: 5 }), { code: 'song-too-big' });
  assert.ok(sent <= 12, 'stopped reading soon after the limit');
  // Gone, no internet, the quota, a 404 on the preview.
  const missing = service([[has('/track/5'), () => json({ error: { type: 'DataException', message: 'no data', code: 800 } })]]);
  await assert.rejects(missing.songs.fetch({ id: 5 }), { status: 404, code: 'song-missing' });
  const off = service([[has('/track/5'), () => json(track(5))], [has('cdnt-preview'), offline]]);
  await assert.rejects(off.songs.fetch({ id: 5 }), { code: 'no-internet' });
  const quota = service([[has('/track/5'), () => json({ error: { type: 'Exception', message: 'Quota limit exceeded', code: 4 } })]]);
  await assert.rejects(quota.songs.fetch({ id: 5 }), { status: 429, code: 'rate-limited' });
  const gone = service([[has('/track/5'), () => json(track(5))], [has('cdnt-preview'), () => new Response('', { status: 403 })]]);
  await assert.rejects(gone.songs.fetch({ id: 5 }), { status: 404, code: 'song-missing' });
});

// ----- the credit in the quiz -----

const songCredit = (author = 'ABBA') => ({ title: 'Dancing Queen', author, source: 'deezer', sourceUrl: 'https://www.deezer.com/track/884025' });

test('a song’s credit is kept with the quiz, in the export, and tidied like a picture’s', async () => {
  assert.deepEqual(cleanCredits({ 'aaaaaaaaaaaaaaaa.mp3': { ...songCredit(), source: 'spotify', sourceUrl: 'http://x' } }, ['aaaaaaaaaaaaaaaa.mp3']), { 'aaaaaaaaaaaaaaaa.mp3': { title: 'Dancing Queen', author: 'ABBA' } });
  const dir = mkdtempSync(join(tmpdir(), 'proquiz-song-credits-'));
  const store = createStore(dir);
  const { name } = await store.addFile('song.mp3', MP3_ID3);
  const board = {
    v: 1,
    title: 'Songs',
    categories: [{ name: 'A', questions: [{ value: 100, question: 'Which song?', answer: 'Dancing Queen', audio: name, audioStart: 5, audioLength: 10 }] }],
    credits: { [name]: songCredit(), 'eeeeeeeeeeeeeeee.mp3': songCredit('Gone') },
  };
  const id = await store.create(board);
  const saved = (await store.get(id)).set;
  assert.deepEqual(saved.credits, { [name]: songCredit() });
  assert.deepEqual(saved.categories[0].questions[0], { value: 100, question: 'Which song?', answer: 'Dancing Queen', audio: name, audioStart: 5, audioLength: 10 });
  const pkg = await store.exportPackage(id);
  assert.deepEqual(pkg.set.credits, { [name]: songCredit() });
  assert.ok(pkg.files[name]);
  const copy = (await store.get((await store.importPackage(JSON.parse(JSON.stringify(pkg)))).ids[0])).set;
  assert.deepEqual(copy.credits, { [name]: songCredit() });
  assert.equal(copy.categories[0].questions[0].audioLength, 10);
  // The clip removed: its credit goes too.
  delete saved.categories[0].questions[0].audio;
  await store.save(id, saved);
  assert.equal((await store.get(id)).set.credits, undefined);
  assert.equal((await store.get(id)).set.categories[0].questions[0].audioLength, undefined, 'no length without a clip');
});

// ----- the TV's credit line -----

const songSet = {
  v: 1,
  title: 'Songs',
  categories: [
    {
      name: 'A',
      questions: [
        { value: 100, question: 'Which song?', answer: 'Dancing Queen', audio: '1111111111111111.mp3', audioStart: 5, audioLength: 10 },
        { value: 200, question: 'q2', answer: 'a2' },
      ],
    },
  ],
  final: { category: 'F', question: 'fq', answer: 'fa', audio: '2222222222222222.mp3' },
  credits: { '1111111111111111.mp3': songCredit(), '2222222222222222.mp3': songCredit('Daft Punk') },
};
const run = (s, ...actions) => actions.reduce(apply, s);
const startedWith = (settings = {}, set = songSet) =>
  run(newGame(set, settings), { type: 'join', teamId: 'r', name: 'Red', color: COLORS[0] }, { type: 'join', teamId: 'b', name: 'Blue', color: COLORS[1] }, { type: 'start', picker: 'r' });
const noSongAnywhere = (v) => assert.ok(!/credit|ABBA|Dancing|\.mp3/.test(JSON.stringify(v)), JSON.stringify(v).slice(0, 200));

test('the TV gets a song’s artist only once the answer is shown, never its title; phones never anything', () => {
  let s = run(startedWith(), { type: 'pick', c: 0, i: 0 }, { type: 'arm', now: 1000 });
  assert.deepEqual(displayView(s).clip, { file: '1111111111111111.mp3', start: 5, length: 10 });
  assert.equal(displayView(s).q.clipCredit, undefined);
  assert.equal(displayView(s).set.credits, undefined);
  noSongAnywhere(phoneView(s, 'r'));
  assert.equal(hostView(s).set.credits['1111111111111111.mp3'].title, 'Dancing Queen'); // the host sees everything
  s = run(s, { type: 'buzz', teamId: 'r', now: 1100 }, { type: 'correct' });
  assert.equal(s.phase, 'revealed');
  assert.deepEqual(displayView(s).q.clipCredit, { author: 'ABBA', license: '', source: 'deezer' });
  assert.ok(!JSON.stringify(displayView(s).q.clipCredit).includes('Dancing'));
  noSongAnywhere(phoneView(s, 'r'));
  const off = run(startedWith({ showCredits: false }), { type: 'pick', c: 0, i: 0 }, { type: 'reveal' });
  assert.equal(displayView(off).q.clipCredit, undefined);
  // The final's with its answer.
  let f = run(startedWith(), { type: 'end' }, { type: 'wager', teamId: 'r', amount: 0 }, { type: 'wager', teamId: 'b', amount: 0 }, { type: 'next', now: 0 });
  assert.equal(displayView(f).final.clipCredit, undefined);
  f = run(f, { type: 'timeout', now: 40_000 }, { type: 'judgeFinal', teamId: 'r', correct: true }, { type: 'judgeFinal', teamId: 'b', correct: false });
  assert.deepEqual(displayView(f).final.clipCredit, { author: 'Daft Punk', license: '', source: 'deezer' });
  noSongAnywhere(phoneView(f, 'r'));
  // A Quick quiz: with the result.
  const quick = {
    v: 1,
    kind: 'quick',
    title: 'Q',
    sections: [{ name: 'S', questions: [{ question: 'Which song?', options: ['Waterloo', 'Mamma Mia'], correct: 0, audio: '1111111111111111.mp3', audioLength: 12 }] }],
    credits: { '1111111111111111.mp3': songCredit() },
  };
  let q = run(newGame(quick), { type: 'join', teamId: 'r', name: 'Red', color: COLORS[0] }, { type: 'start' }, { type: 'next', now: 0 }, { type: 'next', now: 1000 });
  assert.equal(q.phase, 'open');
  assert.deepEqual(displayView(q).clip, { file: '1111111111111111.mp3', start: 0, length: 12 });
  assert.equal(displayView(q).q.clipCredit, undefined);
  noSongAnywhere(phoneView(q, 'r'));
  q = apply(q, { type: 'answer', teamId: 'r', option: 0, now: 2000 });
  assert.equal(q.phase, 'result');
  assert.deepEqual(displayView(q).q.clipCredit, { author: 'ABBA', license: '', source: 'deezer' });
  noSongAnywhere(phoneView(q, 'r'));
});

// ----- the routes: only for the editor on the laptop -----

let srv;
let base;
let remotePort;
const net = fakeNet([
  [has('/search?'), () => json(searchAnswer([1, 2, 3]))],
  [has('/track/884025'), () => json(track(884025))],
  [has('cdnt-preview'), () => bytes(MP3_ID3)],
]);
before(async () => {
  srv = await startServer({ port: 3497, quiet: true, dataDir: mkdtempSync(join(tmpdir(), 'proquiz-songs-srv-')), songOptions: { fetchImpl: net.fetchImpl } });
  base = `http://127.0.0.1:${srv.info.port}`;
  remotePort = await srv.openRemote();
});
after(() => srv.close());

const req = (path, { method = 'GET', body, headers = {}, port } = {}) =>
  fetch(`http://127.0.0.1:${port ?? srv.info.port}${path}`, { method, body: body && JSON.stringify(body), headers, signal: AbortSignal.timeout(5000) }).then(async (r) => ({
    status: r.status,
    data: await r.json().catch(() => null),
  }));

test('the editor searches and fetches songs through the laptop’s own server', async () => {
  const found = await req('/api/songs/search?q=abba&page=1');
  assert.equal(found.status, 200);
  assert.equal(found.data.results.length, 3);
  assert.equal(found.data.more, true);
  assert.equal(found.data.results[0].preview, preview(1), 'the preview address goes to the editor for ▶, never into a quiz');
  assert.deepEqual(await req('/api/songs/search?q='), { status: 400, data: { error: 'bad-query' } });
  const got = await req('/api/songs/fetch', { method: 'POST', body: { id: 884025 }, headers: { 'Sec-Fetch-Site': 'same-origin' } });
  assert.equal(got.status, 201);
  assert.match(got.data.name, /^[0-9a-f]{16}\.mp3$/);
  assert.deepEqual(got.data.credit, { title: 'Song 884025', author: 'ABBA', source: 'deezer', sourceUrl: 'https://www.deezer.com/track/884025' });
  const served = await fetch(`${base}/files/${got.data.name}`);
  assert.equal(served.headers.get('content-type'), 'audio/mpeg');
  assert.deepEqual(Buffer.from(await served.arrayBuffer()), MP3_ID3);
  assert.deepEqual(await req('/api/songs/fetch', { method: 'POST', body: { id: 'x' } }), { status: 400, data: { error: 'bad-id' } });
});

test('nobody else can search or fetch songs: not over the internet, not another website', async () => {
  const before = net.calls.length;
  assert.equal((await req('/api/songs/search?q=abba', { port: remotePort })).status, 403);
  assert.equal((await req('/api/songs/fetch', { method: 'POST', body: { id: 884025 }, port: remotePort })).status, 403);
  assert.equal((await req('/api/songs/search?q=abba', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await req('/api/songs/fetch', { method: 'POST', body: { id: 884025 }, headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal(net.calls.length, before, 'nothing was asked upstream');
});

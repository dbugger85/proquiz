// "Find a free picture" (pictures.js): searching Openverse and Wikimedia Commons, downloading the chosen picture
// safely, its credit kept in the quiz, the routes only for the editor on the laptop, and the TV's credit line only
// after the answer. Never on the real internet: every test uses a pretend `fetchImpl`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPictures, parseOpenverse, parseWikimedia, imageKind, licenseLabel, stripHtml, safeUrl, MAX_PICTURE, USER_AGENT } from '../pictures.js';
import { createStore } from '../store.js';
import { cleanCredits, usedFiles } from '../lib/validate.js';
import { apply, newGame, COLORS, displayView, phoneView, hostView } from '../lib/game.js';
import { startServer } from '../server.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const SVG = Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(10)]);
const OV_ID = '2b2b67a6-fba8-4288-8e2e-7067b310e331';

// Openverse and Commons answers, shaped like the real ones (checked on 2026-10-11).
const ovItem = (n, extra = {}) => ({
  id: `${String(n).padStart(8, '0')}-fba8-4288-8e2e-7067b310e331`,
  title: `Tower ${n}`,
  creator: 'johntrainor',
  license: 'by',
  license_version: '2.0',
  license_url: 'https://creativecommons.org/licenses/by/2.0/',
  foreign_landing_url: 'https://www.flickr.com/photos/1/2',
  url: `https://live.staticflickr.com/1/${n}_b.jpg`,
  thumbnail: `https://api.openverse.org/v1/images/${n}/thumb/`,
  provider: 'flickr',
  width: 683,
  height: 1024,
  mature: false,
  ...extra,
});
const ovSearch = (page = 1, page_count = 3) => ({
  result_count: 60,
  page_count,
  page_size: 20,
  page,
  results: [ovItem(1), ovItem(2, { license: 'cc0', license_version: '1.0' }), ovItem(3, { license: 'pdm', license_version: '' }), ovItem(4, { license: 'by-nc-sa', license_version: '4.0' })],
});
const meta = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { value: v, source: 'commons-desc-page' }]));
const wmPage = (index, title, mime, extra = {}) => ({
  pageid: index * 10,
  ns: 6,
  title: `File:${title}`,
  index,
  imageinfo: [
    {
      size: 1000,
      width: 512,
      height: 372,
      mime,
      thumburl: `https://thumb.wikimedia.org/wikipedia/commons/thumb/d/d9/${encodeURIComponent(title)}/330px-x.png`,
      url: `https://upload.wikimedia.org/wikipedia/commons/d/d9/${encodeURIComponent(title)}`,
      descriptionurl: `https://commons.wikimedia.org/wiki/File:${title.replace(/ /g, '_')}`,
      descriptionshorturl: 'https://commons.wikimedia.org/w/index.php?curid=1',
      extmetadata: meta({
        ObjectName: title.replace(/\.\w+$/, ''),
        Artist: '<a href="//commons.wikimedia.org/wiki/User:Min%27s" title="User:Min&#39;s">Min&#39;s &amp; co</a>',
        LicenseShortName: 'CC BY-SA 4.0',
        LicenseUrl: 'http://creativecommons.org/licenses/by-sa/4.0',
      }),
      ...extra,
    },
  ],
});
const wmSearch = (more = true) => ({
  ...(more && { continue: { gsroffset: 20, continue: 'gsroffset||' } }),
  query: {
    pages: [wmPage(2, 'Norges flagg 1821.PNG', 'image/png'), wmPage(1, 'Flag of Norway.svg', 'image/svg+xml'), wmPage(3, 'Anthem.ogg', 'application/ogg')],
  },
});

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
  throw new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND api.openverse.org'), { code: 'ENOTFOUND' }) });
};

function service(routes, opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'proquiz-pictures-'));
  const net = fakeNet(routes);
  const store = createStore(dir);
  return { ...net, dir, store, pictures: createPictures({ store, fetchImpl: net.fetchImpl, ...opts }) };
}

test('small helpers: the kind of picture from its bytes, licence names, plain text, safe addresses', () => {
  assert.equal(imageKind(PNG), 'png');
  assert.equal(imageKind(GIF), 'gif');
  assert.equal(imageKind(SVG), 'svg');
  assert.equal(imageKind(Buffer.from('MZ\x90\x00')), null);
  assert.equal(licenseLabel('by-sa', '4.0'), 'CC BY-SA 4.0');
  assert.equal(licenseLabel('cc0', '1.0'), 'CC0');
  assert.equal(licenseLabel('pdm', ''), 'Public domain');
  assert.equal(stripHtml('<div>Original:</div> <a href="x">Fredrik&nbsp;Meltzer</a> &amp; &#39;co&#x27;'), "Original: Fredrik Meltzer & 'co'");
  assert.equal(safeUrl('https://live.staticflickr.com/a.jpg'), 'https://live.staticflickr.com/a.jpg');
  for (const bad of ['http://example.com/a.jpg', 'https://127.0.0.1/a.png', 'https://[::1]/a.png', 'https://localhost/a.png', 'https://printer.local/a.png', 'https://intranet/a.png', 'https://u:p@example.com/a', 'file:///etc/passwd', 'nonsense']) {
    assert.equal(safeUrl(bad), null, bad);
  }
  assert.equal(safeUrl('https://upload.wikimedia.org/x.png', ['upload.wikimedia.org']), 'https://upload.wikimedia.org/x.png');
  assert.equal(safeUrl('https://evil.example/x.png', ['upload.wikimedia.org']), null);
});

test('Openverse answers become results with a readable licence, and "more" from the page count', () => {
  const { results, page, more } = parseOpenverse(ovSearch(1, 3));
  assert.equal(page, 1);
  assert.equal(more, true);
  assert.equal(parseOpenverse(ovSearch(3, 3)).more, false);
  assert.deepEqual(
    results.map((r) => r.license),
    ['CC BY 2.0', 'CC0', 'Public domain', 'CC BY-NC-SA 4.0'],
  );
  assert.deepEqual(results.map((r) => r.nc), [false, false, false, true]);
  assert.equal(results[0].thumb, 'https://api.openverse.org/v1/images/1/thumb/');
  assert.equal(results[0].fallback, 'https://live.staticflickr.com/1/1_b.jpg');
  assert.equal(results[0].provider, 'Flickr');
  assert.equal(results[0].author, 'johntrainor');
  assert.equal(results[0].source, 'openverse');
  // Anything that isn't a proper result is left out.
  assert.equal(parseOpenverse({ results: [{ id: '../x', thumbnail: 'x' }, ovItem(5, { mature: true })] }).results.length, 0);
});

test('Wikimedia Commons answers: in search order, sounds left out, drawings kept (shown as PNG), the author as plain text', () => {
  const { results, more } = parseWikimedia(wmSearch(true), 1);
  assert.equal(more, true);
  assert.equal(parseWikimedia(wmSearch(false)).more, false);
  assert.deepEqual(
    results.map((r) => r.id),
    ['Flag of Norway.svg', 'Norges flagg 1821.PNG'],
  );
  const flag = results[0];
  assert.equal(flag.title, 'Flag of Norway');
  assert.equal(flag.author, "Min's & co");
  assert.equal(flag.license, 'CC BY-SA 4.0');
  assert.equal(flag.licenseUrl, 'https://creativecommons.org/licenses/by-sa/4.0');
  assert.equal(flag.sourceUrl, 'https://commons.wikimedia.org/wiki/File:Flag_of_Norway.svg');
  assert.match(flag.thumb, /\.png$/);
});

test('an Openverse search: the right question, the licence choice, a proper name, and asked only once', async () => {
  const { pictures, calls } = service([[has('api.openverse.org/v1/images/?'), (u) => json(ovSearch(Number(new URL(u).searchParams.get('page'))))]]);
  const first = await pictures.search({ q: '  Eiffel   Tower ', source: 'openverse' });
  assert.equal(first.results.length, 4);
  const url = new URL(calls[0].url);
  assert.equal(url.origin + url.pathname, 'https://api.openverse.org/v1/images/');
  assert.equal(url.searchParams.get('q'), 'Eiffel Tower');
  assert.equal(url.searchParams.get('page'), '1');
  assert.equal(url.searchParams.get('page_size'), '20');
  assert.equal(url.searchParams.get('mature'), 'false');
  assert.equal(url.searchParams.get('license'), 'cc0,pdm,by,by-sa'); // free for any use, no "no derivatives"
  assert.equal(calls[0].opts.headers['User-Agent'], USER_AGENT);
  assert.match(USER_AGENT, /^ProQuiz\/\S+ \(https:\/\/github\.com\/dbugger85\/proquiz/);

  // The same search again comes from memory; the next page or the other licence choice asks again.
  await pictures.search({ q: 'eiffel tower', source: 'openverse' });
  assert.equal(calls.length, 1);
  await pictures.search({ q: 'eiffel tower', source: 'openverse', page: 2 });
  await pictures.search({ q: 'eiffel tower', source: 'openverse', license: 'nc' });
  assert.equal(calls.length, 3);
  assert.equal(new URL(calls[2].url).searchParams.get('license'), 'cc0,pdm,by,by-sa,by-nc,by-nc-sa');
});

test('a Wikimedia Commons search asks for pictures and drawings, in Norwegian when the quiz is', async () => {
  const { pictures, calls } = service([[has('commons.wikimedia.org/w/api.php'), () => json(wmSearch())]], { lang: () => 'no' });
  const out = await pictures.search({ q: 'Norges flagg', source: 'wikimedia', page: 2 });
  assert.equal(out.results.length, 2);
  assert.equal(out.page, 2);
  const p = new URL(calls[0].url).searchParams;
  assert.equal(p.get('formatversion'), '2');
  assert.equal(p.get('generator'), 'search');
  assert.equal(p.get('gsrnamespace'), '6');
  assert.equal(p.get('gsrsearch'), 'filetype:bitmap|drawing Norges flagg');
  assert.equal(p.get('gsroffset'), '20');
  assert.equal(p.get('iiextmetadatalanguage'), 'nb');
  assert.equal(calls[0].opts.headers['User-Agent'], USER_AGENT);
  await pictures.search({ q: 'Norges flagg', source: 'wikimedia', page: 1, lang: 'en' });
  assert.equal(new URL(calls[1].url).searchParams.get('iiextmetadatalanguage'), 'en');
});

test('searches that go wrong: bad questions, no internet, too many searches, nothing more to show', async () => {
  const { pictures, calls } = service([]);
  await assert.rejects(pictures.search({ q: 'x', source: 'google' }), { status: 400, code: 'bad-source' });
  await assert.rejects(pictures.search({ q: '   ', source: 'openverse' }), { code: 'bad-query' });
  await assert.rejects(pictures.search({ q: 'x'.repeat(201), source: 'openverse' }), { code: 'bad-query' });
  await assert.rejects(pictures.search({ q: 'x', source: 'openverse', page: 0 }), { code: 'bad-query' });
  await assert.rejects(pictures.search({ q: 'x', source: 'openverse', page: 1.5 }), { code: 'bad-query' });
  assert.equal(calls.length, 0, 'nothing was asked upstream');

  const off = service([[() => true, offline]]);
  await assert.rejects(off.pictures.search({ q: 'x', source: 'openverse' }), { status: 503, code: 'no-internet' });
  const deno = service([[() => true, () => Promise.reject(new TypeError('error sending request: dns error: failed to lookup address information'))]]);
  await assert.rejects(deno.pictures.search({ q: 'x', source: 'wikimedia' }), { code: 'no-internet' });

  const busy = service([[() => true, () => new Response('{}', { status: 429, headers: { 'retry-after': '30' } })]]);
  await assert.rejects(busy.pictures.search({ q: 'x', source: 'openverse' }), { status: 429, code: 'rate-limited', retryAfter: 30 });
  const wmBusy = service([[() => true, () => json({ error: { code: 'ratelimited', info: 'slow down' } })]]);
  await assert.rejects(wmBusy.pictures.search({ q: 'x', source: 'wikimedia' }), { code: 'rate-limited', retryAfter: 60 });
  const broken = service([[() => true, () => new Response('oops', { status: 500 })]]);
  await assert.rejects(broken.pictures.search({ q: 'x', source: 'openverse' }), { status: 502, code: 'picture-failed' });
  assert.equal(broken.calls.length, 2, 'a busy moment is tried once more');
  let tries = 0;
  const flaky = service([[() => true, () => (tries++ ? json(wmSearch()) : new Response('busy', { status: 503 }))]]);
  assert.equal((await flaky.pictures.search({ q: 'x', source: 'wikimedia' })).results.length, 2);

  // Without an account Openverse stops after a few pages: past that, there's simply no more.
  const deep = service([[() => true, () => new Response('{"detail":"page too deep"}', { status: 400 })]]);
  assert.deepEqual(await deep.pictures.search({ q: 'x', source: 'openverse', page: 13 }), { results: [], page: 13, more: false });
  await assert.rejects(deep.pictures.search({ q: 'x', source: 'openverse', page: 1 }), { code: 'picture-failed' });
});

test('fetching a picture: bad sources and ids are refused before anything is asked', async () => {
  const { pictures, calls } = service([]);
  await assert.rejects(pictures.fetch({ source: 'web', id: OV_ID }), { status: 400, code: 'bad-source' });
  await assert.rejects(pictures.fetch({ source: 'openverse', id: 'https://evil.example/x.png' }), { code: 'bad-id' });
  await assert.rejects(pictures.fetch({ source: 'openverse', id: `${OV_ID}/../x` }), { code: 'bad-id' });
  await assert.rejects(pictures.fetch({ source: 'wikimedia', id: 'A.jpg|File:B.jpg' }), { code: 'bad-id' });
  await assert.rejects(pictures.fetch({ source: 'wikimedia', id: '' }), { code: 'bad-id' });
  await assert.rejects(pictures.fetch({ source: 'wikimedia', id: 'x'.repeat(251) }), { code: 'bad-id' });
  assert.equal(calls.length, 0);
});

test('an Openverse picture is downloaded, checked and kept under its content name, with its credit', async () => {
  const { pictures, calls, dir } = service([
    [has(`/v1/images/${OV_ID}/`), (u) => (u.includes('/thumb/') ? bytes(GIF) : json({ ...ovItem(1), id: OV_ID, title: 'Eiffel <b>Tower</b>' }))],
    [has('live.staticflickr.com'), () => bytes(PNG, { 'content-length': String(PNG.length) })],
  ]);
  const out = await pictures.fetch({ source: 'openverse', id: OV_ID });
  assert.match(out.name, /^[0-9a-f]{16}\.png$/);
  assert.equal(out.kind, 'image');
  assert.deepEqual(out.credit, {
    title: 'Eiffel Tower',
    author: 'johntrainor',
    license: 'CC BY 2.0',
    licenseUrl: 'https://creativecommons.org/licenses/by/2.0/',
    source: 'openverse',
    sourceUrl: 'https://www.flickr.com/photos/1/2',
  });
  assert.deepEqual(readFileSync(join(dir, 'files', out.name)), PNG);
  assert.ok(calls.every((c) => c.opts.headers['User-Agent'] === USER_AGENT));
  assert.equal(calls[1].opts.redirect, 'manual');
});

test('an Openverse original that is unsafe, missing or not a picture falls back to Openverse’s own copy', async () => {
  for (const [url, answer] of [
    ['http://live.staticflickr.com/a.jpg', null], // not https: never asked
    ['https://10.0.0.5/a.jpg', null], // an address on the local network: never asked
    ['https://live.staticflickr.com/gone.jpg', () => new Response('', { status: 404 })],
    ['https://live.staticflickr.com/page.jpg', () => bytes(Buffer.from('<html>moved</html>'))],
    ['https://live.staticflickr.com/hop.jpg', () => new Response(null, { status: 302, headers: { location: 'https://192.168.1.1/admin.png' } })],
  ]) {
    const { pictures, calls } = service([
      [has('/thumb/?full_size=true'), () => bytes(GIF)],
      [has(`/v1/images/${OV_ID}/`), () => json({ ...ovItem(1), id: OV_ID, url })],
      [has(new URL(url).host), answer ?? (() => assert.fail(`asked ${url}`))],
    ]);
    const out = await pictures.fetch({ source: 'openverse', id: OV_ID });
    assert.match(out.name, /\.gif$/, url);
    assert.ok(!calls.some((c) => /192\.168|10\.0\.0\.5/.test(c.url)), 'never asked a local address');
  }
  // Both refused: the last reason.
  const { pictures } = service([
    [has('/thumb/?full_size=true'), () => bytes(SVG)],
    [has(`/v1/images/${OV_ID}/`), () => json({ ...ovItem(1), id: OV_ID, url: 'https://live.staticflickr.com/a.svg' })],
    [has('staticflickr'), () => bytes(SVG)],
  ]);
  await assert.rejects(pictures.fetch({ source: 'openverse', id: OV_ID }), { status: 415, code: 'picture-bad-type' });
});

test('a Wikimedia picture: its PNG render from Wikimedia’s own servers only, redirects checked, size and type checked', async () => {
  const detail = (thumburl, extra = {}) => json({ query: { pages: [wmPage(1, 'Flag of Norway.svg', 'image/svg+xml', { thumburl, ...extra })] } });
  const ok = service([
    [has('commons.wikimedia.org/w/api.php'), () => detail('https://thumb.wikimedia.org/a/1920px-Flag.svg.png')],
    [has('thumb.wikimedia.org'), () => new Response(null, { status: 301, headers: { location: 'https://upload.wikimedia.org/a/1920px-Flag.svg.png' } })],
    [has('upload.wikimedia.org'), () => bytes(PNG)],
  ]);
  const out = await ok.pictures.fetch({ source: 'wikimedia', id: 'Flag of Norway.svg' });
  assert.match(out.name, /\.png$/);
  assert.equal(out.credit.source, 'wikimedia');
  assert.equal(out.credit.author, "Min's & co");
  const p = new URL(ok.calls[0].url).searchParams;
  assert.equal(p.get('titles'), 'File:Flag of Norway.svg');
  assert.equal(p.get('iiurlwidth'), '1920');

  // Another host, even through a redirect, is never asked.
  const foreign = service([
    [has('commons.wikimedia.org/w/api.php'), () => detail('https://evil.example/flag.png')],
    [has('evil.example'), () => assert.fail('asked a foreign host')],
  ]);
  await assert.rejects(foreign.pictures.fetch({ source: 'wikimedia', id: 'Flag of Norway.svg' }), { code: 'picture-failed' });
  const hop = service([
    [has('commons.wikimedia.org/w/api.php'), () => detail('https://upload.wikimedia.org/flag.png')],
    [has('upload.wikimedia.org'), () => new Response(null, { status: 302, headers: { location: 'https://evil.example/flag.png' } })],
    [has('evil.example'), () => assert.fail('followed a redirect to a foreign host')],
  ]);
  await assert.rejects(hop.pictures.fetch({ source: 'wikimedia', id: 'Flag of Norway.svg' }), { code: 'picture-failed' });

  // Too big: said up front, or only found out while reading.
  const big = service([
    [has('commons.wikimedia.org/w/api.php'), () => detail('https://upload.wikimedia.org/big.png')],
    [has('upload.wikimedia.org'), () => bytes(PNG, { 'content-length': String(MAX_PICTURE + 1) })],
  ]);
  await assert.rejects(big.pictures.fetch({ source: 'wikimedia', id: 'Flag of Norway.svg' }), { status: 413, code: 'picture-too-big' });
  const chunk = Buffer.alloc(1024 * 1024);
  let sent = 0;
  const endless = new ReadableStream({
    pull(ctrl) {
      sent++;
      ctrl.enqueue(sent === 1 ? Buffer.concat([PNG, chunk]) : chunk);
    },
  });
  const sneaky = service([
    [has('commons.wikimedia.org/w/api.php'), () => detail('https://upload.wikimedia.org/big.png')],
    [has('upload.wikimedia.org'), () => new Response(endless)],
  ]);
  await assert.rejects(sneaky.pictures.fetch({ source: 'wikimedia', id: 'Flag of Norway.svg' }), { code: 'picture-too-big' });
  assert.ok(sent <= 17, 'stopped reading soon after the limit');

  // Not a picture, an SVG, a missing file, a sound file.
  for (const [body, code] of [
    [Buffer.from('MZ\x90\x00 not a picture'), 'picture-bad-type'],
    [SVG, 'picture-bad-type'],
  ]) {
    const s = service([
      [has('commons.wikimedia.org/w/api.php'), () => detail('https://upload.wikimedia.org/x.png')],
      [has('upload.wikimedia.org'), () => bytes(body)],
    ]);
    await assert.rejects(s.pictures.fetch({ source: 'wikimedia', id: 'Flag of Norway.svg' }), { status: 415, code });
    assert.deepEqual(readdirSync(s.dir).filter((n) => n === 'files'), [], 'nothing was kept');
  }
  const missing = service([[has('commons.wikimedia.org'), () => json({ query: { pages: [{ ns: 6, title: 'File:Nope.jpg', missing: true }] } })]]);
  await assert.rejects(missing.pictures.fetch({ source: 'wikimedia', id: 'Nope.jpg' }), { status: 404, code: 'picture-missing' });
  const sound = service([[has('commons.wikimedia.org'), () => json({ query: { pages: [wmPage(1, 'Anthem.ogg', 'application/ogg')] } })]]);
  await assert.rejects(sound.pictures.fetch({ source: 'wikimedia', id: 'Anthem.ogg' }), { status: 415 });
  const off = service([[has('commons.wikimedia.org'), () => detail('https://upload.wikimedia.org/x.png')], [has('upload.wikimedia.org'), offline]]);
  await assert.rejects(off.pictures.fetch({ source: 'wikimedia', id: 'Flag of Norway.svg' }), { code: 'no-internet' });
});

// ----- credits in the quiz -----

const credit = (author = 'Ann') => ({ title: 'Tower', author, license: 'CC BY 2.0', licenseUrl: 'https://creativecommons.org/licenses/by/2.0/', source: 'openverse', sourceUrl: 'https://flickr.com/x' });

test('credits are tidied: only pictures in use, short texts, https links only', () => {
  const used = ['aaaaaaaaaaaaaaaa.png', 'bbbbbbbbbbbbbbbb.jpg', 'clip.mp3'];
  const out = cleanCredits(
    {
      'aaaaaaaaaaaaaaaa.png': { ...credit(), title: 'x'.repeat(300), author: ' Ann\n\tB ', licenseUrl: 'javascript:alert(1)', sourceUrl: 'http://flickr.com/x', source: 'evil', extra: 1 },
      'bbbbbbbbbbbbbbbb.jpg': { title: '', author: '', license: '' },
      'cccccccccccccccc.png': credit(), // not used any more
      'clip.mp3': credit(), // not a picture
      '../x.png': credit(),
    },
    used,
  );
  assert.deepEqual(Object.keys(out), ['aaaaaaaaaaaaaaaa.png']);
  assert.deepEqual(out['aaaaaaaaaaaaaaaa.png'], { title: 'x'.repeat(200), author: 'Ann B', license: 'CC BY 2.0' });
  assert.deepEqual(cleanCredits(null, used), {});
  assert.deepEqual(cleanCredits([credit()], used), {});
  assert.deepEqual(usedFiles({ categories: [{ questions: [{ image: 'a.png', answerImage: 'b.png' }] }], round2: { categories: [{ questions: [{ audio: 'c.mp3' }] }] }, final: { image: 'd.png' } }).sort(), ['a.png', 'b.png', 'c.mp3', 'd.png']);
});

test('saving keeps the credits of pictures in use, and an export and import carry them', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'proquiz-credits-'));
  const store = createStore(dir);
  const { name } = await store.addFile('picture.png', PNG);
  const board = {
    v: 1,
    title: 'Credits',
    categories: [{ name: 'A', questions: [{ value: 100, question: 'q', answer: 'a', answerImage: name }] }],
    credits: { [name]: credit(), 'eeeeeeeeeeeeeeee.png': credit('Gone') },
  };
  const id = await store.create(board);
  const saved = (await store.get(id)).set;
  assert.deepEqual(saved.credits, { [name]: credit() });
  const pkg = await store.exportPackage(id);
  assert.deepEqual(pkg.set.credits, { [name]: credit() });
  assert.ok(pkg.files[name]);
  const copy = (await store.get((await store.importPackage(JSON.parse(JSON.stringify(pkg)))).ids[0])).set;
  assert.deepEqual(copy.credits, { [name]: credit() });
  // The picture removed: its credit goes too.
  delete saved.categories[0].questions[0].answerImage;
  await store.save(id, saved);
  assert.equal((await store.get(id)).set.credits, undefined);
  // A Quick quiz keeps them the same way.
  const quick = { v: 1, kind: 'quick', title: 'Q', sections: [{ name: 'S', questions: [{ question: 'q', options: ['a', 'b'], correct: 0, image: name }] }], credits: { [name]: credit() } };
  assert.deepEqual((await store.get(await store.create(quick))).set.credits, { [name]: credit() });
});

// ----- the TV's credit line -----

const creditedSet = {
  v: 1,
  title: 'Credited',
  categories: [
    {
      name: 'A',
      questions: [
        { value: 100, question: 'Which tower?', answer: 'Eiffel', image: '1111111111111111.jpg' },
        { value: 200, question: 'q2', answer: 'a2' },
      ],
    },
  ],
  final: { category: 'F', question: 'fq', answer: 'fa', answerImage: '2222222222222222.png' },
  credits: { '1111111111111111.jpg': credit('Ann'), '2222222222222222.png': { ...credit('Bo'), source: 'wikimedia' } },
};
const run = (s, ...actions) => actions.reduce(apply, s);
const startedWith = (settings = {}, set = creditedSet) =>
  run(newGame(set, settings), { type: 'join', teamId: 'r', name: 'Red', color: COLORS[0] }, { type: 'join', teamId: 'b', name: 'Blue', color: COLORS[1] }, { type: 'start', picker: 'r' });
const noCreditsAnywhere = (v) => assert.ok(!/credit|Ann|Tower/.test(JSON.stringify(v)), JSON.stringify(v).slice(0, 200));

test('the TV gets a picture’s credit only once the answer is shown, without its title; phones never', () => {
  let s = startedWith();
  s = run(s, { type: 'pick', c: 0, i: 0 }, { type: 'arm', now: 1000 });
  assert.equal(displayView(s).q.credit, undefined);
  assert.equal(displayView(s).set.credits, undefined);
  noCreditsAnywhere(phoneView(s, 'r'));
  assert.deepEqual(hostView(s).set.credits['1111111111111111.jpg'].author, 'Ann'); // the host sees everything
  s = run(s, { type: 'buzz', teamId: 'r', now: 1100 }, { type: 'correct' });
  assert.equal(s.phase, 'revealed');
  assert.deepEqual(displayView(s).q.credit, { author: 'Ann', license: 'CC BY 2.0', source: 'openverse' });
  noCreditsAnywhere(phoneView(s, 'r'));
  // Turned off in the lobby: no line.
  const off = run(startedWith({ showCredits: false }), { type: 'pick', c: 0, i: 0 }, { type: 'reveal' });
  assert.equal(off.phase, 'revealed');
  assert.equal(displayView(off).q.credit, undefined);
  // A question without a credited picture has none.
  assert.equal(displayView(run(startedWith(), { type: 'pick', c: 0, i: 1 }, { type: 'reveal' })).q.credit, undefined);
});

test('the final’s credit appears with its answer, and a Quick quiz’s with the result', () => {
  let s = run(startedWith(), { type: 'end' }, { type: 'wager', teamId: 'r', amount: 0 }, { type: 'wager', teamId: 'b', amount: 0 }, { type: 'next', now: 0 });
  assert.equal(s.phase, 'finalQuestion');
  assert.equal(displayView(s).final.credit, undefined);
  s = run(s, { type: 'timeout', now: 40_000 }, { type: 'judgeFinal', teamId: 'r', correct: true });
  assert.equal(displayView(s).final.credit, undefined, 'not before every team is judged');
  s = apply(s, { type: 'judgeFinal', teamId: 'b', correct: false });
  assert.deepEqual(displayView(s).final.credit, { author: 'Bo', license: 'CC BY 2.0', source: 'wikimedia' });
  noCreditsAnywhere(phoneView(s, 'r'));

  const quick = {
    v: 1,
    kind: 'quick',
    title: 'Q',
    sections: [{ name: 'S', questions: [{ question: 'Which tower?', options: ['Eiffel', 'Big Ben'], correct: 0, image: '1111111111111111.jpg' }] }],
    credits: { '1111111111111111.jpg': credit('Ann') },
  };
  let q = run(newGame(quick), { type: 'join', teamId: 'r', name: 'Red', color: COLORS[0] }, { type: 'start' }, { type: 'next', now: 0 }, { type: 'next', now: 1000 });
  assert.equal(q.phase, 'open');
  assert.equal(displayView(q).q.credit, undefined);
  noCreditsAnywhere(phoneView(q, 'r'));
  q = apply(q, { type: 'answer', teamId: 'r', option: 0, now: 2000 });
  assert.equal(q.phase, 'result');
  assert.deepEqual(displayView(q).q.credit, { author: 'Ann', license: 'CC BY 2.0', source: 'openverse' });
  noCreditsAnywhere(phoneView(q, 'r'));
});

// ----- the routes: only for the editor on the laptop -----

let srv;
let base;
let remotePort;
const routes = [
  [has('api.openverse.org/v1/images/?'), () => json(ovSearch())],
  [has(`/v1/images/${OV_ID}/`), () => json({ ...ovItem(1), id: OV_ID })],
  [has('staticflickr'), () => bytes(PNG)],
];
const net = fakeNet(routes);
before(async () => {
  srv = await startServer({ port: 3494, quiet: true, dataDir: mkdtempSync(join(tmpdir(), 'proquiz-pictures-srv-')), pictureOptions: { fetchImpl: net.fetchImpl } });
  base = `http://127.0.0.1:${srv.info.port}`;
  remotePort = await srv.openRemote();
});
after(() => srv.close());

const req = (path, { method = 'GET', body, headers = {}, port } = {}) =>
  fetch(`http://127.0.0.1:${port ?? srv.info.port}${path}`, { method, body: body && JSON.stringify(body), headers, signal: AbortSignal.timeout(5000) }).then(async (r) => ({
    status: r.status,
    data: await r.json().catch(() => null),
  }));

test('the editor searches and fetches through the laptop’s own server', async () => {
  const found = await req('/api/pictures/search?q=tower&source=openverse&page=1&license=any');
  assert.equal(found.status, 200);
  assert.equal(found.data.results.length, 4);
  assert.equal(found.data.more, true);
  const bad = await req('/api/pictures/search?q=tower&source=google');
  assert.deepEqual(bad, { status: 400, data: { error: 'bad-source' } });
  const got = await req('/api/pictures/fetch', { method: 'POST', body: { source: 'openverse', id: OV_ID }, headers: { 'Sec-Fetch-Site': 'same-origin' } });
  assert.equal(got.status, 201);
  assert.match(got.data.name, /^[0-9a-f]{16}\.png$/);
  assert.equal(got.data.credit.author, 'johntrainor');
  const served = await fetch(`${base}/files/${got.data.name}`);
  assert.deepEqual(Buffer.from(await served.arrayBuffer()), PNG);
});

test('nobody else can search or fetch: not over the internet, not another website, not another name for the laptop', async () => {
  const before = net.calls.length;
  const search = '/api/pictures/search?q=tower&source=openverse';
  assert.equal((await req(search, { port: remotePort })).status, 403);
  assert.equal((await req('/api/pictures/fetch', { method: 'POST', body: { source: 'openverse', id: OV_ID }, port: remotePort })).status, 403);
  assert.equal((await req(search, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await req('/api/pictures/fetch', { method: 'POST', body: { source: 'openverse', id: OV_ID }, headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  const evil = await new Promise((resolve) => {
    import('node:http').then(({ request }) => {
      const r = request({ host: '127.0.0.1', port: srv.info.port, path: search, headers: { Host: 'evil.example' }, timeout: 5000 }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      r.on('error', () => resolve(0));
      r.end();
    });
  });
  assert.equal(evil, 403);
  assert.equal(net.calls.length, before, 'nothing was asked upstream');
});

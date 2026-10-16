// A pretend internet for the website tests: Openverse, Wikimedia Commons, Flickr, Deezer and its preview server
// as one small HTTP server on this machine. The Worker is started with `UPSTREAM=http://127.0.0.1:<port>`
// (web/room.js `upstreamFetch()`), so every address pictures.js and songs.js would fetch comes here as `?u=<the
// real address>`, with the request's method and headers as they were; the rules in pictures.js/songs.js still see
// the real https addresses. Shared by test/web.test.mjs and test/e2e-web.mjs. The answers are shaped like the real
// ones (checked on 2026-10-11), the same way test/e2e-pictures.mjs and test/e2e-songs.mjs pretend.
//
//   const fake = await startFakeUpstream({ port });   fake.mode = 'ok' | 'busy';   fake.calls;   fake.pictures(n)
import { createServer } from 'node:http';

export const FAKE_PORT = 3493;

// A 1×1 PNG, for tests that don't look at the picture (the browser suite draws real ones).
export const TINY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const SVG = Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const MP3 = Buffer.concat([Buffer.from('ID3\x04\x00\x00\x00\x00\x00\x00'), Buffer.alloc(2000)]);

export const uuid = (n) => `${String(n).padStart(8, '0')}-fba8-4288-8e2e-7067b310e331`;

// Openverse: 14 free pictures (page size 12, so page 2 exists), 4 non-commercial ones, and three odd ones for the
// refusals: 90 is an SVG, 91 says it is 20 MB, 92 sends you to an IP address.
const CREATORS = ['Ann Lee', 'Nasjonalbiblioteket', 'Pierre Dubois', 'Museo Nacional'];
export const OPENVERSE = Array.from({ length: 14 }, (_, i) => ({ n: i + 1, title: i === 0 ? 'Eiffel Tower at dusk' : `Tower ${i + 1}`, creator: CREATORS[i % 4], license: ['by', 'cc0', 'by-sa', 'pdm'][i % 4], license_version: ['2.0', '1.0', '4.0', ''][i % 4] }));
export const NONCOMMERCIAL = Array.from({ length: 4 }, (_, i) => ({ n: 20 + i, title: `Tower by night ${i + 1}`, creator: 'Night Owl', license: 'by-nc', license_version: '4.0' }));
const ODD = [
  { n: 90, title: 'A vector', creator: 'Vex', license: 'cc0', license_version: '1.0' },
  { n: 91, title: 'A huge one', creator: 'Big', license: 'cc0', license_version: '1.0' },
  { n: 92, title: 'A moved one', creator: 'Mover', license: 'cc0', license_version: '1.0' },
];
const ALL = [...OPENVERSE, ...NONCOMMERCIAL, ...ODD];
const ovItem = (it) => ({
  id: uuid(it.n),
  title: it.title,
  creator: it.creator,
  license: it.license,
  license_version: it.license_version,
  license_url: `https://creativecommons.org/licenses/${it.license}/${it.license_version || '1.0'}/`,
  foreign_landing_url: `https://www.flickr.com/photos/test/${it.n}`,
  url: `https://live.staticflickr.com/test/${it.n}.jpg`,
  thumbnail: `https://api.openverse.org/v1/images/${uuid(it.n)}/thumb/`,
  provider: it.n % 5 === 0 ? 'smithsonian' : 'flickr',
  width: 1600,
  height: 1200,
  mature: false,
});

export const FLAGS = ['Flag of Norway', 'Flag of Sweden', 'Flag of Denmark'];
const meta = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { value: v }]));
const wmPage = (name, i, byTitle) => ({
  title: `File:${name}.svg`,
  index: i + 1,
  imageinfo: [
    {
      mime: 'image/svg+xml',
      width: 1100,
      height: 800,
      thumburl: `https://upload.wikimedia.org/${byTitle ? 'render' : 'thumb'}/flag-${i + 1}.png`,
      url: `https://upload.wikimedia.org/${name}.svg`,
      descriptionurl: `https://commons.wikimedia.org/wiki/File:${name.replace(/ /g, '_')}.svg`,
      extmetadata: meta({ ObjectName: name, Artist: '<a href="//commons.wikimedia.org/wiki/User:Flagmaker">Flagmaker</a>', LicenseShortName: 'Public domain' }),
    },
  ],
});

export const SONGS = [
  ['Dancing Queen', 'ABBA', 'ABBA Gold', 231],
  ['Dancing Queen (Live at Wembley)', 'ABBA', 'Live at Wembley Arena', 245],
  ['Waterloo', 'ABBA', 'Waterloo', 164],
  ['Mamma Mia', 'ABBA', 'ABBA', 212],
  ['Take a Chance on Me', 'ABBA', 'The Album', 245],
  ['Dancing Queen', 'The Royal Philharmonic Orchestra', 'Symphonic ABBA', 251],
  ['Gimme! Gimme! Gimme!', 'ABBA', 'Voulez-Vous', 292],
  ['Fernando', 'ABBA', 'Arrival', 253],
  ['Chiquitita', 'ABBA', 'Voulez-Vous', 326],
  ['Super Trouper', 'ABBA', 'Super Trouper', 252],
  ['Dancing Queen', 'Kari Nordmann', 'Norske favoritter', 198],
  ['Lay All Your Love on Me', 'ABBA', 'Super Trouper', 274],
].map(([title, artist, album, duration], i) => ({ id: 884000 + i, title, artist, album, duration }));
const track = (s) => ({
  id: s.id,
  readable: true,
  title: s.title,
  title_short: s.title,
  link: `https://www.deezer.com/track/${s.id}`,
  duration: s.duration,
  preview: `https://cdnt-preview.dzcdn.net/api/1/1/${s.id}.mp3?hdnea=exp=1791718203~hmac=abc`,
  artist: { id: 180, name: s.artist, link: 'https://www.deezer.com/artist/180', type: 'artist' },
  album: { id: 1, title: s.album, cover_medium: `https://cdn-images.dzcdn.net/images/cover/${s.id}/250x250-000000-80-0-0.jpg`, type: 'album' },
  type: 'track',
});

const jsonAnswer = (data, status = 200, headers = {}) => ({ status, headers: { 'content-type': 'application/json', ...headers }, body: Buffer.from(JSON.stringify(data)) });
const bytesAnswer = (body, type, headers = {}) => ({ status: 200, headers: { 'content-type': type, ...headers }, body });

export async function startFakeUpstream({ port = FAKE_PORT, pictures = () => TINY_PNG, clip = MP3 } = {}) {
  const fake = { mode: 'ok', calls: [], pictures, clip };

  // The answer for one real address: { status, headers, body }.
  function answer(address) {
    const url = new URL(address);
    const p = url.searchParams;
    if (fake.mode === 'busy') {
      if (url.host === 'api.deezer.com') return jsonAnswer({ error: { type: 'Exception', message: 'Quota limit exceeded', code: 4 } });
      return jsonAnswer({ detail: 'slow down' }, 429, { 'retry-after': '60' });
    }
    if (url.host === 'api.openverse.org' && url.pathname === '/v1/images/') {
      const all = p.get('license').includes('nc') ? [...NONCOMMERCIAL, ...OPENVERSE] : OPENVERSE;
      const page = Number(p.get('page'));
      const per = 12;
      return jsonAnswer({ result_count: all.length, page_count: Math.ceil(all.length / per), page_size: per, page, results: all.slice((page - 1) * per, page * per).map(ovItem) });
    }
    const detail = url.pathname.match(/^\/v1\/images\/([0-9a-f-]{36})\/(thumb\/)?$/);
    if (url.host === 'api.openverse.org' && detail) {
      const it = ALL.find((x) => uuid(x.n) === detail[1]);
      if (!it) return jsonAnswer({ detail: 'Not found.' }, 404);
      if (!detail[2]) return jsonAnswer(ovItem(it));
      return picture(it.n); // the thumbnail service (also the fallback for the original)
    }
    if (url.host === 'live.staticflickr.com') return picture(Number(url.pathname.match(/(\d+)\.jpg$/)[1]));
    if (url.host === 'commons.wikimedia.org') {
      if (p.get('titles')) {
        const name = p.get('titles').replace(/^File:|\.svg$/g, '');
        const i = FLAGS.indexOf(name);
        return jsonAnswer({ query: { pages: i < 0 ? [{ title: p.get('titles'), missing: true }] : [wmPage(name, i, true)] } });
      }
      return jsonAnswer({ query: { pages: FLAGS.map((name, i) => wmPage(name, i, false)) } });
    }
    if (url.host === 'upload.wikimedia.org') return bytesAnswer(fake.pictures(Number(url.pathname.match(/flag-(\d)/)[1])), 'image/png');
    if (url.host === 'api.deezer.com' && url.pathname === '/search') {
      const index = Number(p.get('index'));
      const limit = Number(p.get('limit'));
      const page = SONGS.slice(index, index + limit);
      return jsonAnswer({ data: page.map(track), total: SONGS.length, ...(index + limit < SONGS.length && { next: `https://api.deezer.com/search?q=x&limit=${limit}&index=${index + limit}` }) });
    }
    const id = url.host === 'api.deezer.com' && url.pathname.match(/^\/track\/(\d+)$/)?.[1];
    if (id) {
      const s = SONGS.find((x) => x.id === Number(id));
      return s ? jsonAnswer(track(s)) : jsonAnswer({ error: { type: 'DataException', message: 'no data', code: 800 } });
    }
    if (url.host === 'cdnt-preview.dzcdn.net') return bytesAnswer(fake.clip, 'audio/mpeg');
    return { status: 404, headers: { 'content-type': 'text/plain' }, body: Buffer.from(`no pretend answer for ${address}`) };
  }
  function picture(n) {
    if (n === 90) return bytesAnswer(SVG, 'image/svg+xml');
    if (n === 91) return { ...bytesAnswer(TINY_PNG, 'image/png', { 'content-length': String(20 * 1024 * 1024) }), cut: true }; // says 20 MB, then hangs up
    if (n === 92) return { status: 302, headers: { location: 'https://10.0.0.1/moved.jpg' }, body: Buffer.alloc(0) };
    return bytesAnswer(fake.pictures(n), 'image/png');
  }

  const server = createServer((req, res) => {
    const u = new URL(req.url, 'http://x').searchParams.get('u');
    fake.calls.push(u ?? req.url);
    let out;
    try {
      out = answer(u);
    } catch (err) {
      out = { status: 500, headers: { 'content-type': 'text/plain' }, body: Buffer.from(String(err)) };
    }
    res.writeHead(out.status, out.headers);
    if (out.cut) {
      res.write(out.body, () => res.destroy()); // the rest never comes: the reader must have refused it by its Content-Length
      return;
    }
    res.end(out.body);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  fake.base = `http://127.0.0.1:${port}`;
  fake.stop = () => new Promise((r) => server.close(r));
  fake.searches = () => fake.calls.filter((c) => /v1\/images\/\?|generator=search|\/search\?/.test(c));
  return fake;
}

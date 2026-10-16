// Builds the website version's static files into dist/web (docs/dev/web-plan.md §8): the pages from public/
// (home.html becomes the front page index.html, and the phone page index.html becomes join.html, which the Worker
// serves at /r/<code>), the shared rules from lib/, the built-in quizzes and their files, and the _headers file.
// Wrangler bundles the Worker itself (web/worker.js). Run with `node scripts/web-build.mjs`.
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SECURITY_HEADERS } from '../web/headers.js';

const root = new URL('../', import.meta.url);
const out = new URL('dist/web/', root);
const path = (u) => fileURLToPath(u);

rmSync(path(out), { recursive: true, force: true });
mkdirSync(path(out), { recursive: true });

// Everything a page may load, without the notes (README.md) kept next to the fonts and the vendored code.
const skip = (src) => /\.md$/i.test(src) || /(^|\/)\.DS_Store$/.test(src);
cpSync(path(new URL('public/', root)), path(out), { recursive: true, filter: (src) => !skip(src) });
cpSync(path(new URL('lib/', root)), path(new URL('lib/', out)), { recursive: true, filter: (src) => !skip(src) });
mkdirSync(path(new URL('sets/files/', out)), { recursive: true });
for (const f of readdirSync(path(new URL('sets/', root)))) if (f.endsWith('.json')) cpSync(path(new URL(`sets/${f}`, root)), path(new URL(`sets/${f}`, out)));
cpSync(path(new URL('sets/files/', root)), path(new URL('sets/files/', out)), { recursive: true, filter: (src) => !skip(src) });

// Every page says it is the website version (env.js reads this, so `wrangler dev` on localhost counts as hosted too).
for (const f of readdirSync(path(out))) {
  if (!f.endsWith('.html')) continue;
  const file = new URL(f, out);
  const html = readFileSync(path(file), 'utf8').replace('<meta charset="utf-8">', '<meta charset="utf-8">\n  <meta name="proquiz" content="hosted">');
  if (!html.includes('name="proquiz"')) throw new Error(`${f}: no <meta charset> to stamp after`);
  writeFileSync(path(file), html);
}

// The front page, and the phone page under the name the Worker serves for a room.
cpSync(path(new URL('index.html', out)), path(new URL('join.html', out)));
cpSync(path(new URL('home.html', out)), path(new URL('index.html', out)));
rmSync(path(new URL('home.html', out)));

// Security headers for every static page (the Worker adds the same to the pages it serves itself).
const headers = ['/*', ...Object.entries(SECURITY_HEADERS).map(([k, v]) => `  ${k}: ${v}`), ''].join('\n');
writeFileSync(path(new URL('_headers', out)), headers);

console.log(`Built ${path(out)}`);

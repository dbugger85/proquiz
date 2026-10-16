// The website version's Worker (docs/dev/web-plan.md §1.5): the pages are static assets (dist/web, built by
// scripts/web-build.mjs), and everything under /r/<code> belongs to a room: the phone page, the TV page, the
// WebSocket (handed to the room's Durable Object) and the room's pictures and clips. Wrangler bundles this file
// with lib/hub.js and the rest (the one place ProQuiz uses a bundler).

import { Room, drain } from './room.js';
import { normalizeCode } from '../lib/room.js';
import { FILE_NAME } from '../lib/validate.js';
import { SECURITY_HEADERS } from './headers.js';

export { Room };

const notFound = (what = 'not found') => new Response(what, { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS } });

// A page from the assets (join.html = the phone page, display.html = the TV), with the security headers.
async function page(env, req, path) {
  const url = new URL(req.url);
  const res = await env.ASSETS.fetch(new Request(new URL(path, url.origin), { method: 'GET', headers: req.headers }));
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.headers.set(k, v);
  return out;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const m = /^\/r\/([^/]*)(\/.*)?$/.exec(url.pathname);
    if (m) {
      let code = null;
      try {
        code = normalizeCode(decodeURIComponent(m[1]));
      } catch {
        code = null;
      }
      const rest = m[2] ?? '';
      // A typo in the address bar: back to the front page, which says what a code looks like.
      if (!code) return rest === '/ws' ? notFound('no such room') : Response.redirect(`${url.origin}/?bad=1`, 302);
      // The code as the host made it (upper case), so the pages read the same room from the address.
      if (m[1] !== code) return Response.redirect(`${url.origin}/r/${code}${rest}${url.search}`, 302);
      if (rest === '' || rest === '/') return page(env, req, '/join');
      if (rest === '/display') return page(env, req, '/display');
      const room = () => env.ROOMS.get(env.ROOMS.idFromName(code));
      // The room's Durable Object gets the request as it came, plus the code it serves.
      const toRoom = () => {
        const headers = new Headers(req.headers);
        headers.set('x-proquiz-room', code);
        return room().fetch(new Request(req, { headers }));
      };
      if (rest === '/ws') return toRoom();
      // The editor's picture and song search run in the room (key checked there), so a download has the Durable
      // Object's CPU budget rather than this Worker's 10 ms.
      if (/^\/api\/(pictures|songs)\/(search|fetch)$/.test(rest)) return toRoom();
      // The quiz's pictures and clips (web-plan.md §3): the host's browser puts them into the room (`PUT`, key
      // checked there), lists them (`GET /files`) and drops one (`DELETE`); the TV and host pages fetch them, with
      // Range. A name the room doesn't have falls back to the built-in quizzes' files in the assets.
      if (rest === '/files') return req.method === 'GET' ? toRoom() : notFound();
      const f = /^\/files\/([^/]+)$/.exec(rest);
      if (f) {
        let name = '';
        try {
          name = decodeURIComponent(f[1]);
        } catch {
          name = '';
        }
        if (!FILE_NAME.test(name)) {
          await drain(req); // or workerd drops the connection with the body unread
          return notFound();
        }
        if (req.method === 'PUT' || req.method === 'DELETE') return toRoom();
        if (req.method !== 'GET') return notFound();
        const own = await toRoom();
        if (own.status !== 404) return own;
        const res = await env.ASSETS.fetch(new Request(new URL(`/sets/files/${encodeURIComponent(name)}`, url.origin), { method: 'GET', headers: req.headers }));
        const out = new Response(res.body, res);
        out.headers.set('X-Content-Type-Options', 'nosniff');
        return out;
      }
      return notFound();
    }
    // The laptop's /api/ (the editor's quizzes on disk) doesn't exist here: the website keeps quizzes in the browser,
    // and the picture and song search live under the room (/r/<code>/api/…).
    if (url.pathname.startsWith('/api/')) {
      await drain(req);
      return new Response('{"error":"not-here"}', { status: 404, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
    }
    return env.ASSETS.fetch(req);
  },
};

// Where this page runs: on the laptop's own ProQuiz (today) or on the website version (docs/dev/web-plan.md).
// Every page gets its addresses from here, so the same code works in both places.
//
//   ROOM      the room code when the page was opened as /r/<code> (phones and the TV on the website), else null
//   HOSTED    true on the website: the page carries <meta name="proquiz" content="hosted"> (stamped on every page
//             by scripts/web-build.mjs, so `wrangler dev` on localhost counts too), or the address is a real name,
//             not localhost or an IP (the laptop server only serves the host and editor pages on localhost/an IP,
//             see sameSite() in server.js)
//   wsPath()  the WebSocket's path: /r/<code>/ws in a room, else /ws
//   fileUrl() a picture or clip: /r/<code>/files/<name> in a room, else /files/<name>
//   pagePath() a page's path: /r/<code>/display in a room, else /display
//   setRoom() the host page (opened as /host, not /r/…) says which room it made, so the three above point into it

// No imports: music.js and clip.js are also loaded by the unit tests in Node, where a "/lib/…" address wouldn't resolve.
const loc = typeof location !== 'undefined' ? location : { pathname: '/', hostname: 'localhost' };

// The room code from a /r/<code>… address (upper case, as the website makes them); null elsewhere.
export function roomOf(pathname) {
  const m = /^\/r\/([A-Za-z0-9]{4,12})(?:\/|$)/.exec(pathname ?? '');
  return m ? m[1].toUpperCase() : null;
}

// "localhost", a dotted IPv4 address or a bracketed IPv6 one (as the browser gives `location.hostname`).
export const isLocalName = (name) => name === 'localhost' || /^\d{1,3}(\.\d{1,3}){3}$/.test(name) || name.startsWith('[');

export const ROOM = roomOf(loc.pathname);
const stamped = typeof document !== 'undefined' && Boolean(document.querySelector?.('meta[name="proquiz"][content="hosted"]'));
export const HOSTED = stamped || !isLocalName(loc.hostname);

let room = ROOM;
export const currentRoom = () => room;
export function setRoom(code) {
  room = code || null;
}

export const wsPath = (code = room) => (code ? `/r/${code}/ws` : '/ws');
export const fileUrl = (name, code = room) => `${code ? `/r/${code}` : ''}/files/${encodeURIComponent(name)}`;
export const pagePath = (page, code = room) => (code ? `/r/${code}${page === '/' ? '' : page}` : page);

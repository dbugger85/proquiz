# The website version

How ProQuiz runs as a website (Cloudflare Workers + Durable Objects, free plan) from the same code as the laptop version. The plan and the owner's decisions are in `web-plan.md` (kept as the decision record); this is how it works now. Files: `web/*` (the Worker and the room, bundled by wrangler), `wrangler.toml`, `scripts/web-build.mjs`, `public/js/env.js`, `quizapi.js`, `store-browser.js`, `myroom.js`, `backup.js`, `home.html`/`home.js`, and the hosted parts of `host.js`, `display.js`, `phone.js`, `editor.js`. What every file is for: `files.md`. Nothing here changes the laptop version: every website-only path is behind `HOSTED` (pages), `hosted`/`hostKey` (the hub) or lives in `web/`.

## In one paragraph

The pages are static assets (`dist/web`, built from `public/`, `lib/` and `sets/`). The host opens `/host`; the page makes a secret **key** in its browser and a 6-character **room code** from it, and connects to `/r/<code>/ws`. Each room code is one **Durable Object** (`web/room.js`, class `Room`) holding one hub (`lib/hub.js`, the same game code as the laptop) in memory, nothing on disk. Phones and the TV join with the code (`/r/<code>`, `/r/<code>/display`, from the front page or the QR). The host's quizzes, pictures, clips and branding live only in the host's **browser** (IndexedDB); the quiz is sent to the room over the socket (`cmd loadSet`), the pictures and clips are uploaded into the room's memory (`PUT /r/<code>/files/<name>`) before a game, and the room sends the game back to the host's browser after every change (`save`) so a restart of the website (every deploy restarts every room) can be undone from there (`restore`). No accounts, no statistics, no database.

## Routes (`web/worker.js`, `wrangler.toml`)

Only `/r/*` and `/api/*` run the Worker (`run_worker_first`); everything else is a static asset, free and not counted as a request.

| Path | What |
|---|---|
| `/` | the front page (`public/home.html` → `index.html`): the code field, Join, Show on a TV, Host a quiz |
| `/host`, `/editor`, `/display`, `/js/*`, `/lib/*`, `/style.css`, `/fonts/*`, `/flags/*`, `/vendor/*`, `/sets/*.json`, `/sets/files/*` | static assets (`auto-trailing-slash`, so `/host` is `host.html`) |
| `/r/<code>` | the phone page (`join.html` = `public/index.html`); a lower-case code is redirected to upper case, a bad one to `/?bad=1` |
| `/r/<code>/display` | the TV page (`?embedded` for single-screen mode) |
| `/r/<code>/ws` | the WebSocket, handed to the room |
| `/r/<code>/files` GET, `/r/<code>/files/<name>` PUT and DELETE | the room's file store, host key required |
| `/r/<code>/files/<name>` GET | a picture or clip from the room (Range), else the built-in `sets/files/` asset |
| `/r/<code>/api/pictures/search`, `…/fetch`, `/r/<code>/api/songs/search`, `…/fetch` | the editor's search, in the room, host key required |
| any other `/api/*` | 404 `not-here` (the laptop's editor API doesn't exist here) |

The Worker passes a request to the room with the code in `x-proquiz-room`; the room is `env.ROOMS.idFromName(code)`. Security headers (`web/headers.js`): the CSP (`default-src 'self'`, `style-src 'unsafe-inline'` because the pages set `style` attributes, `img-src`/`media-src` also `blob: data: https:` for the editor's search thumbnails and object URLs, `connect-src 'self'`, `frame-ancestors 'self'`), `nosniff`, `Referrer-Policy: same-origin`; written to `_headers` for the static pages by the build script and added by the Worker to the pages it serves. Room files are served with `nosniff`, the type by extension (`lib/mime.js`) and the logo's script-blocking CSP.

## Rooms and keys (`lib/room.js`, `public/js/myroom.js`, `web/room.js`)

- The host page makes `key = base64url(16 random bytes)` (22 characters) and keeps `{code, key, at}` in `localStorage proquiz.room`; `code = base32(sha256(key)).slice(0, 6)` with an alphabet without 0/O/1/I. The key goes in the host's hello (`{type: 'hello', role: 'host', key}`) and in the `x-proquiz-key` header of the key-checked routes, never in a URL.
- The room learns its key from the first host: `claimKey()` recomputes the code from the key and, when it matches, keeps the key. From then on only that key is the host (`hostKey: (key) => key === this.key` for the hub). Another key for the same code (as good as impossible) gets `room-taken`, and the host page makes a new key and reloads, once. The same key from two tabs at once (the host page and the editor's search) is fine: a claim that lands while the same key is being hashed is recognised.
- Wrong keys are limited per room: after `HOST_KEY_TRIES_PER_MINUTE` (5) misses in a minute, any other key is refused for a minute without being looked at (403 `bad-host-key` becomes 429 `key-wait` with `Retry-After` on the routes, `bad-host-key` on a hello). **The right key always works**: a 128-bit key can't be guessed, and locking it out would let any player with the room code keep the host out.
- Who sees what is the hub's business, unchanged: `hostView` only to connections the hub welcomed as host, `displayView` to TVs with the PIN blanked (anyone with the code can open the TV page), `phoneView` never with questions, answers or file names. The room sends `save` only to adapters whose hello the hub answered with `welcome` as host (`web/socket.js` watches for it). Every phone counts as "elsewhere" (`hosted`), so the PIN, the slack caps and the answer grace work as over the laptop's tunnel; the PIN tick says "Ask players for a PIN".
- Phones and TVs whose hello lands in a room no host has claimed get `hostHere {here: false}` ("Nobody is hosting this room yet", a wrong code or the host still reconnecting) and `here: true` when a host claims it, over the same connection.
- A room closes (`bye {reason: 'closed'}` to everyone, the hub stopped, the files and the key forgotten) 30 min after the last host connection went (`ROOM_IDLE_MS`), or 5 min once nobody is connected at all and the lobby is empty (`ROOM_EMPTY_IDLE_MS`: a visitor who opened `/host` and left costs 5 min, not 30). The pages show "This room has closed" with a way back; the host page's button reloads, and the same key opens a fresh room with the same code.
- A restart of the Durable Object (a deploy, an eviction) closes the sockets it inherits (1012) so every page reconnects and says hello again; the host gets a fresh lobby and sends the game back (below).

## The room's file store (`web/room.js`)

`Map<name, {bytes, type}>` in memory. `GET /files` lists `{files: [{name, size}], bytes, maxFile, maxTotal}`; `PUT /files/<name>` keeps a file (201, or 200 when that name is already there: names are content hashes, so the same name is the same file); `DELETE /files/<name>` drops one; `GET /files/<name>` serves it whole or by Range (206, 416 past the end) with `Cache-Control: private, max-age=3600`. Names must match `FILE_NAME`. Caps (`lib/room.js`, decision 5): `MAX_ROOM_FILE` 8 MB per picture or clip, `MAX_ROOM_MEDIA` 48 MB for all files together (413 `media-too-big` / `media-full`, checked by `Content-Length` first and then by the bytes). The host's logo goes into the same store under its `logo-<hash>.<ext>` name with the laptop's rules (`MAX_LOGO` 2 MB → `logo-too-big`, the bytes must really be that kind → `logo-bad-type`). Every early refusal reads and discards the body first (`drain()`), or workerd drops the connection. The files go when the room closes or restarts; the host page puts them back.

## What the host page does on `welcome` (`public/js/host.js`)

Every connection (the first one, a reload, a reconnect after a restart) starts with the room's `welcome`, and three things follow, each once per connection and each in its own queue so a quick run of changes ends with the last one:

1. **`sendBrand()`**: the branding from the browser store (`store.brand()`: name, accent, plate, the logo's file name) goes to the room: `GET /files`, `PUT` the logo unless the room has it, then the hub message `brand {name, accent, plate, logo}`. The hub keeps it in memory, turns the logo name into `/r/<code>/files/<logo>` (`logoUrl`), puts it in every state message like `brand.view()` on the laptop and broadcasts only a change. The brand is the host's, never in a save or an export. A logo whose file is gone from the browser is sent without the logo.
2. **`offerAutosave()`** (on the first lobby `state` after the welcome): when the room is a fresh lobby (no teams, nothing to continue) and the browser holds a save (`store.autosave()`, the room's last `save` message) whose quiz has no problems, `syncRoom(saved.state.set)` uploads its pictures and clips and `restore {saved}` sends the save back. The hub's `restore()` shapes it exactly like the laptop reads its autosave file at start: a game with teams is offered as "Continue the last game?" (Continue puts the reconnected phones back in their teams), a finished game or a plain lobby brings its quiz and settings back. So a restart of the website, or a new room days later, lands where the host was. "Start a new game" also clears the browser's autosave. Without a save, the quiz chosen last time (`localStorage proquiz.lastSet`) is put back instead (`restoreLastSet()`, quietly if it was deleted since).
3. **`syncRoom(set)`** runs before a quiz is loaded (`chooseQuiz()` from the picker, the editor's save arriving over `BroadcastChannel('proquiz-store')`, the restore above) and again on **Start**: `GET /files`, find the missing files (`usedFiles(set)`) in the browser store (`store.fileBlob()`) or the built-in `sets/files/`, check the caps in the browser first (`mediaTooBig`, `mediaTotalTooBig`), drop another quiz's files when the room's 48 MB would be passed (the logo stays), then `PUT` each with the progress line `#media-progress` in the join card (Start is disabled meanwhile), then `cmd loadSet` with the whole quiz (`MAX_SET_BYTES` 600 KB as JSON, validated by the hub). The TV preloads a quiz's files when the board shows, so the upload is complete before `start`.

The room's `save` messages (`{type: 'save', saved: {v: 1, savedAt, state}}`, 250 ms after a change, `SAVE_AFTER_MS`) are written to IndexedDB `meta.autosave` as they come. The laptop-only parts of the lobby are hidden when `HOSTED` (Quit ProQuiz, the Wi-Fi/internet pills and the tunnel's status, the new-version tick and banner, own music files), the join card shows the room code big with the QR to `/r/<code>` and the TV address, and the lobby's language is written to `localStorage proquiz.lang` so the editor and the front page follow it.

## The browser store (`public/js/store-browser.js`, `quizapi.js`, `backup.js`)

`createBrowserStore()`: IndexedDB `proquiz` v1 with `sets` (`{id, set, updated}`), `files` (`{name, blob, type, size}`, named `<sha256 16 hex>.<ext>` exactly as the laptop names uploads) and `meta` (`archived`, `lastExport`, `autosave`, `brand`). The same methods as `store.js`'s `createStore()` on top of `lib/store-core.js` (`clean()`, the list `summary()`, `slug()`, the export header and `packageSets()`), so `browserApi` in `quizapi.js` gives the editor and the host lobby the same `api` as `httpApi` does on the laptop: `list`, `get`, `create`, `save`, `remove` (also drops files no other quiz uses), `setArchived`, `upload` (a JPG/PNG photo over 1920 px is shrunk to a 1920 px JPEG first, `shrinkPicture()`; a PNG with see-through parts stays PNG), `importFile`/`exportDownload` (the `.proquiz.json` format with the files as base64, so files move freely between laptop and website; a Blob download through a hidden `<a download>`; exports have `app: null`), `fileUrl` (object URLs, warmed by `get()`/`list()` so the editor can draw previews synchronously; built-in files fall back to `/sets/files/`), `lang`, `brand`, `sizeOf` (the "Pictures and clips: 12 MB of 48 MB" line and the picker's "too big for the website"). The built-in quizzes come from `/sets/<id>.json`. Changes are announced on `BroadcastChannel('proquiz-store')` (`saved {id}`, `changed`, `exported`) so the host lobby in another tab reloads its list and the quiz on show. `persist()` asks `navigator.storage.persist()` once per page. **Backup reminder** (`backup.js`, decision 9): the `#backup` banner in the editor and the host lobby when there is an own quiz and nothing was exported for 30 days (or ever), or the browser refused to keep the storage, with Export all quizzes (every export records `lastExport`) and Not now (sessionStorage). Safari deletes a site's storage after 7 days without a visit and mostly refuses `persist()`; the banner says so there.

## The editor's search (`web/room.js searchRequest()`, `pictures.js`, `songs.js`)

The same `pictures.js`/`songs.js` as the laptop (no Node modules; `store: null` makes `fetch()` hand back `{bytes, kind, credit}`), run in the host's own room (`myRoom()`: the key from `localStorage proquiz.room`, made by the editor itself when the host page hasn't yet) rather than the stateless Worker, so a download has the Durable Object's 30 s of CPU, not the Worker's 10 ms. Routes under `/r/<code>/api/…` with the key and the laptop's `Sec-Fetch-Site` rule (same-origin or none, else 403); a search answers JSON as on the laptop (cached 10 min per room), a fetch answers the bytes (201, `x-proquiz-name` = `picture.<kind>`/`song.mp3`, `x-proquiz-credit` as URL-encoded JSON, a 4 KB cap on the request body); `browserApi` then shrinks a picture and stores the bytes with the credit, so the editor's `onPick` is unchanged. The download rules (`lib/safeurl.js`: https, real names, only the sources' own hosts, size caps, the bytes checked) are the laptop's. A room that only ever searched holds no hub and is evicted when idle. `UPSTREAM`: a Worker variable the tests set (`--var`) to point every outgoing address at the pretend internet on 127.0.0.1 (`test/fake-upstream.mjs`); `upstreamFetch()` only honours a `http://127.0.0.1`/`localhost` value and the variable is never in `wrangler.toml`, so a deployed Worker can't be pointed anywhere (and a localhost value there would reach nothing anyway).

## Limits

| What | Value |
|---|---|
| A picture or clip | 8 MB (`MAX_ROOM_FILE`); the editor says so, an import keeps bigger files but the picker then says "too big for the website" |
| A quiz's files together | 48 MB (`MAX_ROOM_MEDIA`) |
| The quiz as JSON over the socket | 600 KB (`MAX_SET_BYTES`, `loadSet` and `restore`) |
| A socket message | 64 KB from a phone or TV, 1 MiB from the host, strings only (`web/socket.js`) |
| The logo | 2 MB, a real PNG/JPG/WebP/SVG (`lib/brand-core.js`) |
| Wrong host keys | 5 a minute per room, then other keys wait a minute; the right key always works |
| Wrong PINs | 10 a minute per room (the hub) |
| Players | `MAX_TEAMS` 8 / `MAX_PLAYERS` 100, reactions one a second per phone (the hub) |
| A forgotten room | closes 30 min after the host left; 5 min once empty and nobody connected |
| Fair-buzz clock pings | every 20 s per phone (`CLOCK_EVERY_MS` in room.js; 5 s on the laptop) |
| Keep-alive | the room pings every page every 30 s (`ROOM_HEARTBEAT_MS`; 10 s on the laptop); a page that doesn't answer twice is dropped |

**The free plan** (checked 2026-10-15, web-plan.md §9): 100,000 Worker requests a day (only `/r/*` and `/api/*` page loads, uploads and file fetches count; static pages and socket messages don't), 100,000 Durable Object requests a day with incoming WebSocket messages at 20 to 1, and 13,000 GB-s of Durable Object duration a day (a room with a hub is awake the whole time its timers run: about 28 hours of room time a day at 128 MB). A 100-player, 2-hour Quick quiz is roughly 24,000 pongs + 36,000 clock answers + 72,000 actions ≈ 132,000 incoming messages ≈ 6,600 requests (7 %) and 922 GB-s (7 %), so a couple of such games a day fit **if** the 20:1 rule applies to the free limit; counted one to one, a game that size would run out, and the answer is the Workers Paid plan (USD 5 a month) or slower pings. **Read the request count on the Cloudflare dashboard after the first real game.** Two things to know: a host tab left open keeps its room awake (the heartbeat) and costs duration all day (24 h ≈ 11,000 GB-s, most of a day's budget), so close the host page when not playing; and every deploy restarts every room (below).

## Running it here

```sh
npm run web:dev      # builds dist/web and runs wrangler dev on port 8787 (http://localhost:8787; the pages count as hosted there too)
npm run web:build    # just the build (dist/web, ignored by git)
npm run test:web     # test/web.test.mjs against wrangler dev on 3499, with the pretend internet on 3493 (about 40 s)
npm run e2e:web      # test/e2e-web.mjs: the website in headless Chromium, screenshots test/screenshots/web-*.png (about 4 min)
```

`test/web-dev.mjs` starts and stops `wrangler dev` for both suites (its own process group, so workerd goes too; `WEBLOG=1` prints wrangler's log at the end). `ROOM_IDLE_MS`, `ROOM_MEDIA_BYTES` and `UPSTREAM` can be passed as Worker variables for tests. Never run the two website suites at the same time (one port), and never on 3000/3001. The unit tests for the shared parts need no wrangler: `test/hub.test.js` (pretend sockets), `test/room.test.js`, `test/safeurl.test.js`. Which suites to run for which area: `tests.md`.

## Deploying

Once on this machine: `npx wrangler login` (the owner's Cloudflare account; the browser opens). Then

```sh
npm run web:deploy   # builds dist/web and runs `wrangler deploy`
```

The first deploy creates the Worker `proquiz` at `https://proquiz.<account>.workers.dev` and runs the `v1` migration that makes `Room` a SQLite-backed Durable Object class (the kind the free plan allows; nothing is stored in it). `npx wrangler deploy --dry-run --outdir <dir>` bundles without logging in, to check that the Worker builds. There are no secrets and no variables to set; `[observability]` is off (no statistics, decision 10).

**Never deploy during a game.** A deploy restarts every room: the sockets are closed, the pages reconnect, the host gets a fresh lobby and the game comes back from the host's browser through `restore` (the host sees "Continue the last game?" and presses it; phones are put back in their teams), but the players wait a few seconds and the host has to press Continue. Deploy before or after, as the last step of a release (update-and-release.md). The deployed site serves the pages from the same `public/` as the laptop program, so a release with page changes needs a deploy for the website to match.

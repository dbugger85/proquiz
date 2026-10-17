# ProQuiz

**Read the doc for the area you are changing (the map at the bottom, under `docs/dev/`) before you start; you don't need the others.** This file has the rules that apply everywhere, the commands and a short overview.

A Jeopardy-style team quiz. The host laptop runs a small server, a TV shows the game, and each team's phone is a buzzer on the same Wi-Fi. A second kind of quiz, the **Quick quiz** (multiple choice in sections, every phone a player), runs on the same server and screens. `PLAN.md` has the owner's decisions, the status and the open items; `docs/dev/history.md` is the build log.

- **Repo:** `dbugger85/proquiz` (public, branch `main`). Commit and push only when the owner asks. Never put a claude.ai session link in a commit, a PR or a release.
- **Owner:** a beginner "vibe coder". Explain changes in plain language and keep user-facing text free of jargon. Everything the user sees must exist in English and Norwegian.

## Commands

```sh
npm install          # once (installs `ws` and playwright-core)
npm start            # starts the server, prints the host, TV and phone addresses (port 3000, or the next free one), opens the host page (PROQUIZ_NO_OPEN=1 to skip)
npm test             # unit tests + server tests (node --test), about 20 s
npm run e2e:board    # one browser suite: board quiz, lobby, final round, editor (test/e2e.mjs)
npm run e2e:quick    # … Quick quiz. Also e2e:crazy, e2e:single, e2e:remote, e2e:brand, e2e:pictures, e2e:songs
npm run e2e          # all eight browser suites (about 5 min): host, TV and phones in headless Chromium (/usr/bin/chromium); screenshots in test/screenshots/
npm run build        # dist/ProQuiz-<version>-<system>.zip for Windows, Mac (arm64 + Intel), Linux (x64 + arm64), via deno compile, plus dist/SHA256SUMS.txt
npm run web:dev      # the website version here: builds dist/web and runs wrangler dev on port 8787
npm run test:web     # the website against wrangler dev (port 3499, about 40 s; not part of npm test)
npm run e2e:web      # the website in headless Chromium (port 3499, about 4 min; not part of npm run e2e)
npm run web:deploy   # deploys the website (after `npx wrangler login` once; never during a game)
```

**Testing while you build:** run `npm test` plus only the browser suites for the area you changed (the table in `docs/dev/tests.md`). Run the full `npm run e2e` once at the end, and look at the screenshots after UI changes. Run long test commands in the foreground. Never touch whatever runs on ports 3000/3001 (the owner's own ProQuiz); the suites use 3456–3498.

**Releasing** (only when the owner asks): bump with `npm version X.Y.Z --no-git-tag-version`, commit, push, `npm run build`, then `gh release create vX.Y.Z dist/* --title "ProQuiz X.Y.Z" --notes-file <notes> --latest`. Upload **everything in dist/**, including `SHA256SUMS.txt`, or "Update now" refuses the release. Start the notes with one friendly summary sentence (the lobby's update banner shows the first paragraph). Then `npm run web:deploy` for the website, never while a game is on (a deploy restarts every room). Details in `docs/dev/update-and-release.md`.

## Stack and hard rules

- **Server:** `server.js` uses only `node:*` modules plus `ws`, because it must also run inside `deno compile`. Find files through `new URL(..., import.meta.url)` and never through `process.cwd()`. It starts only when `import.meta.main` is true, so tests can import it.
- **Browser:** plain HTML, CSS and JavaScript ES modules. No framework and no bundler. The one exception: wrangler bundles the website's Worker (`web/*` with the `lib/` it imports) at deploy time; the pages stay plain and are served as they are.
- **Game rules:** `lib/game.js` is a pure reducer: `apply(state, action)` returns a new state. It has no DOM, no sockets and no `Date.now()`: actions that need the time carry `now`, and timers are stored as `state.deadline`. The server sends `{type:'timeout', now}` when a deadline passes. Actions that don't fit the current phase return the same state object, and bad joins, wagers or settings throw `GameError` with a `code`. Add a test in `test/game.test.js` for any rule change. The Quick quiz's rules are in `lib/quick.js` under the same rules; `apply()` dispatches on `state.mode`.
- **Who sees what:** `hostView` shows everything, `displayView` (the TV) hides answers until they're revealed, and `phoneView` never contains questions or answers. Tests check this, so keep them passing. **The exceptions:** in a Quick quiz with the lobby setting `quickPhoneText` on (on by default, so nobody has to look at the TV), `quickPhoneView` adds the question text (from `ready`) and the option texts (from `open`); the right answer still only comes at `result`, and file names never. And a phone that reads the quiz in another language gets that language's texts through `wantsText()` (see `docs/dev/languages.md`), never the whole set ahead of time and never file names.
- **Never load anything from the internet** during a game. The four exceptions, all server-side (the laptop's server, or the website's game room) and only for the host: the editor's picture search (`pictures.js`), the editor's song search (`songs.js`), the host's new-version check (`lib/update.js`, laptop only), and the host's own "Update now" download of a ProQuiz release (`lib/selfupdate.js`, compiled program only). Fonts are bundled in `public/fonts/`.
- **Text:** all visible text goes through `t()` in `public/js/i18n.js` (both `en` and `no`), or `data-t` attributes in the HTML. `test/i18n.test.js` fails if a key is missing in either language. Every points number on screen (scores, deltas, bets, tile values, count-up frames) goes through `pts(n)` from i18n.js: a no-break space between the thousands ("12 500", "-1 500"), the same in both languages; inputs stay plain. Tests that read a score from the page strip `\s` first. Error codes from the server are translated as `err-<code>`.
- **Pop-up questions:** never the browser's `confirm()`/`alert()`/`prompt()`. Use `ask({title, text, ok, cancel, danger})` → `Promise<boolean>`, `tell({title, text})` and `askNumber(…)` from `public/js/ui.js` (a `<dialog class="pq-modal">`; `danger` = red button with Cancel focused). While one is open (`modalOpen()`), the host page's keys do nothing. The e2e tests answer them with `answerModal()` and fail if a browser dialog ever appears.
- **Tap targets are at least 48px.** One dark theme on purpose (made for a TV); colours are CSS variables in `:root` in `public/style.css`, and the accent ones must be used through `rgb(var(--light-rgb) / a)` so branding can re-hue them.
- **Pages:** phones use `http://<LAN IP>:port`, which isn't a secure context: no Wake Lock, no service worker and no `crypto.randomUUID`, so use the fallbacks. (Phones over the internet tunnel use https; the code must work either way.)
- **Host is laptop-only:** the server accepts `role: 'host'` only from loopback, and the tunnel's own listener refuses `/api/`, `/host` and `/editor`. Everything that changes files (`/api/…`) is laptop-only too. On the website the host is whoever holds the room's secret key (`docs/dev/web.md`); there is no `/api/`, and the quizzes live in the host's browser.
- **Packaging:** only the Linux build can be run here. Windows and Mac builds can't, so ask the owner to try them.

## How it fits together (one paragraph per area)

**Board quiz** (`lib/game.js`, `lib/crazy.js`, host/TV/phone pages): phases `lobby → board → (special) → reading → armed → answering → revealed → board …` then `round2`, `finalWager → finalQuestion → finalJudge → over`; a final round, an optional round 2, Kaosmodus specials (random or placed by hand), picking from the phone, fair buzzing, undo (exactly one step, via `remember()`), autosave to `<data dir>/autosave.json` with resume, a main menu that keeps the game resumable, and single-screen mode (the TV in an iframe on the host page when no TV is connected). The host lobby's settings panel is the owner's chosen order. → `docs/dev/board-game.md`

**Quick quiz** (`lib/quick.js`): `set.kind === 'quick'`, phases `lobby → section → ready → open → result → ranks → …` with the last result going straight to `over`; up to 100 players; three question kinds (choice, multi, order) scored all-or-nothing with speed points from `pointsFor()`; the animated top 5 (`public/js/rankanim.js`), standings, the podium, and player reactions (fixed emoji, nothing stored). → `docs/dev/quick-quiz.md`

**Editor and quizzes on disk** (`store.js`, `public/js/editor.js`, `lib/validate.js`, `lib/fileformat.js`): quizzes in `<data dir>/sets/<id>.json`, the built-ins in `sets/` (`BUILT_IN`), the `/api/` routes (loopback only), uploads named by content hash, archive, description and cover, the versioned `.proquiz.json` export with upgrade steps and "Export all quizzes" (`docs/file-format.md`). → `docs/dev/editor.md`

**AI** (`lib/aiquiz.js`): copy and paste only. `buildRequest`/`parseReply` make a new board or Quick quiz, `buildFillRequest`/`parseFill` fill only the gaps, `buildTranslateRequest`/`parseTranslation` translate; every reader is forgiving and never changes what is there. → `docs/dev/ai.md`

**Media** (`public/js/clip.js`, `pictures.js`, `songs.js`): `image`, `answerImage`, `audio` with `audioStart`/`audioLength` (the editor's trim bar), slowly appearing pictures (`unveil`, pixels or blur, board and Quick), clip playback driven by `state.media`, the free picture search (Openverse, Wikimedia Commons) and the song search (Deezer previews) with credits saved in the quiz and shown on the TV after the answer. → `docs/dev/media-and-pictures.md`

**Languages** (`lib/languages.js`): a quiz has a main language and extra ones with `translations` on each item; phones pick a language on the join form, the TV stays in the main language, the host sees grey translation lines, the editor has a Translations dialog and "Translate with AI". → `docs/dev/languages.md`

**Network** (`lib/hub.js`, `server.js`, `public/js/net.js`, `lib/tunnel.js`): the WebSocket protocol (`hello`, `join`, `buzz`, `pick`, `answer`, `cmd {action}` …, `state` after every change), the server clock, fair buzzing (clock samples per phone, `slack`, the decide window), and joining over the internet through a Cloudflare quick tunnel on a second, remote-only listener with an optional PIN. → `docs/dev/network-and-remote.md`

**Updates and releases** (`lib/update.js`, `lib/selfupdate.js`, `scripts/build.mjs`): the new-version banner from GitHub's latest release (host hello only, 6-hour cache), "Update now" in the compiled program (download from the release, verify SHA256SUMS.txt, swap, `--version` check, restart as a child, rollback), and packaging with `deno compile`. → `docs/dev/update-and-release.md`

**Look and branding** (`public/style.css`, `brand.js`, `lib/avatar.js`, `public/js/sounds.js`, `public/js/music.js`, `public/js/ui.js`): the game-show stage, the glass look (`body.glass`), branding (logo, name, accent re-hued into every tone), 16 team colours, avatars/mascots, synthesized sounds driven by `state.event`, background music from `moodFor()`, pop-ups and the sticky top bar. → `docs/dev/look-and-branding.md`

**Website** (`web/worker.js`, `web/room.js`, `lib/hub.js`, `public/js/env.js`, `store-browser.js`, `quizapi.js`): the same game on Cloudflare Workers (free plan), one Durable Object per 6-character room code holding the hub in memory and nothing on disk; the host's browser makes the room's secret key, keeps the quizzes, pictures, clips and branding in IndexedDB, uploads a quiz's files into the room before a game (`syncRoom`), sends its branding (`sendBrand`) and gets the game back as `save` messages so a restart is undone with `restore` (`offerAutosave`); phones and the TV join with the code; the editor's search runs in the room. `HOSTED` in env.js switches the pages. Live at https://proquiz.dbugger85.workers.dev. → `docs/dev/web.md`

**Tests** (`test/`): unit tests per module, server tests against the real server, eight browser suites, and two website suites against `wrangler dev`. → `docs/dev/tests.md`

## Map: area → key files → detailed doc

| Area | Key files | Read |
|---|---|---|
| Board rules, phases, specials, final, round 2, undo, autosave, main menu, quit, single-screen, lobby settings panel | `lib/game.js`, `lib/crazy.js`, `public/js/host.js`, `public/js/display.js`, `public/js/phone.js`, `public/js/specials.js`, `public/host.html` | `docs/dev/board-game.md` |
| Quick quiz: phases, question kinds, scoring, standings, top 5, podium, reactions, its file format | `lib/quick.js`, `public/js/rankanim.js`, `sets/quick-sample.json`, `sets/lynquiz.json` | `docs/dev/quick-quiz.md` |
| Editor, quizzes on disk, uploads, archive, description and cover, export/import format | `store.js`, `lib/store-core.js`, `public/js/editor.js`, `public/js/quizapi.js`, `public/editor.html`, `lib/validate.js`, `lib/fileformat.js`, `docs/file-format.md` | `docs/dev/editor.md` |
| Making, filling and translating quizzes with AI | `lib/aiquiz.js` | `docs/dev/ai.md` |
| Pictures, clips and the trim bar, unveil, clip playback, picture search, song search, credits | `public/js/clip.js`, `pictures.js`, `songs.js`, `lib/validate.js`, `public/js/display.js` | `docs/dev/media-and-pictures.md` |
| Extra languages in a quiz | `lib/languages.js`, `public/flags/` | `docs/dev/languages.md` |
| Protocol, roles, fair buzzing, tunnel, PIN, keep-awake | `lib/hub.js`, `server.js`, `public/js/net.js`, `lib/tunnel.js`, `public/js/wake.js` | `docs/dev/network-and-remote.md` |
| New-version notice, Update now, packaging, releasing | `lib/update.js`, `lib/selfupdate.js`, `scripts/build.mjs` | `docs/dev/update-and-release.md` |
| Stage look, glass, branding, colours, avatars, sounds, music, pop-ups, top bar | `public/style.css`, `brand.js`, `lib/avatar.js`, `public/js/avatar.js`, `public/js/sounds.js`, `public/js/music.js`, `public/js/ui.js` | `docs/dev/look-and-branding.md` |
| The website: routes, rooms and keys, the room's file store, the browser store, restore, limits, deploying | `web/*`, `wrangler.toml`, `scripts/web-build.mjs`, `public/js/env.js`, `public/js/quizapi.js`, `public/js/store-browser.js`, `public/js/myroom.js`, `public/js/backup.js`, `public/home.html` | `docs/dev/web.md` (decisions: `web-plan.md`) |
| Tests: which suite covers what, how to wait without flaking | `test/*.test.js`, `test/e2e*.mjs`, `test/web*.mjs` | `docs/dev/tests.md` |
| What every file is for | – | `docs/dev/files.md` |
| What was built when, with the owner's words | – | `docs/dev/history.md` |

When you add a feature, put its detail in the area doc (not here), add a row to `docs/dev/files.md` for any new file, and keep this file short.

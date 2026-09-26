# ProQuiz

A Jeopardy-style team quiz. The host laptop runs a small server, a TV shows the game, and each team's phone is a buzzer on the same Wi-Fi. `PLAN.md` has the user's decisions and the build steps, so read it first.

- **Repo:** `dbugger85/proquiz` (public, branch `main`). Commit and push only when the user asks.
- **Owner:** a beginner "vibe coder". Explain changes in plain language and keep user-facing text free of jargon. Everything the user sees must exist in English and Norwegian.

## Commands

```sh
npm install      # once (installs `ws`)
npm start        # starts the server, prints the host, TV and phone addresses (port 3000, or the next free one), opens the host page (PROQUIZ_NO_OPEN=1 to skip)
npm test         # unit tests + server tests (node --test)
npm run e2e      # browser test: host, TV and 3 phones in headless Chromium (/usr/bin/chromium); screenshots in test/screenshots/
npm run build    # dist/ProQuiz-<version>-<system>.zip for Windows, Mac (arm64 + Intel), Linux (x64 + arm64), via deno compile
gh release create v<version> dist/*.zip   # publish (only when the user asks)
```

Run `npm test` and `npm run e2e` after any change, and look at the screenshots after UI changes.

## Stack and rules

- **Server:** `server.js` uses only `node:*` modules plus `ws`, because it must also run inside `deno compile`. Find files through `new URL(..., import.meta.url)` and never through `process.cwd()`. It starts only when `import.meta.main` is true, so tests can import it.
- **Browser:** plain HTML, CSS and JavaScript ES modules. No framework and no bundler.
- **Game rules:** `lib/game.js` is a pure reducer: `apply(state, action)` returns a new state. It has no DOM, no sockets and no `Date.now()`: actions that need the time carry `now`, and timers are stored as `state.deadline`. The server sends `{type:'timeout', now}` when a deadline passes. Actions that don't fit the current phase return the same state object, and bad joins, wagers or settings throw `GameError` with a `code`. Add a test in `test/game.test.js` for any rule change.
- **Who sees what:** `hostView` shows everything, `displayView` (the TV) hides answers until they're revealed, and `phoneView` never contains questions or answers. Tests check this, so keep them passing.
- **Sounds and flashes:** these are driven by `state.event` (`{seq, type, ...}`). Clients react when `seq` changes. Sounds are synthesized in `public/js/sounds.js` (no files), and each team's buzz is a note chosen by its colour index. **The TV plays the sounds.** The host laptop plays them only when no TV screen is connected (`displays === 0` in the state message). Both show a "click to turn on sound" pill until the browser allows audio. The `sound` setting (key M) turns them off. The last 3 seconds of any timer tick.
- **Autosave:** the server writes `autosave.json` to `PROQUIZ_DATA` (default `~/ProQuiz/`) about 250 ms after each change. On start, a saved game with teams is offered in the host lobby (`msg.resume`). The host sends `resume` or `discardSave`, and a new game keeps the saved settings. On resume, phones that already said hello with their team id get a fresh `welcome` with it. Tests always pass a temporary `dataDir`.
- **Pictures and sound clips:** a question (or the final) can have `image` (shown with the question), `answerImage` (shown only when revealed, and never sent to the TV before), and `audio` with an optional `audioStart` in seconds. They are plain file names (`IMAGE_NAME`/`AUDIO_NAME` in `lib/validate.js`) served at `/files/<name>` (with Range support), from `<data dir>/files/` first and then the bundled `sets/files/`. Uploads are named after their content (sha256, 16 hex characters). The TV loads pictures and clips early while the board shows. Phones never get file names.
- **Clip playback:** `state.media` (`{playing, seq}`) is set by `syncMedia()` in `lib/game.js` after every action. A new question starts its clip. A buzz or the final's judging pauses it, and the re-opened buzzers and the reveal play it on. `mediaToggle` (P) and `mediaRestart` (0, which bumps `seq`) are host actions. `public/js/clip.js` makes an `<audio>` follow that state. It runs on the TV, or on the host when no TV is open. Views carry `clip: {file, start}`.
- **Quizzes and the editor:** `store.js` keeps quizzes in `<data dir>/sets/<id>.json` (the built-in `sets/sample.json` is id `sample` and read-only) and runs the editor's HTTP API under `/api/` (loopback only): list/get/create/save/delete sets, `POST /api/files?name=` for uploads (25 MB max, image or audio only), `GET /api/export/:id` (a `.proquiz.json` with the files inside as base64) and `POST /api/import`. Saving is allowed with problems (drafts), but only valid quizzes can be chosen in the lobby (`chooseSet` host message). Saving the quiz that's on show in the lobby reloads it there. A new game keeps the last quiz and settings from the autosave. `state.setId` tracks which quiz is loaded.
- **Editor page** (`/editor`, `public/js/editor.js`): the quiz list, the board as tiles, and a `<dialog>` per question with the picture and clip pickers. It autosaves 600 ms after each change. Completely empty questions and categories aren't marked red, just counted. Use `fill()` from ui.js instead of `replaceChildren()` when a child might be null.
- **Final round:** the TV shows the category and bet ticks, then the question with answer ticks, then judge cards that fill in as the host marks each team. The right answer appears when every team is judged. The host's final screen has Correct/Wrong per team (click again to clear). On phones, `stageKeyFor()` means the stage is only rebuilt when something that team sees changes, so typing a bet or answer isn't wiped out by other teams' updates. Teams with no points to bet send 0 automatically.
- **Keep-awake:** `public/js/wake.js` uses Wake Lock where allowed, otherwise the tiny looping `public/media/keepawake.*` video, started on the first tap.
- **Host is laptop-only:** the server accepts `role: 'host'` only from loopback addresses, because the host view contains the answers. The TV (`/display`) and phones can connect from anywhere.
- **Protocol:** client → `hello {role, teamId?}`. Phones then send `join {name, color, teamId?}`, `buzz`, `wager {amount}` and `finalAnswer {text}`. The host sends `cmd {action}` (allowed list: `HOST_ACTIONS` in server.js). The host can also send `resume`, `discardSave`, `testSound` and `chooseSet {id}`. A phone's `buzz` in the lobby just plays its tone. The server → `welcome` (with `info.phoneUrl` for host/display, `teamId` for phones), `joined {teamId}`, `error {code}`, `sound {name, teamId?}` (sounds outside the game, sent to the TV or else the host), and `state {view, connected, displays, serverNow, resume?}` after every change. Error codes are translated as `err-<code>` in i18n.
- **Look:** a modern game-show stage: deep ink-violet, one soft stage light from above, glassy rounded tiles, pill buttons, and team colours as the loudest thing on screen. One dark theme on purpose (it is made for a TV). Colours are CSS variables in `:root` in `public/style.css`. Fonts are Unbounded (wide display face for headings and numbers) and Atkinson Hyperlegible (text), bundled in `public/fonts/` so the game works offline. Never load anything from the internet. Tap targets are at least 48px.
- **Text:** all visible text goes through `t()` in `public/js/i18n.js` (both `en` and `no`), or `data-t` attributes in the HTML. `test/i18n.test.js` fails if a key is missing in either language.
- **Packaging:** the Linux build is tested here. Windows and Mac builds can't be run on this laptop, so ask the user to try them. The programs are unsigned: Windows shows SmartScreen ("More info → Run anyway"), and Mac needs right-click → Open. Both ask to allow network access.
- **Pages:** phones use `http://<LAN IP>:port`, which isn't a secure context. That means no Wake Lock, no service worker and no `crypto.randomUUID`, so use the fallbacks.

## Files

| File | Purpose |
|---|---|
| `server.js` | Static files (`/` phone, `/host`, `/display`, `/editor`, `/lib/*`, `/files/*`), the WebSocket at `/ws`, and printing the LAN address |
| `lib/game.js` | Game rules, phases, scoring, undo, final round, and the per-screen views |
| `lib/validate.js` | Question set checks, shared by the server and the editor |
| `store.js` | Quizzes and files on disk, plus the editor's `/api/`. Built-in quizzes are listed in `BUILT_IN` (`sample` in English, `eksempel` in Norwegian) |
| `scripts/build.mjs` | Packaging: `deno compile` per system, plus a START HERE note, zipped into `dist/` |
| `test/i18n.test.js` | Every text key exists in both languages with the same `{placeholders}`, every key used in the pages exists, and every server error code is translated |
| `public/editor.html`, `js/editor.js` | Question editor |
| `public/js/clip.js` | Sound clip player that follows `state.media` |
| `sets/sample.json`, `sets/eksempel.json`, `sets/files/` | The English and Norwegian sample quizzes (5×5 plus a final), with two sample pictures and a generated sample tune |
| `public/index.html`, `js/phone.js` | Phone: join form (name + colour), then the team-coloured buzzer screen. The team id is kept in localStorage (`proquiz.team`) |
| `public/host.html`, `js/host.js` | Host laptop: lobby (QR, teams, settings), then the board, the question with its answer, the scores (Let them pick, Change score) and the controls. `controls()` lists the buttons for the current phase and also drives the keys: Space arms or goes back to the board, Y correct, N wrong, R show answer, Esc put back, U undo, E end the board. `body[data-phase]` is set for the e2e test |
| `public/display.html`, `js/display.js` | TV screen: lobby, board, question (zooms in once per question), the score strip, and the "buzz takeover" (the frame floods in the colour of the team that buzzed). F toggles full screen |
| `public/js/net.js` | Reconnecting WebSocket client and the server clock offset |
| `public/js/i18n.js` | English and Norwegian text |
| `public/js/ui.js` | `h()` element builder, `inkFor()` and `teamStyle()` (team colour and text colour), `qrSvg()`, `countdown()` and `runCountdowns()` (timer bars that follow `[data-deadline]` on the server clock) |
| `public/vendor/qrcode.js` | QR encoder (qrcode-generator, MIT) |
| `test/game.test.js` | Rule tests |
| `test/server.test.js` | Real server plus WebSocket clients: join, buzz order, reconnect, timers |
| `test/e2e.mjs` | Browser test with host, TV and 3 phones: join, too-early, buzz, wrong then re-open, correct, undo, show answer, picture and sound clip questions, the whole final round, and the editor (new quiz, a question with a picture and a clip, a refused upload, then the lobby's quiz picker). Every `shot()` also fails if a screen shows "null", "undefined" or "NaN". Wait for the page's `body[data-phase]` before pressing keys, or the test races the screen |

# ProQuiz

A Jeopardy-style team quiz. The host laptop runs a small server, a TV shows the game, and each team's phone is a buzzer on the same Wi-Fi. `PLAN.md` has the user's decisions and the build steps, so read it first.

- **Repo:** `dbugger85/proquiz` (public, branch `main`). Commit and push only when the user asks.
- **Owner:** a beginner "vibe coder". Explain changes in plain language and keep user-facing text free of jargon. Everything the user sees must exist in English and Norwegian.

## Commands

```sh
npm install      # once (installs `ws`)
npm start        # starts the server; prints the host, TV and phone addresses (port 3000, or the next free one)
npm test         # unit tests + server tests (node --test)
npm run e2e      # browser test: host, TV and 3 phones in headless Chromium (/usr/bin/chromium); screenshots in test/screenshots/
deno compile -A --include public --include lib --include sets -o dist/proquiz server.js   # single-file program (packaging step)
```

Run `npm test` and `npm run e2e` after any change, and look at the screenshots after UI changes.

## Stack and rules

- **Server:** `server.js` uses only `node:*` modules plus `ws`, because it must also run inside `deno compile`. Find files through `new URL(..., import.meta.url)` and never through `process.cwd()`. It starts only when `import.meta.main` is true, so tests can import it.
- **Browser:** plain HTML, CSS and JavaScript ES modules. No framework and no bundler.
- **Game rules:** `lib/game.js` is a pure reducer: `apply(state, action)` returns a new state. It has no DOM, no sockets and no `Date.now()`: actions that need the time carry `now`, and timers are stored as `state.deadline`. The server sends `{type:'timeout', now}` when a deadline passes. Actions that don't fit the current phase return the same state object, and bad joins, wagers or settings throw `GameError` with a `code`. Add a test in `test/game.test.js` for any rule change.
- **Who sees what:** `hostView` shows everything, `displayView` (the TV) hides answers until they're revealed, and `phoneView` never contains questions or answers. Tests check this, so keep them passing.
- **Sounds and flashes:** these are driven by `state.event` (`{seq, type, ...}`). Clients react when `seq` changes.
- **Host is laptop-only:** the server accepts `role: 'host'` only from loopback addresses, because the host view contains the answers. The TV (`/display`) and phones can connect from anywhere.
- **Protocol:** client → `hello {role, teamId?}`. Phones then send `join {name, color, teamId?}`, `buzz`, `wager {amount}` and `finalAnswer {text}`. The host sends `cmd {action}` (allowed list: `HOST_ACTIONS` in server.js). The server → `welcome` (with `info.phoneUrl` for host/display, `teamId` for phones), `joined {teamId}`, `error {code}`, and `state {view, connected, serverNow}` after every change. Error codes are translated as `err-<code>` in i18n.
- **Look:** a modern game-show stage: deep ink-violet, one soft stage light from above, glassy rounded tiles, pill buttons, and team colours as the loudest thing on screen. One dark theme on purpose (it is made for a TV). Colours are CSS variables in `:root` in `public/style.css`. Fonts are Unbounded (wide display face for headings and numbers) and Atkinson Hyperlegible (text), bundled in `public/fonts/` so the game works offline. Never load anything from the internet. Tap targets are at least 48px.
- **Text:** all visible text goes through `t()` in `public/js/i18n.js` (both `en` and `no`), or `data-t` attributes in the HTML.
- **Pages:** phones use `http://<LAN IP>:port`, which isn't a secure context. That means no Wake Lock, no service worker and no `crypto.randomUUID`, so use the fallbacks.

## Files

| File | Purpose |
|---|---|
| `server.js` | Static files (`/` phone, `/host`, `/display`, `/lib/*`), the WebSocket at `/ws`, and printing the LAN address |
| `lib/game.js` | Game rules, phases, scoring, undo, final round, and the per-screen views |
| `lib/validate.js` | Question set checks, shared by the server and the editor |
| `sets/sample.json` | Sample question set (5×5 plus a final) |
| `public/index.html`, `js/phone.js` | Phone: join form (name + colour), then the team-coloured buzzer screen. The team id is kept in localStorage (`proquiz.team`) |
| `public/host.html`, `js/host.js` | Host laptop: lobby (QR, teams, settings), then the board, the question with its answer, the scores (Let them pick, Change score) and the controls. `controls()` lists the buttons for the current phase and also drives the keys: Space arms or goes back to the board, Y correct, N wrong, R show answer, Esc put back, U undo, E end the board. `body[data-phase]` is set for the e2e test |
| `public/display.html`, `js/display.js` | TV screen: lobby, board, question (zooms in once per question), the score strip, and the "buzz takeover" (the frame floods in the colour of the team that buzzed). F toggles full screen |
| `public/js/net.js` | Reconnecting WebSocket client and the server clock offset |
| `public/js/i18n.js` | English and Norwegian text |
| `public/js/ui.js` | `h()` element builder, `inkFor()` and `teamStyle()` (team colour and text colour), `qrSvg()`, `countdown()` and `runCountdowns()` (timer bars that follow `[data-deadline]` on the server clock) |
| `public/vendor/qrcode.js` | QR encoder (qrcode-generator, MIT) |
| `test/game.test.js` | Rule tests |
| `test/server.test.js` | Real server plus WebSocket clients: join, buzz order, reconnect, timers |
| `test/e2e.mjs` | Browser test with host, TV and 3 phones: join, too-early, buzz, wrong then re-open, correct, undo, show answer, end. Wait for the page's `body[data-phase]` before pressing keys, or the test races the screen |

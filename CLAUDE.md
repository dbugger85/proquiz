# ProQuiz

A Jeopardy-style team quiz. The host laptop runs a small server, a TV shows the game, and each team's phone is a buzzer on the same Wi-Fi. `PLAN.md` has the user's decisions and the build steps, so read it first.

- **Repo:** `dbugger85/proquiz` (public, branch `main`). Commit and push only when the user asks.
- **Owner:** a beginner "vibe coder". Explain changes in plain language and keep user-facing text free of jargon. Everything the user sees must exist in English and Norwegian.

## Commands

```sh
npm install      # once (installs `ws`)
npm start        # starts the server; prints the host, TV and phone addresses (port 3000, or the next free one)
npm test         # unit tests (node --test)
deno compile -A --include public --include lib --include sets -o dist/proquiz server.js   # single-file program (packaging step)
```

Run `npm test` after any change.

## Stack and rules

- **Server:** `server.js` uses only `node:*` modules plus `ws`, because it must also run inside `deno compile`. Find files through `new URL(..., import.meta.url)` and never through `process.cwd()`. It starts only when `import.meta.main` is true, so tests can import it.
- **Browser:** plain HTML, CSS and JavaScript ES modules. No framework and no bundler.
- **Game rules:** `lib/game.js` is a pure reducer: `apply(state, action)` returns a new state. It has no DOM, no sockets and no `Date.now()`: actions that need the time carry `now`, and timers are stored as `state.deadline`. The server sends `{type:'timeout', now}` when a deadline passes. Actions that don't fit the current phase return the same state object, and bad joins, wagers or settings throw `GameError` with a `code`. Add a test in `test/game.test.js` for any rule change.
- **Who sees what:** `hostView` shows everything, `displayView` (the TV) hides answers until they're revealed, and `phoneView` never contains questions or answers. Tests check this, so keep them passing.
- **Sounds and flashes:** these are driven by `state.event` (`{seq, type, ...}`). Clients react when `seq` changes.
- **Pages:** phones use `http://<LAN IP>:port`, which isn't a secure context. That means no Wake Lock, no service worker and no `crypto.randomUUID`, so use the fallbacks.

## Files

| File | Purpose |
|---|---|
| `server.js` | Static files (`/` phone, `/host`, `/display`, `/lib/*`), the WebSocket at `/ws`, and printing the LAN address |
| `lib/game.js` | Game rules, phases, scoring, undo, final round, and the per-screen views |
| `lib/validate.js` | Question set checks, shared by the server and the editor |
| `sets/sample.json` | Sample question set (5×5 plus a final) |
| `public/` | Browser pages |
| `test/game.test.js` | Rule tests |

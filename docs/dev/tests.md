# Tests

Unit and server tests run with `node --test` (`npm test`, about 20 s). The browser tests (`test/e2e*.mjs`) drive headless Chromium (`/usr/bin/chromium`, or `CHROMIUM=<path>`) with `playwright-core`: each suite starts its own server on its own port (3456–3498) with a temporary data folder, opens a host, a TV and some phones, and writes screenshots to `test/screenshots/`. Every `shot()` also fails if a screen shows "null", "undefined" or "NaN".

## While building

- Run `npm test` after any change, plus **only the browser suites for the area you changed** (table below). Each suite takes 20–90 s.
- Run the full `npm run e2e` **once at the end**, and look at the screenshots after UI changes.
- Run long test commands in the foreground (not in the background), so you see the result before going on.

```sh
npm test                 # unit + server tests
npm run e2e:board        # test/e2e.mjs: the board quiz, lobby, final round, editor
npm run e2e:crazy        # test/e2e-crazy.mjs: Kaosmodus specials
npm run e2e:single       # test/e2e-single.mjs: single-screen mode
npm run e2e:quick        # test/e2e-quick.mjs: the Quick quiz, avatars, reactions, top 5, podium, its editor and AI dialogs
npm run e2e:remote       # test/e2e-remote.mjs: joining over the internet
npm run e2e:brand        # test/e2e-brand.mjs: branding, the update banner, Update now
npm run e2e:pictures     # test/e2e-pictures.mjs: the free picture search and credits
npm run e2e:songs        # test/e2e-songs.mjs: the song search, the trim bar, trimmed clips
npm run e2e              # all eight, one after the other (about 5 minutes)
```

## Which suites to run for which area

| Area changed | Unit tests that cover it | Browser suites |
|---|---|---|
| Board rules (`lib/game.js`, `lib/crazy.js`), host page, TV, phone buzzer, final round | `game`, `crazy`, `server`, `fairbuzz` | `e2e:board`, `e2e:crazy`, `e2e:single` |
| Lobby settings, autosave, resume, main menu, quit | `server` | `e2e:board` |
| Quick quiz (`lib/quick.js`, its screens, reactions, top 5, podium, avatars) | `quick`, `avatar`, `server`, `music` | `e2e:quick`, `e2e:brand` (the Quick podium with a logo) |
| Editor (`store.js`, `public/js/editor.js`), export/import, archive, description and cover | `export`, `server` | `e2e:board`, `e2e:quick` (the Quick editor) |
| AI dialogs (`lib/aiquiz.js`) | `aiquiz` | `e2e:board` (board quiz), `e2e:quick` (Quick quiz, fill) |
| Pictures, unveil, clips, trim bar | `game`, `quick`, `export` | `e2e:board`, `e2e:quick`, `e2e:songs` (the trim bar) |
| Picture search (`pictures.js`) | `pictures` | `e2e:pictures` |
| Song search (`songs.js`) | `songs` | `e2e:songs` |
| Languages (`lib/languages.js`, translations) | `languages`, `game`, `quick`, `server`, `export`, `aiquiz` | `e2e:board`, `e2e:quick` |
| Protocol, fair buzzing, tunnel, PIN (`server.js`, `lib/tunnel.js`) | `server`, `fairbuzz`, `remote` | `e2e:remote`, `e2e:board` |
| Branding (`brand.js`), glass look, colours, sounds, music | `brand`, `music`, `quick` (colour contrast) | `e2e:brand`, `e2e:board` (glass on/off shots) |
| New-version notice, Update now (`lib/update.js`, `lib/selfupdate.js`) | `update`, `selfupdate` | `e2e:brand` |
| Texts (`public/js/i18n.js`) | `i18n` | the suite of the screen you changed |
| `public/style.css` | – | the suite of the screen you changed, then look at the screenshots |

## Writing browser tests that don't flake

- **Wait on real conditions, never on time.** The pages set `body[data-phase]` (host), `body[data-mode]` (all three), `body[data-music]` (where sounds play), `body[data-rankanim]` (the top 5's stages: before/count/move/done) and `[data-step]`/`[data-pct]`/`[data-blur]` on the unveil canvas. Wait for `body[data-phase=…]` before pressing keys, or the test races the screen. Use `waitForSelector`, `waitForFunction`, or poll the server (`srv.hub.getState()` / `fetch(base + '/api/…')`) with the suite's `waitFor()`.
- `waitForTimeout` is only for letting an animation settle **before a screenshot** (pop-ins, bars growing, the zoom-in), never before an assertion. If an assertion needs something to have happened, wait for the thing itself.
- **The editor autosaves 600 ms after a change**, and `#ed-status` may already say "Saved" from an earlier save. To check what was saved, poll `/api/sets/<id>` until it has the change (`savedSet()` in e2e-quick.mjs) rather than sleeping.
- **Things that disappear by themselves** (reactions fade out after 3 s, the "Too early!" lock) must be counted as they appear (a `MutationObserver` installed in the page from the test, see the reactions step in e2e-quick.mjs), not by their live count later.
- Players joined straight through the server (`srv.hub.dispatch({type: 'join', …})` / `'answer'`) are deterministic: use them for anything that must be in a certain order (for example "Bo answers first" before the phones), and dispatch before the phones act.
- Timers in the game are real: a question that runs out of time really waits its seconds. Give that `phase()` a long enough timeout and don't add more such waits than needed.
- Lobby sections are `<details>`: click the `summary` of a closed group before touching what is inside. Radio pills are clicked through `label:has(> input[name=…][value=…])` (`pickPill()` in e2e.mjs).
- Pop-ups are ProQuiz's own `<dialog class="pq-modal">`: answer them with `answerModal()`; the suites fail if a browser dialog ever appears.
- Fixed ports: board 3456, crazy 3457, single 3458, quick 3459, remote 3462, brand 3486, pictures 3496, songs 3498. Never 3000/3001 (the running app).

## Test files

| File | Purpose |
|---|---|
| `test/crazy.test.js`, `test/e2e-crazy.mjs` | Kaosmodus rules, and one of each special played in the browser |
| `test/remote.test.js`, `test/e2e-remote.mjs` | The tunnel's own listener (no host, no editor, no `/api/`), the PIN, remote TV pages, `joinMode` starting and stopping the tunnel (and a saved one waiting for the host), `lib/tunnel.js` with pretend cloudflared scripts; in the browser the Wi-Fi/internet pills, missing, starting, on, back to Wi-Fi and the in-game warning (screenshots `remote-*.png`) |
| `test/e2e-quick.mjs` | Quick quiz in the browser: host, TV and 4 phones (plus 2 players joined through the server), choosing it in the lobby, a question everyone answers early, a "tick all that are right" one (ticking, unticking, the disabled Submit, a subset scoring nothing; screenshots `quick-phone-tick*`, `quick-tv-result-tick`, `quick-host-result-tick`), one that runs out of time, a "put in order" one (the shuffle on the TV and phones, tap/Clear/tap/Submit, a 360px phone `quick-phone-order-narrow`, a swapped pair scoring nothing, `.quick-order-result`; screenshots `quick-*-order*`), fastest and gap lines, the animated top 5 (screenshots `-before`, `-counting` and the end, glass on and off, a player climbing in and one dropping out, the end order and points checked, a reduced-motion TV showing the end at once), the phone's points counting up, the podium's points, the calm music moods, glass on/off, the editor's sections and question dialog (including the kind pills: `quick-editor-tick`, `quick-editor-order`; `editor-space-quick-1280`/`-1920`: a question without media needs no scrolling), a Quick quiz made from a pasted AI answer (`quick-editor-ai-dialog`: sizes above the topics), and a half-written Quick quiz filled and topped up from a pasted answer (`quick-editor-fill-dialog`, `quick-editor-filled`). Also the avatar builder (dice, tabs, tiles, 48px targets, `quick-phone-avatar-builder`), faces on the TV lobby (newest first; a 30-player lobby that fits, `quick-tv-lobby-30`, and the 100-player one with "+ 53 more", `quick-tv-lobby-100`, plus the host lobby's scrolling list and note, `quick-host-lobby-100`), reactions (six 48px buttons under the result, a tap and two server-side players floating up on the TV, the 1-a-second limit, the setting off: `quick-phone-reactions`, `quick-tv-reactions`), the top 5 (centred under its title, arrows outside), the standings (`quick-tv-section-standings`) and the podium; the last question's result going straight to the podium (the host's button says **Show the podium**, no `.top-list` on the TV); a second game with long Norwegian names on this 1080p TV and a 720p one, glass on and off: the top 5 plates about 60vw wide and centred with the arrows outside, no name cut on the top 5, the standings or the podium, and every step's points above the podium's floor (`quick-tv-top5-names`, `quick-tv-top5-names-720`, `quick-glass-off-tv-top5-names`, `quick-tv-standings-names`, `quick-tv-podium-names`, `-720`); and a pasted AI reply shaped like the owner's first real one (Norwegian, no types): the "sorter" question becomes put in order, the "hvilke av disse" list becomes tick all, the note says "Read 9 questions: 7 pick one, 1 tick all that are right, 1 put in order." and flags the one to check (`quick-editor-ai-summary`). Screenshots `quick-*.png` |
| `test/i18n.test.js` | Every text key exists in both languages with the same `{placeholders}`, every key used in the pages exists, and every server error code is translated |
| `test/music.test.js` | Which music plays when, and that the songs are well formed |
| `test/game.test.js` | Rule tests |
| `test/server.test.js` | Real server plus WebSocket clients: join, buzz order, reconnect, timers, and Quit ProQuiz (only the host; saved, `bye`, ports closed, `onQuit`) |
| `test/fairbuzz.test.js` | Fair buzzing against the real server: pretend phones with wrong clocks, slow Wi-Fi, a cheater, and one that is never measured |
| `test/e2e-single.mjs` | Single-screen mode: the TV view inside the host page, tile clicks, hidden answers, H, undo, handing over to a real TV |
| `test/e2e.mjs` | Browser test with host, TV and 3 phones: join, too-early, buzz, wrong then re-open, correct, undo, show answer, picture and sound clip questions, a phone picking the next question, the whole final round, and the editor (new quiz, a question with a picture and a clip (its start set on the trim bar), a refused upload, a quiz made from a pasted AI answer, the description and cover picture (`editor-9-about`), then the lobby's quiz picker showing them (`host-12b-lobby-about`), archiving and bringing back (`editor-10-archived`, the picker leaving it out), the Export all download, and the editor's use of the screen at 1280×800 and 1920×1080 (`editor-space-question-*`, `editor-space-board-*`: a wide dialog with the words left and the media right, the sticky title bar with its × and Done, the folded "About the quiz")). Every `shot()` also fails if a screen shows "null", "undefined" or "NaN". Wait for the page's `body[data-phase]` before pressing keys, or the test races the screen |

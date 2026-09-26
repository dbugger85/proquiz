# ProQuiz plan

A Jeopardy-style quiz for teams in one room. The host laptop runs the game, a TV shows the board, and each team's phone is a buzzer.

## Decisions (made by the user on 2026-09-26)

| Topic | Decision |
|---|---|
| How it runs | A small server on the host laptop. Phones join over the room's Wi-Fi via a QR code. No internet needed |
| Players' computers | They download one program file (Windows, Mac or Linux) made with `deno compile`. No npm needed |
| Wrong answer | A setting: none, half or full. Default is half. Negative scores are allowed (also a setting) |
| Buzzers | Turn on when the host presses Space. Buzzing early locks that phone for 0.5 s |
| Timers | Settings. Defaults: 10 s to buzz, 15 s to answer, 30 s for the final. 0 means off. Running out of answer time counts as wrong |
| Who picks next | The last team to answer correctly |
| Teams | Up to 8, each with its own colour and buzzer tone |
| Language | English and Norwegian, chosen in settings |
| Screens | `/host` on the laptop (answers and controls) and `/display` on the TV (no answers until revealed) |
| Extras in v1 | A Final round: teams bet, type their answer on the phone, and the host judges each one. Daily Double and round 2 come later |
| Repo | Public, `dbugger85/proquiz` |

## Build steps

1. ✅ Basic setup: server, placeholder pages, notes
2. ✅ Game rules (`lib/game.js`) with unit tests
3. ✅ Lobby and joining: phone join page, host lobby with QR code and team list, server wiring, server tests
4. ✅ Board and questions on `/host` and `/display`, keyboard controls
5. ✅ Buzzers end to end: phone button, who was first, correct/wrong/lock-out, timers
6. ✅ Sounds, vibration, keep-awake, reconnecting, autosave and resume
7. Final round screens (wager, answer, judging)
8. Question editor with checks, import and export, and choosing a set in the lobby
9. Polish and a browser test with one host and 3 phones; English and Norwegian text
10. Packaging: program files for Windows, Mac and Linux, published as GitHub releases

## Also done
- A modern redesign (2026-09-26, asked for by the user): ink-violet stage, glass tiles, the Unbounded font.

## Later
Daily Double, a round 2 with doubled values, picking the tile from the phone, sound files instead of synthesized sounds, correcting for phone clock differences.

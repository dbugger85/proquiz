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
7. ✅ Final round screens (wager, answer, judging)
8. ✅ Question editor with checks, import and export, picture and sound uploads, and choosing a quiz in the lobby
9. ✅ Polish: keyboard help (?), a game-night guide in the README, a Norwegian sample quiz, and tests that both languages have every text
10. ✅ Packaging: `npm run build` makes zips for Windows, Mac (Apple Silicon and Intel) and Linux (x64 and arm64), published as GitHub releases

## Also done
- Background music (planned with Fable, 2026-09-27): four built-in generated tunes that follow the game (lobby, calm between questions, thinking that gets intense in the last 3 s, a soft hum while a team answers, silence at reveals and for sound clips and the Kaosmodus reel, suspense in the final, party music after the fanfare), your own file per moment, on/off (B) and a volume slider, separate from the effects.
- Slowly appearing pictures (planned with Fable, 2026-09-27): a per-question option "Show the picture slowly" (seconds until it's clear). It pixelates from big blocks to clear, runs while the buzzers are on, freezes on a buzz, and the buzz timer starts once it's clear. No blur, no dropping points, not on the final.
- Kaosmodus / Crazy mode (planned with Fable, decided by the user on 2026-09-27): an instant bomb, triple, hot seat, rescue (no penalty), turbo (the picking team, 3 random questions, 5 s each, no penalty, no buzzing), jackpot (a secret pot), and freeze, with a mystery-reel reveal on the TV. Off / a little (≈3) / lots (≈6) at random anywhere on the board, and no badge. Placing specials by hand in the editor isn't built.
- Sound clips in questions (asked for by the user), e.g. "Which song is this?". A clip plays on the TV when the question opens, pauses on a buzz, plays on when others may buzz again and at the reveal. The host has P (play/pause) and 0 (from the start). Each clip can have a start time.
- Pictures in questions (asked for by the user): `image` shows with the question, `answerImage` only when the answer is revealed. This works for the final question too, and a picture can replace the question text.
- A modern redesign (2026-09-26, asked for by the user): ink-violet stage, glass tiles, the Unbounded font.

## Later
Daily Double, a round 2 with doubled values, picking the tile from the phone, sound files instead of synthesized sounds, correcting for phone clock differences.

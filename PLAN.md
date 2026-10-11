# ProQuiz plan

A Jeopardy-style quiz for teams in one room. The host laptop runs the game, a TV shows the board, and each team's phone is a buzzer. A second kind of quiz, the **Quick quiz** (multiple choice, every phone a player), runs on the same server and screens.

This file holds the owner's decisions, the status and the open items. What was built, when and how (the full build log with every decision quoted) is in `docs/dev/history.md`; how things work now is in `CLAUDE.md` and `docs/dev/`.

## Decisions (made by the user on 2026-09-26)

| Topic | Decision |
|---|---|
| How it runs | A small server on the host laptop. Phones join over the room's Wi-Fi via a QR code. No internet needed |
| Players' computers | They download one program file (Windows, Mac or Linux) made with `deno compile`. No npm needed |
| Wrong answer | A setting: none, half or full. Default is half. Negative scores are allowed (also a setting) |
| Buzzers | Turn on when the host presses Space. Buzzing early locks that phone for 0.5 s |
| Timers | Settings. Defaults: 10 s to buzz, 15 s to answer, 30 s for the final. 0 means off. Running out of answer time counts as wrong |
| Who picks next | The last team to answer correctly |
| Teams | Up to 8, each with its own colour and buzzer tone (16 colours to pick from since 2026-10-11) |
| Language | English and Norwegian, chosen in settings |
| Screens | `/host` on the laptop (answers and controls) and `/display` on the TV (no answers until revealed) |
| Extras in v1 | A Final round: teams bet, type their answer on the phone, and the host judges each one. Daily Double and round 2 come later |
| Repo | Public, `dbugger85/proquiz` |

## Decisions since (one line each; the full record is in `docs/dev/history.md`)

- 2026-09-26: a modern redesign (ink-violet stage, glass tiles, the Unbounded font).
- 2026-09-27: background music (built-in tunes that follow the game, own files, on/off and volume); slowly appearing pictures (per question, no dropping points, not on the final); Kaosmodus / Crazy mode (bomb, triple, hot seat, rescue, turbo, jackpot, freeze; off / a little / lots; no badge on the TV).
- Asked for by the user (early): sound clips in questions with a start time; pictures with the question and with the answer; the final question can have a picture.
- 2026-10-04: picking the tile from the phone (on by default, the host can still click); making a quiz with AI by copy and paste (no API key, no internet in ProQuiz).
- 2026-10-05: Daily Double as a special (the picking team bets, answers alone, a wrong answer loses the whole bet); the picking phone chooses who to freeze; AI fills only the empty spots; specials placed by hand in the editor.
- 2026-10-06: fairer buzzing (a lobby setting, off by default; the server measures each phone's delay); round 2 (an optional second board, the team with the fewest points picks first, the pot carries over).
- 2026-10-10: the Quick quiz (sections, 2–4 coloured answers, faster is more points, the host presses Space between screens, the "question first, then the answers" wait is automatic, a top 5 with arrows, a podium; "Kahoot" is never shown); players elsewhere over a Cloudflare quick tunnel with an optional PIN; **Players join: On this Wi-Fi / Over the internet** as a saved lobby setting with one QR code; several right answers in a Quick quiz (any one counts, not every option may be right); branding (logo, event name, accent colour; never in exports); calm music after the answer; an animated top 5 (no lobby setting); avatars and mascots (drawn offline, optional in the rules).
- 2026-10-11: find a free picture (Openverse and Wikimedia Commons, credits saved in the quiz, a credit line on the TV after the answer); two more Quick question kinds, **Tick all that are right** and **Put in order** (all or nothing, question texts never say how many are right); bigger crowds and reactions (16 colours, up to 100 players in a Quick quiz, the newest player first on the TV lobby, six fixed emoji reactions, nothing stored); the new-version notice (a lobby banner, at most every 6 hours, a tick to turn it off); **Update now** (download from the GitHub release, check SHA256SUMS.txt, swap and restart in the same window, roll back if the new one dies); louder defaults (80 %), archive, description and cover picture, a versioned export and **Export all quizzes**; **Quit ProQuiz** (a quiet button at the bottom of the lobby, asks first, saves, says goodbye to every screen); trim every sound clip with a trim bar; **Find a song clip** (Deezer 30 s previews, editor only; Spotify was decided against: its policy forbids trivia quizzes); extra languages in a quiz (translations on each item, flags as bundled SVGs, Thai included, a host switch, the TV always in the main language, the phone's own buttons follow the choice only for en/no); slowly appearing pictures in the Quick quiz with a new blur style; fill empty spots with AI for Quick quizzes; and the fixes after the first real game (the top 5 about 60 % of the screen wide with no cut names, the last result straight to the podium, AI-made quizzes keep their question kinds); a **New quiz** button in the lobby and one New quiz button in the editor that asks "What kind of quiz?" (board or Quick, with small pictures); editor tidy-ups (quiz rows with the cover as a slim banner and no sideways scroll, Archive as a small box icon, New quiz + Import side by side, Export all at the bottom of the list, the list keeps its place whether its scroll bar shows or not); and an editor layout pass (question dialogs up to 1100 px wide in two columns, an × in the corner of every editor dialog, description/cover/languages folded into "About the quiz").

## Status and open items (2026-10-11)

**Latest release: v2.4.0** (2026-10-11: song clips, quiz languages, Quick quiz reveal, editor tidy-up; commit 0a2c875). Releases this weekend: 2.0.0, 2.0.1, 2.0.2, 2.1.0 (picture search), 2.2.0 (tick-all / put-in-order questions, reactions, 100 players, 16 colours), 2.2.1 (icon, new-version notice, review fixes), 2.3.0 (Update now, louder defaults, archive, quiz description and cover, versioned export), 2.3.1 (Quit ProQuiz).

**Released as v2.4.0 on 2026-10-11:** everything built that day (see "Decisions since").

**Small layout issues seen in the last screenshot (`test/screenshots/editor-space-question-1280.png`), left for later at the owner's choice:** in the two-column question dialog with a picture, a clip and the slow reveal, the right column is much longer than the left (half empty), and the floating Done button covers part of the sound clip's player. Possible fix: move the sound clip under the words on the left and give Done its own bar at the bottom.

**How to release:** bump with `npm version X.Y.Z --no-git-tag-version`, commit, push, `npm run build`, then `gh release create vX.Y.Z dist/* --title "ProQuiz X.Y.Z" --notes-file <notes> --latest`. Upload **everything in dist/**, including `SHA256SUMS.txt`, or Update now refuses the release. Start the notes with one friendly summary sentence: the lobby's update banner shows the first paragraph.

**Waiting for the owner:**
- The Windows test of **Update now**: install 2.3.0 by hand (from the v2.3.0 release page, not "latest"), press Update now, check that the black window stays, the page says "ProQuiz was updated to 2.3.1", `ProQuiz.old.exe` appears, and Quit ProQuiz stops it. Also note any SmartScreen or firewall prompt.
- Whether the new icon looks right on `ProQuiz.exe` in Windows.
- The loudness of the new 80 % defaults, by ear.
- Try today's features for real: a real Deezer search in the editor (the tests used a pretend Deezer), dragging the trim handles on a touch screen, a quiz with Thai and Norwegian translations on real phones, the blur reveal on the TV, and the wider top 5 on the smart TV's own browser.

**Never tried on real hardware:** the Mac builds (and Update now on a Mac), internet play on Windows and Mac, more than 30 real phones on a real router (marked experimental in the lobby), reactions on a smart TV browser, the buzz notes of the 8 new colours, and the new Norwegian texts read by a native speaker.

**Decided against for now:** hosting ProQuiz as a website (the owner said "Let's not go online for now", 2026-10-11; if it comes back, start with rooms with join codes, quizzes kept in the host's browser, and no accounts). Spotify for song clips (its Developer Policy forbids trivia quizzes; Apple MusicKit and YouTube embeds were ruled out too). A Mac `.app` with its own icon and a Linux desktop shortcut were left out because they can't be tested here.

**Review screenshots:** 300 numbered screenshots of every screen are in `~/Work/proquiz-review/index.html` (outside the repo). They were made by scripts in a session scratchpad that is gone after the session, so make new ones the same way if needed: a Playwright script per area that starts `startServer()` on its own port with a temporary data folder, joins pretend players and numbers each shot.

## Later
Showing the board quiz's questions on the phones for players elsewhere, a time limit for picking, sound files instead of synthesized sounds.

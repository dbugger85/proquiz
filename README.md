# ProQuiz

![ProQuiz: the TV shows the question with the team that buzzed first, and each team's phone says who was first](docs/screenshots/hero.jpg)

A Jeopardy-style quiz for teams in the same room. A laptop runs the game, a TV shows the board, and every team uses a phone as a buzzer. No internet is needed: everything runs over the room's Wi-Fi.

- A board of categories and questions (100–500 points). The team that answers right picks the next question.
- Phones buzz in, and the first team is shown on the TV in its colour. A wrong answer costs points (none, half or all, your choice), and the other teams can try.
- Game-show sounds, a different buzz note for each team, and timers.
- Background music, Kahoot style: a lobby tune, thinking music while the buzzers are on, suspense in the final, and party music at the end. You can swap in your own music files.
- Pictures and sound clips in questions ("Which song is this?"). A picture can start as big blocks and slowly become clear.
- An optional round 2: a second board with new questions and double points, played before the final. The team with the fewest points picks first.
- A final round: teams bet, type their answers on their phones, and you judge each one.
- Fairer buzzing (optional): the team that pressed first wins, even if its phone has slower Wi-Fi.
- A question editor, English and Norwegian, and an autosave that survives a crash.
- **Crazy mode (Kaosmodus):** hidden special tiles, revealed on the TV with a spinning reel. They include bombs, triple points, a hot seat, a rescue for the team in last place, a three-question turbo, a jackpot, a freeze and a Daily Double. You can also place specials yourself in the editor.

## Screenshots

**On the TV**

| | |
|---|---|
| ![The board: five categories with 100 to 500 points, and the scores along the bottom](docs/screenshots/tv-board.jpg) | ![A picture question: a flag, with "This flag flies over which capital city?"](docs/screenshots/tv-picture.jpg) |
| The board | A picture question |
| ![A sound clip question, with moving sound bars while the clip plays](docs/screenshots/tv-sound-clip.jpg) | ![The final round: each team's answer and bet, marked right or wrong, and the correct answer](docs/screenshots/tv-final.jpg) |
| A sound clip question | The final round, judged |
| ![Crazy mode: a Triple tile revealed](docs/screenshots/tv-crazy-triple.jpg) | ![Crazy mode: a bomb goes off, BOOM, Blue Steel loses 200](docs/screenshots/tv-crazy-boom.jpg) |
| Crazy mode: triple points | Crazy mode: the bomb |

**On the phones**

| | | | |
|---|---|---|---|
| ![Joining: a team name and a colour](docs/screenshots/phone-join.jpg) | ![The buzzer](docs/screenshots/phone-buzzer.jpg) | ![Betting in the final round](docs/screenshots/phone-bet.jpg) | ![Typing the final answer](docs/screenshots/phone-answer.jpg) |
| Join with a name and colour | The buzzer | Bet in the final | Type the final answer |

**On the host laptop**

| | |
|---|---|
| ![The host screen: the question with its answer, who buzzed first, Correct and Wrong buttons, and the scores](docs/screenshots/host-question.jpg) | ![The question editor: points, question, answer, pictures and a sound clip](docs/screenshots/editor.jpg) |
| Only you see the answer | The question editor |

## Get it

Download the zip for your computer from the [latest release](https://github.com/dbugger85/proquiz/releases/latest) and unzip it. There's nothing to install. Each zip has a "START HERE" note.

| Computer | Download |
|---|---|
| Windows | `ProQuiz-…-windows.zip` → double-click `ProQuiz.exe` |
| Mac from late 2020 onwards (M1, M2, …) | `ProQuiz-…-mac-apple-silicon.zip` → right-click `ProQuiz` → Open |
| Older Mac (Intel) | `ProQuiz-…-mac-intel.zip` → right-click `ProQuiz` → Open |
| Linux | `ProQuiz-…-linux-x64.zip` → run `./ProQuiz` |

- **Windows:** before you unzip, right-click the zip → **Properties** → tick **Unblock** → **OK**. Without this, Windows may refuse to start ProQuiz and offer only "Don't run". If it still warns, click **More info → Run anyway**. Then **Allow** network access, or phones can't connect. The program isn't signed (signing costs money), which is why Windows is careful.
- **Mac** blocks a normal double-click the first time for the same reason. Right-click → **Open** once, and allow incoming connections if asked.

## Before the night

1. Start ProQuiz. Your browser opens the **host screen**.
2. Click **Edit questions** to make your quiz. Click a tile to write its question and answer, and add a picture or sound clip if you like. The editor saves by itself, and a list under the board tells you what's missing. Two sample quizzes are included, in English and Norwegian, each with a round 2.
   - **Round 2:** tick **This quiz has a round 2** under the board. A second board appears, the same size, with double points (you can change them). Write its questions like the first board's.
3. Try it once with two phones, so you know how it feels.

**Make a quiz with AI:** in the editor, click **Make questions with AI**. Type a few topics (one per line, each becomes a category), add example questions if you like, and choose the difficulty (kids 5–9, easy, medium, hard or expert), the board size, the final question, a round 2 (with its own topics if you like) and the language. Click **Copy the request**, paste it into Claude or ChatGPT, then copy the AI's whole answer back into the box and click **Fill the board**. Your new quiz opens in the editor. **Check every answer: AI can get facts wrong.** ProQuiz itself never goes on the internet.

**Fill the empty spots with AI:** started a quiz but ran out of ideas? Open it in the editor and click **Fill empty spots with AI** under the board. ProQuiz shows what is missing (empty questions, questions without an answer, answers without a question, category names, the final), on both boards if the quiz has a round 2. The request includes everything you have already written, so the AI matches its topics, difficulty and language and avoids repeating your answers. You can choose a difficulty yourself, and give topics for categories that are completely empty. Paste the answer back and only the empty spots are filled: nothing you wrote changes, and the new tiles get a dashed edge so you can check them. Picture and sound questions without an answer are left for you, because the AI can't see them.

**Ready-made quizzes to import** (download the file, then **Import** in the editor):
- [Barnequiz 2 (5–9 år)](examples/barnequiz-2.proquiz.json): a Norwegian quiz for children aged 5 to 9, about animals, food, fairy tales, numbers, Norway and the world, and nature and space, with six pictures.

## On the night

1. **Wi-Fi:** connect the laptop and all the phones to the **same Wi-Fi**.
2. **Start** ProQuiz. Keep its black (or Terminal) window open while you play.
3. **TV:** connect the laptop to the TV as a **second screen** (extend, not mirror). On the host screen click **Open TV screen**, drag that window onto the TV, and press **F** for full screen. Click the TV screen once so it's allowed to play sound.
   - **Only one screen** (just the laptop, or the laptop mirrored to the TV)? Skip "Open TV screen". Once the game starts, the laptop shows the TV view itself, with the controls underneath: click the tiles on the board, and the answers stay hidden until you reveal them. Press **H** to peek at the host view (with the answer and score changes), and **H** again to go back. **F** is full screen.
4. **Teams join:** they scan the QR code on the TV, type a team name and pick a colour. They can press **Try your buzzer** to hear their tone.
5. **Settings:** in the lobby, choose the quiz, the language, what a wrong answer costs, the timers, and the music: on or off, the volume, and optionally your own music file for each moment (lobby, between questions, thinking, final, after the game).
6. **Round 2:** if the quiz has a round 2, **Play round 2** is ticked in the lobby. Untick it to skip it tonight.
7. **Fairer buzzing:** tick it if close calls matter. Normally the laptop goes by whose buzz *arrives* first, so a phone with weak Wi-Fi can lose by a few hundredths of a second. With this on, ProQuiz measures how slow each phone's Wi-Fi is (you'll see it in milliseconds next to each team) and goes by who *pressed* first. The winner shows a tiny moment later (0.15 s), which most people won't notice.
8. **Picking on the phone:** with **Teams pick the next question on their phone** ticked (it is by default), the team whose turn it is chooses a category and then the points on its phone, and the question opens on the TV at once. You can always click a tile on the laptop instead, for example if their phone has run out of battery.
9. **Start game.**

### Crazy mode (Kaosmodus)

Turn it on in the lobby's settings: **A little** hides about 3 special tiles on a 5×5 board, and **Lots** about 6. They land anywhere, and nobody (except you, on the laptop) knows where. Untick any specials you don't want under **Specials to use**.

**Place specials yourself:** in the editor, open a question and choose a **Special tile**. Its icon shows on the tile in the editor (and on your laptop's board), never on the TV. A quiz's own specials always play, even with Crazy mode off; untick **Use this quiz's own special tiles** in the lobby to play without them. With Crazy mode on, the random specials are added on other tiles.

When a team picks one, the TV spins a reel and lands on the special. Press **Space** to go on.

| Special | What happens |
|---|---|
| ×3 **Triple** | Three times the points, and three times the penalty for every wrong answer |
| 💣 **Bomb** | No question: the picking team loses the tile's points |
| 🔥 **Hot seat** | Only the picking team may answer |
| 🛟 **Rescue** | The team in last place answers alone, and a wrong answer costs nothing |
| ⚡ **Turbo** | The picking team gets three questions in a row, 5 seconds each, with no penalty |
| 💰 **Jackpot** | Every point lost to wrong answers and bombs has gone into a secret pot. Answer right to win it |
| 🧊 **Freeze** | The picking team chooses, on its phone, a team that can't buzz on this question (you can also click it on the laptop) |
| 🎲 **Daily Double** | The picking team bets on its phone first: up to its score, or the board's top value if that's more. Then it answers alone. Right wins the bet, wrong loses all of it (whatever the wrong-answer setting says). If nobody bets, the tile's value is played, and you can also type the bet on the laptop |

### Playing

| Key | What it does |
|---|---|
| Click a tile | Open the question the team picked (or let them pick it on their phone) |
| **Space** | Turn the buzzers on (after reading the question), or go back to the board |
| **Y** / **N** | The answer is correct / wrong |
| **R** | Show the answer (nobody got it) |
| **Esc** | Put the question back (picked by mistake) |
| **U** | Undo the last judgement or score change |
| **P** / **0** | Play or pause the sound clip / play it from the start |
| **M** | Sound effects on or off |
| **B** | Background music on or off |
| **H** | Without a separate TV screen: switch between the TV view and the host view |
| **E** | End the board early and go to round 2 (if it's on) or the final round |
| **?** | Show all the keys |

You also have buttons to **Change score** and **Let them pick** for each team. When the first board is done (or you press **E**), round 2 starts with a big intro on the TV: the team with the fewest points picks first, and **Space** opens the new board. Crazy mode gets new hidden specials on it, and an unwon jackpot carries over. In the final round, the teams bet on their phones, then type their answers. You mark each one **Correct** or **Wrong**, and it flips up on the TV.

## If something goes wrong

- **Phones can't connect.**
  - Check they're on the same Wi-Fi as the laptop, not mobile data.
  - Guest or hotel Wi-Fi often stops devices seeing each other. Turn on a hotspot on one phone and put the laptop and all the phones on it.
  - On Windows, check ProQuiz is allowed through the firewall.
- **A phone went to sleep or lost its connection.** Unlock it or reload the page. It comes back as the same team, with the same score.
- **The laptop crashed, or you closed ProQuiz.** Start it again. The host screen asks **Continue the last game?**
- **No sound.** Click the TV screen once. Check **Sound effects** is on and the TV isn't muted. Sound clips play from the TV screen, or from the laptop when no TV screen is open.

Your quizzes, their pictures and clips, and the autosave are kept in a **ProQuiz** folder in your home folder. Use **Export** in the editor to share a quiz, pictures and clips included, and **Import** to open one.

## For developers

```sh
npm install
npm start        # starts the server and opens the host page (PROQUIZ_NO_OPEN=1 to skip)
npm test         # unit and server tests
npm run e2e      # browser test with a host, a TV and three phones
npm run build    # the zips in dist/ (needs Deno and zip)
```

See [CLAUDE.md](CLAUDE.md) for how it's built and [PLAN.md](PLAN.md) for the plan and decisions.

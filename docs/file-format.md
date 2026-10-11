# The ProQuiz quiz file (`.proquiz.json`)

**Export** in the editor writes one of these files, and **Import** reads them. The code is in `lib/fileformat.js` (the version rules) and `store.js` (`exportPackage`, `exportAll`, `importPackage`). The quiz itself is described in `lib/validate.js`.

## One quiz

```json
{
  "proquiz": 1,
  "app": "2.3.0",
  "exported": "2026-10-11T18:30:00.000Z",
  "set": { "v": 1, "title": "My quiz", "description": "…", "cover": "3fa9c0d1e2b4a6f8.jpg", "categories": [ … ], "credits": { … } },
  "files": { "3fa9c0d1e2b4a6f8.jpg": "<base64>", "0b1c2d3e4f5a6b7c.mp3": "<base64>" }
}
```

| Field | What it is |
|---|---|
| `proquiz` | The **file-format version** (`FORMAT_VERSION` in `lib/fileformat.js`). 1 since the first export. |
| `app` | The ProQuiz version that wrote the file (from `package.json`), or `null` when it isn't known. Only for information. |
| `exported` | When the file was written, as an ISO date. Only for information. |
| `set` | The quiz, exactly as it is saved in `<data dir>/sets/<id>.json` (a board quiz or a Quick quiz). The `description` and `cover` belong to the quiz, so they travel with it; `credits` are the picture and song credits by file name (a song clip from "Find a song clip" has `title`, `author` (the artist), `source: "deezer"` and `sourceUrl`). A question's clip can be trimmed: `audioStart` (seconds) and `audioLength` (seconds, 0.5–600; left out = to the end), both optional, so the version stays 1. A question picture can appear slowly: `unveil` (seconds until it is clear, 1–120; in a Quick quiz it is cut to the question's seconds when played) and `unveilStyle` (`"pixels"`, the default and left out of the file: big blocks that get smaller; or `"blur"`: a heavy blur that sharpens), both optional and only kept with a picture, so the version stays 1. |
| `files` | Every picture and sound clip the quiz uses (`usedFiles()` in `lib/validate.js`: the cover, both boards, the sections, the final; question pictures, answer pictures and clips), base64 by file name. The names are made from the content (sha256, 16 hex characters), so the same file twice is the same name. |

A plain quiz (just the `set` object, without `proquiz` and `files`) can be imported too; it then has no pictures.

### Extra languages

A quiz can carry translations into other languages (`lib/languages.js`). They are optional fields, so the version stays 1, and a quiz without them is written exactly as before.

```json
{
  "v": 1,
  "title": "Sample quiz",
  "lang": "en",
  "languages": ["no", "th"],
  "translations": { "no": { "title": "Prøvequiz", "description": "…" } },
  "categories": [
    {
      "name": "Capitals",
      "translations": { "no": { "name": "Hovedsteder" } },
      "questions": [
        { "value": 100, "question": "What is the capital of Norway?", "answer": "Oslo",
          "translations": { "no": { "question": "Hva er hovedstaden i Norge?", "answer": "Oslo" }, "th": { "question": "…" } } }
      ]
    }
  ],
  "final": { "category": "Norway", "question": "…", "answer": "…", "translations": { "no": { "category": "Norge", "question": "…", "answer": "…" } } }
}
```

| Field | What it is |
|---|---|
| `lang` | The quiz's **main language**: the one the texts are written in and the TV shows. One of the codes in `LANGUAGES` (`en`, `no`, `sv`, `da`, `fi`, `de`, `fr`, `es`, `it`, `pt`, `nl`, `pl`, `lt`, `ro`, `uk`, `ru`, `tr`, `ar`, `fa`, `ur`, `so`, `ti`, `hi`, `th`, `vi`, `tl`, `zh`, `ja`, `ko`). Left out = English. |
| `languages` | The added languages, as codes. Only known codes other than the main one are kept. |
| `translations` | On the thing it translates: on the quiz `{ title, description }`, on a category or a Quick quiz section `{ name }`, on a board question `{ question, answer }`, on a Quick question `{ question, options }` (a list **by index**: `options[2]` translates `options[2]`, `""` = not translated yet), on the final `{ category, question, answer }`. Keyed by language code. A missing or empty field falls back to the main text when played. `clean()` keeps only the codes in `languages`, trims, and drops empty ones; when it drops an empty Quick option it drops the translations of that option too, so the lists stay in step. |

A quiz with `translations` but no `languages` is saved without them.

## Every quiz at once ("Export all quizzes")

```json
{
  "proquiz": 1,
  "app": "2.3.0",
  "exported": "…",
  "sets": [ { "set": { … } }, { "set": { … }, "archived": true } ],
  "files": { … }
}
```

`sets` has every quiz the host made (the built-in samples are left out). `archived: true` marks a quiz that was put away in the editor; the import puts it away again. A file shared by several quizzes is in `files` once. Importing one of these imports every quiz and says how many.

## Versions

- **Adding an optional field keeps `proquiz` at 1.** An older ProQuiz just ignores what it doesn't know (`clean()` in `store.js` drops unknown fields when the quiz is saved).
- **Only a change an older ProQuiz could misread** (a renamed or reshaped field) bumps `FORMAT_VERSION`, together with an upgrade step for the files written before.
- On import, a file with a **newer** `proquiz` than this ProQuiz knows is refused with the code `quiz-too-new`; the editor says "This quiz was made with a newer ProQuiz. Update ProQuiz to open it." An **older** file is run through `upgradeExport()` first, which applies the steps in `UPGRADES` one after the other until the file is current.

### Adding an upgrade step

When `FORMAT_VERSION` goes from 1 to 2, add to `UPGRADES` in `lib/fileformat.js`:

```js
UPGRADES[1] = (data) => ({
  ...data,
  proquiz: 2,
  set: data.set && fixSet(data.set),
  sets: data.sets?.map((s) => ({ ...s, set: fixSet(s.set) })),
});
```

The step for version *n* takes a file in format *n* and returns it in format *n* + 1 (`upgradeExport()` checks that). It must handle both a single `set` and the `sets` list. Add a test to `test/export.test.js` that imports a file in the old format.

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
| `set` | The quiz, exactly as it is saved in `<data dir>/sets/<id>.json` (a board quiz or a Quick quiz). The `description` and `cover` belong to the quiz, so they travel with it; `credits` are the picture credits by file name. |
| `files` | Every picture and sound clip the quiz uses (`usedFiles()` in `lib/validate.js`: the cover, both boards, the sections, the final; question pictures, answer pictures and clips), base64 by file name. The names are made from the content (sha256, 16 hex characters), so the same file twice is the same name. |

A plain quiz (just the `set` object, without `proquiz` and `files`) can be imported too; it then has no pictures.

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

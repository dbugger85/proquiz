// The question editor (laptop only). Quizzes save themselves a moment after each change.
import { validateSet, usedFiles, cleanCredits, modeOf, MAX_DESCRIPTION, MIN_AUDIO_LENGTH, MAX_CATEGORIES, MAX_QUESTIONS, MAX_SECTIONS, MAX_SECTION_QUESTIONS, MAX_OPTION, MIN_SECONDS, MAX_SECONDS, DEFAULT_SECONDS, rightSet, typeOf, QUESTION_TYPES, UNVEIL_STYLES } from '/lib/validate.js';
import { buildRequest, parseReply, splitTopics, AiQuizError, DIFFICULTIES, FILL_DIFFICULTIES, MIN_SIZE, QUICK_SECTIONS, QUICK_PER_SECTION, gapsOf, guessLanguage, buildFillRequest, parseFill, suggestedTarget, buildTranslateRequest, parseTranslation } from '/lib/aiquiz.js';
import { SHAPES, OPTION_COLORS } from '/lib/quick.js';
import { LANGUAGES, languageName, flagUrl, mainLang, languagesOf, translationSlots, slotTranslation, setSlotTranslation, missingTranslations, removeLanguage } from '/lib/languages.js';
import { t, pts, setLang, getLang, translatePage, licenseName, lengthText, mss } from './i18n.js';
import { $, h, fill, setGlass, savedGlass, shapeSvg, optionStyle, setBrand, ask, tell } from './ui.js';
import { KINDS } from '/lib/crazy.js';
import { ICONS } from './specials.js';
import { api } from './quizapi.js';
import { HOSTED } from './env.js';
import { refreshBackup } from './backup.js';

let quizzes = []; // the list on the left
let currentId = null;
let set = null; // the quiz being edited
let builtIn = false;
let problems = [];
let saveTimer = null;
let savePromise = Promise.resolve();
let aiNote = null; // { id, duplicates, filled?, left?, summary? } for a quiz just made or filled with AI (shown until another quiz is opened)
// The website (docs/dev/web-plan.md §2–§4): the quizzes live in this browser, the picture and song search go
// through this browser's room (quizapi.js), a picture or clip is at most 8 MB, and a quiz's files must fit a room
// (48 MB): the "About the quiz" fold says how much they add up to, and the problems box says when it is too much.
const canSearch = true; // both the laptop and the website have the picture and song search
const uploadFailedText = () => t(HOSTED ? 'edUploadFailedWeb' : 'edUploadFailed');
let mediaSize = null; // { bytes, biggest, ok, maxBytes, maxFile } of the quiz on show (website only)
let mediaSizeKey = null; // which quiz and files it was measured for

// A Quick quiz read from a pasted AI answer: how many questions of each kind were read ("Read 19 questions: 14 pick one,
// 3 tick all that are right, 2 put in order"), and a line for each pick-one question whose wording sounds like
// "tick all" or "put in order", so the host checks its kind (the owner's first AI quiz lost them, 2026-10-11).
function aiSummaryLines(note) {
  const sum = note.summary;
  if (!sum || !sum.questions) return [];
  const kinds = [
    sum.choice && t('aiKindChoice', { n: sum.choice }),
    sum.any && t('aiKindAny', { n: sum.any }),
    sum.multi && t('aiKindMulti', { n: sum.multi }),
    sum.order && t('aiKindOrder', { n: sum.order }),
  ].filter(Boolean);
  const where = (x) => t('edWhereQuick', { cat: set?.sections?.[x.c]?.name?.trim() || t('edSection', { n: x.c + 1 }), n: x.i + 1 });
  return [
    h('p', { class: 'muted ai-summary' }, t(note.filled ? 'aiNowSummary' : 'aiReadSummary', { n: sum.questions, kinds: kinds.join(', ') })),
    ...sum.suspects.map((x) => h('p', { class: 'muted ai-suspect' }, t(x.looks === 'order' ? 'aiLooksOrder' : 'aiLooksMulti', { where: where(x) }))),
  ];
}

// A Quick quiz (multiple choice in sections) instead of a board: see renderSections() and openQuestion().
const quick = () => modeOf(set) === 'quick';

// Every editor dialog starts with the same bar: the title and an × in the corner (48px, "Close"). The × closes the
// dialog exactly like its Done or Cancel button: `dialog.close()` fires the same `close` event, so whatever the
// dialog does then (save, stop a preview, redraw) happens the same way. The bar stays put while the rest scrolls.
// `dialog` may be a function giving the dialog, for a dialog that is only made after its buttons (chooseKind()).
const closeButton = (dialog, value) => h('button', { class: 'ed-dialog-close', type: 'button', 'aria-label': t('edClose'), title: t('edClose'), onclick: () => (typeof dialog === 'function' ? dialog() : dialog).close(value) }, '×');
const dialogHead = (dialog, ...title) => h('div', { class: 'ed-dialog-head' }, h('h2', {}, ...title), closeButton(dialog));

setGlass(savedGlass()); // the look the host chose last (the editor has no game state of its own)
// The host's branding (logo and accent colour), fetched once.
api
  .brand()
  .then(setBrand)
  .catch(() => {});

// ----- the quizzes: everything goes through `api` (quizapi.js) -----

async function loadList() {
  quizzes = await api.list();
  renderList();
  refreshBackup(); // the website's backup reminder follows the list
}

function setStatus(key) {
  const el = $('#ed-status');
  if (!el) return;
  el.textContent = key ? t(key) : '';
  el.className = `ed-status ${key === 'edSaveFailed' ? 'bad' : ''}`;
}

function scheduleSave() {
  if (builtIn || !currentId) return;
  setStatus('edSaving');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 600);
}

function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (builtIn || !currentId) return savePromise;
  const id = currentId;
  const body = { set: structuredClone(set) };
  savePromise = savePromise
    .then(() => api.save(id, body.set))
    .then(() => {
      if (id === currentId && !saveTimer) setStatus('edSaved');
      const item = quizzes.find((q) => q.id === id);
      if (item) {
        // What the list shows: the name, whether it is ready, the cover and the first line of the description.
        const description = String(body.set.description ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? '';
        Object.assign(item, { title: body.set.title, problems: validateSet(body.set).length, cover: body.set.cover ?? null, description });
      }
      renderList();
    })
    .catch(() => setStatus('edSaveFailed'));
  return savePromise;
}

// Anything changed: check the quiz again and save soon.
function changed({ board = false } = {}) {
  pruneCredits();
  problems = validateSet(set);
  if (board) renderBoard();
  else markTiles();
  renderProblems();
  if (document.querySelector('.ed-languages') && languagesOf(set).length) redrawLanguages(); // the "n missing" counts
  scheduleSave();
  refreshMediaSize();
}

// The website: measures the quiz's pictures and clips again when they changed, then redraws the size line, the
// fold's status and the problems box.
const mbText = (bytes) => new Intl.NumberFormat(getLang() === 'no' ? 'nb' : 'en', { maximumFractionDigits: 1 }).format(bytes / (1024 * 1024));
async function refreshMediaSize() {
  if (!HOSTED || !set || builtIn) return; // a built-in quiz's files stay on the server, so there is nothing to measure
  const key = `${currentId}|${usedFiles(set).join(',')}`;
  if (key === mediaSizeKey) return;
  mediaSizeKey = key;
  const size = await api.sizeOf(set).catch(() => null);
  if (key !== mediaSizeKey) return; // measured again meanwhile
  mediaSize = size;
  redrawAboutStatus();
  renderMediaSize();
  renderProblems();
}
function mediaSizeLine() {
  return mediaSize ? t('edMediaSize', { used: mbText(mediaSize.bytes), max: mbText(mediaSize.maxBytes) }) : '';
}
function renderMediaSize() {
  const el = document.querySelector('.ed-media-size');
  if (!el) return;
  el.textContent = mediaSizeLine();
  el.classList.toggle('bad', Boolean(mediaSize && !mediaSize.ok));
}
// The lines for the problems box when the quiz's files don't fit a room (nothing on the laptop).
function mediaProblems() {
  if (!mediaSize || mediaSize.ok) return [];
  const out = [];
  if (mediaSize.biggest > mediaSize.maxFile) out.push(t('edMediaFileOver', { max: mbText(mediaSize.maxFile) }));
  if (mediaSize.bytes > mediaSize.maxBytes) out.push(t('edMediaOver', { used: mbText(mediaSize.bytes), max: mbText(mediaSize.maxBytes) }));
  return out;
}

// ----- the list of quizzes -----

// Each row: the quiz (cover thumbnail, title, the first line of its description) and Archive / Bring back.
// Archived quizzes sit in a folded "Archived (n)" section at the bottom (archiving is personal to this computer).
function renderList() {
  const row = (q) =>
    h(
      'li',
      { class: `ed-row${q.archived ? ' archived' : ''}` },
      h(
        'button',
        { class: `ed-item${q.id === currentId ? ' on' : ''}${q.cover ? ' with-cover' : ''}`, type: 'button', onclick: () => select(q.id).then(foldList) },
        q.cover ? h('img', { class: 'ed-item-thumb', src: api.fileUrl(q.cover), alt: '' }) : null,
        h(
          'span',
          { class: 'ed-item-text' },
          h('span', { class: 'ed-item-title' }, q.title || t('edNewQuizTitle')),
          q.description ? h('span', { class: 'ed-item-desc' }, q.description) : null,
          h(
            'span',
            { class: `ed-item-sub${q.problems ? ' bad' : ''}` },
            [q.kind === 'quick' ? t('quickTag') : null, q.builtIn ? t('edBuiltIn') : q.problems ? t('edNotReady') : t('edQuestions', { n: q.questions })].filter(Boolean).join(' · '),
          ),
        ),
      ),
      h(
        'button',
        {
          class: 'ed-archive',
          type: 'button',
          title: t(q.archived ? 'edUnarchiveTitle' : 'edArchiveTitle'),
          'aria-label': t(q.archived ? 'edUnarchive' : 'edArchive'),
          onclick: () => setArchived(q, !q.archived),
        },
        archiveIcon(q.archived),
      ),
    );
  const archived = quizzes.filter((q) => q.archived);
  fill($('#quiz-list'), ...quizzes.filter((q) => !q.archived).map(row));
  const box = $('#quiz-archived');
  box.hidden = archived.length === 0;
  box.querySelector('summary').textContent = t('edArchived', { n: archived.length });
  fill(box.querySelector('ul'), ...archived.map(row));
}

async function setArchived(q, on) {
  try {
    const { archived } = await api.setArchived(q.id, on);
    q.archived = archived;
  } catch {}
  renderList();
}

// On a narrow window the list sits above the quiz: picking a quiz folds it away (the heading opens it again).
const narrow = () => matchMedia('(max-width: 800px)').matches;
function foldList() {
  if (!narrow()) return;
  $('.ed-side').classList.add('folded');
  $('.ed-layout').scrollTop = 0;
}
$('#ed-side-toggle').addEventListener('click', () => narrow() && $('.ed-side').classList.toggle('folded'));

async function select(id) {
  await saveNow();
  const found = await api.get(id).catch(() => null);
  if (!found) return;
  if (aiNote && aiNote.id !== id) aiNote = null;
  currentId = id;
  set = found.set;
  builtIn = found.builtIn;
  problems = validateSet(set);
  mediaSize = null; // measured again for this quiz (the website)
  mediaSizeKey = null;
  history.replaceState(null, '', `#${id}`);
  renderList();
  renderMain();
}

function blankQuestion(value) {
  return { value, question: '', answer: '' };
}

function blankSet() {
  return {
    v: 1,
    title: t('edNewQuizTitle'),
    categories: Array.from({ length: 5 }, () => ({ name: '', questions: [100, 200, 300, 400, 500].map(blankQuestion) })),
    final: { category: '', question: '', answer: '' },
  };
}

// A Quick quiz to start from: two sections of five empty questions (no right answer marked yet).
const blankQuickQuestion = () => ({ question: '', options: [] });
const blankSection = (n = 5) => ({ name: '', questions: Array.from({ length: n }, blankQuickQuestion) });
function blankQuickSet() {
  return { v: 1, kind: 'quick', title: t('edNewQuizTitle'), sections: [blankSection(), blankSection()] };
}

async function createQuiz(newSet) {
  const { id } = await api.create(newSet);
  await loadList();
  await select(id);
}

// ----- New quiz: "What kind of quiz?" -----

// Small flat pictures for the two cards, drawn in the app's own colours (CSS variables, so they follow branding).
const SVG = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs = {}, ...children) {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  el.append(...children);
  return el;
}
const picture = (...children) => svgEl('svg', { viewBox: '0 0 160 100', class: 'ed-kind-pic', 'aria-hidden': 'true' }, ...children);

// A board: three category headers, point tiles underneath and three team buzzers along the bottom.
function boardPicture() {
  const cols = [4, 56, 108];
  const headers = cols.map((x) => svgEl('rect', { x, y: 4, width: 48, height: 16, rx: 5, fill: 'var(--light)' }));
  const names = cols.map((x, i) => svgEl('rect', { x: x + 9, y: 10, width: 30 - i * 6, height: 4, rx: 2, fill: 'rgb(255 255 255 / 0.85)' }));
  const tiles = [];
  [100, 200, 300].forEach((points, row) => {
    for (const x of cols) {
      const y = 24 + row * 18;
      tiles.push(
        svgEl('rect', { x, y, width: 48, height: 15, rx: 4, fill: 'rgb(var(--light-2-rgb) / 0.28)', stroke: 'rgb(var(--light-3-rgb) / 0.4)' }),
        svgEl('text', { x: x + 24, y: y + 11, 'text-anchor': 'middle', 'font-size': '9', 'font-weight': '700', fill: 'currentColor' }, String(points)),
      );
    }
  });
  // Three phones with a big buzzer each, in the first teams' colours.
  const buzzers = ['#ff453a', '#0a84ff', '#30d158'].flatMap((color, i) => {
    const x = 44 + i * 26;
    return [
      svgEl('rect', { x, y: 80, width: 20, height: 24, rx: 4, fill: 'rgb(255 255 255 / 0.16)', stroke: 'rgb(255 255 255 / 0.35)' }),
      svgEl('circle', { cx: x + 10, cy: 91, r: 6, fill: color }),
    ];
  });
  return picture(...headers, ...names, ...tiles, ...buzzers);
}

// A Quick quiz: a question bar and the four answer shapes in their colours.
function quickPicture() {
  const bar = [
    svgEl('rect', { x: 20, y: 4, width: 120, height: 22, rx: 6, fill: 'rgb(var(--light-2-rgb) / 0.28)', stroke: 'rgb(var(--light-3-rgb) / 0.4)' }),
    svgEl('rect', { x: 32, y: 10, width: 72, height: 4, rx: 2, fill: 'rgb(255 255 255 / 0.85)' }),
    svgEl('rect', { x: 32, y: 17, width: 48, height: 4, rx: 2, fill: 'rgb(255 255 255 / 0.5)' }),
  ];
  const options = SHAPES.flatMap((shape, i) => {
    const x = 20 + (i % 2) * 62;
    const y = 32 + Math.floor(i / 2) * 34;
    const icon = shapeSvg(shape, 'ed-kind-shape');
    icon.setAttribute('x', x + 19);
    icon.setAttribute('y', y + 5);
    icon.setAttribute('width', 20);
    icon.setAttribute('height', 20);
    return [svgEl('rect', { x, y, width: 58, height: 30, rx: 7, fill: OPTION_COLORS[i] }), icon];
  });
  return picture(...bar, ...options);
}

// The pop-up behind New quiz: two big cards. Resolves 'board', 'quick', or null for Cancel, Esc or closing.
function chooseKind() {
  return new Promise((resolve) => {
    const card = (kind, pic, name, hint) =>
      h(
        'button',
        { class: `ed-kind ed-kind-${kind}`, type: 'button', value: kind, onclick: () => dialog.close(kind) },
        pic,
        h('b', {}, name),
        h('span', {}, hint),
      );
    const cancel = h('button', { class: 'btn', type: 'button', onclick: () => dialog.close('cancel') }, t('dlgCancel'));
    const form = h(
      'form',
      { method: 'dialog', novalidate: true },
      h('h2', { id: 'ed-kind-title' }, t('edKindTitle')),
      closeButton(() => dialog, 'cancel'),
      h(
        'div',
        { class: 'ed-kinds' },
        card('board', boardPicture(), t('edKindBoard'), t('edKindBoardHint')),
        card('quick', quickPicture(), t('edKindQuick'), t('edKindQuickHint')),
      ),
      h('div', { class: 'pq-modal-actions' }, cancel),
    );
    const dialog = h('dialog', { class: 'pq-modal ed-kind-modal', 'aria-labelledby': 'ed-kind-title' }, form);
    const before = document.activeElement;
    dialog.addEventListener('close', () => {
      dialog.remove();
      if (before?.isConnected && typeof before.focus === 'function') before.focus({ preventScroll: true });
      resolve(['board', 'quick'].includes(dialog.returnValue) ? dialog.returnValue : null);
    });
    document.body.append(dialog);
    dialog.returnValue = '';
    dialog.showModal();
    form.querySelector('.ed-kind').focus();
  });
}

async function newQuiz() {
  const kind = await chooseKind();
  if (kind === 'board') await createQuiz(blankSet());
  else if (kind === 'quick') await createQuiz(blankQuickSet());
}

$('#new-quiz').addEventListener('click', newQuiz);

$('#export-all').addEventListener('click', async () => {
  await api.exportDownload(null); // every quiz the host made, in one file
  refreshBackup(); // on the website an export counts as a backup
});

$('#import-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const { id, count } = await api.importFile(await file.text());
    await loadList();
    await select(id);
    if (count > 1) tell({ title: t('dlgImportedTitle'), text: t('edImportedMany', { n: count }) }); // an "Export all quizzes" file
  } catch (err) {
    // A file from a newer ProQuiz says so plainly (lib/fileformat.js); anything else isn't a quiz.
    tell({ title: t('dlgImportTitle'), text: t(err.code === 'quiz-too-new' ? 'edImportTooNew' : 'edImportFailed') });
  }
});

// ----- the quiz -----

function renderMain() {
  const main = $('#ed-main');
  fill(main, 
    builtIn
      ? h(
          'div',
          { class: 'ed-note' },
          h('p', {}, t('edSampleNote')),
          h('button', { class: 'btn btn-primary', type: 'button', onclick: () => createQuiz({ ...structuredClone(set), title: t('edCopyName', { title: set.title }) }) }, t('edCopy')),
        )
      : null,
    aiNote?.id === currentId
      ? h(
          'div',
          { class: 'ed-note ai-note' },
          h(
            'div',
            {},
            h('p', {}, aiNote.filled ? t('aiFilledNote', { n: aiNote.filled.size }) : t('aiMadeNote')),
            aiNote.added ? h('p', { class: 'muted' }, t('aiAddedNote', { n: aiNote.added })) : null,
            ...aiSummaryLines(aiNote),
            aiNote.left ? h('p', { class: 'muted' }, t('aiFillLeft', { n: aiNote.left })) : null,
            aiNote.duplicates.length ? h('p', { class: 'muted' }, t('aiDuplicates', { list: aiNote.duplicates.join(', ') })) : null,
          ),
          h('button', { class: 'btn', type: 'button', onclick: () => ((aiNote = null), renderMain()) }, t('aiDismiss')),
        )
      : null,
    h(
      'div',
      { class: 'ed-head' },
      h(
        'label',
        { class: 'field ed-name' },
        h('span', {}, t('edQuizName')),
        h('input', {
          type: 'text',
          value: set.title,
          maxlength: 80,
          disabled: builtIn,
          oninput: (e) => {
            set.title = e.target.value;
            changed();
          },
        }),
      ),
      h('span', { id: 'ed-status', class: 'ed-status' }),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn', type: 'button', onclick: async () => (await api.exportDownload(currentId), refreshBackup()) }, t('edExport')),
      builtIn
        ? null
        : h(
            'button',
            {
              class: 'btn',
              type: 'button',
              onclick: async () => {
                if (!(await ask({ title: t('dlgDeleteQuizTitle'), text: t('edConfirmDelete', { title: set.title }), ok: t('edDelete'), danger: true }))) return;
                clearTimeout(saveTimer);
                saveTimer = null;
                await api.remove(currentId);
                currentId = null;
                set = null;
                await loadList();
                select(quizzes[0].id);
              },
            },
            t('edDelete'),
          ),
    ),
    aboutFold(),
    quick() ? h('div', { id: 'ed-sections', class: 'ed-sections' }) : [h('div', { id: 'ed-board' }), h('div', { id: 'ed-round2' }), h('div', { id: 'ed-final' })],
    h('div', { id: 'ed-problems' }),
    h('div', { id: 'ed-credits' }),
  );
  renderBoard();
  renderProblems();
  refreshMediaSize();
}

// The description, the cover picture and the languages are used once per quiz, so they sit folded under the name
// ("About the quiz"), with a one-line status in the summary, and the questions start right under it. The fold
// stays as the host left it (localStorage), closed to begin with.
const ABOUT_OPEN_KEY = 'proquiz.edAboutOpen';
let redrawAboutStatus = () => {};
function aboutStatus() {
  const langs = languagesOf(set);
  return [
    set.description?.trim() ? t('edDescription') : t('edNoDescription'),
    set.cover ? t('edCover') : t('edNoCover'),
    [languageName(guessedMain()), ...langs.map(languageName)].join(' + '),
    HOSTED && !builtIn ? mediaSizeLine() : '',
  ]
    .filter(Boolean)
    .join(' · ');
}
function aboutFold() {
  const status = h('small', { class: 'ed-fold-status muted' });
  redrawAboutStatus = () => (status.textContent = aboutStatus());
  redrawAboutStatus();
  let open = false;
  try {
    open = localStorage.getItem(ABOUT_OPEN_KEY) === '1';
  } catch {}
  return h(
    'details',
    {
      class: 'ed-fold ed-about-fold',
      open,
      ontoggle: (e) => {
        try {
          localStorage.setItem(ABOUT_OPEN_KEY, e.target.open ? '1' : '0');
        } catch {}
      },
    },
    h('summary', {}, h('b', {}, t('edAbout')), status),
    h('div', { class: 'ed-fold-body' }, aboutBlock(), languagesBlock(), HOSTED && !builtIn ? h('p', { class: `ed-media-size${mediaSize && !mediaSize.ok ? ' bad' : ''}` }, mediaSizeLine()) : null),
  );
}

// The quiz's description and cover picture (part of the quiz file, so exports carry them), under the name.
// The cover works like a question's picture: Choose a file, Find a free picture (with its credit), Remove.
function aboutBlock() {
  const box = h('div', { class: 'ed-about' });
  const setCover = (name) => {
    if (name) set.cover = name;
    else delete set.cover;
    changed();
    draw();
  };
  const draw = (status = '') => {
    const cover = set.cover;
    const credit = cover ? set.credits?.[cover] : null;
    redrawAboutStatus();
    const input = h('input', {
      type: 'file',
      accept: 'image/*',
      hidden: true,
      onchange: async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        draw(t('edUploading'));
        try {
          const up = await api.upload(file);
          if (up.kind !== 'image') throw new Error('wrong kind');
          setCover(up.name);
        } catch {
          draw(uploadFailedText());
        }
      },
    });
    fill(
      box,
      h(
        'label',
        { class: 'field ed-desc' },
        h('span', {}, t('edDescription')),
        h(
          'textarea',
          {
            name: 'description',
            rows: 3,
            maxlength: MAX_DESCRIPTION,
            disabled: builtIn,
            oninput: (e) => {
              set.description = e.target.value;
              changed();
              redrawAboutStatus();
            },
          },
          set.description ?? '',
        ),
        h('small', {}, t('edDescriptionHint', { max: MAX_DESCRIPTION })),
      ),
      h(
        'div',
        { class: 'ed-media ed-cover' },
        h('span', { class: 'ed-media-label' }, t('edCover')),
        h('small', {}, t('edCoverHint')),
        cover ? h('img', { src: api.fileUrl(cover), alt: '' }) : null,
        credit ? h('small', { class: 'ed-credit' }, creditNodes(credit)) : null,
        builtIn
          ? null
          : h(
              'span',
              { class: 'row' },
              h('label', { class: 'btn' }, t('edChooseFile'), input),
              !canSearch
                ? null
                : h(
                'button',
                {
                  class: 'btn ed-pic-search',
                  type: 'button',
                  onclick: () =>
                    openPictureDialog({
                      query: suggestQuery(set.title),
                      onPick: ({ name: picked, credit: found }) => {
                        set.credits = { ...(set.credits ?? {}), [picked]: found };
                        setCover(picked);
                      },
                    }),
                },
                t('picSearch'),
              ),
              cover ? h('button', { class: 'btn btn-quiet', type: 'button', onclick: () => setCover(null) }, t('edRemove')) : null,
            ),
        status ? h('p', { class: `ed-media-status${status === uploadFailedText() ? ' bad' : ''}` }, status) : null,
      ),
    );
  };
  draw();
  return box;
}

// ----- extra languages (lib/languages.js): the main language, the added ones, and their translations -----

const flagImg = (code, cls = 'flag') => h('img', { class: cls, src: flagUrl(code), alt: '', 'aria-hidden': 'true' });
// The quiz's main language for the select: what the file says, else a guess from its text, else the editor's language.
const guessedMain = () => (set.lang ? mainLang(set) : (guessLanguage(set) ?? getLang()));
let redrawLanguages = () => {};

// Under the description: the main language, a chip per added language (its flag, the name, how many texts are still
// missing, Translations and ×), and Add a language. Phones can then read the questions in one of these.
function languagesBlock() {
  const box = h('div', { class: 'ed-languages' });
  const draw = () => {
    const main = guessedMain();
    const langs = languagesOf(set);
    redrawAboutStatus();
    const chip = (code) => {
      const missing = missingTranslations(set, code).length;
      return h(
        'span',
        { class: `lang-chip${missing ? ' missing' : ''}`, 'data-lang': code },
        flagImg(code),
        h('b', { lang: code }, languageName(code)),
        h('small', {}, missing ? t('edLangMissing', { n: missing }) : t('edLangComplete')),
        h('button', { class: 'btn btn-small lang-translate', type: 'button', onclick: () => openTranslationsDialog(code) }, t('edTranslations')),
        builtIn
          ? null
          : h(
              'button',
              {
                class: 'ed-x lang-remove',
                type: 'button',
                title: t('edRemoveLanguage', { lang: languageName(code) }),
                'aria-label': t('edRemoveLanguage', { lang: languageName(code) }),
                onclick: async () => {
                  const ok = await ask({ title: t('dlgRemoveLanguageTitle'), text: t('edConfirmRemoveLanguage', { lang: languageName(code), n: translationSlots(set).length - missing }), ok: t('dlgRemove'), danger: true });
                  if (!ok) return;
                  removeLanguage(set, code);
                  changed();
                  draw();
                },
              },
              '×',
            ),
      );
    };
    fill(
      box,
      h('span', { class: 'ed-media-label' }, t('edLanguages')),
      h('small', {}, t('edLanguagesHint')),
      h(
        'div',
        { class: 'row ed-lang-row' },
        h(
          'label',
          { class: 'field ed-main-lang' },
          h('span', {}, t('edMainLanguage')),
          h(
            'select',
            {
              name: 'mainLang',
              disabled: builtIn,
              onchange: (e) => {
                set.lang = e.target.value;
                changed();
                draw();
              },
            },
            LANGUAGES.filter((l) => !langs.includes(l.code)).map((l) => h('option', { value: l.code, selected: l.code === main, lang: l.code }, l.name)),
          ),
        ),
        h('div', { class: 'lang-chips' }, langs.map(chip), builtIn ? null : h('button', { class: 'btn btn-small ed-add-language', type: 'button', onclick: () => openLanguagePicker(main, langs, draw) }, `+ ${t('edAddLanguage')}`)),
      ),
    );
  };
  redrawLanguages = draw;
  draw();
  return box;
}

// "Add a language": a pop-up with a flag button per language not yet in the quiz.
function openLanguagePicker(main, langs, done) {
  const choices = LANGUAGES.filter((l) => l.code !== main && !langs.includes(l.code));
  const dialog = h('dialog', { class: 'pq-modal ed-lang-modal', 'aria-labelledby': 'ed-lang-title' });
  const form = h(
    'form',
    { method: 'dialog', novalidate: true },
    h('h2', { id: 'ed-lang-title' }, t('edAddLanguage')),
    h('p', { class: 'pq-modal-text' }, t('edAddLanguageHint')),
    h(
      'div',
      { class: 'ed-lang-grid' },
      choices.map((l) => h('button', { class: 'ed-lang-pick', type: 'button', value: l.code, lang: l.code, onclick: () => dialog.close(l.code) }, flagImg(l.code), h('span', {}, l.name))),
    ),
    h('div', { class: 'pq-modal-actions' }, h('button', { class: 'btn', type: 'button', onclick: () => dialog.close('cancel') }, t('dlgCancel'))),
  );
  dialog.append(form);
  const before = document.activeElement;
  dialog.addEventListener('close', () => {
    dialog.remove();
    if (before?.isConnected && typeof before.focus === 'function') before.focus({ preventScroll: true });
    const code = dialog.returnValue;
    if (!choices.some((l) => l.code === code)) return;
    set.lang = main; // the main language is now part of the file too
    set.languages = [...languagesOf(set), code];
    changed();
    done();
    openTranslationsDialog(code);
  });
  document.body.append(dialog);
  dialog.returnValue = '';
  dialog.showModal();
  form.querySelector('.ed-lang-pick')?.focus();
}

// Where a text is, for the translations table: "Capitals · 300", "Warm-up, question 2", "Final question".
function slotLabel(slot) {
  if (slot.final) return t('edFinal');
  if (slot.c === undefined) return '';
  const cats = catsOf(slot.r ?? 1);
  const cat = cats[slot.c];
  const name = cat?.name?.trim() || t(quick() ? 'edSection' : 'edCategory', { n: slot.c + 1 });
  if (slot.i === undefined) return slot.r === 2 ? `${t('edRound2')}: ${name}` : name;
  const where = quick() ? t('edWhereQuick', { cat: name, n: slot.i + 1 }) : `${name} · ${pts(cat?.questions[slot.i]?.value ?? '')}`;
  return slot.r === 2 ? `${t('edRound2')}: ${where}` : where;
}

// The translations into one language: every text of the quiz on the left (read-only), its translation on the right,
// with "Show only missing" and the count. Typing saves (autosave). Translate with AI fills the empty ones from a pasted reply.
function openTranslationsDialog(code) {
  const dialog = $('#tr-dialog');
  const form = $('#tr-form');
  let onlyMissing = false;
  const count = h('span', { class: 'tr-count', role: 'status' });
  const list = h('div', { class: 'tr-list' });
  const drawCount = () => {
    const slots = translationSlots(set);
    const missing = slots.filter((slot) => !slotTranslation(slot, code)).length;
    count.textContent = missing ? t('edLangMissingOf', { n: missing, total: slots.length }) : t('edLangAllDone', { total: slots.length });
    count.classList.toggle('good', !missing);
    redrawLanguages();
  };
  const drawList = () => {
    const slots = translationSlots(set);
    let lastWhere = null;
    const rows = [];
    for (const slot of slots) {
      const value = slotTranslation(slot, code);
      if (onlyMissing && value) continue;
      const where = slot.kind === 'title' || slot.kind === 'description' ? t('edQuizName') : slotLabel(slot);
      if (where !== lastWhere) {
        rows.push(h('h3', { class: 'tr-where' }, where));
        lastWhere = where;
      }
      const kind = slot.kind === 'option' ? t('trKind-option', { n: slot.k + 1 }) : t(`trKind-${slot.kind}`);
      const input = h('textarea', {
        rows: 1,
        dir: 'auto',
        lang: code,
        'data-id': slot.id,
        'aria-label': `${kind}: ${slot.text}`,
        disabled: builtIn,
        placeholder: t('edTranslationPlaceholder', { lang: languageName(code) }),
        oninput: (e) => {
          setSlotTranslation(slot, code, e.target.value);
          e.target.closest('.tr-row').classList.toggle('missing', !e.target.value.trim());
          changed();
          drawCount();
        },
      });
      input.value = value;
      rows.push(
        h(
          'div',
          { class: `tr-row${value ? '' : ' missing'}`, 'data-id': slot.id },
          h('div', { class: 'tr-main' }, h('small', { class: 'tr-kind' }, kind), h('span', { dir: 'auto' }, slot.text)),
          h('div', { class: 'tr-input' }, input),
        ),
      );
    }
    fill(list, rows.length ? rows : h('p', { class: 'muted' }, t(onlyMissing ? 'edLangNothingMissing' : 'edLangNothingToTranslate')));
  };
  fill(
    form,
    dialogHead(dialog, flagImg(code, 'flag big'), ' ', t('edTranslationsTitle', { lang: languageName(code) })),
    h('p', { class: 'muted' }, t('edTranslationsIntro', { main: languageName(mainLang(set, guessedMain())), lang: languageName(code) })),
    h(
      'div',
      { class: 'row tr-tools' },
      count,
      h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'onlyMissing', onchange: (e) => ((onlyMissing = e.target.checked), drawList()) }), h('span', {}, t('edShowOnlyMissing'))),
      builtIn ? null : h('button', { class: 'btn ai-translate-open', type: 'button', onclick: () => openTranslateAiDialog(code, () => (drawList(), drawCount())) }, `✨ ${t('aiTranslateButton')}`),
    ),
    list,
    h('div', { class: 'ed-dialog-actions' }, h('button', { class: 'btn btn-primary', value: 'done' }, t('edDone'))),
  );
  drawCount();
  drawList();
  dialog.onclose = () => saveNow();
  dialog.showModal();
}

// Translate with AI: like Fill empty spots, by copy and paste. The request lists only the texts still missing, each
// with its id; the pasted reply fills only those (never a text that is already translated).
function openTranslateAiDialog(code, done) {
  const dialog = $('#ai-dialog');
  const form = $('#ai-form');
  const missing = missingTranslations(set, code).length;
  const request = h('textarea', { id: 'ai-request', class: 'ai-request', readonly: true, rows: 8 });
  const copied = h('span', { class: 'ed-status', role: 'status' });
  const reply = h('textarea', { id: 'ai-reply', rows: 6, placeholder: t('aiReplyPlaceholder'), oninput: () => (error.textContent = '') });
  const error = h('p', { id: 'ai-error', class: 'ed-media-status bad', role: 'alert' });
  async function copy() {
    try {
      await navigator.clipboard.writeText(request.value);
    } catch {
      request.select();
      document.execCommand('copy');
    }
    copied.textContent = t('aiCopied');
    setTimeout(() => (copied.textContent = ''), 2000);
  }
  function fillTranslations() {
    error.textContent = '';
    let made;
    try {
      made = parseTranslation(reply.value, set, code);
    } catch (err) {
      if (!(err instanceof AiQuizError)) throw err;
      error.textContent = t(`ai-${err.code}`);
      return;
    }
    set = made.set;
    reply.value = '';
    dialog.close();
    changed();
    done(made);
  }
  fill(
    form,
    dialogHead(dialog, t('aiTranslateTitle', { lang: languageName(code) })),
    h('p', { class: 'muted' }, t('aiTranslateIntro', { n: missing })),
    ...(missing
      ? [
          h('h3', {}, t('aiStep2')),
          request,
          h('div', { class: 'row' }, h('button', { class: 'btn btn-primary ai-copy', type: 'button', onclick: copy }, t('aiCopy')), copied),
          h('h3', {}, t('aiStep3')),
          reply,
          h('p', { class: 'ai-warn' }, t('aiTranslateWarn')),
          error,
          h('div', { class: 'ed-dialog-actions' }, h('button', { class: 'btn btn-quiet', value: 'cancel' }, t('aiCancel')), h('button', { class: 'btn btn-primary ai-translate-go', type: 'button', onclick: fillTranslations }, t('aiTranslateGo'))),
        ]
      : [h('div', { class: 'ed-dialog-actions' }, h('button', { class: 'btn btn-primary', value: 'cancel' }, t('aiDismiss')))]),
  );
  if (missing) request.value = buildTranslateRequest(set, code);
  dialog.showModal();
}

// The categories of a board: r = 1 is the main board, r = 2 the round 2 board.
// A Quick quiz's sections take the place of the categories (problems use `c` for the section, `i` for the question).
const catsOf = (r) => (quick() ? (r === 2 ? [] : set.sections) : r === 2 ? (set.round2?.categories ?? []) : set.categories);
const tileKey = (c, i, r = 1) => (r === 2 ? `2:${c}-${i}` : `${c}-${i}`); // for the AI-filled marks

// A question nobody has started on yet: not shown in red, just counted.
const isBlank = (q) =>
  !q.question?.trim() && !q.answer?.trim() && !(q.options ?? []).some((o) => String(o ?? '').trim()) && !q.image && !q.answerImage && !q.audio;
const blankCategory = (cat) => !cat?.name?.trim() && (cat?.questions ?? []).every(isBlank);
const blankProblem = (p) => {
  const cats = catsOf(p.r ?? 1);
  return p.i !== undefined ? isBlank(cats[p.c]?.questions[p.i] ?? {}) : /^no-(category|section)-name$/.test(p.code) && blankCategory(cats[p.c]);
};
const hasProblem = (c, i, r = 1) =>
  problems.some((p) => (p.r ?? 1) === r && p.c === c && (i === undefined ? p.i === undefined : p.i === i) && !blankProblem(p));

function snippet(q) {
  const icons = `${q.image || q.answerImage ? '🖼 ' : ''}${q.audio ? '♪ ' : ''}`;
  const text = q.question?.trim() || (q.image || q.audio ? '' : t('edEmptyTile'));
  return `${icons}${text}`.trim();
}

function renderBoard() {
  if (quick()) return renderSections();
  fill($('#ed-board'), ...boardParts(1));
  renderRound2();
  renderFinal();
}

// One board (r = 1 the main board, r = 2 round 2): the tiles, and the tools to change its size.
function boardParts(r) {
  const cats = catsOf(r);
  const rows = Math.max(0, ...cats.map((c) => c.questions.length));
  const board = h(
    'div',
    { class: 'ed-board', style: `--cols: ${cats.length}` },
    cats.map((cat, c) =>
      h(
        'div',
        { class: 'ed-col' },
        h(
          'div',
          { class: `ed-cat${hasProblem(c, undefined, r) ? ' bad' : ''}`, 'data-c': c, 'data-r': r },
          h('input', {
            type: 'text',
            value: cat.name,
            maxlength: 40,
            placeholder: t('edCategory', { n: c + 1 }),
            'aria-label': t('edCategoryName'),
            disabled: builtIn,
            oninput: (e) => {
              cat.name = e.target.value;
              changed();
            },
          }),
          builtIn || cats.length <= 1
            ? null
            : h(
                'button',
                {
                  class: 'ed-x',
                  type: 'button',
                  title: t('edRemoveCategory'),
                  'aria-label': t('edRemoveCategory'),
                  onclick: async () => {
                    const text = t('edConfirmRemoveCategory', { name: cat.name || t('edCategory', { n: c + 1 }) });
                    if (!(await ask({ title: t('dlgRemoveCategoryTitle'), text, ok: t('dlgRemove'), danger: true }))) return;
                    cats.splice(c, 1);
                    changed({ board: true });
                  },
                },
                '×',
              ),
        ),
        cat.questions.map((q, i) =>
          h(
            'button',
            {
              class: `ed-tile${hasProblem(c, i, r) ? ' bad' : ''}${q.question || q.image || q.audio ? '' : ' blank'}${aiNote?.id === currentId && aiNote.filled?.has(tileKey(c, i, r)) ? ' ai-filled' : ''}`,
              type: 'button',
              'data-c': c,
              'data-i': i,
              'data-r': r,
              onclick: () => openQuestion(c, i, r),
            },
            h('b', {}, q.value ? pts(q.value) : '?'),
            h('span', {}, snippet(q)),
            KINDS.includes(q.special) ? h('span', { class: `ed-special k-${q.special}`, title: t(`n-${q.special}`) }, ICONS[q.special]) : null,
          ),
        ),
      ),
    ),
  );
  const tools = builtIn
    ? null
    : h(
        'div',
        { class: 'row ed-tools' },
        h(
          'button',
          {
            class: 'btn',
            type: 'button',
            disabled: cats.length >= MAX_CATEGORIES,
            onclick: () => {
              const values = cats[0]?.questions.map((q) => q.value) ?? [100, 200, 300, 400, 500].map((v) => v * r);
              cats.push({ name: '', questions: values.map(blankQuestion) });
              changed({ board: true });
            },
          },
          t('edAddCategory'),
        ),
        h(
          'button',
          {
            class: 'btn',
            type: 'button',
            disabled: rows >= MAX_QUESTIONS,
            onclick: () => {
              for (const cat of cats) {
                const last = cat.questions.at(-1)?.value ?? 0;
                cat.questions.push(blankQuestion(last + 100 * r));
              }
              changed({ board: true });
            },
          },
          t('edAddRow'),
        ),
        h(
          'button',
          {
            class: 'btn',
            type: 'button',
            disabled: rows <= 1,
            onclick: async () => {
              if (!(await ask({ title: t('dlgRemoveRowTitle'), text: t('edConfirmRemoveRow'), ok: t('dlgRemove'), danger: true }))) return;
              for (const cat of cats) if (cat.questions.length > 1) cat.questions.pop();
              changed({ board: true });
            },
          },
          t('edRemoveRow'),
        ),
        r === 1 ? h('button', { class: 'btn ai-fill-open', type: 'button', onclick: openFillDialog }, `✨ ${t('aiFillButton')}`) : null,
      );
  return [board, tools ?? ''];
}

// Round 2: an optional second board, the same size as the first, with double points to start with.
function renderRound2() {
  const on = Boolean(set.round2);
  fill(
    $('#ed-round2'),
    h('h2', {}, t('edRound2')),
    h(
      'label',
      { class: 'check' },
      h('input', {
        type: 'checkbox',
        name: 'hasRound2',
        checked: on,
        disabled: builtIn,
        onchange: (e) => {
          if (e.target.checked) {
            set.round2 = {
              categories: set.categories.map((cat) => ({ name: '', questions: cat.questions.map((q) => blankQuestion((q.value || 0) * 2)) })),
            };
          } else {
            const started = set.round2.categories.some((cat) => !blankCategory(cat));
            if (started) {
              // Stays ticked while the question is open, and only goes when the host says Remove.
              e.target.checked = true;
              const quiz = set;
              ask({ title: t('dlgRemoveRound2Title'), text: t('edConfirmRemoveRound2'), ok: t('dlgRemove'), danger: true }).then((ok) => {
                if (!ok || set !== quiz) return;
                delete set.round2;
                changed({ board: true });
              });
              return;
            }
            delete set.round2;
          }
          changed({ board: true });
        },
      }),
      h('span', {}, t('edHasRound2')),
    ),
    on ? h('small', { class: 'muted' }, t('edRound2Hint')) : null,
    ...(on ? boardParts(2) : []),
  );
}

function renderFinal() {
  const f = set.final;
  const finalProblem = problems.some((p) => !p.r && p.c === undefined && /final|bad-/.test(p.code));
  fill($('#ed-final'), 
    h('h2', {}, t('edFinal')),
    h(
      'label',
      { class: 'check' },
      h('input', {
        type: 'checkbox',
        checked: Boolean(f),
        disabled: builtIn,
        onchange: (e) => {
          if (e.target.checked) set.final = set.final ?? { category: '', question: '', answer: '' };
          else delete set.final;
          changed({ board: true });
        },
      }),
      h('span', {}, t('edHasFinal')),
    ),
    f
      ? h(
          'button',
          { class: `ed-tile ed-final-tile${finalProblem ? ' bad' : ''}`, type: 'button', onclick: () => openQuestion(null) },
          h('b', {}, f.category || t('edFinalCategory')),
          h('span', {}, snippet(f)),
        )
      : null,
  );
}

// ----- a Quick quiz: sections of multiple-choice questions -----

// Moves an item of a list one place up (-1) or down (+1).
function move(list, n, by) {
  const to = n + by;
  if (to < 0 || to >= list.length) return;
  list.splice(to, 0, ...list.splice(n, 1));
  changed({ board: true });
}

// The small ▲ ▼ × buttons next to a section or a question.
function orderButtons(list, n, removeLabel, remove) {
  if (builtIn) return null;
  const mini = (label, text, onclick, disabled, extra = '') =>
    h('button', { class: `ed-mini${extra}`, type: 'button', title: label, 'aria-label': label, disabled, onclick }, text);
  return h(
    'div',
    { class: 'ed-order' },
    mini(t('edMoveUp'), '▲', () => move(list, n, -1), n === 0, ' ed-up'),
    mini(t('edMoveDown'), '▼', () => move(list, n, 1), n === list.length - 1, ' ed-down'),
    mini(removeLabel, '×', remove, list.length <= 1, ' ed-del'),
  );
}

// One question's line in its section: number, text, the right answer with its shape (a "put in order" question
// shows its answers numbered, in the right order), the kind, the time and the points.
function questionRow(sec, c, q, i) {
  const type = typeOf(q);
  const chip = (n, num = null) => h('span', { class: 'ed-qright', style: optionStyle(OPTION_COLORS[n]) }, num ? h('b', { class: 'ed-qnum-small' }, `${num}.`) : null, shapeSvg(SHAPES[n]), h('span', {}, q.options[n]));
  const filled = (q.options ?? []).map((o, n) => n).filter((n) => q.options[n]?.trim());
  const rights = type === 'order' ? filled : rightSet(q).filter((n) => filled.includes(n));
  const blank = isBlank(q);
  const meta = [
    type === 'multi' ? h('span', { class: 'ed-qbadge kind' }, t('edMultiBadge')) : type === 'order' ? h('span', { class: 'ed-qbadge kind' }, t('edOrderBadge')) : null,
    ...(rights.length
      ? rights.map((n, k) => chip(n, type === 'order' ? k + 1 : null))
      : blank || type === 'order'
        ? [null]
        : [h('span', { class: 'ed-qright none' }, t('edNoRight'))]),
    h('span', { class: 'ed-qbadge secs', 'data-own': q.seconds != null }, t('quickSecs', { s: q.seconds ?? sec.seconds ?? DEFAULT_SECONDS })),
    q.points === 2000 ? h('span', { class: 'ed-qbadge double' }, `×2 ${t('quickDouble')}`) : null,
    q.points === 0 ? h('span', { class: 'ed-qbadge none' }, t('edPointsNone')) : null,
  ];
  return h(
    'li',
    { class: 'ed-qitem' },
    h(
      'button',
      {
        class: `ed-qrow${hasProblem(c, i) ? ' bad' : ''}${blank ? ' blank' : ''}${aiNote?.id === currentId && aiNote.filled?.has(tileKey(c, i)) ? ' ai-filled' : ''}`,
        type: 'button',
        'data-c': c,
        'data-i': i,
        onclick: () => openQuestion(c, i),
      },
      h('b', { class: 'ed-qnum' }, String(i + 1)),
      h('span', { class: 'ed-qtext' }, snippet(q)),
      h('span', { class: 'ed-qmeta' }, meta),
    ),
    orderButtons(sec.questions, i, t('edRemoveQuestion'), async () => {
      if (!isBlank(q) && !(await ask({ title: t('dlgRemoveQuestionTitle'), text: t('edConfirmRemoveQuestion', { n: i + 1 }), ok: t('dlgRemove'), danger: true }))) return;
      sec.questions.splice(i, 1);
      changed({ board: true });
    }),
  );
}

function sectionCard(sec, c) {
  const secs = set.sections;
  const name = sec.name?.trim() || t('edSection', { n: c + 1 });
  return h(
    'section',
    { class: 'ed-sec' },
    h(
      'div',
      { class: `ed-sec-head${hasProblem(c) ? ' bad' : ''}`, 'data-c': c },
      h('span', { class: 'ed-sec-num' }, t('edSection', { n: c + 1 })),
      h(
        'label',
        { class: 'field ed-sec-name' },
        h('span', {}, t('edSectionName')),
        h('input', {
          type: 'text',
          name: 'sectionName',
          value: sec.name ?? '',
          maxlength: 40,
          placeholder: t('edSection', { n: c + 1 }),
          disabled: builtIn,
          oninput: (e) => {
            sec.name = e.target.value;
            changed();
          },
        }),
      ),
      h(
        'label',
        { class: 'field ed-sec-secs' },
        h('span', {}, t('edSectionSeconds')),
        h('input', {
          type: 'number',
          name: 'sectionSeconds',
          min: MIN_SECONDS,
          max: MAX_SECONDS,
          step: 1,
          value: sec.seconds ?? '',
          placeholder: String(DEFAULT_SECONDS),
          disabled: builtIn,
          oninput: (e) => {
            const v = e.target.value.trim();
            if (v === '') delete sec.seconds;
            else sec.seconds = Math.round(Number(v));
            changed();
            // The questions without their own time show the new one (no redraw, so the cursor stays here).
            const secs = t('quickSecs', { s: Number.isInteger(sec.seconds) ? sec.seconds : DEFAULT_SECONDS });
            for (const b of e.target.closest('.ed-sec').querySelectorAll('.ed-qbadge.secs:not([data-own])')) b.textContent = secs;
          },
        }),
      ),
      orderButtons(secs, c, t('edRemoveSection'), async () => {
        if (!blankCategory(sec) && !(await ask({ title: t('dlgRemoveSectionTitle'), text: t('edConfirmRemoveSection', { name }), ok: t('dlgRemove'), danger: true }))) return;
        secs.splice(c, 1);
        changed({ board: true });
      }),
    ),
    h('ol', { class: 'ed-qlist' }, sec.questions.map((q, i) => questionRow(sec, c, q, i))),
    builtIn
      ? null
      : h(
          'button',
          {
            class: 'btn btn-small ed-add-question',
            type: 'button',
            disabled: sec.questions.length >= MAX_SECTION_QUESTIONS,
            onclick: () => {
              sec.questions.push(blankQuickQuestion());
              changed({ board: true });
              openQuestion(c, sec.questions.length - 1);
            },
          },
          `+ ${t('edAddQuestion')}`,
        ),
  );
}

function renderSections() {
  const box = $('#ed-sections');
  if (!box) return;
  fill(
    box,
    h('div', { class: 'ed-sec-intro' }, h('h2', {}, t('edSections')), h('small', { class: 'muted' }, t('edSectionsHint'))),
    set.sections.map((sec, c) => sectionCard(sec, c)),
    builtIn
      ? null
      : h(
          'div',
          { class: 'row ed-tools' },
          h(
            'button',
            {
              class: 'btn ed-add-section',
              type: 'button',
              disabled: set.sections.length >= MAX_SECTIONS,
              onclick: () => {
                set.sections.push(blankSection(3));
                changed({ board: true });
              },
            },
            `+ ${t('edAddSection')}`,
          ),
          h('button', { class: 'btn ai-fill-open', type: 'button', onclick: openFillDialog }, `✨ ${t('aiFillButton')}`),
        ),
  );
}

// Update just the red marks (keeps the cursor where it is while typing a category name).
function markTiles() {
  for (const el of document.querySelectorAll('.ed-tile[data-c]')) el.classList.toggle('bad', hasProblem(Number(el.dataset.c), Number(el.dataset.i), Number(el.dataset.r)));
  for (const el of document.querySelectorAll('.ed-cat[data-c]')) el.classList.toggle('bad', hasProblem(Number(el.dataset.c), undefined, Number(el.dataset.r)));
  for (const el of document.querySelectorAll('.ed-qrow[data-c]')) el.classList.toggle('bad', hasProblem(Number(el.dataset.c), Number(el.dataset.i)));
  for (const el of document.querySelectorAll('.ed-sec-head[data-c]')) el.classList.toggle('bad', hasProblem(Number(el.dataset.c)));
  const ft = document.querySelector('.ed-final-tile');
  if (ft) ft.classList.toggle('bad', problems.some((p) => !p.r && p.c === undefined && /final|bad-/.test(p.code)));
}

function problemText(p) {
  if (quick()) {
    const cat = p.c !== undefined ? set.sections[p.c]?.name?.trim() || t('edSection', { n: p.c + 1 }) : '';
    return t(`p-${p.code}`, { cat, where: p.i !== undefined ? t('edWhereQuick', { cat, n: p.i + 1 }) : cat });
  }
  const cats = catsOf(p.r ?? 1);
  const cat = p.c !== undefined ? cats[p.c]?.name || t('edCategory', { n: p.c + 1 }) : t('edFinal');
  const where = p.i !== undefined ? `${cat} ${cats[p.c]?.questions[p.i]?.value ?? ''}`.trim() : cat;
  const text = t(`p-${p.code}`, { cat, where });
  return p.r === 2 ? `${t('edRound2')}: ${text}` : text;
}

function renderProblems() {
  renderCredits();
  const box = $('#ed-problems');
  if (!box) return;
  const blanks = [...catsOf(1), ...catsOf(2)].reduce((n, c) => n + c.questions.filter(isBlank).length, 0);
  const lines = [...problems.filter((p) => !blankProblem(p)).map(problemText), ...mediaProblems()];
  if (blanks) lines.unshift(t('edBlanks', { n: blanks }));
  fill(
    box,
    lines.length
      ? h('div', { class: 'ed-problems bad' }, h('p', {}, t('edFixList')), h('ul', {}, lines.map((line) => h('li', {}, line))))
      : h('p', { class: 'ed-problems good' }, t('edAllGood')),
  );
}

// ----- picture credits (pictures found with "Find a free picture") -----

// Credits only for pictures the quiz still uses (the server does the same when it saves).
function pruneCredits() {
  if (!set?.credits) return;
  const kept = cleanCredits(set.credits, usedFiles(set));
  if (Object.keys(kept).length) set.credits = kept;
  else delete set.credits;
}

const sourceName = (source) => t(source === 'deezer' ? 'songSourceDeezer' : source === 'wikimedia' ? 'picSourceWikimedia' : 'picSourceOpenverse');
const outLink = (href, text) => (href ? h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, text) : text);
const isSong = (c) => c?.source === 'deezer';

// "Picture: Ann · CC BY 2.0 · Openverse" (or "Song: Dancing Queen – ABBA · Deezer" for a song clip), with the source
// as a link to the picture's or song's own page.
function creditNodes(c) {
  const mark = '\u0000';
  const line = isSong(c)
    ? t('songCreditEditor', { title: c.title || '?', author: c.author || t('songUnknownArtist'), source: mark })
    : c.author
      ? t('picCreditLine', { author: c.author, license: licenseName(c.license), source: mark })
      : t('picCreditNoAuthor', { license: licenseName(c.license), source: mark });
  const [before, after] = line.split(mark);
  return [before, outLink(c.sourceUrl, sourceName(c.source)), after];
}

// The list under the quiz: every credited picture, so they can be given at the event (or in a program).
function renderCredits() {
  const box = $('#ed-credits');
  if (!box) return;
  const list = Object.entries(set.credits ?? {});
  const wasOpen = box.querySelector('details')?.open ?? false;
  fill(
    box,
    list.length
      ? h(
          'details',
          { class: 'ed-credits', open: wasOpen },
          h('summary', {}, t('edCredits', { n: list.length })),
          h('p', { class: 'muted' }, t('edCreditsHint')),
          h(
            'ul',
            {},
            list.map(([name, c]) =>
              h(
                'li',
                {},
                isSong(c) ? h('span', { class: 'ed-credit-note', 'aria-hidden': 'true' }, '♪') : h('img', { src: api.fileUrl(name), alt: '', loading: 'lazy' }),
                h('span', {}, c.title && !isSong(c) ? h('b', {}, c.title) : null, h('span', {}, creditNodes(c), c.licenseUrl ? [' · ', outLink(c.licenseUrl, t('picAboutLicense'))] : null)),
              ),
            ),
          ),
        )
      : null,
  );
}

// ----- editing one question -----

function openQuestion(c, i, r = 1) {
  const isFinal = c === null;
  const isQuick = quick();
  const cats = catsOf(r);
  const q = isFinal ? set.final : cats[c].questions[i];
  const dialog = $('#q-dialog');
  const form = $('#q-form');
  const upd = (key, value) => {
    if (value === '' || value === null || value === undefined) delete q[key];
    else q[key] = value;
    changed();
  };
  const field = (label, input, hint) => h('label', { class: 'field' }, h('span', {}, label), input, hint ? h('small', {}, hint) : null);
  const text = (key, { area = false, max = 300 } = {}) =>
    h(area ? 'textarea' : 'input', {
      ...(area ? { rows: 3, class: 'ed-q-text' } : { type: 'text', value: q[key] ?? '' }),
      name: key,
      maxlength: max,
      disabled: builtIn,
      oninput: (e) => {
        q[key] = e.target.value;
        changed();
      },
    });

  function mediaField(key, kind, label, hint) {
    const box = h('div', { class: 'ed-media' });
    const draw = (status = '') => {
      const name = q[key];
      const preview = name
        ? kind === 'image'
          ? h('img', { src: api.fileUrl(name), alt: '' })
          : h('audio', { src: api.fileUrl(name), controls: true, preload: 'metadata' })
        : null;
      const input = h('input', {
        type: 'file',
        accept: kind === 'image' ? 'image/*' : 'audio/*',
        hidden: true,
        onchange: async (e) => {
          const file = e.target.files[0];
          if (!file) return;
          draw(t('edUploading'));
          try {
            const up = await api.upload(file);
            if (up.kind !== kind) throw new Error('wrong kind');
            upd(key, up.name);
            draw();
          } catch {
            draw(uploadFailedText());
          }
        },
      });
      const credit = name ? set.credits?.[name] : null; // a found picture, or a song clip from "Find a song clip"
      fill(box, 
        h('span', { class: 'ed-media-label' }, label),
        hint ? h('small', {}, hint) : null,
        preview,
        credit ? h('small', { class: 'ed-credit' }, creditNodes(credit)) : null,
        builtIn
          ? null
          : h(
              'span',
              { class: 'row' },
              h('label', { class: 'btn' }, t('edChooseFile'), input),
              !canSearch
                ? null
                : kind === 'image'
                ? h(
                    'button',
                    {
                      class: 'btn ed-pic-search',
                      type: 'button',
                      onclick: () =>
                        openPictureDialog({
                          query: suggestQuery(key === 'answerImage' ? q.answer : q.question || q.answer),
                          onPick: ({ name: picked, credit: found }) => {
                            set.credits = { ...(set.credits ?? {}), [picked]: found };
                            upd(key, picked);
                            draw();
                          },
                        }),
                    },
                    t('picSearch'),
                  )
                : h(
                    'button',
                    {
                      class: 'btn ed-song-search',
                      type: 'button',
                      onclick: () =>
                        openSongDialog({
                          query: suggestQuery(q.answer || q.question),
                          onPick: ({ name: picked, credit: found }) => {
                            set.credits = { ...(set.credits ?? {}), [picked]: found };
                            delete q.audioStart; // the trim bar starts over for the new clip
                            delete q.audioLength;
                            upd(key, picked);
                            draw();
                          },
                        }),
                    },
                    t('songSearch'),
                  ),
              name
                ? h(
                    'button',
                    {
                      class: 'btn btn-quiet',
                      type: 'button',
                      onclick: () => {
                        upd(key, null);
                        if (key === 'audio') {
                          delete q.audioStart;
                          delete q.audioLength;
                        }
                        if (key === 'image') delete q.unveil;
                        draw();
                      },
                    },
                    t('edRemove'),
                  )
                : null,
            ),
        status ? h('p', { class: `ed-media-status${status === uploadFailedText() ? ' bad' : ''}` }, status) : null,
      );
      if (key === 'audio') drawTrim(preview);
      if (key === 'image') drawUnveil();
    };
    return { box, draw };
  }

  // The trim bar, only when there is a clip: the whole clip as a track with a handle at each end (drag the left one
  // for where the clip starts, the right one for where it stops), the chosen part highlighted, the times as m:ss,
  // and "Try it", which plays just that part with a moving playhead. The right handle at the very end means "to
  // the end" (no `audioLength`). `preview` is the clip's own <audio> element: its metadata gives the length.
  const startBox = h('div');
  function drawTrim(preview) {
    if (!q.audio || !preview) return fill(startBox);
    const bar = trimBar({
      audio: preview,
      get: () => ({ start: Number(q.audioStart) || 0, length: Number(q.audioLength) || null }),
      set: ({ start, length }) => {
        upd('audioStart', start > 0 ? start : null);
        upd('audioLength', length > 0 ? length : null);
      },
      disabled: builtIn,
    });
    fill(startBox, bar);
  }

  // "Show the picture slowly" only when there is a question picture: the seconds, and how it appears (Pixels: big
  // blocks that get smaller, or Blur: a heavy blur that sharpens). Not offered on the final question. In a Quick
  // quiz it runs while the answers are open, so a time longer than the question's seconds is cut to them (said here).
  const unveilBox = h('div');
  const quickSeconds = () => Number(q.seconds) || Number(set.sections?.[c]?.seconds) || DEFAULT_SECONDS;
  function drawUnveil() {
    if (isFinal || !q.image) return fill(unveilBox);
    const on = Number(q.unveil) > 0;
    const style = UNVEIL_STYLES.includes(q.unveilStyle) ? q.unveilStyle : 'pixels';
    const capped = isQuick && on && Number(q.unveil) > quickSeconds();
    fill(
      unveilBox,
      h(
        'label',
        { class: 'check' },
        h('input', {
          type: 'checkbox',
          name: 'unveil',
          checked: on,
          disabled: builtIn,
          onchange: (e) => {
            upd('unveil', e.target.checked ? Math.min(15, isQuick ? quickSeconds() : 15) : null);
            if (!e.target.checked) upd('unveilStyle', null);
            drawUnveil();
          },
        }),
        h('span', {}, t('edUnveil')),
      ),
      on
        ? h(
            'div',
            { class: 'ed-unveil' },
            field(
              t('edUnveilSeconds'),
              h('input', {
                type: 'number',
                name: 'unveilSeconds',
                min: 1,
                max: 120,
                step: 1,
                value: q.unveil,
                disabled: builtIn,
                oninput: (e) => {
                  const n = Math.round(Number(e.target.value));
                  if (Number.isFinite(n) && n >= 1) upd('unveil', Math.min(120, n));
                  drawUnveilNote();
                },
              }),
            ),
            h(
              'div',
              { class: 'field' },
              h('span', {}, t('edUnveilStyle')),
              h(
                'div',
                { class: 'pills ed-unveil-pills', role: 'radiogroup' },
                UNVEIL_STYLES.map((k) =>
                  h(
                    'label',
                    {},
                    h('input', {
                      type: 'radio',
                      name: 'unveilStyle',
                      value: k,
                      checked: k === style,
                      disabled: builtIn,
                      onchange: () => upd('unveilStyle', k === 'pixels' ? null : k), // pixels is the default, left out of the file
                    }),
                    h('span', {}, unveilIcon(k), t(k === 'blur' ? 'edUnveilBlur' : 'edUnveilPixels')),
                  ),
                ),
              ),
            ),
          )
        : null,
      on ? h('small', { class: 'ed-unveil-note' }, unveilNote(capped)) : null,
    );
  }
  const unveilNote = (capped) => (capped ? t('edUnveilCapped', { n: Number(q.unveil), s: quickSeconds() }) : t(isQuick ? 'edUnveilHintQuick' : 'edUnveilHint'));
  // Only the note under the control (the seconds field keeps its focus while typing).
  function drawUnveilNote() {
    const note = unveilBox.querySelector('.ed-unveil-note');
    if (note) note.textContent = unveilNote(isQuick && Number(q.unveil) > quickSeconds());
  }

  const picQ = mediaField('image', 'image', t('edPicQ'));
  const picA = isQuick ? null : mediaField('answerImage', 'image', t('edPicA'));
  const clip = mediaField('audio', 'audio', t('edClip'), isQuick ? t('edQuickClipHint') : t('edClipHint'));

  const question = text('question', { area: true });
  question.value = q.question ?? '';

  // The dialog: the title bar (with ×) and Done stay put; between them the words on the left and the media on the
  // right (one column in a narrow window). A board question's two pictures share a row, the clip spans both.
  const media = isQuick
    ? h('div', { class: 'ed-q-media' }, picQ.box, unveilBox, clip.box, startBox)
    : h('div', { class: 'ed-q-media board' }, picQ.box, picA.box, unveilBox, clip.box, startBox);
  unveilBox.className = 'ed-unveil-box ed-media-wide';
  clip.box.classList.add('ed-media-wide');
  startBox.className = 'ed-media-wide';
  let title;
  let main;
  if (isQuick) ({ title, fields: main } = quickFields(c, i, q, question, field, upd, drawUnveilNote));
  else {
    title = isFinal ? t('edFinal') : `${r === 2 ? `${t('edRound2')}: ` : ''}${cats[c].name || t('edCategory', { n: c + 1 })}`;
    main = [
      isFinal
        ? field(t('edFinalCategory'), text('category', { max: 40 }))
        : h(
            'div',
            { class: 'ed-q-row' },
            field(
              t('edPoints'),
              h('input', {
                type: 'number',
                name: 'points',
                min: 1,
                step: 1,
                value: q.value,
                disabled: builtIn,
                oninput: (e) => {
                  q.value = Math.round(Number(e.target.value)) || 0;
                  changed();
                },
              }),
            ),
            field(
              t('edSpecial'),
              h(
                'select',
                { name: 'special', disabled: builtIn, onchange: (e) => upd('special', e.target.value) },
                h('option', { value: '', selected: !q.special }, t('edSpecialNone')),
                KINDS.map((kind) => h('option', { value: kind, selected: q.special === kind }, `${ICONS[kind]}  ${t(`n-${kind}`)}`)),
              ),
              t('edSpecialHint'),
            ),
          ),
      field(t('edQuestion'), question),
      field(t('edAnswer'), text('answer', { max: 120 })),
    ];
  }
  fill(
    form,
    dialogHead(dialog, title),
    h('div', { class: 'ed-q-body' }, h('div', { class: 'ed-q-main' }, main), media),
    h('div', { class: 'ed-dialog-actions' }, h('button', { class: 'btn btn-primary', value: 'done' }, t('edDone'))),
  );
  picQ.draw();
  picA?.draw();
  clip.draw();
  dialog.onclose = () => {
    for (const a of form.querySelectorAll('audio')) a.pause();
    renderBoard();
    saveNow();
  };
  dialog.showModal();
  if (!builtIn) (isFinal ? form.querySelector('input') : question).focus();
}

// The Quick quiz part of the question dialog: the kind of question (pick one, tick all that are right, put in
// order), the question, 2 to 4 answers in their colours and shapes with one or more marked right (any of them
// counts for "pick one"; exactly these for "tick all"; a "put in order" question has no marks, its answers are
// written in the right order), the time and the points. Empty answers are left out (so 2 filled in = two
// choices), except the ones marked right, so the problem list can say it's empty. Answers after an empty one
// move up (with a note) once the host leaves the answers, so the dialog shows the colours and shapes the game
// will use; until then a note says it will happen (moving them while the host is still clicking there would be
// confusing).
// A small picture of each way a picture can appear: a few blocks, or a soft blurred shape.
// (An <i>, not a <span>: the pill's own styling is on `.pills span`.)
function unveilIcon(style) {
  const svg = (inner) => {
    const el = h('i', { class: 'ed-unveil-icon', 'aria-hidden': 'true' });
    el.innerHTML = `<svg viewBox="0 0 24 24" width="22" height="22">${inner}</svg>`;
    return el;
  };
  if (style === 'blur') return svg('<defs><filter id="ed-unveil-blur" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="2.2"/></filter></defs><circle cx="12" cy="12" r="6.5" fill="currentColor" filter="url(#ed-unveil-blur)"/>');
  const cells = [];
  for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) cells.push(`<rect x="${3 + x * 6}" y="${3 + y * 6}" width="6" height="6" fill="currentColor" opacity="${[0.35, 0.7, 1, 0.7, 1, 0.5, 1, 0.5, 0.35][y * 3 + x]}"/>`);
  return svg(cells.join(''));
}

// `onSeconds` is told when the seconds change (the slowly appearing picture's note depends on them).
function quickFields(c, i, q, question, field, upd, onSeconds = () => {}) {
  const sec = set.sections[c];
  const slots = SHAPES.map((_, n) => String(q.options?.[n] ?? ''));
  // The translated options (lib/languages.js), by slot like the options themselves, so they move with them.
  const trSlots = Object.fromEntries(Object.entries(q.translations ?? {}).map(([code, tr]) => [code, SHAPES.map((_, n) => String(tr?.options?.[n] ?? ''))]));
  let type = QUESTION_TYPES.includes(typeOf(q)) ? typeOf(q) : 'choice';
  let right = rightSet(q).filter((n) => n < slots.length); // the slots marked right (one or more; any of them counts)
  const sync = () => {
    const keep = kept();
    q.options = keep.map((n) => slots[n]);
    for (const [code, list] of Object.entries(trSlots)) {
      const options = keep.map((n) => list[n] ?? '');
      while (options.length && !options.at(-1).trim()) options.pop();
      if (options.length) q.translations[code].options = options;
      else delete q.translations[code].options;
    }
    if (type === 'choice') delete q.type;
    else q.type = type;
    const marks = type === 'order' ? [] : right.map((n) => keep.indexOf(n));
    if (!marks.length) delete q.correct;
    else q.correct = marks.length === 1 && type !== 'multi' ? marks[0] : marks; // one right answer is saved as a number, as before; "tick all" always a list
    changed();
  };
  const showMarks = () =>
    rows.forEach((row, n) => {
      row.querySelector('input[type=checkbox]').checked = right.includes(n);
      row.classList.toggle('right', type !== 'order' && right.includes(n));
    });
  // The kind decides what the answer rows show: Right ticks, or the places 1. 2. 3. 4. of an order.
  const hints = { choice: 'edOptionsHint', multi: 'edOptionsHintMulti', order: 'edOptionsHintOrder' };
  const hint = h('small', {}, t(hints[type]));
  const showKind = () => {
    hint.textContent = t(hints[type]);
    rows.forEach((row) => {
      row.querySelector('.ed-opt-right').hidden = type === 'order';
      row.querySelector('.ed-opt-n').hidden = type !== 'order';
    });
    opts.classList.toggle('ordered', type === 'order');
    showMarks();
  };
  const kindPills = h(
    'div',
    { class: 'pills ed-kind-pills', role: 'radiogroup' },
    QUESTION_TYPES.map((k) =>
      h(
        'label',
        {},
        h('input', {
          type: 'radio',
          name: 'type',
          value: k,
          checked: k === type,
          disabled: builtIn,
          onchange: () => {
            type = k;
            showKind();
            sync();
            gapNote();
          },
        }),
        h('span', {}, t(k === 'order' ? 'edStyleOrder' : k === 'multi' ? 'edStyleMulti' : 'edStyleChoice')),
      ),
    ),
  );
  const rows = SHAPES.map((shape, n) =>
    h(
      'div',
      { class: `ed-opt${type !== 'order' && right.includes(n) ? ' right' : ''}`, style: optionStyle(OPTION_COLORS[n]) },
      h('b', { class: 'ed-opt-n', hidden: type !== 'order' }, `${n + 1}.`),
      h('span', { class: 'ed-opt-shape' }, shapeSvg(shape)),
      h('input', {
        type: 'text',
        name: `option${n}`,
        value: slots[n],
        maxlength: MAX_OPTION,
        placeholder: n < 2 ? t('quickOption', { n: n + 1 }) : t('edOptionOptional', { n: n + 1 }),
        'aria-label': t('quickOption', { n: n + 1 }),
        disabled: builtIn,
        oninput: (e) => {
          slots[n] = e.target.value;
          sync();
          gapNote();
        },
      }),
      h(
        'label',
        { class: 'ed-opt-right', hidden: type === 'order' },
        h('input', {
          type: 'checkbox',
          name: 'correct',
          value: n,
          checked: right.includes(n),
          disabled: builtIn,
          onchange: (e) => {
            right = e.target.checked ? [...right, n].sort((a, b) => a - b) : right.filter((k) => k !== n);
            showMarks();
            sync();
            gapNote();
          },
        }),
        h('span', {}, t('edRightAnswer')),
      ),
    ),
  );
  // Close a gap (answers 1, 2 and 4 filled): 4 becomes 3, as in the game. The right marks move with their answers.
  const movedNote = h('small', { class: 'ed-opts-moved', role: 'status', hidden: true });
  const kept = () => slots.map((_, n) => n).filter((n) => slots[n].trim() !== '' || (type !== 'order' && right.includes(n)));
  const gapNote = () => {
    const keep = kept();
    const first = keep.find((n, k) => n !== k);
    movedNote.hidden = first === undefined;
    if (first !== undefined) movedNote.textContent = t('edOptionsGap', { from: first + 1, to: keep.indexOf(first) + 1 });
  };
  const moveUp = () => {
    const keep = kept();
    const gaps = keep.filter((n, k) => n !== k);
    if (!gaps.length) return;
    const texts = keep.map((n) => slots[n]);
    right = right.map((n) => keep.indexOf(n));
    slots.forEach((_, n) => (slots[n] = texts[n] ?? ''));
    for (const list of Object.values(trSlots)) {
      const moved = keep.map((n) => list[n]);
      list.forEach((_, n) => (list[n] = moved[n] ?? ''));
    }
    rows.forEach((row, n) => (row.querySelector('input[type=text]').value = slots[n]));
    showMarks();
    movedNote.textContent = t('edOptionsMoved', { from: gaps[0] + 1, to: keep.indexOf(gaps[0]) + 1 });
    movedNote.hidden = false;
    sync();
  };
  const fallback = sec.seconds ?? DEFAULT_SECONDS;
  const opts = h(
    'div',
    {
      class: `field ed-opts${type === 'order' ? ' ordered' : ''}`,
      // Leaving the answers (not just moving between them): close any gap.
      onfocusout: (e) => !e.currentTarget.contains(e.relatedTarget) && moveUp(),
    },
    h('span', {}, t('edOptions')),
    hint,
    rows,
    movedNote,
  );
  const title = `${sec.name?.trim() || t('edSection', { n: c + 1 })}: ${t('edQuestionN', { n: i + 1 })}`;
  const fields = [
    h('div', { class: 'field' }, h('span', {}, t('edStyle')), kindPills), // a div: a label around the pills' own labels would misfire
    field(t('edQuestion'), question),
    opts,
    h(
      'div',
      { class: 'ed-q-row ed-quick-row' },
      field(
        t('edSeconds'),
        h('input', {
          type: 'number',
          name: 'seconds',
          min: MIN_SECONDS,
          max: MAX_SECONDS,
          step: 1,
          value: q.seconds ?? '',
          placeholder: String(fallback),
          disabled: builtIn,
          oninput: (e) => {
            const v = e.target.value.trim();
            upd('seconds', v === '' ? null : Math.round(Number(v)));
            onSeconds();
          },
        }),
        t('edSecondsHint', { n: fallback }),
      ),
      field(
        t('edPoints'),
        h(
          'select',
          { name: 'points', disabled: builtIn, onchange: (e) => upd('points', e.target.value === '1000' ? null : Number(e.target.value)) },
          [
            [1000, t('edPointsNormal')],
            [2000, t('edPointsDouble')],
            [0, t('edPointsNone')],
          ].map(([value, label]) => h('option', { value, selected: (q.points ?? 1000) === value }, label)),
        ),
      ),
    ),
  ];
  return { title, fields };
}

// ----- "Find a free picture": search Openverse or Wikimedia Commons through ProQuiz's own server (pictures.js) -----
// The only part of ProQuiz that uses the internet, and only here in the editor. The chosen picture is copied into
// the files folder like an upload, so the game itself stays offline. Thumbnails load straight from the sources
// (without telling them which page asked: referrerpolicy no-referrer).

const PIC_SOURCE_KEY = 'proquiz.picSource';
const PIC_LICENSE_KEY = 'proquiz.picLicense';
const remembered = (key, allowed) => {
  try {
    const v = localStorage.getItem(key);
    return allowed.includes(v) ? v : allowed[0];
  } catch {
    return allowed[0];
  }
};
const remember = (key, value) => {
  try {
    localStorage.setItem(key, value);
  } catch {}
};

// ----- the clip's trim bar -----

const TRIM_STEP = 0.5; // seconds per arrow key
const TRIM_BIG_STEP = 5; // seconds per Page Up/Down
const TRIM_MIN = MIN_AUDIO_LENGTH;
const round1 = (n) => Math.round(n * 10) / 10;

// `audio` is the clip's <audio> element (the track is as long as it says), `get()` gives { start, length } (length
// null = to the end) and `set({ start, length })` stores a change. Returns the bar's element.
function trimBar({ audio, get, set, disabled = false }) {
  const range = h('div', { class: 'ed-trim-range' });
  const playhead = h('div', { class: 'ed-trim-playhead', hidden: true });
  const handle = (which) =>
    h('button', {
      class: `ed-trim-handle ${which}`,
      type: 'button',
      role: 'slider',
      'aria-label': t(which === 'start' ? 'edTrimStart' : 'edTrimEnd'),
      'aria-orientation': 'horizontal',
      disabled,
    });
  const left = handle('start');
  const right = handle('end');
  const track = h('div', { class: 'ed-trim-track' }, range, playhead, left, right);
  const times = h('span', { class: 'ed-trim-times' });
  const tryBtn = h('button', { class: 'btn ed-trim-try', type: 'button', disabled: true }, t('edTrimTry'));
  const box = h(
    'div',
    { class: 'ed-trim' },
    h('div', { class: 'ed-trim-head' }, h('span', { class: 'ed-media-label' }, t('edTrim')), times),
    track,
    h('div', { class: 'row ed-trim-foot' }, tryBtn, h('small', {}, t(disabled ? 'edTrimHintSample' : 'edTrimHint'))),
  );

  let duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0;
  let trying = false;
  let raf = 0;

  // Where the handles are, in seconds: the start, and the end (the clip's end when no length is set).
  const ends = () => {
    const { start, length } = get();
    const s = Math.min(Math.max(0, start), Math.max(0, duration - TRIM_MIN));
    const e = length ? Math.min(duration, Math.max(s + TRIM_MIN, s + length)) : duration;
    return { s, e, toEnd: !length || s + length >= duration - 0.05 };
  };
  const pct = (sec) => (duration ? (100 * sec) / duration : 0);

  function draw() {
    if (!duration) {
      times.textContent = t('edTrimLoading');
      box.classList.add('loading');
      return;
    }
    box.classList.remove('loading');
    const { s, e, toEnd } = ends();
    range.style.left = `${pct(s)}%`;
    range.style.width = `${pct(e) - pct(s)}%`;
    left.style.left = `${pct(s)}%`;
    right.style.left = `${pct(e)}%`;
    for (const [el, v] of [
      [left, s],
      [right, e],
    ]) {
      el.setAttribute('aria-valuemin', '0');
      el.setAttribute('aria-valuemax', String(round1(duration)));
      el.setAttribute('aria-valuenow', String(round1(v)));
      el.setAttribute('aria-valuetext', mss(v));
    }
    const whole = s === 0 && toEnd;
    times.textContent = whole ? t('edTrimWhole', { total: mss(duration) }) : t('edTrimTimes', { from: mss(s), to: mss(e), len: lengthText(e - s) });
    box.classList.toggle('trimmed', !whole);
    tryBtn.disabled = false;
  }

  function store(s, e) {
    s = round1(Math.min(Math.max(0, s), duration - TRIM_MIN));
    e = round1(Math.min(Math.max(s + TRIM_MIN, e), duration));
    const toEnd = e >= round1(duration) - 0.05;
    set({ start: s, length: toEnd ? null : round1(e - s) });
    draw();
  }

  // Dragging a handle with a finger or the mouse.
  function drag(el, which) {
    el.addEventListener('pointerdown', (ev) => {
      if (disabled || !duration) return;
      ev.preventDefault();
      el.setPointerCapture(ev.pointerId);
      el.focus();
      const move = (e) => {
        const r = track.getBoundingClientRect();
        const at = duration * Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
        const { s, e: end } = ends();
        if (which === 'start') store(Math.min(at, end - TRIM_MIN), end);
        else store(s, Math.max(at, s + TRIM_MIN));
      };
      const up = () => {
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        el.removeEventListener('pointercancel', up);
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
      move(ev);
    });
    // Arrow keys move half a second, Page Up/Down five, Home/End to the ends.
    el.addEventListener('keydown', (ev) => {
      if (disabled || !duration) return;
      const steps = { ArrowLeft: -TRIM_STEP, ArrowDown: -TRIM_STEP, ArrowRight: TRIM_STEP, ArrowUp: TRIM_STEP, PageDown: -TRIM_BIG_STEP, PageUp: TRIM_BIG_STEP };
      const { s, e } = ends();
      let next;
      if (ev.key in steps) next = (which === 'start' ? s : e) + steps[ev.key];
      else if (ev.key === 'Home') next = which === 'start' ? 0 : s + TRIM_MIN;
      else if (ev.key === 'End') next = which === 'start' ? e - TRIM_MIN : duration;
      else return;
      ev.preventDefault();
      if (which === 'start') store(Math.min(next, e - TRIM_MIN), e);
      else store(s, Math.max(next, s + TRIM_MIN));
    });
  }
  drag(left, 'start');
  drag(right, 'end');

  // "Try it": the chosen part only, with a playhead moving across the track. Pressed again, it stops.
  function stopTry() {
    trying = false;
    cancelAnimationFrame(raf);
    playhead.hidden = true;
    tryBtn.textContent = t('edTrimTry');
    box.classList.remove('trying');
    if (!audio.paused) audio.pause();
  }
  function tick() {
    if (!trying) return;
    const { e } = ends();
    playhead.style.left = `${pct(Math.min(audio.currentTime, e))}%`;
    if (audio.currentTime >= e - 0.02 || audio.paused || audio.ended) return stopTry();
    raf = requestAnimationFrame(tick);
  }
  tryBtn.addEventListener('click', () => {
    if (trying) return stopTry();
    const { s } = ends();
    trying = true;
    try {
      audio.currentTime = s;
    } catch {}
    playhead.style.left = `${pct(s)}%`;
    playhead.hidden = false;
    tryBtn.textContent = t('edTrimStop');
    box.classList.add('trying');
    audio.play().then(() => tick()).catch(stopTry);
  });
  audio.addEventListener('pause', () => trying && audio.currentTime < ends().e - 0.02 && stopTry());

  const ready = () => {
    duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0;
    draw();
  };
  if (!duration) audio.addEventListener('loadedmetadata', ready, { once: true });
  audio.addEventListener('durationchange', ready);
  draw();
  return box;
}

// A starting point for the search from the question's text: the first words, without the question mark.
function suggestQuery(text) {
  const s = String(text ?? '').replace(/[?¿!.:;«»"“”]/g, ' ').replace(/\s+/g, ' ').trim();
  if (s.length <= 60) return s;
  return s.slice(0, 60).replace(/\s+\S*$/, '');
}

const PIC_ERRORS = { 'no-internet': 'picErrOffline', 'rate-limited': 'picErrRate', 'picture-too-big': 'picErrTooBig', 'too-big-for-web': 'picErrTooBigWeb', 'picture-bad-type': 'picErrType', 'picture-missing': 'picErrMissing' };
const picError = (err) => t(navigator.onLine === false ? 'picErrOffline' : (PIC_ERRORS[err?.code] ?? 'picErrFailed'));

function openPictureDialog({ query = '', onPick }) {
  const dialog = $('#pic-dialog');
  const form = $('#pic-form');
  const st = {
    source: remembered(PIC_SOURCE_KEY, ['openverse', 'wikimedia']),
    license: remembered(PIC_LICENSE_KEY, ['any', 'nc']),
    words: '', // what the results are for
    results: [],
    page: 1,
    more: false,
    chosen: null,
    lastId: null,
    token: 0, // a newer search makes the answers of older ones useless
    scroll: 0,
  };

  const queryInput = h('input', {
    type: 'search',
    name: 'picQuery',
    maxlength: 200,
    autocomplete: 'off',
    placeholder: t('picQueryPlaceholder'),
    'aria-label': t('picQueryLabel'),
    onkeydown: (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault(); // the form is method=dialog: Enter would close it
      search();
    },
  });
  queryInput.value = query;
  const goBtn = h('button', { class: 'btn btn-primary pic-go', type: 'button', onclick: () => search() }, t('picGo'));
  const status = h('p', { class: 'pic-status', role: 'status', 'aria-live': 'polite' });
  const body = h('div', { class: 'pic-body' });
  const moreBtn = h('button', { class: 'btn pic-more', type: 'button', hidden: true, onclick: () => search({ more: true }) }, t('picMore'));
  const licenseBox = h('div', { class: 'pic-license' });

  // A choice of a few, as pills (like the lobby's settings). `hint` gives a pill a second, smaller line.
  const pills = (name, options, value, onPickPill) =>
    h(
      'div',
      { class: `pills pic-pills pic-${name}`, role: 'radiogroup' },
      options.map(([v, label, hint]) =>
        h(
          'label',
          {},
          h('input', { type: 'radio', name, value: v, checked: v === value, onchange: () => onPickPill(v) }),
          h('span', {}, hint ? [h('b', {}, label), h('small', {}, hint)] : label),
        ),
      ),
    );

  function drawLicense() {
    const label = h('span', { class: 'pic-row-label' }, t('picLicenseLabel'));
    if (st.source === 'wikimedia') return fill(licenseBox, label, h('p', { class: 'pic-wiki-note' }, h('span', { class: 'pic-badge free' }, '✓'), h('span', {}, t('picWikiNote'))));
    fill(
      licenseBox,
      label,
      pills(
        'picLicense',
        [
          ['any', t('picLicenseAny')],
          ['nc', t('picLicenseNc')],
        ],
        st.license,
        (v) => {
          st.license = v;
          remember(PIC_LICENSE_KEY, v);
          drawLicense();
          if (st.words) search();
        },
      ),
      h('small', { class: 'pic-license-hint' }, t(st.license === 'nc' ? 'picLicenseNcHint' : 'picLicenseAnyHint')),
    );
  }

  const say = (text, bad = false) => {
    status.textContent = text;
    status.classList.toggle('bad', bad);
    status.setAttribute('role', bad ? 'alert' : 'status');
  };

  async function search({ more = false } = {}) {
    const words = queryInput.value.replace(/\s+/g, ' ').trim();
    if (!words) return queryInput.focus();
    const token = ++st.token;
    st.chosen = null;
    if (!more) {
      st.words = words;
      st.results = [];
      st.page = 1;
      st.more = false;
      drawResults();
    }
    if (navigator.onLine === false) return say(t('picErrOffline'), true);
    say(t('picSearching'));
    moreBtn.disabled = true;
    goBtn.disabled = true;
    const page = more ? st.page + 1 : 1;
    try {
      const out = await api.searchPictures({ q: st.words, source: st.source, page: String(page), license: st.license, lang: getLang() });
      if (token !== st.token) return;
      const seen = new Set(st.results.map((r) => r.id));
      st.results.push(...out.results.filter((r) => !seen.has(r.id)));
      st.page = out.page;
      st.more = out.more;
      say(st.results.length ? '' : t('picNone'));
      drawResults();
    } catch (err) {
      if (token !== st.token) return;
      say(picError(err), true);
    } finally {
      if (token === st.token) {
        goBtn.disabled = false;
        moreBtn.disabled = false;
      }
    }
  }

  // The thumbnail of a result. Openverse's thumbnail service has its own daily limit: then the original is used.
  const thumb = (r, cls) =>
    h('img', {
      class: cls,
      referrerpolicy: 'no-referrer',
      loading: 'lazy',
      decoding: 'async',
      alt: r.title || '',
      src: r.thumb,
      onerror: (e) => {
        const im = e.currentTarget;
        if (r.fallback && im.src !== r.fallback) im.src = r.fallback;
        else im.classList.add('broken');
      },
    });
  const badge = (r) => h('span', { class: `pic-badge${r.nc ? ' nc' : ''}` }, licenseName(r.license));

  function drawResults() {
    moreBtn.hidden = !st.more;
    fill(
      body,
      st.results.length
        ? h(
            'div',
            { class: 'pic-grid' },
            st.results.map((r) =>
              h(
                'button',
                { class: 'pic-tile', type: 'button', 'data-id': r.id, title: r.title || '', onclick: () => choose(r) },
                h('span', { class: 'pic-thumb' }, thumb(r), badge(r)),
                h('span', { class: 'pic-cap' }, r.author || t('picUnknownAuthor')),
              ),
            ),
          )
        : null,
    );
  }

  function choose(r) {
    st.chosen = r;
    st.lastId = r.id;
    st.scroll = form.scrollTop;
    moreBtn.hidden = true;
    say('');
    const useStatus = h('p', { class: 'pic-use-status', role: 'alert' });
    const useBtn = h('button', { class: 'btn btn-primary pic-use', type: 'button' }, t('picUse'));
    const backBtn = h('button', { class: 'btn pic-back', type: 'button', onclick: back }, t('picBack'));
    useBtn.addEventListener('click', async () => {
      useBtn.disabled = true;
      backBtn.disabled = true;
      useStatus.classList.remove('bad');
      useStatus.textContent = t('picAdding');
      try {
        const got = await api.fetchPicture({ source: r.source, id: r.id });
        dialog.close();
        onPick(got);
      } catch (err) {
        useStatus.classList.add('bad');
        useStatus.textContent = picError(err);
        useBtn.disabled = false;
        backBtn.disabled = false;
      }
    });
    const facts = [r.width && r.height ? t('picSize', { w: r.width, h: r.height }) : null, r.provider ? t('picVia', { provider: r.provider }) : null].filter(Boolean).join(' · ');
    fill(
      body,
      h(
        'div',
        { class: 'pic-preview' },
        h('div', { class: 'pic-preview-img' }, thumb(r)),
        h(
          'div',
          { class: 'pic-preview-info' },
          h('h3', {}, r.title || t('picTitle')),
          h('p', { class: 'pic-by' }, r.author ? t('picBy', { author: r.author }) : t('picUnknownAuthor')),
          h('p', { class: 'pic-license-line' }, badge(r), r.licenseUrl ? outLink(r.licenseUrl, t('picAboutLicense')) : null),
          r.nc ? h('p', { class: 'pic-nc-note' }, t('picNcNote')) : null,
          facts ? h('p', { class: 'muted' }, facts) : null,
          r.sourceUrl ? h('p', {}, outLink(r.sourceUrl, t('picOpenSource', { source: sourceName(r.source) }))) : null,
          h('div', { class: 'row pic-preview-actions' }, backBtn, useBtn),
          useStatus,
        ),
      ),
    );
    form.scrollTop = 0;
    useBtn.focus();
  }

  // Back to the same results, where they were (nothing is asked again).
  function back() {
    st.chosen = null;
    drawResults();
    form.scrollTop = st.scroll;
    body.querySelector(`.pic-tile[data-id="${CSS.escape(st.lastId ?? '')}"]`)?.focus({ preventScroll: true });
  }

  fill(
    form,
    dialogHead(dialog, t('picTitle')),
    h('p', { class: 'muted pic-intro' }, t('picIntro')),
    h(
      'div',
      { class: 'pic-controls' },
      h('span', { class: 'pic-row-label' }, t('picSourceLabel')),
      pills(
        'picSource',
        [
          ['openverse', t('picSourceOpenverse'), t('picSourceOpenverseHint')],
          ['wikimedia', t('picSourceWikimedia'), t('picSourceWikimediaHint')],
        ],
        st.source,
        (v) => {
          st.source = v;
          remember(PIC_SOURCE_KEY, v);
          drawLicense();
          if (st.words) search();
        },
      ),
      h('label', { class: 'pic-row-label', for: 'pic-query' }, t('picQueryLabel')),
      h('div', { class: 'pic-search' }, queryInput, goBtn),
      licenseBox,
      getLang() === 'no' ? h('p', { class: 'pic-tip' }, t('picEnglishTip')) : null,
    ),
    status,
    body,
    moreBtn,
    h('div', { class: 'ed-dialog-actions' }, h('button', { class: 'btn btn-quiet', value: 'cancel' }, t('aiCancel'))),
  );
  queryInput.id = 'pic-query';
  drawLicense();
  dialog.showModal();
  queryInput.focus();
  queryInput.select();
}

// ----- "Find a song clip" (Deezer's 30-second previews, songs.js) -----

const SONG_ERRORS = { 'no-internet': 'songErrOffline', 'rate-limited': 'songErrRate', 'song-too-big': 'songErrTooBig', 'song-bad-type': 'songErrType', 'song-missing': 'songErrMissing' };
const songError = (err) => t(navigator.onLine === false ? 'songErrOffline' : (SONG_ERRORS[err?.code] ?? 'songErrFailed'));

function openSongDialog({ query = '', onPick }) {
  const dialog = $('#song-dialog');
  const form = $('#song-form');
  const st = { words: '', results: [], page: 1, more: false, token: 0 };
  // One preview plays at a time, straight from Deezer (only while the dialog is open; nothing is kept).
  const player = new Audio();
  player.preload = 'none';
  let playing = null; // the result whose preview plays

  const queryInput = h('input', {
    type: 'search',
    name: 'songQuery',
    maxlength: 200,
    autocomplete: 'off',
    placeholder: t('songQueryPlaceholder'),
    'aria-label': t('songQueryLabel'),
    onkeydown: (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault(); // the form is method=dialog: Enter would close it
      search();
    },
  });
  queryInput.value = query;
  const goBtn = h('button', { class: 'btn btn-primary song-go', type: 'button', onclick: () => search() }, t('songGo'));
  const status = h('p', { class: 'pic-status song-status', role: 'status', 'aria-live': 'polite' });
  const body = h('div', { class: 'song-body' });
  const moreBtn = h('button', { class: 'btn song-more', type: 'button', hidden: true, onclick: () => search({ more: true }) }, t('songMore'));

  const say = (text, bad = false) => {
    status.textContent = text;
    status.classList.toggle('bad', bad);
    status.setAttribute('role', bad ? 'alert' : 'status');
  };

  function stopPreview() {
    playing = null;
    player.pause();
    for (const b of body.querySelectorAll('.song-play.on')) {
      b.classList.remove('on');
      b.setAttribute('aria-label', t('songPlay', { title: b.dataset.title }));
      b.textContent = '▶';
    }
  }
  function togglePreview(r, btn) {
    if (playing === r.id) return stopPreview();
    stopPreview();
    playing = r.id;
    btn.classList.add('on');
    btn.setAttribute('aria-label', t('songStop'));
    btn.textContent = '■';
    player.src = r.preview;
    player.currentTime = 0;
    player.play().catch(stopPreview);
  }
  player.addEventListener('ended', stopPreview);
  player.addEventListener('error', stopPreview);

  async function search({ more = false } = {}) {
    const words = queryInput.value.replace(/\s+/g, ' ').trim();
    if (!words) return queryInput.focus();
    const token = ++st.token;
    if (!more) {
      stopPreview();
      st.words = words;
      st.results = [];
      st.page = 1;
      st.more = false;
      drawResults();
    }
    if (navigator.onLine === false) return say(t('songErrOffline'), true);
    say(t('songSearching'));
    moreBtn.disabled = true;
    goBtn.disabled = true;
    const page = more ? st.page + 1 : 1;
    try {
      const out = await api.searchSongs({ q: st.words, page: String(page) });
      if (token !== st.token) return;
      const seen = new Set(st.results.map((r) => r.id));
      st.results.push(...out.results.filter((r) => !seen.has(r.id)));
      st.page = out.page;
      st.more = out.more;
      say(st.results.length ? '' : t('songNone'));
      drawResults();
    } catch (err) {
      if (token !== st.token) return;
      say(songError(err), true);
    } finally {
      if (token === st.token) {
        goBtn.disabled = false;
        moreBtn.disabled = false;
      }
    }
  }

  async function use(r, row, useBtn, useStatus) {
    stopPreview();
    useBtn.disabled = true;
    row.classList.add('busy');
    useStatus.classList.remove('bad');
    useStatus.textContent = t('songAdding');
    try {
      const got = await api.fetchSong({ id: r.id });
      dialog.close();
      onPick(got);
    } catch (err) {
      useStatus.classList.add('bad');
      useStatus.textContent = songError(err);
      useBtn.disabled = false;
      row.classList.remove('busy');
    }
  }

  function drawResults() {
    moreBtn.hidden = !st.more;
    fill(
      body,
      st.results.length
        ? h(
            'ul',
            { class: 'song-list' },
            st.results.map((r) => {
              const playBtn = h('button', { class: 'song-play', type: 'button', 'data-title': r.title, 'aria-label': t('songPlay', { title: r.title }), onclick: () => togglePreview(r, playBtn) }, '▶');
              const useBtn = h('button', { class: 'btn song-use', type: 'button' }, t('songUse'));
              const useStatus = h('span', { class: 'song-use-status', role: 'alert' });
              const row = h(
                'li',
                { class: 'song-row', 'data-id': String(r.id) },
                r.cover ? h('img', { class: 'song-cover', src: r.cover, referrerpolicy: 'no-referrer', loading: 'lazy', decoding: 'async', alt: '' }) : h('span', { class: 'song-cover song-cover-none', 'aria-hidden': 'true' }, '♪'),
                h(
                  'span',
                  { class: 'song-info' },
                  h('b', { class: 'song-title' }, r.title),
                  h('span', { class: 'song-artist' }, r.artist || t('songUnknownArtist'), r.album ? ` · ${r.album}` : ''),
                  h('span', { class: 'song-facts muted' }, r.duration ? `${mss(r.duration)} · ` : '', t('songPreviewLength')),
                  useStatus,
                ),
                playBtn,
                useBtn,
              );
              useBtn.addEventListener('click', () => use(r, row, useBtn, useStatus));
              return row;
            }),
          )
        : null,
    );
  }

  fill(
    form,
    dialogHead(dialog, t('songTitle')),
    h('p', { class: 'muted pic-intro song-intro' }, t('songIntro')),
    h('div', { class: 'pic-controls song-controls' }, h('label', { class: 'pic-row-label', for: 'song-query' }, t('songQueryLabel')), h('div', { class: 'pic-search' }, queryInput, goBtn)),
    status,
    body,
    moreBtn,
    h('div', { class: 'ed-dialog-actions' }, h('button', { class: 'btn btn-quiet', value: 'cancel' }, t('aiCancel'))),
  );
  queryInput.id = 'song-query';
  dialog.addEventListener('close', stopPreview, { once: true });
  dialog.showModal();
  queryInput.focus();
  queryInput.select();
}

// ----- making a quiz with AI (copy and paste, ProQuiz itself stays offline) -----

const aiOpts = { kind: 'board', topics: '', examples: '', difficulty: 'medium', categories: 5, rows: 5, final: true, round2: false, round2Topics: '', sections: 3, perSection: 5, lang: null };

function openAiDialog() {
  const dialog = $('#ai-dialog');
  const form = $('#ai-form');
  aiOpts.lang ??= getLang();
  const field = (label, input, hint) => h('label', { class: 'field' }, h('span', {}, label), input, hint ? h('small', {}, hint) : null);
  const choice = (name, options) =>
    h(
      'select',
      { name, onchange: (e) => update(name, typeof aiOpts[name] === 'number' ? Number(e.target.value) : e.target.value) },
      options.map(([value, label]) => h('option', { value, selected: String(aiOpts[name]) === String(value) }, label)),
    );
  const sizes = Array.from({ length: MAX_CATEGORIES - MIN_SIZE + 1 }, (_, n) => [n + MIN_SIZE, String(n + MIN_SIZE)]);
  const request = h('textarea', { id: 'ai-request', class: 'ai-request', readonly: true, rows: 8 });
  const tooMany = h('small', { class: 'ai-too-many' });
  const copied = h('span', { class: 'ed-status', role: 'status' });
  const reply = h('textarea', { id: 'ai-reply', rows: 6, placeholder: t('aiReplyPlaceholder'), oninput: () => (error.textContent = '') });
  const error = h('p', { id: 'ai-error', class: 'ed-media-status bad', role: 'alert' });
  // Round 2's own topics, only shown when round 2 is ticked.
  const round2Box = h('div', { hidden: !aiOpts.round2 || aiOpts.kind === 'quick' });
  const isQuickKind = () => aiOpts.kind === 'quick';
  const topicsHint = h('small', {});
  const makeBtn = h('button', { class: 'btn btn-primary ai-fill', type: 'button', onclick: fillBoard });

  // Only the request text and the hint change while typing, so the cursor stays where it is.
  function redraw() {
    request.value = buildRequest(aiOpts);
    const n = splitTopics(aiOpts.topics).length;
    const most = isQuickKind() ? aiOpts.sections : aiOpts.categories;
    tooMany.textContent = n > most ? t('aiTooManyTopics', { n: most }) : '';
    topicsHint.textContent = isQuickKind() ? (aiOpts.sections === 1 ? t('aiTopicsHintQuickOne') : t('aiTopicsHintQuick', { n: aiOpts.sections })) : t('aiTopicsHint', { n: aiOpts.categories });
    makeBtn.textContent = isQuickKind() ? t('aiMakeQuick') : t('aiFill');
  }
  // A board quiz or a Quick quiz: each has its own size settings.
  function setKind(kind) {
    aiOpts.kind = kind;
    boardPart.hidden = isQuickKind();
    quickPart.hidden = !isQuickKind();
    round2Box.hidden = isQuickKind() || !aiOpts.round2;
    redraw();
  }
  function update(key, value) {
    aiOpts[key] = value;
    redraw();
  }
  const text = (key, rows) => {
    const el = h('textarea', { name: key, rows, oninput: (e) => update(key, e.target.value) });
    el.value = aiOpts[key];
    return el;
  };

  async function copy() {
    try {
      await navigator.clipboard.writeText(request.value);
    } catch {
      request.select();
      document.execCommand('copy');
    }
    copied.textContent = t('aiCopied');
    setTimeout(() => (copied.textContent = ''), 2000);
  }

  // The size settings of each kind of quiz (display: contents, so they sit in the same row as the rest).
  const boardPart = h(
    'span',
    { class: 'ai-part', hidden: isQuickKind() },
    field(t('aiCategories'), choice('categories', sizes)),
    field(t('aiRows'), choice('rows', sizes)),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'final', checked: aiOpts.final, onchange: (e) => update('final', e.target.checked) }), h('span', {}, t('aiFinal'))),
    h(
      'label',
      { class: 'check' },
      h('input', {
        type: 'checkbox',
        name: 'round2',
        checked: aiOpts.round2,
        onchange: (e) => {
          update('round2', e.target.checked);
          round2Box.hidden = !e.target.checked;
        },
      }),
      h('span', {}, t('aiRound2')),
    ),
  );
  const quickPart = h(
    'span',
    { class: 'ai-part', hidden: !isQuickKind() },
    field(t('aiSections'), choice('sections', QUICK_SECTIONS.map((n) => [n, String(n)]))),
    field(t('aiPerSection'), choice('perSection', QUICK_PER_SECTION.map((n) => [n, String(n)]))),
  );

  async function fillBoard() {
    error.textContent = '';
    let made;
    try {
      made = parseReply(reply.value, { final: aiOpts.final, round2: aiOpts.round2, title: t('aiDefaultTitle'), kind: aiOpts.kind });
    } catch (err) {
      if (!(err instanceof AiQuizError)) throw err;
      error.textContent = t(`ai-${err.code}`);
      return;
    }
    await saveNow();
    const { id } = await api.create(made.set);
    aiNote = { id, duplicates: made.duplicates, summary: made.summary };
    reply.value = '';
    dialog.close();
    await loadList();
    await select(id);
  }

  // The kind and size come first: how many categories or sections there are decides how many topics to write.
  fill(
    form,
    dialogHead(dialog, t('aiTitle')),
    h('p', { class: 'muted' }, t('aiIntro')),
    h(
      'div',
      { class: 'ai-opts' },
      field(
        t('aiKind'),
        h(
          'select',
          { name: 'kind', onchange: (e) => setKind(e.target.value) },
          [
            ['board', t('aiKindBoard')],
            ['quick', t('aiKindQuick')],
          ].map(([value, label]) => h('option', { value, selected: aiOpts.kind === value }, label)),
        ),
      ),
      boardPart,
      quickPart,
    ),
    h('h3', {}, t('aiStep1')),
    h(
      'div',
      { class: 'ai-grid' },
      h('div', { class: 'ai-topics' }, h('label', { class: 'field' }, h('span', {}, t('aiTopics')), text('topics', 4), topicsHint), tooMany),
      field(t('aiExamples'), text('examples', 4), t('aiExamplesHint')),
    ),
    round2Box,
    h(
      'div',
      { class: 'ai-opts' },
      field(t('aiDifficulty'), choice('difficulty', DIFFICULTIES.map((d) => [d, t(`aiLevel-${d}`)]))),
      field(t('aiLang'), choice('lang', [['en', 'English'], ['no', 'Norsk']])),
    ),
    h('h3', {}, t('aiStep2')),
    request,
    h('div', { class: 'row' }, h('button', { class: 'btn btn-primary ai-copy', type: 'button', onclick: copy }, t('aiCopy')), copied),
    h('h3', {}, t('aiStep3')),
    reply,
    h('p', { class: 'ai-warn' }, t('aiWarn')),
    error,
    h(
      'div',
      { class: 'ed-dialog-actions' },
      h('button', { class: 'btn btn-quiet', value: 'cancel' }, t('aiCancel')),
      makeBtn,
    ),
  );
  fill(round2Box, field(t('aiRound2Topics'), text('round2Topics', 3), t('aiRound2TopicsHint')));
  redraw();
  dialog.showModal();
  form.querySelector('textarea').focus();
}

$('#ai-quiz').addEventListener('click', openAiDialog);

// ----- filling only the empty spots of the open quiz with AI -----

const fillOpts = { difficulty: 'match', topics: '', lang: null, target: 0 };

// Works for both kinds: a board's tiles, or a Quick quiz's questions (plus "fill each section up to N questions",
// which adds new questions at the end of the shorter sections).
function openFillDialog() {
  const dialog = $('#ai-dialog');
  const form = $('#ai-form');
  const isQuick = quick();
  fillOpts.target = isQuick ? suggestedTarget(set) : 0;
  let gaps = gapsOf(set, fillOpts);
  fillOpts.lang = guessLanguage(set) ?? fillOpts.lang ?? getLang();
  const field = (label, input, hint) => h('label', { class: 'field' }, h('span', {}, label), input, hint ? h('small', {}, hint) : null);
  const choice = (name, options) =>
    h(
      'select',
      { name, onchange: (e) => update(name, e.target.value) },
      options.map(([value, label]) => h('option', { value, selected: fillOpts[name] === value }, label)),
    );
  const request = h('textarea', { id: 'ai-request', class: 'ai-request', readonly: true, rows: 8 });
  const copied = h('span', { class: 'ed-status', role: 'status' });
  const reply = h('textarea', { id: 'ai-reply', rows: 6, placeholder: t('aiReplyPlaceholder'), oninput: () => (error.textContent = '') });
  const error = h('p', { id: 'ai-error', class: 'ed-media-status bad', role: 'alert' });
  const topics = h('textarea', { name: 'topics', rows: 3, oninput: (e) => update('topics', e.target.value) });
  topics.value = fillOpts.topics;
  const target = h('input', {
    type: 'number',
    name: 'target',
    min: 1,
    max: MAX_SECTION_QUESTIONS,
    step: 1,
    value: fillOpts.target,
    oninput: (e) => {
      const n = Math.round(Number(e.target.value));
      update('target', Number.isFinite(n) && e.target.value.trim() !== '' ? Math.max(0, Math.min(MAX_SECTION_QUESTIONS, n)) : 0);
    },
  });
  const missingBox = h('div', { class: 'ai-gaps' });
  const goBtn = h('button', { class: 'btn btn-primary ai-fill-gaps', type: 'button', onclick: fillGaps }, t('aiFillGo'));
  function update(key, value) {
    fillOpts[key] = value;
    renderMissing();
    request.value = buildFillRequest(set, fillOpts);
  }

  // Categories (or sections) with nothing at all in them: only then are topics asked for.
  const emptyCats = isQuick
    ? gaps.names.map((c) => set.sections[c]).filter((sec) => sec.questions.every(isBlank)).length
    : [...gaps.names.map((c) => set.categories[c]), ...gaps.names2.map((c) => set.round2.categories[c])].filter((cat) => cat.questions.every(isBlank)).length;

  function renderMissing() {
    gaps = gapsOf(set, fillOpts);
    const count = (need) => (isQuick ? gaps.questions.filter((g) => g.need.includes(need) && (need === 'question' || !g.need.includes('question')) && (need !== 'correct' || !g.need.includes('options'))) : gaps.tiles.filter((g) => g.need === need)).length;
    const lines = isQuick
      ? [
          count('question') && t('aiGapBoth', { n: count('question') }),
          count('options') && t('aiGapOptions', { n: count('options') }),
          count('correct') && t('aiGapCorrect', { n: count('correct') }),
          gaps.names.length && t('aiGapSection', { n: gaps.names.length }),
          gaps.extra && t('aiGapAdd', { n: gaps.extra }),
        ]
      : [
          count('both') && t('aiGapBoth', { n: count('both') }),
          count('answer') && t('aiGapAnswer', { n: count('answer') }),
          count('question') && t('aiGapQuestion', { n: count('question') }),
          gaps.names.length + gaps.names2.length && t('aiGapName', { n: gaps.names.length + gaps.names2.length }),
          gaps.final && t('aiGapFinal'),
        ];
    fill(
      missingBox,
      gaps.count ? [h('p', {}, t('aiFillMissing')), h('ul', {}, lines.filter(Boolean).map((line) => h('li', {}, line)))] : h('p', {}, t(isQuick ? 'aiFillNothingQuick' : 'aiFillNothing')),
    );
    goBtn.disabled = !gaps.count;
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(request.value);
    } catch {
      request.select();
      document.execCommand('copy');
    }
    copied.textContent = t('aiCopied');
    setTimeout(() => (copied.textContent = ''), 2000);
  }

  function fillGaps() {
    error.textContent = '';
    let made;
    try {
      made = parseFill(reply.value, set, fillOpts);
    } catch (err) {
      if (!(err instanceof AiQuizError)) throw err;
      error.textContent = t(`ai-${err.code}`);
      return;
    }
    set = made.set;
    aiNote = { id: currentId, duplicates: made.duplicates, filled: new Set(made.filled), added: made.added ?? 0, left: made.left, summary: made.summary };
    reply.value = '';
    dialog.close();
    changed({ board: true });
    renderMain();
  }

  renderMissing();
  const head = [
    dialogHead(dialog, t('aiFillTitle')),
    h('p', { class: 'muted' }, t('aiFillIntro')),
    missingBox,
    gaps.skipped ? h('p', { class: 'muted' }, t(isQuick ? 'aiFillSkippedQuick' : 'aiFillSkipped', { n: gaps.skipped })) : null,
  ];
  // A board with nothing missing has nothing to ask for; a Quick quiz can still be topped up with new questions.
  if (!gaps.count && !isQuick) {
    fill(form, ...head, h('div', { class: 'ed-dialog-actions' }, h('button', { class: 'btn btn-primary', value: 'cancel' }, t('aiDismiss'))));
    dialog.showModal();
    return;
  }
  fill(
    form,
    ...head,
    h('h3', {}, t('aiStep1Fill')),
    h(
      'div',
      { class: 'ai-opts' },
      field(t('aiDifficulty'), choice('difficulty', FILL_DIFFICULTIES.map((d) => [d, d === 'match' ? t('aiFillLevelMatch') : t(`aiLevel-${d}`)]))),
      field(t('aiLang'), choice('lang', [['en', 'English'], ['no', 'Norsk']])),
      isQuick ? field(t('aiFillUpTo'), target, t('aiFillUpToHint', { max: MAX_SECTION_QUESTIONS })) : null,
    ),
    emptyCats ? field(t(isQuick ? 'aiFillTopicsQuick' : 'aiFillTopics'), topics, t('aiFillTopicsHint')) : null,
    h('h3', {}, t('aiStep2')),
    request,
    h('div', { class: 'row' }, h('button', { class: 'btn btn-primary ai-copy', type: 'button', onclick: copy }, t('aiCopy')), copied),
    h('h3', {}, t('aiStep3')),
    reply,
    h('p', { class: 'ai-warn' }, t('aiWarn')),
    error,
    h('div', { class: 'ed-dialog-actions' }, h('button', { class: 'btn btn-quiet', value: 'cancel' }, t('aiCancel')), goBtn),
  );
  request.value = buildFillRequest(set, fillOpts);
  dialog.showModal();
}

// ----- start -----

window.addEventListener('beforeunload', () => saveTimer && saveNow());

(async () => {
  const lang = await api.lang().catch(() => 'en');
  setLang(lang);
  translatePage();
  await loadList();
  const wanted = location.hash.slice(1);
  const first = quizzes.find((q) => q.id === wanted) ?? quizzes.find((q) => !q.builtIn) ?? quizzes[0];
  if (first) await select(first.id);
  // The lobby's New quiz button opens /editor?new: straight to "What kind of quiz?" (the address is tidied first,
  // so a reload doesn't ask again).
  if (new URLSearchParams(location.search).has('new')) {
    history.replaceState(null, '', location.pathname + location.hash);
    newQuiz();
  }
})();

// The small box icon on each quiz row: a box (Archive) or a box with an arrow up (Bring back).
function archiveIcon(back) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = back
    ? '<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8"/><path d="M12 17v-6m-3 3 3-3 3 3"/>'
    : '<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8"/><path d="M10 12h4"/>';
  return svg;
}

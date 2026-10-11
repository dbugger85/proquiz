// The question editor (laptop only). Quizzes save themselves a moment after each change.
import { validateSet, usedFiles, cleanCredits, modeOf, MAX_CATEGORIES, MAX_QUESTIONS, MAX_SECTIONS, MAX_SECTION_QUESTIONS, MAX_OPTION, MIN_SECONDS, MAX_SECONDS, DEFAULT_SECONDS, rightSet, typeOf, QUESTION_TYPES } from '/lib/validate.js';
import { buildRequest, parseReply, splitTopics, AiQuizError, DIFFICULTIES, FILL_DIFFICULTIES, MIN_SIZE, QUICK_SECTIONS, QUICK_PER_SECTION, gapsOf, guessLanguage, buildFillRequest, parseFill } from '/lib/aiquiz.js';
import { SHAPES, OPTION_COLORS } from '/lib/quick.js';
import { t, pts, setLang, getLang, translatePage, licenseName } from './i18n.js';
import { $, h, fill, setGlass, savedGlass, shapeSvg, optionStyle, setBrand, ask, tell } from './ui.js';
import { KINDS } from '/lib/crazy.js';
import { ICONS } from './specials.js';

let quizzes = []; // the list on the left
let currentId = null;
let set = null; // the quiz being edited
let builtIn = false;
let problems = [];
let saveTimer = null;
let savePromise = Promise.resolve();
let aiNote = null; // { id, duplicates, filled?, left? } for a quiz just made or filled with AI (shown until another quiz is opened)

// A Quick quiz (multiple choice in sections) instead of a board: see renderSections() and openQuestion().
const quick = () => modeOf(set) === 'quick';

setGlass(savedGlass()); // the look the host chose last (the editor has no game state of its own)
// The host's branding (logo and accent colour), fetched once (the editor is on the laptop, so /api/ answers).
fetch('/api/brand')
  .then((r) => (r.ok ? r.json() : null))
  .then(setBrand)
  .catch(() => {});

// ----- talking to the server -----

async function call(method, url, body, raw) {
  const r = await fetch(url, { method, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.error || 'failed'), { code: data.error });
  return data;
}

async function loadList() {
  quizzes = await call('GET', '/api/sets');
  renderList();
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
    .then(() => call('PUT', `/api/sets/${id}`, body))
    .then(() => {
      if (id === currentId && !saveTimer) setStatus('edSaved');
      const item = quizzes.find((q) => q.id === id);
      if (item) Object.assign(item, { title: body.set.title, problems: validateSet(body.set).length });
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
  scheduleSave();
}

// ----- the list of quizzes -----

function renderList() {
  fill($('#quiz-list'), 
    ...quizzes.map((q) =>
      h(
        'li',
        {},
        h(
          'button',
          { class: `ed-item${q.id === currentId ? ' on' : ''}`, type: 'button', onclick: () => select(q.id) },
          h('span', { class: 'ed-item-title' }, q.title || t('edNewQuizTitle')),
          h(
            'span',
            { class: `ed-item-sub${q.problems ? ' bad' : ''}` },
            [q.kind === 'quick' ? t('quickTag') : null, q.builtIn ? t('edBuiltIn') : q.problems ? t('edNotReady') : t('edQuestions', { n: q.questions })].filter(Boolean).join(' · '),
          ),
        ),
      ),
    ),
  );
}

async function select(id) {
  await saveNow();
  const found = await call('GET', `/api/sets/${id}`).catch(() => null);
  if (!found) return;
  if (aiNote && aiNote.id !== id) aiNote = null;
  currentId = id;
  set = found.set;
  builtIn = found.builtIn;
  problems = validateSet(set);
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
  const { id } = await call('POST', '/api/sets', { set: newSet });
  await loadList();
  await select(id);
}

$('#new-quiz').addEventListener('click', () => createQuiz(blankSet()));
$('#new-quick').addEventListener('click', () => createQuiz(blankQuickSet()));

$('#import-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const { id } = await call('POST', '/api/import', undefined, await file.text());
    await loadList();
    await select(id);
  } catch {
    tell({ title: t('dlgImportTitle'), text: t('edImportFailed') });
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
      h('a', { class: 'btn', href: `/api/export/${currentId}`, download: '' }, t('edExport')),
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
                await call('DELETE', `/api/sets/${currentId}`);
                currentId = null;
                set = null;
                await loadList();
                select(quizzes[0].id);
              },
            },
            t('edDelete'),
          ),
    ),
    quick() ? h('div', { id: 'ed-sections', class: 'ed-sections' }) : [h('div', { id: 'ed-board' }), h('div', { id: 'ed-round2' }), h('div', { id: 'ed-final' })],
    h('div', { id: 'ed-problems' }),
    h('div', { id: 'ed-credits' }),
  );
  renderBoard();
  renderProblems();
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
        class: `ed-qrow${hasProblem(c, i) ? ' bad' : ''}${blank ? ' blank' : ''}`,
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
  const lines = problems.filter((p) => !blankProblem(p)).map(problemText);
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

const sourceName = (source) => t(source === 'wikimedia' ? 'picSourceWikimedia' : 'picSourceOpenverse');
const outLink = (href, text) => (href ? h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, text) : text);

// "Picture: Ann · CC BY 2.0 · Openverse", with the source as a link to the picture's own page.
function creditNodes(c) {
  const mark = '\u0000';
  const line = c.author ? t('picCreditLine', { author: c.author, license: licenseName(c.license), source: mark }) : t('picCreditNoAuthor', { license: licenseName(c.license), source: mark });
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
                h('img', { src: `/files/${encodeURIComponent(name)}`, alt: '', loading: 'lazy' }),
                h('span', {}, c.title ? h('b', {}, c.title) : null, h('span', {}, creditNodes(c), c.licenseUrl ? [' · ', outLink(c.licenseUrl, t('picAboutLicense'))] : null)),
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
      ...(area ? { rows: 3 } : { type: 'text', value: q[key] ?? '' }),
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
          ? h('img', { src: `/files/${encodeURIComponent(name)}`, alt: '' })
          : h('audio', { src: `/files/${encodeURIComponent(name)}`, controls: true, preload: 'metadata' })
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
            const up = await call('POST', `/api/files?name=${encodeURIComponent(file.name)}`, undefined, file);
            if (up.kind !== kind) throw new Error('wrong kind');
            upd(key, up.name);
            draw();
          } catch {
            draw(t('edUploadFailed'));
          }
        },
      });
      const credit = name && kind === 'image' ? set.credits?.[name] : null;
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
              kind === 'image'
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
                : null,
              name
                ? h(
                    'button',
                    {
                      class: 'btn btn-quiet',
                      type: 'button',
                      onclick: () => {
                        upd(key, null);
                        if (key === 'audio') delete q.audioStart;
                        if (key === 'image') delete q.unveil;
                        draw();
                        drawStart();
                      },
                    },
                    t('edRemove'),
                  )
                : null,
            ),
        status ? h('p', { class: `ed-media-status${status === t('edUploadFailed') ? ' bad' : ''}` }, status) : null,
      );
      if (key === 'audio') drawStart();
      if (key === 'image') drawUnveil();
    };
    return { box, draw };
  }

  // "Start at (seconds)" only when there is a clip.
  const startBox = h('div');
  function drawStart() {
    fill(startBox, 
      q.audio
        ? field(
            t('edClipStart'),
            h('input', {
              type: 'number',
              min: 0,
              step: 0.5,
              value: q.audioStart ?? 0,
              disabled: builtIn,
              oninput: (e) => {
                const n = Number(e.target.value);
                upd('audioStart', Number.isFinite(n) && n > 0 ? n : null);
              },
            }),
          )
        : '',
    );
  }

  // "Show the picture slowly" (big blocks that get smaller) only when there is a question picture.
  // Not offered on the final question.
  const unveilBox = h('div');
  function drawUnveil() {
    if (isFinal || isQuick || !q.image) return fill(unveilBox);
    const on = Number(q.unveil) > 0;
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
            upd('unveil', e.target.checked ? 15 : null);
            drawUnveil();
          },
        }),
        h('span', {}, t('edUnveil')),
      ),
      on
        ? field(
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
              },
            }),
          )
        : null,
      on ? h('small', {}, t('edUnveilHint')) : null,
    );
  }

  const picQ = mediaField('image', 'image', t('edPicQ'));
  const picA = isQuick ? null : mediaField('answerImage', 'image', t('edPicA'));
  const clip = mediaField('audio', 'audio', t('edClip'), isQuick ? t('edQuickClipHint') : t('edClipHint'));

  const question = text('question', { area: true });
  question.value = q.question ?? '';

  if (isQuick) fill(form, ...quickFields(c, i, q, question, field, upd), h('div', { class: 'ed-media-grid two' }, h('div', {}, picQ.box), h('div', {}, clip.box, startBox)), h('div', { class: 'ed-dialog-actions' }, h('button', { class: 'btn btn-primary', value: 'done' }, t('edDone'))));
  else fill(form, 
    h('h2', {}, isFinal ? t('edFinal') : `${r === 2 ? `${t('edRound2')}: ` : ''}${cats[c].name || t('edCategory', { n: c + 1 })}`),
    isFinal
      ? field(t('edFinalCategory'), text('category', { max: 40 }))
      : field(
          t('edPoints'),
          h('input', {
            type: 'number',
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
    field(t('edQuestion'), question),
    field(t('edAnswer'), text('answer', { max: 120 })),
    isFinal
      ? null
      : field(
          t('edSpecial'),
          h(
            'select',
            { name: 'special', disabled: builtIn, onchange: (e) => upd('special', e.target.value) },
            h('option', { value: '', selected: !q.special }, t('edSpecialNone')),
            KINDS.map((kind) => h('option', { value: kind, selected: q.special === kind }, `${ICONS[kind]}  ${t(`n-${kind}`)}`)),
          ),
        ),
    isFinal ? null : h('small', { class: 'muted ed-special-hint' }, t('edSpecialHint')),
    h('div', { class: 'ed-media-grid' }, h('div', {}, picQ.box, unveilBox), picA.box, h('div', {}, clip.box, startBox)),
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
function quickFields(c, i, q, question, field, upd) {
  const sec = set.sections[c];
  const slots = SHAPES.map((_, n) => String(q.options?.[n] ?? ''));
  let type = QUESTION_TYPES.includes(typeOf(q)) ? typeOf(q) : 'choice';
  let right = rightSet(q).filter((n) => n < slots.length); // the slots marked right (one or more; any of them counts)
  const sync = () => {
    const keep = kept();
    q.options = keep.map((n) => slots[n]);
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
  return [
    h('h2', {}, `${sec.name?.trim() || t('edSection', { n: c + 1 })}: ${t('edQuestionN', { n: i + 1 })}`),
    h('div', { class: 'field' }, h('span', {}, t('edStyle')), kindPills), // a div: a label around the pills' own labels would misfire
    field(t('edQuestion'), question),
    opts,
    h(
      'div',
      { class: 'ed-quick-row' },
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

// A starting point for the search from the question's text: the first words, without the question mark.
function suggestQuery(text) {
  const s = String(text ?? '').replace(/[?¿!.:;«»"“”]/g, ' ').replace(/\s+/g, ' ').trim();
  if (s.length <= 60) return s;
  return s.slice(0, 60).replace(/\s+\S*$/, '');
}

const PIC_ERRORS = { 'no-internet': 'picErrOffline', 'rate-limited': 'picErrRate', 'picture-too-big': 'picErrTooBig', 'picture-bad-type': 'picErrType', 'picture-missing': 'picErrMissing' };
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
      const params = new URLSearchParams({ q: st.words, source: st.source, page: String(page), license: st.license, lang: getLang() });
      const out = await call('GET', `/api/pictures/search?${params}`);
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
        const got = await call('POST', '/api/pictures/fetch', { source: r.source, id: r.id });
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
    h('h2', {}, t('picTitle')),
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
    topicsHint.textContent = isQuickKind() ? t('aiTopicsHintQuick') : t('aiTopicsHint');
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
    const { id } = await call('POST', '/api/sets', { set: made.set });
    aiNote = { id, duplicates: made.duplicates };
    reply.value = '';
    dialog.close();
    await loadList();
    await select(id);
  }

  fill(
    form,
    h('h2', {}, t('aiTitle')),
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
    ),
    h('h3', {}, t('aiStep1')),
    h(
      'div',
      { class: 'ai-grid' },
      h('div', { class: 'ai-topics' }, h('label', { class: 'field' }, h('span', {}, t('aiTopics')), text('topics', 4), topicsHint), tooMany),
      field(t('aiExamples'), text('examples', 4), t('aiExamplesHint')),
    ),
    h(
      'div',
      { class: 'ai-opts' },
      field(t('aiDifficulty'), choice('difficulty', DIFFICULTIES.map((d) => [d, t(`aiLevel-${d}`)]))),
      field(t('aiLang'), choice('lang', [['en', 'English'], ['no', 'Norsk']])),
      boardPart,
      quickPart,
    ),
    round2Box,
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

const fillOpts = { difficulty: 'match', topics: '', lang: null };

function openFillDialog() {
  const dialog = $('#ai-dialog');
  const form = $('#ai-form');
  const gaps = gapsOf(set);
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
  function update(key, value) {
    fillOpts[key] = value;
    request.value = buildFillRequest(set, fillOpts);
  }

  // Categories with nothing at all in them: only then are topics asked for.
  const emptyCats = [...gaps.names.map((c) => set.categories[c]), ...gaps.names2.map((c) => set.round2.categories[c])].filter((cat) =>
    cat.questions.every(isBlank),
  ).length;
  const count = (need) => gaps.tiles.filter((g) => g.need === need).length;
  const missing = [
    count('both') && t('aiGapBoth', { n: count('both') }),
    count('answer') && t('aiGapAnswer', { n: count('answer') }),
    count('question') && t('aiGapQuestion', { n: count('question') }),
    gaps.names.length + gaps.names2.length && t('aiGapName', { n: gaps.names.length + gaps.names2.length }),
    gaps.final && t('aiGapFinal'),
  ].filter(Boolean);

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
      made = parseFill(reply.value, set);
    } catch (err) {
      if (!(err instanceof AiQuizError)) throw err;
      error.textContent = t(`ai-${err.code}`);
      return;
    }
    set = made.set;
    aiNote = { id: currentId, duplicates: made.duplicates, filled: new Set(made.filled), left: made.left };
    reply.value = '';
    dialog.close();
    changed();
    renderMain();
  }

  const head = [
    h('h2', {}, t('aiFillTitle')),
    h('p', { class: 'muted' }, t('aiFillIntro')),
    gaps.count ? h('div', { class: 'ai-gaps' }, h('p', {}, t('aiFillMissing')), h('ul', {}, missing.map((line) => h('li', {}, line)))) : h('p', { class: 'ai-gaps' }, t('aiFillNothing')),
    gaps.skipped ? h('p', { class: 'muted' }, t('aiFillSkipped', { n: gaps.skipped })) : null,
  ];
  if (!gaps.count) {
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
    ),
    emptyCats ? field(t('aiFillTopics'), topics, t('aiFillTopicsHint')) : null,
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
      h('button', { class: 'btn btn-primary ai-fill-gaps', type: 'button', onclick: fillGaps }, t('aiFillGo')),
    ),
  );
  request.value = buildFillRequest(set, fillOpts);
  dialog.showModal();
}

// ----- start -----

window.addEventListener('beforeunload', () => saveTimer && saveNow());

(async () => {
  const { lang } = await call('GET', '/api/lang').catch(() => ({ lang: 'en' }));
  setLang(lang);
  translatePage();
  await loadList();
  const wanted = location.hash.slice(1);
  const first = quizzes.find((q) => q.id === wanted) ?? quizzes.find((q) => !q.builtIn) ?? quizzes[0];
  if (first) select(first.id);
})();

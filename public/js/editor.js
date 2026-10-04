// The question editor (laptop only). Quizzes save themselves a moment after each change.
import { validateSet, MAX_CATEGORIES, MAX_QUESTIONS } from '/lib/validate.js';
import { buildRequest, parseReply, splitTopics, AiQuizError, DIFFICULTIES, MIN_SIZE } from '/lib/aiquiz.js';
import { t, setLang, getLang, translatePage } from './i18n.js';
import { $, h, fill } from './ui.js';

let quizzes = []; // the list on the left
let currentId = null;
let set = null; // the quiz being edited
let builtIn = false;
let problems = [];
let saveTimer = null;
let savePromise = Promise.resolve();
let aiNote = null; // { id, duplicates } for a quiz just made with AI (shown until another quiz is opened)

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
            q.builtIn ? t('edBuiltIn') : q.problems ? t('edNotReady') : t('edQuestions', { n: q.questions }),
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

async function createQuiz(newSet) {
  const { id } = await call('POST', '/api/sets', { set: newSet });
  await loadList();
  await select(id);
}

$('#new-quiz').addEventListener('click', () => createQuiz(blankSet()));

$('#import-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const { id } = await call('POST', '/api/import', undefined, await file.text());
    await loadList();
    await select(id);
  } catch {
    alert(t('edImportFailed'));
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
            h('p', {}, t('aiMadeNote')),
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
                if (!confirm(t('edConfirmDelete', { title: set.title }))) return;
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
    h('div', { id: 'ed-board' }),
    h('div', { id: 'ed-final' }),
    h('div', { id: 'ed-problems' }),
  );
  renderBoard();
  renderProblems();
}

// A question nobody has started on yet: not shown in red, just counted.
const isBlank = (q) => !q.question?.trim() && !q.answer?.trim() && !q.image && !q.answerImage && !q.audio;
const blankCategory = (cat) => !cat?.name?.trim() && (cat?.questions ?? []).every(isBlank);
const blankProblem = (p) =>
  p.i !== undefined ? isBlank(set.categories[p.c]?.questions[p.i] ?? {}) : p.code === 'no-category-name' && blankCategory(set.categories[p.c]);
const hasProblem = (c, i) => problems.some((p) => p.c === c && (i === undefined ? p.i === undefined : p.i === i) && !blankProblem(p));

function snippet(q) {
  const icons = `${q.image || q.answerImage ? '🖼 ' : ''}${q.audio ? '♪ ' : ''}`;
  const text = q.question?.trim() || (q.image || q.audio ? '' : t('edEmptyTile'));
  return `${icons}${text}`.trim();
}

function renderBoard() {
  const rows = Math.max(0, ...set.categories.map((c) => c.questions.length));
  const board = h(
    'div',
    { class: 'ed-board', style: `--cols: ${set.categories.length}` },
    set.categories.map((cat, c) =>
      h(
        'div',
        { class: 'ed-col' },
        h(
          'div',
          { class: `ed-cat${hasProblem(c) ? ' bad' : ''}`, 'data-c': c },
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
          builtIn || set.categories.length <= 1
            ? null
            : h(
                'button',
                {
                  class: 'ed-x',
                  type: 'button',
                  title: t('edRemoveCategory'),
                  'aria-label': t('edRemoveCategory'),
                  onclick: () => {
                    if (!confirm(t('edConfirmRemoveCategory', { name: cat.name || t('edCategory', { n: c + 1 }) }))) return;
                    set.categories.splice(c, 1);
                    changed({ board: true });
                  },
                },
                '×',
              ),
        ),
        cat.questions.map((q, i) =>
          h(
            'button',
            { class: `ed-tile${hasProblem(c, i) ? ' bad' : ''}${q.question || q.image || q.audio ? '' : ' blank'}`, type: 'button', 'data-c': c, 'data-i': i, onclick: () => openQuestion(c, i) },
            h('b', {}, String(q.value || '?')),
            h('span', {}, snippet(q)),
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
            disabled: set.categories.length >= MAX_CATEGORIES,
            onclick: () => {
              const values = set.categories[0]?.questions.map((q) => q.value) ?? [100, 200, 300, 400, 500];
              set.categories.push({ name: '', questions: values.map(blankQuestion) });
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
              for (const cat of set.categories) {
                const last = cat.questions.at(-1)?.value ?? 0;
                cat.questions.push(blankQuestion(last + 100));
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
            onclick: () => {
              if (!confirm(t('edConfirmRemoveRow'))) return;
              for (const cat of set.categories) if (cat.questions.length > 1) cat.questions.pop();
              changed({ board: true });
            },
          },
          t('edRemoveRow'),
        ),
      );
  fill($('#ed-board'), board, tools ?? '');
  renderFinal();
}

function renderFinal() {
  const f = set.final;
  const finalProblem = problems.some((p) => p.c === undefined && /final|bad-/.test(p.code));
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

// Update just the red marks (keeps the cursor where it is while typing a category name).
function markTiles() {
  for (const el of document.querySelectorAll('.ed-tile[data-c]')) el.classList.toggle('bad', hasProblem(Number(el.dataset.c), Number(el.dataset.i)));
  for (const el of document.querySelectorAll('.ed-cat[data-c]')) el.classList.toggle('bad', hasProblem(Number(el.dataset.c)));
  const ft = document.querySelector('.ed-final-tile');
  if (ft) ft.classList.toggle('bad', problems.some((p) => p.c === undefined && /final|bad-/.test(p.code)));
}

function problemText(p) {
  const cat = p.c !== undefined ? set.categories[p.c]?.name || t('edCategory', { n: p.c + 1 }) : t('edFinal');
  const where = p.i !== undefined ? `${cat} ${set.categories[p.c]?.questions[p.i]?.value ?? ''}`.trim() : cat;
  return t(`p-${p.code}`, { cat, where });
}

function renderProblems() {
  const box = $('#ed-problems');
  if (!box) return;
  const blanks = set.categories.reduce((n, c) => n + c.questions.filter(isBlank).length, 0);
  const lines = problems.filter((p) => !blankProblem(p)).map(problemText);
  if (blanks) lines.unshift(t('edBlanks', { n: blanks }));
  fill(
    box,
    lines.length
      ? h('div', { class: 'ed-problems bad' }, h('p', {}, t('edFixList')), h('ul', {}, lines.map((line) => h('li', {}, line))))
      : h('p', { class: 'ed-problems good' }, t('edAllGood')),
  );
}

// ----- editing one question -----

function openQuestion(c, i) {
  const isFinal = c === null;
  const q = isFinal ? set.final : set.categories[c].questions[i];
  const dialog = $('#q-dialog');
  const form = $('#q-form');
  const upd = (key, value) => {
    if (value === '' || value === null || value === undefined) delete q[key];
    else q[key] = value;
    changed();
  };
  const field = (label, input) => h('label', { class: 'field' }, h('span', {}, label), input);
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
      fill(box, 
        h('span', { class: 'ed-media-label' }, label),
        hint ? h('small', {}, hint) : null,
        preview,
        builtIn
          ? null
          : h(
              'span',
              { class: 'row' },
              h('label', { class: 'btn' }, t('edChooseFile'), input),
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
    if (isFinal || !q.image) return fill(unveilBox);
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
  const picA = mediaField('answerImage', 'image', t('edPicA'));
  const clip = mediaField('audio', 'audio', t('edClip'), t('edClipHint'));

  const question = text('question', { area: true });
  question.value = q.question ?? '';

  fill(form, 
    h('h2', {}, isFinal ? t('edFinal') : `${set.categories[c].name || t('edCategory', { n: c + 1 })}`),
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
    h('div', { class: 'ed-media-grid' }, h('div', {}, picQ.box, unveilBox), picA.box, h('div', {}, clip.box, startBox)),
    h('div', { class: 'ed-dialog-actions' }, h('button', { class: 'btn btn-primary', value: 'done' }, t('edDone'))),
  );
  picQ.draw();
  picA.draw();
  clip.draw();
  dialog.onclose = () => {
    for (const a of form.querySelectorAll('audio')) a.pause();
    renderBoard();
    saveNow();
  };
  dialog.showModal();
  if (!builtIn) (isFinal ? form.querySelector('input') : question).focus();
}

// ----- making a quiz with AI (copy and paste, ProQuiz itself stays offline) -----

const aiOpts = { topics: '', examples: '', difficulty: 'medium', categories: 5, rows: 5, final: true, lang: null };

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

  // Only the request text and the hint change while typing, so the cursor stays where it is.
  function redraw() {
    request.value = buildRequest(aiOpts);
    const n = splitTopics(aiOpts.topics).length;
    tooMany.textContent = n > aiOpts.categories ? t('aiTooManyTopics', { n: aiOpts.categories }) : '';
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

  async function fillBoard() {
    error.textContent = '';
    let made;
    try {
      made = parseReply(reply.value, { final: aiOpts.final, title: t('aiDefaultTitle') });
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
    h('h3', {}, t('aiStep1')),
    h(
      'div',
      { class: 'ai-grid' },
      h('div', { class: 'ai-topics' }, field(t('aiTopics'), text('topics', 4), t('aiTopicsHint')), tooMany),
      field(t('aiExamples'), text('examples', 4), t('aiExamplesHint')),
    ),
    h(
      'div',
      { class: 'ai-opts' },
      field(t('aiDifficulty'), choice('difficulty', DIFFICULTIES.map((d) => [d, t(`aiLevel-${d}`)]))),
      field(t('aiCategories'), choice('categories', sizes)),
      field(t('aiRows'), choice('rows', sizes)),
      field(t('aiLang'), choice('lang', [['en', 'English'], ['no', 'Norsk']])),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'final', checked: aiOpts.final, onchange: (e) => update('final', e.target.checked) }), h('span', {}, t('aiFinal'))),
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
      h('button', { class: 'btn btn-primary ai-fill', type: 'button', onclick: fillBoard }, t('aiFill')),
    ),
  );
  redraw();
  dialog.showModal();
  form.querySelector('textarea').focus();
}

$('#ai-quiz').addEventListener('click', openAiDialog);

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

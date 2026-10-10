// The host laptop: lobby with settings, then the game controls. The host sees the answers.
//
// Keys: Space = turn buzzers on / back to the board, Y = correct, N = wrong, R = show answer,
// Esc = put the question back, U = undo.
import { ranking, COLORS, KINDS, unveilProgress, MUSIC_MOODS, maxBet, SHAPES, OPTION_COLORS, MAX_PLAYERS, MAX_TEAMS } from '/lib/game.js';
import { connect } from './net.js';
import { t, setLang, translatePage, fastestTitle, secondsText } from './i18n.js';
import { $, h, fill, qrSvg, shortUrl, urlNodes, countdown, runCountdowns, teamStyle, setGlass, shapeSvg, optionStyle, setBrand, brandLogo, ACCENTS, ask, askNumber, askColor, modalOpen } from './ui.js';
import { unlockAudio, audioReady, playEvent, playSound, startTicks } from './sounds.js';
import { syncClip, stopClip } from './clip.js';
import { syncMusic, stopMusic } from './music.js';
import { ICONS, ruleFor, badgeFor } from './specials.js';
import { ownSpecials } from '/lib/crazy.js';
import { avatarEl } from './avatar.js';

// A team's avatar (mascot or player face) in a list, or nothing for a team without one.
const face = (team) => avatarEl(team?.avatar);

let view = null;
let connected = new Set();
let info = null;
let displays = 0; // TV screens open; when there are none, this laptop plays the sounds
let tvs = 0; // separate TV screens (not the one shown inside this page)
let peek = false; // single-screen mode: showing the host view (with the answers) instead of the TV view
let soundSeq = null;
let resume = null; // a saved game the host can continue
let latency = {}; // fair buzzing: teamId → the phone's measured delay (ms)
let remote = { status: 'off', url: null, reason: null, progress: null, remoteTeams: [] }; // players elsewhere (the internet tunnel)
let brand = null; // the host's logo, event name and accent colour (brand.js, changed through /api/brand)
let remoteQuickDone = false; // turned on the question text on the phones for this tunnel (once, so the host can turn it off again)

const net = connect({
  role: 'host',
  onMessage(msg) {
    if (msg.type === 'welcome') {
      info = msg.info;
      renderQr();
    } else if (msg.type === 'state') {
      view = msg.view;
      connected = new Set(msg.connected);
      displays = msg.displays;
      tvs = msg.tvs ?? msg.displays;
      resume = msg.resume ?? null;
      latency = msg.latency ?? {};
      remote = msg.remote ?? remote;
      brand = msg.brand ?? null;
      const ev = view.event;
      if (ev && soundSeq !== null && ev.seq !== soundSeq && displays === 0) playEvent(view, ev, COLORS);
      soundSeq = ev?.seq ?? 0;
      render();
    } else if (msg.type === 'latency') {
      latency = msg.latency;
      if (view?.phase === 'lobby') renderTeams();
    } else if (msg.type === 'sound') {
      playSound(view, msg, COLORS);
    } else if (msg.type === 'error') {
      showError(t(`err-${msg.code}`));
    }
  },
});
runCountdowns(net.now);
startTicks(() => (displays === 0 ? view : null), net.now);

function showUnlock() {
  $('#sound-unlock').hidden = !(view?.settings.sound || view?.settings.music) || displays > 0 || audioReady();
}
// With no TV screen open, this laptop plays the background music too.
setInterval(() => view && displays === 0 && syncMusic(view, net.now()), 250);
for (const type of ['pointerdown', 'keydown']) {
  document.addEventListener(type, () => {
    unlockAudio();
    setTimeout(showUnlock, 100);
  });
}

const cmd = (action) => net.send({ type: 'cmd', action });

function showError(text) {
  const el = $('#host-error');
  el.textContent = text;
  el.hidden = !text;
}

// The join card: one QR code. On this Wi-Fi it's the laptop's address; over the internet it's the internet
// address, and until that is ready the card says what is happening, with the Wi-Fi code below as a stand-in.
function renderQr() {
  if (!info) return;
  const internet = view?.settings.joinMode === 'internet';
  const ready = internet && remoteOn();
  const waiting = internet && !ready;
  const url = ready ? remote.url : info.phoneUrl;
  $('.join-card').classList.toggle('waiting', waiting);
  $('#join-label').textContent = ready ? t('overInternet') : waiting ? t('wifiForNow') : t('onThisWifi');
  if (url) {
    if ($('#qr').dataset.url !== url) {
      $('#qr').replaceChildren(qrSvg(url));
      $('#qr').dataset.url = url;
    }
    $('#url').replaceChildren(...urlNodes(url));
  } else {
    $('#qr').replaceChildren();
    $('#qr').dataset.url = '';
    $('#url').textContent = t('noNetwork');
  }
  $('#tv-url').textContent = info.tvUrl ? t('tvElsewhereHint', { url: shortUrl(info.tvUrl) }) : '';
  $('#tv-url').hidden = !info.tvUrl;
  // Over the internet: the PIN, and the TV page for players who can't see the TV.
  const pin = ready && view?.settings.remotePin;
  $('#remote-pin').hidden = !pin;
  $('#remote-pin').textContent = pin ? t('remotePinShow', { pin }) : '';
  $('#remote-tv').hidden = !ready;
  $('#remote-tv').textContent = ready ? t('remoteTvLink', { url: `${shortUrl(remote.url)}/display` }) : '';
  // Not ready yet (or not working): say so where the code will be.
  $('#join-wait').hidden = !waiting;
  if (waiting) {
    const st = remote.status;
    $('#join-wait').dataset.status = st;
    $('#join-wait-text').textContent = remoteStateText();
    $('#join-retry').hidden = !canRetry() || st === 'missing'; // then the download is the button
    $('#join-download').hidden = !(st === 'missing' || (st === 'failed' && remote.reason === 'download'));
  }
}

// ----- how players join: on this Wi-Fi, or over the internet -----

const remoteOn = () => remote.status === 'on' && Boolean(remote.url);

// Over the internet, not running: "Try again" (after installing cloudflared yourself, too).
const canRetry = () => ['off', 'missing'].includes(remote.status) || (remote.status === 'failed' && remote.reason !== 'download');

function remoteStateText() {
  const st = remote.status;
  return st === 'on' ? t('remoteStateOn', { url: shortUrl(remote.url ?? '') })
    : st === 'starting' ? t('remoteStateStarting')
    : st === 'missing' ? t('remoteStateMissing')
    : st === 'downloading' ? t('remoteStateDownloading', { pct: remote.progress ?? 0 })
    : st === 'failed' ? t(`remoteFailed-${remote.reason ?? 'start'}`)
    : t('remoteStateOff');
}

// The "How players join" settings group: the Wi-Fi / internet pills (a normal setting), and over the internet
// what is happening, the download, trying again, and the PIN.
function renderRemote() {
  const st = remote.status;
  const internet = view.settings.joinMode === 'internet';
  const busy = st === 'starting' || st === 'downloading';
  $('#join-mode-hint').textContent = t(internet ? 'remoteHint' : 'joinWifiHint');
  $('#remote-more').hidden = !internet;
  $('#remote-state').textContent = remoteStateText();
  $('#remote-state').classList.toggle('bad', st === 'failed');
  $('#remote-retry').hidden = !(internet && canRetry());
  $('#remote-missing').hidden = !(st === 'missing' || (st === 'failed' && remote.reason === 'download'));
  $('#remote-status').textContent = !internet
    ? t('joinWifi')
    : `${t('joinInternet')} · ${st === 'on' ? t('stateOn') : busy ? t('remoteSummaryStarting') : t('remoteSummaryProblem')}`;
  $('#remote-status').classList.toggle('bad', internet && (st === 'failed' || st === 'missing'));
  // Keep the group open while something is happening in it.
  if (internet && !$('#group-remote').dataset.opened) {
    $('#group-remote').open = true;
    $('#group-remote').dataset.opened = '1';
  }
  const pin = view.settings.remotePin;
  if (document.activeElement !== $('#remote-pin-on')) $('#remote-pin-on').checked = Boolean(pin);
  $('#remote-pin-row').hidden = !pin;
  $('#remote-pin-show').textContent = pin ? t('remotePinShow', { pin }) : '';
  // A Quick quiz with players elsewhere: they can't see the TV, so the phones show the question and answers too.
  if (st === 'off') remoteQuickDone = false;
  if (remoteOn() && quick() && !remoteQuickDone) {
    remoteQuickDone = true;
    if (!view.settings.quickPhoneText) {
      cmd({ type: 'settings', settings: { quickPhoneText: true } });
      $('#remote-note').hidden = false;
    }
  }
  if (!quick()) $('#remote-note').hidden = true;
}

// During a game: a small warning when players join over the internet and that has stopped working (or came
// back on a new address, which players elsewhere must open again).
let gameUrl; // the internet address when the game started
function renderRemoteWarn() {
  const el = $('#remote-warn');
  const inGame = view.phase !== 'lobby';
  if (!inGame) gameUrl = remoteOn() ? remote.url : null;
  const internet = view.settings.joinMode === 'internet';
  const st = remote.status;
  const text = !inGame || !internet ? ''
    : st === 'on' ? (remote.url !== gameUrl ? t('remoteWarnNew', { url: shortUrl(remote.url) }) : '')
    : st === 'starting' || st === 'downloading' ? t('remoteWarnStarting')
    : t('remoteWarnDown');
  el.hidden = !text;
  if (!text) return;
  fill(el, h('span', {}, `⚠ ${text}`), canRetry() ? h('button', { class: 'btn btn-small', type: 'button', onclick: () => net.send({ type: 'tunnel', on: true }) }, t('remoteRetry')) : null);
}

const newPin = () => {
  const n = new Uint32Array(1);
  crypto.getRandomValues(n);
  return String(n[0] % 10000).padStart(4, '0');
};

for (const id of ['#remote-retry', '#join-retry']) $(id).addEventListener('click', () => net.send({ type: 'tunnel', on: true }));
for (const id of ['#remote-download', '#join-download']) $(id).addEventListener('click', () => net.send({ type: 'tunnelDownload' }));
$('#remote-pin-on').addEventListener('change', (e) => cmd({ type: 'settings', settings: { remotePin: e.target.checked ? newPin() : '' } }));
$('#remote-pin-new').addEventListener('click', () => cmd({ type: 'settings', settings: { remotePin: newPin() } }));

const teamName = (id) => view.teams.find((tm) => tm.id === id)?.name ?? '?';
// A Quick quiz (multiple choice): each phone is a player, and the screens and keys are its own.
const quick = () => view?.mode === 'quick';

// ----- lobby -----

function renderTeams() {
  const teams = view.teams;
  $('#team-count').textContent = `${teams.length}/${quick() ? MAX_PLAYERS : MAX_TEAMS}`;
  $('#no-teams').hidden = teams.length > 0;
  $('#teams').replaceChildren(
    ...teams.map((team) => {
      const on = connected.has(team.id);
      const ms = view.settings.fairBuzz && on ? latency[team.id] : undefined;
      return h(
        'li',
        { class: 'plate', style: teamStyle(team) },
        h('span', { class: 'name' }, face(team), h('span', {}, team.name)),
        h(
          'span',
          { class: 'conn' },
          h('span', { class: `dot${on ? ' on' : ''}` }),
          on ? t('online') : t('offline'),
          remote.remoteTeams?.includes(team.id) ? h('span', { class: 'elsewhere', title: t('remoteTagHint') }, t('remoteTag')) : null,
          ms !== undefined ? h('span', { class: 'ping', title: t('pingHint') }, t('pingMs', { ms })) : null,
        ),
        h(
          'button',
          {
            class: 'remove',
            type: 'button',
            'aria-label': t('removeTeam', { name: team.name }),
            title: t('removeTeam', { name: team.name }),
            onclick: async () => {
              const ok = await ask({ title: t('dlgRemoveTeamTitle'), text: t('confirmRemove', { name: team.name }), ok: t('dlgRemove'), danger: true });
              if (ok) cmd({ type: 'removeTeam', teamId: team.id });
            },
          },
          '×',
        ),
      );
    }),
  );
  $('#start').disabled = teams.length === 0;
  $('#start-why').hidden = teams.length > 0;
}

// Fill the settings form from the game, unless the host is typing in it right now.
function renderSettings() {
  const form = $('#settings');
  for (const [key, value] of Object.entries(view.settings)) {
    const el = form.elements[key];
    // A pill group is a RadioNodeList: skip it too while one of its buttons has focus.
    const active = el instanceof RadioNodeList ? [...el].includes(document.activeElement) : el === document.activeElement;
    if (!el || active) continue;
    if (el.type === 'checkbox') el.checked = value;
    else el.value = String(value);
  }
  // Hide what doesn't apply right now, instead of greying it out.
  const st = view.settings;
  $('#final-setting').hidden = !view.set.final;
  $('#final-seconds').hidden = !st.finalRound;
  $('#negative-setting').hidden = st.penalty === 'none';
  $('#volume-setting').hidden = !st.music;
  // A Quick quiz has its own group; the board's rules, Kaosmodus, round 2, final and specials don't apply.
  $('#group-quick').hidden = !quick();
  for (const id of ['#group-crazy', '#group-rules']) $(id).hidden = quick();
  if (quick()) $('#final-setting').hidden = true;
  renderQuizOptions();
  renderCrazyKinds();
  renderMusicFiles();
  renderBrand();
  renderSummaries();
  renderRemote();
}

// The one-line status next to each folding section, so a closed section still says what is set.
function renderSummaries() {
  const st = view.settings;
  const secs = (n) => (n ? t('nSeconds', { n }) : t('noTimer'));
  const used = KINDS.length - st.crazyExclude.length;
  $('#crazy-status').textContent =
    st.crazy === 'off' ? t('crazyOff') : used === 0 ? t('crazyNoneShort') : t('crazySummary', { level: t(st.crazy === 'some' ? 'crazySome' : 'crazyLots'), n: used, total: KINDS.length });
  $('#crazy-status').classList.toggle('bad', st.crazy !== 'off' && used === 0);
  const penalty = { none: 'penaltyNone', half: 'penaltyHalf', full: 'penaltyFull' }[st.penalty];
  $('#rules-status').textContent = t('rulesSummary', { penalty: t(penalty), buzz: secs(st.buzzSeconds), answer: secs(st.answerSeconds) });
  $('#sound-status').textContent = t('soundSummary', {
    fx: t(st.sound ? 'stateOn' : 'stateOff'),
    music: st.music ? t('musicLevel', { pct: st.musicVolume }) : t('stateOff'),
  });
  const own = MUSIC_MOODS.filter((m) => st.musicFiles[m]).length;
  $('#music-files-status').textContent = own ? t('ownMusicSome', { n: own, total: MUSIC_MOODS.length }) : t('ownMusicNone');
  const accent = accentOf(brand?.accent);
  $('#look-status').textContent = [
    t('lookSummary', { state: t(st.glass ? 'stateOn' : 'stateOff') }),
    brand?.logo ? t('brandHasLogo') : null,
    accent === 'violet' ? null : t(`accent-${accent}`),
  ]
    .filter(Boolean)
    .join(' · ');
  $('#quick-status').textContent = t('quickSummary', {
    read: st.quickReadSeconds ? t('nSeconds', { n: st.quickReadSeconds }) : t('quickUntilSpace'),
    streak: t(st.quickStreak ? 'stateOn' : 'stateOff'),
    text: t(st.quickPhoneText ? 'stateOn' : 'stateOff'),
  });
}

// Your own music: a file per moment, or the built-in tune.
function renderMusicFiles() {
  const box = $('#music-files');
  box.hidden = !view.settings.music;
  const chosen = view.settings.musicFiles;
  const key = JSON.stringify(chosen) + view.settings.lang;
  if (box.dataset.key === key) return; // don't redraw (and stop a preview) on every update
  box.dataset.key = key;
  const setFile = (mood, name) => {
    const next = { ...chosen };
    if (name) next[mood] = name;
    else delete next[mood];
    cmd({ type: 'settings', settings: { musicFiles: next } });
  };
  fill(
    $('#music-file-list'),
    MUSIC_MOODS.map((mood) => {
      const name = chosen[mood];
      const status = h('small', { class: 'music-status' });
      const input = h('input', {
        type: 'file',
        accept: 'audio/*',
        hidden: true,
        onchange: async (e) => {
          const file = e.target.files[0];
          if (!file) return;
          status.textContent = t('edUploading');
          try {
            const r = await fetch(`/api/files?name=${encodeURIComponent(file.name)}`, { method: 'POST', body: file });
            const up = await r.json();
            if (!r.ok || up.kind !== 'audio') throw new Error('bad');
            setFile(mood, up.name);
          } catch {
            status.textContent = t('musicUploadFailed');
          }
        },
      });
      return h(
        'div',
        { class: 'music-row' },
        h('span', { class: 'music-mood' }, t(`mood-${mood}`)),
        name ? h('audio', { src: `/files/${encodeURIComponent(name)}`, controls: true, preload: 'metadata', onerror: () => (status.textContent = t('musicMissing')) }) : h('span', { class: 'music-builtin' }, t('musicBuiltIn')),
        h(
          'span',
          { class: 'row' },
          h('label', { class: 'btn' }, t('musicChoose'), input),
          name ? h('button', { class: 'btn btn-quiet', type: 'button', onclick: () => setFile(mood, null) }, t('musicUseBuiltIn')) : null,
        ),
        status,
      );
    }),
  );
}

// ----- branding: the logo, the event name and the accent colour (brand.js; saved through /api/brand) -----

// Which accent choice a saved colour is: one of ACCENTS, or 'custom'.
const accentOf = (color) => ACCENTS.find((a) => a.color === (color ?? null))?.id ?? 'custom';

async function saveBrand(patch) {
  try {
    const r = await fetch('/api/brand', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
    if (!r.ok) throw new Error('bad');
  } catch {
    brandMsg(t('brandFailed'), true);
  }
}
function brandMsg(text, bad = false) {
  $('#brand-logo-msg').textContent = text || t('brandLogoHint');
  $('#brand-logo-msg').classList.toggle('error', bad);
}

$('#brand-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = ''; // the same file can be chosen again
  if (!file) return;
  if (file.size > 2 * 1024 * 1024) return brandMsg(t('brandLogoTooBig'), true);
  brandMsg(t('brandUploading'));
  try {
    const r = await fetch('/api/brand/logo', { method: 'POST', body: file });
    const out = await r.json().catch(() => ({}));
    if (!r.ok) return brandMsg(t({ 'logo-too-big': 'brandLogoTooBig', 'logo-bad-type': 'brandLogoBadType' }[out.error] ?? 'brandFailed'), true);
    brandMsg('');
  } catch {
    brandMsg(t('brandFailed'), true);
  }
});
$('#brand-remove').addEventListener('click', async () => {
  try {
    const r = await fetch('/api/brand/logo', { method: 'DELETE' });
    if (!r.ok) throw new Error('bad');
    brandMsg('');
  } catch {
    brandMsg(t('brandFailed'), true);
  }
});
$('#brand-plate').addEventListener('change', (e) => saveBrand({ plate: e.target.checked }));
// The event name is saved a moment after typing stops (and at once when leaving the field).
let nameTimer = null;
$('#brand-name').addEventListener('input', (e) => {
  clearTimeout(nameTimer);
  nameTimer = setTimeout(() => saveBrand({ name: e.target.value }), 500);
});
$('#brand-name').addEventListener('change', (e) => {
  clearTimeout(nameTimer);
  saveBrand({ name: e.target.value });
});
// Dragging around the colour picker sends many colours: only the one it rests on for a moment is saved.
let colorTimer = null;
const pickColor = (color) => {
  clearTimeout(colorTimer);
  colorTimer = setTimeout(() => saveBrand({ accent: color }), 150);
};

function renderBrand() {
  const key = JSON.stringify([brand, view.settings.lang]);
  if ($('#brand').dataset.key === key) return;
  $('#brand').dataset.key = key;
  const logo = brandLogo(brand, 'brand-logo preview');
  fill($('#brand-preview'), logo ?? h('span', { class: 'brand-none' }, t('brandNoLogo')));
  $('#brand-preview').classList.toggle('empty', !logo);
  $('#brand-remove').hidden = !logo;
  $('#brand-choose').dataset.t = logo ? 'brandReplace' : 'brandChoose';
  $('#brand-choose').textContent = t($('#brand-choose').dataset.t);
  $('#brand-plate-row').hidden = !logo;
  $('#brand-plate').checked = Boolean(brand?.plate);
  if (!$('#brand-logo-msg').classList.contains('error') && $('#brand-logo-msg').textContent !== t('brandUploading')) brandMsg('');
  if (document.activeElement !== $('#brand-name')) $('#brand-name').value = brand?.name ?? '';
  // The accent colours: ProQuiz's violet, a few others, and one of your own.
  const chosen = accentOf(brand?.accent);
  $('#brand-accent-name').textContent = `· ${t(`accent-${chosen}`)}`;
  const swatch = (a) =>
    h(
      'label',
      { class: 'accent', title: t(`accent-${a.id}`), style: `--a: ${a.color ?? a.swatch}; --b: ${a.flare}` },
      h('input', { type: 'radio', name: 'brandAccent', value: a.id, checked: chosen === a.id, 'aria-label': t(`accent-${a.id}`), onchange: () => saveBrand({ accent: a.color }) }),
      h('span', {}),
    );
  // Your own colour: ProQuiz's colour box (the browser's own picker can open outside the window).
  const custom = h(
    'button',
    { type: 'button', id: 'brand-color', class: `accent custom${chosen === 'custom' ? ' on' : ''}`, title: t('accent-custom'), 'aria-label': t('accent-custom'), style: chosen === 'custom' ? `--a: ${brand.accent}` : '', onclick: chooseOwnColor },
    h('span', {}),
  );
  fill($('#brand-accents'), ACCENTS.map(swatch), custom);
}

// The colour changes everywhere as the sliders move; Cancel puts the old one back.
async function chooseOwnColor() {
  const before = brand?.accent ?? null;
  const color = await askColor({ title: t('dlgColorTitle'), value: before ?? '#6f55ff', ok: t('dlgColorUse'), onPreview: pickColor });
  if (color) pickColor(color);
  else {
    clearTimeout(colorTimer);
    saveBrand({ accent: before });
  }
}

// Kaosmodus: a tick for each special; unticked ones are left out of the game.
function renderCrazyKinds() {
  const box = $('#crazy-kinds');
  box.hidden = view.settings.crazy === 'off';
  const excluded = view.settings.crazyExclude;
  if (!$('#crazy-kind-list').children.length) {
    fill(
      $('#crazy-kind-list'),
      KINDS.map((kind) =>
        h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'crazyKind', value: kind }), h('span', { class: `kind-icon k-${kind}` }, ICONS[kind]), h('span', { 'data-t': `n-${kind}` }, t(`n-${kind}`))),
      ),
    );
  }
  for (const input of box.querySelectorAll('input[name=crazyKind]')) input.checked = !excluded.includes(input.value);
  $('#crazy-none').hidden = excluded.length < KINDS.length;
}

// Ticks that only make sense for the chosen quiz: its round 2 and its own special tiles.
function renderQuizOptions() {
  // Specials placed by hand in the quiz: only offered when the quiz has some.
  const own = Object.keys(ownSpecials(view.set.categories)).length + Object.keys(ownSpecials(view.set.round2?.categories)).length;
  $('#quiz-specials').hidden = own === 0 || quick();
  $('#quiz-specials-label').textContent = t('quizSpecials', { n: own });
  // Round 2: only offered when the quiz has one.
  const r2 = view.set.round2?.categories ?? [];
  $('#round2-setting').hidden = r2.length === 0 || quick();
  $('#round2-label').textContent = t('round2Setting', { n: r2.reduce((n, c) => n + c.questions.length, 0) });
}

$('#settings').addEventListener('change', (e) => {
  const el = e.target;
  if (!el.name || el.type === 'file' || el.closest('#brand')) return; // the music file pickers upload by themselves; branding saves itself
  if (el.name === 'crazyKind') {
    const excluded = [...$('#settings').querySelectorAll('input[name=crazyKind]')].filter((x) => !x.checked).map((x) => x.value);
    return cmd({ type: 'settings', settings: { crazyExclude: excluded } });
  }
  let value = el.type === 'checkbox' ? el.checked : el.value;
  if (el.type === 'number' || el.type === 'range') {
    value = Math.round(Number(value));
    if (!Number.isFinite(value) || value < Number(el.min) || value > Number(el.max)) {
      el.value = String(view.settings[el.name]);
      return;
    }
  }
  cmd({ type: 'settings', settings: { [el.name]: value } });
});

$('#start').addEventListener('click', () => cmd({ type: 'start' }));

// The list of quizzes to choose from (fetched when the lobby shows, and when the window gets focus again).
let quizList = [];
async function loadQuizzes() {
  try {
    quizList = await (await fetch('/api/sets')).json();
  } catch {
    return;
  }
  renderSetPicker();
}
function renderSetPicker() {
  const sel = $('#set-picker');
  // Edit opens the editor on the quiz chosen here.
  if (view?.setId) $('#edit-set').href = `/editor#${encodeURIComponent(view.setId)}`;
  if (!view || sel === document.activeElement) return;
  const opts = quizList.map((q) => {
    const title = q.kind === 'quick' ? `${q.title} · ${t('quickTag')}` : q.title; // a Quick quiz gets a small tag
    return h('option', { value: q.id, disabled: q.problems > 0 }, q.problems ? `${title} (${t('needsFixing')})` : title);
  });
  if (!quizList.some((q) => q.id === view.setId)) opts.unshift(h('option', { value: view.setId ?? '' }, view.set.title));
  sel.replaceChildren(...opts);
  sel.value = view.setId ?? '';
}
$('#set-picker').addEventListener('change', (e) => net.send({ type: 'chooseSet', id: e.target.value }));
window.addEventListener('focus', loadQuizzes);
loadQuizzes();
$('#test-sound').addEventListener('click', () => net.send({ type: 'testSound' }));
$('#resume-yes').addEventListener('click', () => net.send({ type: 'resume' }));
$('#resume-no').addEventListener('click', () => net.send({ type: 'discardSave' }));
// Leave the game for the main menu. It is kept, and the lobby offers to continue it.
$('#menu-btn').addEventListener('click', async () => {
  if (await ask({ title: t('dlgMainMenuTitle'), text: t('confirmMainMenu'), ok: t('dlgMainMenuOk') })) net.send({ type: 'mainMenu' });
});

function renderResume() {
  $('#resume').hidden = !resume;
  if (!resume) return;
  const time = new Date(resume.savedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  $('#resume-text').textContent = t(resume.mode === 'quick' ? 'resumeTextQuick' : resume.round === 2 ? 'resumeTextRound2' : 'resumeText', { title: resume.title, time, played: resume.played, total: resume.total });
  $('#resume-teams').replaceChildren(
    ...resume.teams.map((tm) => h('li', { class: 'plate', style: teamStyle(tm) }, face(tm), h('span', {}, tm.name), h('b', {}, String(tm.score)))),
  );
}

// ----- game -----

// The buttons for the current moment. Each has a key; the same list drives the keyboard.
function controls() {
  const p = view.phase;
  const list = [];
  const add = (key, label, action, cls = '', team = null) => list.push({ key, label, action, cls, team });
  if (quick()) quickControls(add);
  else if (p === 'special') {
    add(' ', view.q.special === 'bomb' ? t('bombGo') : t('specialGo'), { type: 'next' }, 'btn-primary');
    add('Escape', t('cancelBtn'), { type: 'cancel' });
  } else if (p === 'reading') {
    add(' ', view.q.solo ? t('soloArm') : t('armBtn'), { type: 'arm' }, 'btn-primary');
    add('r', t('revealBtn'), { type: 'reveal' });
    add('Escape', t('cancelBtn'), { type: 'cancel' });
  } else if (p === 'armed') {
    add('r', t('revealBtn'), { type: 'reveal' });
    if (!view.q.lockedOut.length) add('Escape', t('cancelBtn'), { type: 'cancel' });
  } else if (p === 'answering') {
    add('y', t('correctBtn'), { type: 'correct' }, 'btn-good');
    add('n', t('wrongBtn'), { type: 'wrong' }, 'btn-bad');
  } else if (p === 'revealed') {
    add(' ', t('nextBtn'), { type: 'next' }, 'btn-primary');
  } else if (p === 'round2') {
    add(' ', t('startRound2'), { type: 'next' }, 'btn-primary');
  } else if (p === 'board') {
    add('e', t('endBoardBtn'), async () => (await ask({ title: t('dlgEndTitle'), text: t('confirmEnd'), ok: t('endBoardBtn') })) && cmd({ type: 'end' }));
  } else if (p === 'finalWager') {
    add(' ', t('showFinalQ'), { type: 'next' }, 'btn-primary');
  } else if (p === 'finalQuestion') {
    add(' ', t('stopAnswers'), { type: 'next' }, 'btn-primary');
  } else if (p === 'finalJudge') {
    const left = view.teams.filter((tm) => !(tm.id in view.final.judged)).length;
    add(' ', t('showScores'), async () => (left === 0 || (await ask({ title: t('dlgUnjudgedTitle'), text: t('confirmUnjudged', { n: left }), ok: t('showScores') }))) && cmd({ type: 'next' }), 'btn-primary');
  } else if (p === 'over') {
    add(' ', t('restartBtn'), confirmRestart, 'btn-primary');
  }
  if (singleScreen()) {
    // With no separate TV screen, the choices that need the host view on a TV setup get buttons here.
    if (p === 'special' && view.q.special === 'freeze') {
      for (const tm of view.teams.filter((x) => x.id !== view.picker)) {
        add('', `🧊 ${tm.name}`, { type: 'freeze', teamId: tm.id }, `team-btn${view.q.frozen === tm.id ? ' on' : ''}`, tm);
      }
    }
    if (p === 'finalJudge') {
      for (const tm of view.teams) {
        const v = view.final.judged[tm.id];
        add('', `✓ ${tm.name}`, { type: 'judgeFinal', teamId: tm.id, correct: v === true ? null : true }, `team-btn${v === true ? ' on' : ''}`, tm);
        add('', `✗ ${tm.name}`, { type: 'judgeFinal', teamId: tm.id, correct: v === false ? null : false }, `team-btn${v === false ? ' on' : ''}`, tm);
      }
    }
    add('h', peek ? t('tvViewBtn') : t('hostViewBtn'), () => {
      peek = !peek;
      render();
    });
  }
  if (view.media) {
    add('p', view.media.playing ? t('clipPause') : t('clipPlay'), { type: 'mediaToggle' });
    add('0', t('clipRestart'), { type: 'mediaRestart' });
  }
  if (view.canUndo && p !== 'over') add('u', t('undoBtn'), { type: 'undo' }, 'push');
  add('b', view.settings.music ? t('musicIsOn') : t('musicIsOff'), { type: 'settings', settings: { music: !view.settings.music } }, view.canUndo && p !== 'over' ? '' : 'push');
  add('m', view.settings.sound ? t('soundIsOn') : t('soundIsOff'), { type: 'settings', settings: { sound: !view.settings.sound } });
  return list;
}

// Quick quiz: Space always goes one step on, Esc skips a question that is showing.
function quickControls(add) {
  const p = view.phase;
  const next = { type: 'next' };
  if (p === 'section') add(' ', t('startSection'), next, 'btn-primary');
  else if (p === 'ready') {
    add(' ', t('showAnswersBtn'), next, 'btn-primary');
    add('Escape', t('skipQuestion'), { type: 'skip' });
  } else if (p === 'open') {
    add(' ', t('stopNow'), next, 'btn-primary');
    add('Escape', t('skipQuestion'), { type: 'skip' });
  } else if (p === 'result') add(' ', t('showTop'), next, 'btn-primary');
  else if (p === 'ranks') {
    const lastQ = view.pos.i + 1 >= view.set.sections[view.pos.s].questions.length;
    const lastS = view.pos.s + 1 >= view.set.sections.length;
    add(' ', t(!lastQ ? 'nextQuestion' : !lastS ? 'nextSection' : 'showPodium'), next, 'btn-primary');
  } else if (p === 'over') add(' ', t('restartBtn'), confirmRestart, 'btn-primary');
}

// Back to the main menu at the end (same teams, scores to zero).
const confirmRestart = async () => (await ask({ title: t('dlgRestartTitle'), text: t('confirmRestart'), ok: t('restartBtn') })) && cmd({ type: 'restart' });
const run = (action) => (typeof action === 'function' ? action() : cmd(action));
const keyLabel = (key) => ({ ' ': 'Space', Escape: 'Esc' })[key] ?? key.toUpperCase();

// The keyboard help (? or the Keys button). A Quick quiz has fewer keys, and Space and Esc do other things.
const helpRows = () =>
  quick()
    ? [['Space', 'helpSpaceQuick'], ['Esc', 'helpEscQuick'], ...HELP.filter(([key]) => !['Space', 'Y', 'N', 'R', 'Esc', 'E'].includes(key))]
    : HELP;
const HELP = [
  ['Space', 'helpSpace'],
  ['Y', 'helpY'],
  ['N', 'helpN'],
  ['R', 'helpR'],
  ['Esc', 'helpEsc'],
  ['U', 'helpU'],
  ['P', 'helpP'],
  ['0', 'help0'],
  ['M', 'helpM'],
  ['B', 'helpB'],
  ['H', 'helpH'],
  ['F', 'helpF'],
  ['E', 'helpE'],
  ['?', 'helpHelp'],
];
function toggleHelp(show = $('#help').hidden) {
  fill(
    $('#help'),
    h(
      'div',
      { class: 'help-card', role: 'dialog', 'aria-label': t('helpTitle') },
      h('h2', {}, t('helpTitle')),
      h('dl', {}, helpRows().map(([key, text]) => [h('dt', {}, h('kbd', {}, key)), h('dd', {}, t(text))])),
      h('p', { class: 'help-foot' }, t('helpTv')),
      h('button', { class: 'btn btn-primary', type: 'button', onclick: () => toggleHelp(false) }, t('helpClose')),
    ),
  );
  $('#help').hidden = !show;
}
$('#help-btn').addEventListener('click', () => toggleHelp());
$('#help').addEventListener('click', (e) => e.target === $('#help') && toggleHelp(false));

// Returns true when the key did something.
function handleKey(e) {
  if (e.key === '?') return toggleHelp(), true;
  if (e.key === 'Escape' && !$('#help').hidden) return toggleHelp(false), true;
  if (!view || view.phase === 'lobby' || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return false;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (key === 'f' && singleScreen()) {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen().catch(() => {});
    return true;
  }
  const c = controls().find((x) => x.key === key);
  if (!c) return false;
  run(c.action);
  return true;
}
document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, select, textarea') || modalOpen()) return; // a pop-up question has the keys
  if (handleKey(e)) e.preventDefault();
});
// The TV view inside this page passes on its key presses and tile clicks.
window.addEventListener('message', (e) => {
  if (e.origin !== location.origin || !e.data?.proquiz) return;
  if (e.data.type === 'key' && !modalOpen()) handleKey(e.data);
  if (e.data.type === 'pick') cmd({ type: 'pick', c: e.data.c, i: e.data.i });
});

function renderControls() {
  return h(
    'nav',
    { class: 'controls', 'aria-label': t('controlsLabel') },
    controls().map((c) =>
      h(
        'button',
        { class: `btn ${c.cls}`, type: 'button', style: c.team ? teamStyle(c.team) : false, onclick: (e) => (e.currentTarget.blur(), run(c.action)) },
        c.label,
        c.key ? h('kbd', {}, keyLabel(c.key)) : null,
      ),
    ),
  );
}

function boardHint() {
  if (!view.picker) return t('boardHint');
  const name = teamName(view.picker);
  if (!view.settings.phonePick) return `${t('picks', { name })}. ${t('boardHint')}`;
  return connected.has(view.picker) ? t('boardHintPhone', { name }) : t('noPhonePicker', { name });
}

function renderBoard() {
  return h(
    'div',
    {},
    h('p', { class: 'board-hint' }, view.round === 2 ? h('span', { class: 'round-tag' }, t('round2Title')) : null, boardHint()),
    h(
      'div',
      { class: 'host-board' },
      view.set.categories.map((cat, c) =>
        h(
          'div',
          { class: 'col' },
          h('div', { class: 'cat' }, cat.name),
          cat.questions.map((q, i) => {
            const kind = view.used[c][i] ? null : view.specials?.[`${c}-${i}`];
            return h(
              'button',
              { class: 'tile', type: 'button', disabled: view.used[c][i], 'data-special': kind || false, title: kind ? t(`k-${kind}`) : false, onclick: () => cmd({ type: 'pick', c, i }) },
              String(q.value),
              kind ? h('span', { class: 'tile-special' }, ICONS[kind]) : null,
            );
          }),
        ),
      ),
    ),
    Object.keys(view.specials ?? {}).length ? h('p', { class: 'board-hint specials-note' }, t('specialsNote')) : null,
  );
}

// Kaosmodus: the reveal, as the host sees it (the freeze choice is made here).
function renderSpecialHost() {
  const q = view.q;
  const kind = q.special;
  return h(
    'div',
    { class: 'host-q host-special' },
    h('p', { class: 'where' }, `${view.set.categories[q.c].name} `, h('b', {}, String(q.value))),
    h('div', { class: `special-card k-${kind}` }, h('span', { class: 'special-icon' }, ICONS[kind]), h('div', {}, h('h2', {}, t(`k-${kind}`)), h('p', {}, ruleFor(view)))),
    kind === 'double' ? doubleBetForm() : null,
    kind === 'freeze'
      ? h(
          'div',
          { class: 'freeze-pick' },
          h('p', {}, t(connected.has(view.picker) ? 'freezePickPhone' : 'freezePick')),
          h(
            'div',
            { class: 'row' },
            view.teams
              .filter((tm) => tm.id !== view.picker)
              .map((tm) =>
                h(
                  'button',
                  { class: `btn plate${q.frozen === tm.id ? ' on' : ''}`, style: teamStyle(tm), type: 'button', 'aria-pressed': String(q.frozen === tm.id), onclick: () => cmd({ type: 'freeze', teamId: tm.id }) },
                  `${ICONS.freeze} ${tm.name}`,
                ),
              ),
          ),
        )
      : null,
  );
}

// Daily Double: the team bets on its phone; the host can type it in as well (or just go on with the tile's value).
function doubleBetForm() {
  const q = view.q;
  const picker = view.teams.find((tm) => tm.id === view.picker);
  const max = maxBet(view.set.categories, picker?.score ?? 0);
  const input = h('input', { id: 'double-bet', type: 'number', min: 0, max, step: 1, value: q.bet ?? '', 'aria-label': t('doubleBet') });
  return h(
    'form',
    {
      class: 'double-bet',
      onsubmit: (e) => {
        e.preventDefault();
        const amount = Math.round(Number(input.value));
        if (input.value !== '' && Number.isFinite(amount)) cmd({ type: 'bet', amount });
      },
    },
    h('p', {}, t('doubleBetHint', { name: picker?.name ?? '', n: max })),
    h('label', { class: 'field' }, h('span', {}, t('doubleBet')), input),
    h('button', { class: 'btn', type: 'submit' }, t('doubleBetSet')),
    q.bet == null ? h('p', { class: 'muted' }, t('doubleNoBet', { n: q.value })) : null,
  );
}

function statusLine() {
  const q = view.q;
  const p = view.phase;
  if (p === 'reading') return h('p', { class: 'host-status' }, q.solo ? t('soloStatus', { name: teamName(q.solo) }) : t('statusReading'));
  if (p === 'armed') {
    const wrongTeam = view.event?.reopened ? view.event.teamId : null;
    return h('p', { class: 'host-status' }, wrongTeam ? t('wrongReopen', { name: teamName(wrongTeam) }) : t('buzzersOn'));
  }
  if (p === 'answering') {
    const team = view.teams.find((tm) => tm.id === q.buzzedTeam);
    return h('p', { class: 'host-status' }, h('span', { class: 'plate', style: teamStyle(team) }, face(team), team.name), t('buzzedFirst', { name: '' }).trim());
  }
  if (p === 'revealed') {
    const r = q.result;
    const text =
      r.type === 'boom'
        ? t('boomResult', { name: teamName(r.teamId), n: r.amount })
        : r.type === 'correct' && q.won
          ? t('jackpotWon', { name: teamName(r.teamId), n: q.value, pot: q.won })
          : r.type === 'correct'
            ? t('resultCorrect', { name: teamName(r.teamId), n: q.value })
            : q.fullPenalty && q.lockedOut.includes(q.solo)
              ? t('doubleLost', { name: teamName(q.solo), n: q.value })
              : r.type === 'timeout'
              ? t('resultTimeout')
              : t('resultNobody');
    return h('p', { class: 'host-status' }, text);
  }
  return null;
}

// Who buzzed after the winner, and how close it was.
function buzzOrder() {
  const b = view.q.buzzes;
  if (view.phase !== 'answering' || b.length < 2) return null;
  const first = b[0].at;
  return h(
    'p',
    { class: 'buzz-order' },
    `${t('alsoBuzzed')} `,
    b.slice(1).map((x) => t('lateBy', { name: teamName(x.teamId), ms: Math.round(x.at - first) })).join(', '),
    view.settings.fairBuzz ? h('small', {}, ` ${t('buzzCorrected')}`) : null,
  );
}

const img = (name, cls, label) =>
  name ? h('figure', { class: cls }, h('img', { src: `/files/${encodeURIComponent(name)}`, alt: '' }), label ? h('figcaption', {}, label) : null) : null;

function renderQuestion() {
  const q = view.q;
  const src = view.set.categories[q.c].questions[q.i];
  return h(
    'div',
    { class: 'host-q' },
    h('p', { class: 'where' }, `${view.set.categories[q.c].name} `, h('b', {}, String(q.value)), q.special ? h('span', { class: `special-badge k-${q.special}` }, badgeFor(view)) : null),
    src.image || src.answerImage
      ? h('div', { class: 'host-imgs' }, img(src.image, 'host-img', t('picQuestion')), img(src.answerImage, 'host-img', t('picAnswer')))
      : null,
    src.question ? h('p', { class: 'question' }, src.question) : null,
    h('p', { class: 'answer' }, h('span', {}, `${t('answerLabel')}:`), src.answer),
    clipLine(src),
    unveilLine(q),
    statusLine(),
    countdown(view),
    buzzOrder(),
  );
}

// How clear the slowly appearing picture is on the TV right now (kept up to date by the loop below).
function unveilLine(q) {
  if (!q.unveil) return null;
  if (view.phase === 'reading') return h('p', { class: 'clip-line' }, h('span', { class: 'clip-dot' }), t('unveilWaiting'));
  return h('p', { class: 'clip-line on', 'data-unveil-pct': '' }, h('span', { class: 'clip-dot' }), h('span', {}));
}
function runUnveilLine() {
  const tick = () => {
    const el = document.querySelector('[data-unveil-pct]');
    if (el && view?.q?.unveil) el.lastChild.textContent = t('unveilPct', { n: Math.round(unveilProgress(view.q.unveil, net.now()) * 100) });
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
runUnveilLine();

// "Sound clip: playing" / "paused", so the host knows what the room hears.
function clipLine(src) {
  if (!src.audio) return null;
  const on = view.media?.playing;
  return h('p', { class: `clip-line${on ? ' on' : ''}` }, h('span', { class: 'clip-dot' }), on ? t('clipPlaying') : t('clipPaused'), src.audioStart ? ` (${t('clipFrom', { s: src.audioStart })})` : '');
}

// ----- final round -----

function renderFinal() {
  const f = view.final;
  const src = view.set.final;
  const p = view.phase;
  const head = [
    h('p', { class: 'where' }, t('finalRound'), h('b', {}, src.category)),
    p !== 'finalWager' && (src.image || src.answerImage)
      ? h('div', { class: 'host-imgs' }, img(src.image, 'host-img', t('picQuestion')), img(src.answerImage, 'host-img', t('picAnswer')))
      : null,
    h('p', { class: 'question' }, p === 'finalWager' ? t('hostWagerHint') : src.question),
    h('p', { class: 'answer' }, h('span', {}, `${t('answerLabel')}:`), src.answer),
    p !== 'finalWager' ? clipLine(src) : null,
  ];
  if (p === 'finalQuestion') head.push(countdown(view));
  const rows = view.teams.map((tm) => {
    const wager = f.wagers[tm.id];
    const answer = f.answers[tm.id];
    const verdict = f.judged[tm.id];
    const cells = [h('span', { class: 'who' }, face(tm), tm.name), h('span', { class: 'bet' }, wager == null ? t('betWaiting') : t('betAmount', { n: wager }))];
    if (p !== 'finalWager') cells.push(h('span', { class: 'said' }, answer == null ? t(p === 'finalJudge' ? 'noAnswer' : 'noAnswerYet') : answer || '—'));
    if (p === 'finalJudge') {
      const judge = (correct) => cmd({ type: 'judgeFinal', teamId: tm.id, correct: verdict === correct ? null : correct });
      cells.push(
        h(
          'span',
          { class: 'verdict' },
          h('button', { class: `btn btn-good${verdict === true ? ' on' : ''}`, type: 'button', onclick: () => judge(true), 'aria-pressed': String(verdict === true) }, t('correctBtn')),
          h('button', { class: `btn btn-bad${verdict === false ? ' on' : ''}`, type: 'button', onclick: () => judge(false), 'aria-pressed': String(verdict === false) }, t('wrongBtn')),
        ),
      );
    }
    return h('li', { class: `final-row${verdict === undefined ? '' : ' judged'}`, style: teamStyle(tm) }, cells);
  });
  return h('div', { class: 'host-q host-final' }, head, h('ul', { class: 'final-rows' }, rows));
}

// Round 2's intro: who picks first, and the scores so far.
function renderRound2Host() {
  const top = Math.max(0, ...view.set.categories.flatMap((cat) => cat.questions.map((q) => q.value)));
  return h(
    'div',
    { class: 'host-over' },
    h('h2', {}, t('round2Title')),
    h('p', { class: 'board-hint' }, `${t('round2PicksFirst', { name: teamName(view.picker) })}. ${t('round2UpTo', { n: top })}.`),
    h('ol', { class: 'rank-list' }, ranking(view.teams).map((tm) => h('li', { class: 'plate', style: teamStyle(tm) }, h('span', {}, face(tm), tm.name), h('span', {}, String(tm.score))))),
  );
}

function renderOver() {
  const ranked = ranking(view.teams);
  const tie = ranked.length > 1 && ranked[0].score === ranked[1].score;
  return h(
    'div',
    { class: 'host-over' },
    h('h2', {}, ranked.length ? (tie ? t('tie') : t('winner', { name: ranked[0].name })) : t('gameOver')),
    h('ol', { class: 'rank-list' }, ranked.map((tm) => h('li', { class: 'plate', style: teamStyle(tm) }, h('span', {}, face(tm), tm.name), h('span', {}, String(tm.score))))),
  );
}

function renderScores() {
  const q = view.q;
  return h(
    'aside',
    { class: 'host-side' },
    h('h2', {}, t('teams')),
    view.teams.map((team) =>
      h(
        'div',
        {
          class: `score-row plate${q?.buzzedTeam === team.id ? ' buzzed' : ''}${q?.lockedOut.includes(team.id) ? ' out' : ''}`,
          style: teamStyle(team),
        },
        h(
          'span',
          { class: 'name' },
          h('span', { class: `dot${connected.has(team.id) ? ' on' : ''}`, title: connected.has(team.id) ? t('online') : t('offline') }),
          face(team),
          team.name,
        ),
        h('span', { class: 'pts' }, String(team.score)),
        h(
          'span',
          { class: 'tools' },
          view.picker === team.id
            ? h('span', { class: 'picker-tag' }, t('picksShort'))
            : h('button', { type: 'button', onclick: () => cmd({ type: 'setPicker', teamId: team.id }) }, t('makePicker')),
          h('button', { type: 'button', onclick: () => adjust(team) }, t('adjustBtn')),
        ),
      ),
    ),
  );
}

// ----- Quick quiz (multiple choice) -----

const quickSection = () => view.set.sections[view.pos?.s];

// Where we are: "Warm-up · Question 3 of 5", with the points tag for a double or a no-points question.
function quickWhere() {
  const sec = quickSection();
  const q = view.q;
  return h(
    'p',
    { class: 'where' },
    t('quickSectionOf', { n: view.pos.s + 1, total: view.set.sections.length }),
    q ? h('b', {}, sec.name) : null, // the section card has the name as its heading
    q ? t('quickQuestionOf', { n: view.pos.i + 1, total: sec.questions.length }) : null,
    q?.points === 2000 ? h('span', { class: 'pts-badge double' }, `×2 ${t('quickDouble')}`) : q?.points === 0 ? h('span', { class: 'pts-badge' }, t('quickSurvey')) : null,
  );
}

// The options as the host sees them: the right one marked, and how many picked each after the answers close.
function quickOptions(src) {
  const q = view.q;
  const settled = q.counts != null && ['result', 'ranks'].includes(view.phase);
  const rights = [].concat(q.correct ?? []); // one or more right options
  return h(
    'ol',
    { class: 'host-opts' },
    src.options.map((text, i) =>
      h(
        'li',
        { class: `host-opt${rights.includes(i) ? ' right' : ''}`, style: optionStyle(OPTION_COLORS[i]) },
        h('span', { class: 'opt-shape' }, shapeSvg(SHAPES[i])),
        h('span', { class: 'opt-text' }, text),
        rights.includes(i) ? h('span', { class: 'opt-right', title: t('quickRightMark') }, '✓') : null,
        settled ? h('span', { class: 'opt-count' }, t('quickPicked', { n: q.counts[i] })) : null,
      ),
    ),
  );
}

function quickStatus() {
  const q = view.q;
  const p = view.phase;
  const answered = Object.keys(q.answers).filter((id) => view.teams.some((tm) => tm.id === id)).length;
  if (p === 'ready') return h('p', { class: 'host-status' }, t(view.deadline == null ? 'quickHostReadyWait' : 'quickHostReady'));
  if (p === 'open') return h('p', { class: 'host-status' }, t('quickAnswered', { n: answered, total: view.teams.length }));
  const right = [].concat(q.correct ?? []).reduce((n, i) => n + (q.counts?.[i] ?? 0), 0); // everyone who picked a right one
  const fastest = q.fastest
    ? h('span', { class: 'fastest' }, `⚡ ${fastestTitle(view.pos)}`, h('span', { class: 'plate', style: teamStyle(q.fastest) }, face(q.fastest), q.fastest.name), secondsText(q.fastest.ms))
    : null;
  if (p === 'result') return h('p', { class: 'host-status' }, q.points === 0 ? t('quickSurvey') : right ? t('quickGotIt', { n: right, total: view.teams.length }) : t('quickNobodyRight'), fastest);
  return h('p', { class: 'host-status' }, t('quickHostRanks'));
}

const rankLine = (e) => h('li', { class: 'plate', style: teamStyle(e) }, h('span', {}, `${e.rank}. `, face(e), e.name), h('span', {}, e.delta ? h('small', { class: 'gain' }, `+${e.delta} `) : null, String(e.score)));

function renderQuickHost() {
  const p = view.phase;
  if (p === 'over') return renderOver();
  if (p === 'section') {
    const sec = quickSection();
    return h(
      'div',
      { class: 'host-q host-over' },
      quickWhere(),
      h('h2', {}, sec.name),
      h('p', { class: 'board-hint' }, `${t('quickNQuestions', { n: sec.questions.length })}. ${t('quickHostSection')}`),
      view.standings.some((e) => e.score > 0) ? h('ol', { class: 'rank-list' }, view.standings.slice(0, 10).map(rankLine)) : null,
    );
  }
  const src = quickSection().questions[view.pos.i];
  return h(
    'div',
    { class: 'host-q host-quick' },
    quickWhere(),
    src.image ? h('div', { class: 'host-imgs' }, img(src.image, 'host-img', t('picQuestion'))) : null,
    src.question ? h('p', { class: 'question' }, src.question) : null,
    quickOptions(src),
    clipLine(src),
    quickStatus(),
    p === 'ready' || p === 'open' ? countdown(view) : null,
    p === 'ranks' ? h('ol', { class: 'rank-list' }, view.ranks.top.map(rankLine)) : null,
  );
}

// Everyone's score, highest first (a Quick quiz can have up to 30 players), with a tick for who has answered.
function renderQuickScores() {
  const q = view.q;
  const p = view.phase;
  return h(
    'aside',
    { class: 'host-side quick-side' },
    h('h2', {}, `${t('players')} (${view.teams.length})`),
    view.standings.map((e) => {
      const answered = q && p === 'open' && q.answers[e.id];
      const gain = q?.gained && ['result', 'ranks'].includes(p) ? q.gained[e.id] : undefined;
      return h(
        'div',
        { class: `score-row plate${answered ? ' answered' : ''}`, style: teamStyle(e) },
        h(
          'span',
          { class: 'name' },
          h('span', { class: `dot${connected.has(e.id) ? ' on' : ''}`, title: connected.has(e.id) ? t('online') : t('offline') }),
          h('span', { class: 'rank-small' }, `${e.rank}.`),
          face(e),
          e.name,
          answered ? h('span', { class: 'answered-tick' }, '✓') : null,
        ),
        h('span', { class: 'pts' }, gain ? h('small', { class: 'gain' }, `+${gain} `) : null, String(e.score)),
        h('span', { class: 'tools' }, h('button', { type: 'button', onclick: () => adjust(e) }, t('adjustBtn'))),
      );
    }),
  );
}

async function adjust(team) {
  const delta = await askNumber({
    title: t('adjustBtn'),
    text: t('adjustPrompt', { name: team.name }),
    ok: t('dlgAdjustOk'),
    preview: (n) => t('dlgAdjustPreview', { score: team.score + n }),
  });
  if (delta) cmd({ type: 'adjust', teamId: team.id, delta });
}

// Single-screen mode: no separate TV screen is open, so this page shows the TV view (answers hidden),
// with the controls underneath. H switches to the host view and back.
const singleScreen = () => Boolean(view) && view.phase !== 'lobby' && tvs === 0;
let stage = null; // the TV view, kept between updates (moving an iframe would reload it)

function renderStage() {
  if (!stage) {
    stage = h('div', { class: 'stage-area' }, h('iframe', { src: '/display?embedded', title: t('openDisplay'), allow: 'autoplay; fullscreen' }), h('div', { class: 'stage-controls' }));
    $('#game').append(stage);
  }
  fill(stage.querySelector('.stage-controls'), renderControls());
}

function renderGame() {
  const tvView = singleScreen() && !peek;
  if (singleScreen()) renderStage();
  else if (stage) {
    stage.remove(); // a separate TV screen took over: this page goes back to being the host view
    stage = null;
    peek = false;
  }
  if (stage) stage.hidden = !tvView;
  let hostArea = $('#game > .host-game');
  if (tvView) {
    hostArea?.remove();
    return;
  }
  const p = view.phase;
  let main;
  if (quick()) main = renderQuickHost();
  else if (p === 'board') main = renderBoard();
  else if (p === 'round2') main = renderRound2Host();
  else if (p === 'special') main = renderSpecialHost();
  else if (view.q) main = renderQuestion();
  else if (p === 'over') main = renderOver();
  else main = renderFinal();
  const note = singleScreen() ? h('p', { class: 'peek-note' }, t('peekNote')) : null;
  const area = h('div', { class: 'host-game' }, h('main', { class: 'host-main' }, note, main), quick() ? renderQuickScores() : renderScores(), renderControls());
  if (hostArea) hostArea.replaceWith(area);
  else $('#game').prepend(area);
}

// ----- everything -----

function render() {
  document.body.dataset.phase = view.phase; // handy for the browser test
  document.body.dataset.mode = view.mode ?? 'board';
  $('#teams-title').dataset.t = quick() ? 'players' : 'teams';
  $('#no-teams').dataset.t = quick() ? 'noPlayersYet' : 'noTeamsYet';
  $('#start-why').dataset.t = quick() ? 'needPlayer' : 'needTeam';
  setGlass(view.settings.glass, { remember: true }); // the editor follows this choice
  setBrand(brand);
  setLang(view.settings.lang);
  translatePage();
  renderQr();
  renderRemoteWarn();
  showError('');
  $('#set-title').textContent = view.set.title;
  const inLobby = view.phase === 'lobby';
  $('#lobby').hidden = !inLobby;
  $('#game').hidden = inLobby;
  $('#menu-btn').hidden = inLobby;
  if (inLobby) {
    renderResume();
    renderTeams();
    renderSettings();
    renderSetPicker();
  } else {
    renderGame();
  }
  // With no TV screen open, this laptop plays the question's sound clip.
  if (displays === 0) {
    syncClip(view, quick() ? `quick-${view.pos?.s}-${view.pos?.i}` : view.q ? `q${view.round}-${view.q.c}-${view.q.i}` : 'final');
    syncMusic(view, net.now());
  } else {
    stopClip();
    stopMusic();
  }
  showUnlock();
}

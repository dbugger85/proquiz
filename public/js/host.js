// The host laptop: lobby with settings, then the game controls. The host sees the answers.
//
// Keys: Space = turn buzzers on / back to the board, Y = correct, N = wrong, R = show answer,
// Esc = put the question back, U = undo.
import { ranking, COLORS, KINDS, unveilProgress, MUSIC_MOODS, maxBet, SHAPES, OPTION_COLORS, MAX_PLAYERS, MAX_TEAMS, wantsText } from '/lib/game.js';
import { languagesOf, languageName, flagUrl, textOf, optionsOf } from '/lib/languages.js';
import { connect } from './net.js';
import { t, pts, setLang, translatePage, fastestTitle, secondsText, licenseName, mss, lengthText } from './i18n.js';
import { $, h, fill, qrSvg, shortUrl, urlNodes, countdown, runCountdowns, teamStyle, setGlass, shapeSvg, optionStyle, setBrand, brandLogo, ACCENTS, ask, askNumber, askColor, modalOpen } from './ui.js';
import { unlockAudio, audioReady, playEvent, playSound, startTicks, setSoundVolume } from './sounds.js';
import { syncClip, stopClip } from './clip.js';
import { syncMusic, stopMusic } from './music.js';
import { ICONS, ruleFor, badgeFor } from './specials.js';
import { ownSpecials } from '/lib/crazy.js';
import { avatarEl } from './avatar.js';
import { fileUrl, HOSTED, setRoom, wsPath, pagePath } from './env.js';
import { MAX_ROOM_FILE } from '/lib/room.js';
import { logoKind } from '/lib/mime.js';
import { MAX_LOGO, NO_BRAND } from '/lib/brand-core.js';
import { myRoom, makeRoom } from './myroom.js';
import { usedFiles, validateSet } from '/lib/validate.js';
import { api, store } from './quizapi.js';
import { refreshBackup } from './backup.js';

// A team's avatar (mascot or player face) in a list, or nothing for a team without one.
const face = (team) => avatarEl(team?.avatar);

// ----- extra languages in the quiz (lib/languages.js) -----
// The TV always shows the main language. A team that reads the quiz in another language (wantsText() in game.js:
// the switch is on, the team chose one and the quiz has it) gets a small flag next to its name here, and the host
// sees that language's text in small grey lines under the question and the answer (and under the Quick options).
const flagImg = (code, cls = 'flag', alt = '') => h('img', { class: cls, src: flagUrl(code), alt, ...(alt ? {} : { 'aria-hidden': 'true' }) });
const flagBadge = (team) => {
  const lang = view && wantsText(view, team);
  const text = lang && t('readsIn', { lang: languageName(lang) });
  return lang ? h('span', { class: 'flag-badge', title: text }, flagImg(lang, 'flag', text)) : null; // the words are the picture's alt, so lists read as names only
};
// The languages some team in the game reads in right now (in the order of the quiz's list).
const usedLangs = () => languagesOf(view.set).filter((code) => view.teams.some((tm) => wantsText(view, tm) === code));
// Small grey lines with `field` of `item` in each of those languages (nothing when they add nothing).
function translationLines(item, field, cls = '') {
  const lines = usedLangs()
    .map((code) => [code, item?.translations?.[code]?.[field]])
    .filter(([, text]) => typeof text === 'string' && text.trim());
  if (!lines.length) return null;
  return h('div', { class: `host-trs ${cls}` }, lines.map(([code, text]) => h('p', { class: 'host-tr', dir: 'auto', lang: code }, flagImg(code), h('span', {}, text))));
}

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
let brand = null; // the host's logo, event name and accent colour (brand.js, changed through /api/brand; on the website sent by this page, see sendBrand())
let remoteQuickDone = false; // turned on the question text on the phones for this tunnel (once, so the host can turn it off again)
let update = null; // a newer ProQuiz is out: {version, url, notes} from the server (lib/update.js), or null

// ----- the website version: this browser's room (docs/dev/web-plan.md §1.4) -----
// The host's browser makes a secret key and keeps it (public/js/myroom.js); the room code is made from the key, so
// the room knows its host by the key alone. The same key reopens the same room after a refresh (or a restart of
// the room).
const LAST_SET = 'proquiz.lastSet'; // the quiz chosen last time (the room starts with the sample)
const room = HOSTED ? await myRoom() : null;
if (room) {
  setRoom(room.code); // wsPath(), fileUrl() and pagePath() point into the room from here on
  $('#open-display').href = pagePath('/display');
}
// The website: the branding as kept in this browser (store-browser.js `meta.brand`, the logo as a file name there).
let myBrand = store ? await store.brand().catch(() => ({ ...NO_BRAND })) : null;
// Another host already has a room with this code (as good as impossible): a new key, a new room, once.
async function roomTaken() {
  if (sessionStorage.getItem('proquiz.roomRetry')) return showError(t('err-room-taken'));
  sessionStorage.setItem('proquiz.roomRetry', '1');
  await makeRoom();
  location.reload();
}

const net = connect({
  role: 'host',
  path: wsPath(),
  extra: room ? { key: room.key } : {},
  onMessage(msg) {
    if (msg.type === 'welcome') {
      info = msg.info;
      restoreTried = false; // a new connection: the room may be a fresh one (web-plan.md §5)
      lastSetDone = false; // (a fresh room starts with the sample quiz)
      renderQr();
      if (store) sendBrand(); // the website: the room keeps the branding only in memory, so it gets it on every connection
    } else if (msg.type === 'save') {
      // The website: the room's autosave, kept in this browser (store-browser.js) for a room that comes up fresh.
      store?.setAutosave(msg.saved).catch(() => {});
    } else if (msg.type === 'state') {
      view = msg.view;
      connected = new Set(msg.connected);
      displays = msg.displays;
      tvs = msg.tvs ?? msg.displays;
      resume = msg.resume ?? null;
      latency = msg.latency ?? {};
      remote = msg.remote ?? remote;
      brand = msg.brand ?? null;
      update = msg.update ?? null;
      setSoundVolume(view.settings.soundVolume);
      const ev = view.event;
      if (ev && soundSeq !== null && ev.seq !== soundSeq && displays === 0) playEvent(view, ev, COLORS);
      soundSeq = ev?.seq ?? 0;
      render();
    } else if (msg.type === 'latency') {
      latency = msg.latency;
      if (view?.phase === 'lobby') renderTeams();
    } else if (msg.type === 'update') {
      // "Update now" moved on (a percent more downloaded, checking, restarting, or a problem)
      update = msg.update ?? null;
      if (view?.phase === 'lobby') renderUpdate();
    } else if (msg.type === 'sound') {
      playSound(view, msg, COLORS);
    } else if (msg.type === 'error') {
      if (msg.code === 'room-taken') return roomTaken();
      showError(t(`err-${msg.code}`));
    } else if (msg.type === 'bye') {
      stopped(msg.reason); // Quit ProQuiz: the server has saved and is closing (or, on the website, the room closed)
    }
  },
});
runCountdowns(net.now);
startTicks(() => (displays === 0 ? view : null), net.now);

// After Quit ProQuiz: one plain message over everything, no sound or music, no keys, and net.js never connects again.
// On the website the room closed while this page was away (`reason: 'closed'`): the same block says so, with a
// button that opens the room again (the same key, a fresh room; the game is offered from this browser's autosave).
function stopped(reason = null) {
  stopMusic();
  stopClip();
  view = null; // the music and tick timers stay quiet, and handleKey() does nothing
  $('#sound-unlock').hidden = true;
  const closed = reason === 'closed';
  $('#stopped-title').dataset.t = closed ? 'roomClosedTitle' : 'stoppedTitle';
  $('#stopped-text').dataset.t = closed ? 'roomClosedHostText' : 'stoppedText';
  $('#stopped-again').hidden = !closed;
  $('#stopped').hidden = false;
  translatePage();
}
$('#stopped-again').addEventListener('click', () => location.reload());

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

// A newer ProQuiz is out: a small banner at the top of the lobby, until the host closes it (for this browser
// session, remembered per version). The Download button only ever opens ProQuiz's own releases page. In the
// downloaded program (`update.canInstall`) there is also **Update now**, and `update.install` says how far it has
// got (lib/selfupdate.js). After the restart the same banner says "ProQuiz was updated to …" (`info.updatedFrom`).
const UPDATE_SEEN = 'proquiz.updateSeen';
const RELEASES = 'https://github.com/dbugger85/proquiz/releases/';
const UPDATE_BUSY = ['downloading', 'checking', 'restarting'];
// Which banner would show: the new release, the "updated" note, or nothing.
const updateKey = () => (update?.version ? update.version : info?.updatedFrom && info?.version ? `done-${info.version}` : null);
function updateDismissed() {
  try {
    return sessionStorage.getItem(UPDATE_SEEN) === updateKey();
  } catch {
    return false;
  }
}
function renderUpdate() {
  const el = $('#update');
  const key = updateKey();
  const show = Boolean(key) && !updateDismissed();
  el.hidden = !show;
  if (!show) return;
  const status = $('#update-status');
  if (!update?.version) {
    // Just restarted by Update now: a quiet "done" note.
    $('#update-title').textContent = t('updateDone', { version: info.version });
    $('#update-notes').hidden = true;
    $('#update-keep').hidden = false;
    status.hidden = true;
    $('#update-now').hidden = true;
    $('#update-link').hidden = true;
    $('#update-close').hidden = false;
    return;
  }
  const install = update.install ?? { stage: 'idle' };
  const busy = UPDATE_BUSY.includes(install.stage);
  $('#update-title').textContent = t('updateTitle', { version: update.version });
  $('#update-notes').textContent = update.notes || '';
  $('#update-notes').hidden = !update.notes || busy;
  $('#update-keep').hidden = busy || install.stage === 'failed';
  $('#update-link').href = typeof update.url === 'string' && update.url.startsWith(RELEASES) ? update.url : `${RELEASES}latest`;
  $('#update-link').hidden = busy;
  $('#update-link').classList.toggle('btn-primary', !update.canInstall);
  $('#update-now').hidden = !update.canInstall || busy;
  $('#update-close').hidden = busy;
  const text =
    install.stage === 'downloading'
      ? t('updateDownloading', { pct: install.progress ?? 0 })
      : install.stage === 'checking'
        ? t('updateChecking')
        : install.stage === 'restarting'
          ? t('updateRestarting')
          : install.stage === 'failed'
            ? t(`updateErr-${install.error ?? 'download'}`)
            : '';
  status.textContent = text;
  status.hidden = !text;
  status.classList.toggle('error', install.stage === 'failed');
  el.classList.toggle('busy', busy);
}
$('#update-close').addEventListener('click', () => {
  try {
    sessionStorage.setItem(UPDATE_SEEN, updateKey() ?? '');
  } catch {}
  $('#update').hidden = true;
});
// Update now: ProQuiz's own question first, then the server downloads, checks, swaps and restarts.
$('#update-now').addEventListener('click', async () => {
  if (!update?.version) return;
  const ok = await ask({ title: t('updateAskTitle', { version: update.version }), text: t('updateAskText'), ok: t('updateNow') });
  if (ok) net.send({ type: 'updateNow' });
});

// Which ProQuiz this is, small under the settings.
function renderAbout() {
  const version = info?.version;
  $('#about-line').hidden = !version;
  $('#about-line').textContent = version ? t('versionLine', { version }) : '';
}

// The join card: one QR code. On this Wi-Fi it's the laptop's address; over the internet it's the internet
// address, and until that is ready the card says what is happening, with the Wi-Fi code below as a stand-in.
function renderQr() {
  if (!info) return;
  if (info.hosted) return renderRoomCard();
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

// The website version's join card: the room code big, the QR code to the room, and where the TV page is.
function renderRoomCard() {
  $('.join-card').classList.remove('waiting');
  $('#join-label').textContent = t('roomCodeTitle');
  $('#room-code').hidden = false;
  $('#room-code').textContent = info.code ?? '';
  const url = info.phoneUrl;
  if ($('#qr').dataset.url !== url) {
    $('#qr').replaceChildren(qrSvg(url));
    $('#qr').dataset.url = url;
  }
  $('#url').replaceChildren(...urlNodes(url));
  const hint = $('#join-hint');
  hint.removeAttribute('data-t'); // its text has the site in it, so translatePage() must leave it alone
  hint.textContent = t('joinWithCode', { site: shortUrl(location.origin) });
  $('#tv-url').textContent = t('tvHostedHint', { url: shortUrl(info.tvUrl ?? '') });
  $('#tv-url').hidden = !info.tvUrl;
  $('#hosted-hint').hidden = false;
  // Anyone with the code can open the phone page, so the PIN (if set) counts here; the TV page never shows it.
  const pin = view?.settings.remotePin;
  $('#remote-pin').hidden = !pin;
  $('#remote-pin').textContent = pin ? t('remotePinShow', { pin }) : '';
  $('#remote-tv').hidden = true;
  $('#join-wait').hidden = true;
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
  if (HOSTED) return renderRemoteHosted();
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

// The website: there is no tunnel (everyone joins with the code), so the group only has the PIN tick.
function renderRemoteHosted() {
  const pin = view.settings.remotePin;
  $('#remote-more').hidden = false;
  $('#remote-status').textContent = pin ? t('remotePinShow', { pin }) : t('stateOff');
  if (document.activeElement !== $('#remote-pin-on')) $('#remote-pin-on').checked = Boolean(pin);
  $('#remote-pin-row').hidden = !pin;
  $('#remote-pin-show').textContent = pin ? t('remotePinShow', { pin }) : '';
}

// During a game: a small warning when players join over the internet and that has stopped working (or came
// back on a new address, which players elsewhere must open again).
let gameUrl; // the internet address when the game started
function renderRemoteWarn() {
  const el = $('#remote-warn');
  if (HOSTED) return (el.hidden = true);
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
  $('#many-note').hidden = !(quick() && teams.length > 30); // more than 30 hasn't been tried in a real game yet
  $('#teams').replaceChildren(
    ...teams.map((team) => {
      const on = connected.has(team.id);
      const ms = view.settings.fairBuzz && on ? latency[team.id] : undefined;
      return h(
        'li',
        { class: 'plate', style: teamStyle(team) },
        h('span', { class: 'name' }, face(team), h('span', {}, team.name), flagBadge(team)),
        h(
          'span',
          { class: 'conn' },
          h('span', { class: `dot${on ? ' on' : ''}` }),
          on ? t('online') : t('offline'),
          !HOSTED && remote.remoteTeams?.includes(team.id) ? h('span', { class: 'elsewhere', title: t('remoteTagHint') }, t('remoteTag')) : null,
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
  $('#start').disabled = teams.length === 0 || mediaBusy;
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
  $('#sound-volume-setting').hidden = !st.sound;
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
    fx: st.sound ? t('musicLevel', { pct: st.soundVolume }) : t('stateOff'),
    music: st.music ? t('musicLevel', { pct: st.musicVolume }) : t('stateOff'),
  });
  const own = MUSIC_MOODS.filter((m) => st.musicFiles[m]).length;
  $('#music-files-status').textContent = own ? t('ownMusicSome', { n: own, total: MUSIC_MOODS.length }) : t('ownMusicNone');
  const accent = accentOf(brand?.accent);
  $('#look-status').textContent = [
    t('lookSummary', { state: t(st.glass ? 'stateOn' : 'stateOff') }),
    st.showCredits ? null : t('lookCreditsOff'),
    st.updateCheck || HOSTED ? null : t('lookUpdateOff'),
    brand?.logo ? t('brandHasLogo') : null,
    accent === 'violet' ? null : t(`accent-${accent}`),
  ]
    .filter(Boolean)
    .join(' · ');
  $('#quick-status').textContent = t('quickSummary', {
    read: st.quickReadSeconds ? t('nSeconds', { n: st.quickReadSeconds }) : t('quickUntilSpace'),
    streak: t(st.quickStreak ? 'stateOn' : 'stateOff'),
    text: t(st.quickPhoneText ? 'stateOn' : 'stateOff'),
    reactions: t(st.quickReactions ? 'stateOn' : 'stateOff'),
  });
}

// Your own music: a file per moment, or the built-in tune.
function renderMusicFiles() {
  const box = $('#music-files');
  box.hidden = !view.settings.music || HOSTED; // the website plays the built-in music only
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
        name ? h('audio', { src: fileUrl(name), controls: true, preload: 'metadata', onerror: () => (status.textContent = t('musicMissing')) }) : h('span', { class: 'music-builtin' }, t('musicBuiltIn')),
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
// On the website (docs/dev/web-plan.md Phase 6) the same block works on top of this browser's store instead: the
// change is kept in IndexedDB (`store.setBrand()`, `setLogo()`, `removeLogo()`), then sendBrand() puts the logo
// into the room's file store and sends `brand` to the room, whose state message brings it back to every screen.

// Which accent choice a saved colour is: one of ACCENTS, or 'custom'.
const accentOf = (color) => ACCENTS.find((a) => a.color === (color ?? null))?.id ?? 'custom';
const LOGO_ERRORS = { 'logo-too-big': 'brandLogoTooBig', 'logo-bad-type': 'brandLogoBadType' };

async function saveBrand(patch) {
  try {
    if (store) {
      await store.setBrand(patch);
      return sendBrand();
    }
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
  if (file.size > MAX_LOGO) return brandMsg(t('brandLogoTooBig'), true);
  brandMsg(t('brandUploading'));
  try {
    if (store) {
      // The website: checked and kept in this browser (named after its content), then into the room.
      if (!logoKind(new Uint8Array(await file.arrayBuffer()))) return brandMsg(t('brandLogoBadType'), true);
      const { old } = await store.setLogo(file);
      if (await sendBrand()) brandMsg('');
      if (old) dropFromRoom(old);
      return;
    }
    const r = await fetch('/api/brand/logo', { method: 'POST', body: file });
    const out = await r.json().catch(() => ({}));
    if (!r.ok) return brandMsg(t(LOGO_ERRORS[out.error] ?? 'brandFailed'), true);
    brandMsg('');
  } catch (err) {
    brandMsg(t(LOGO_ERRORS[err?.code] ?? 'brandFailed'), true);
  }
});
$('#brand-remove').addEventListener('click', async () => {
  try {
    if (store) {
      const { old } = await store.removeLogo();
      if (await sendBrand()) brandMsg('');
      if (old) dropFromRoom(old);
      return;
    }
    const r = await fetch('/api/brand/logo', { method: 'DELETE' });
    if (!r.ok) throw new Error('bad');
    brandMsg('');
  } catch {
    brandMsg(t('brandFailed'), true);
  }
});

// The website: the branding from this browser to the room. The room keeps it only in memory, so it goes on every
// connection (a fresh room after a restart or a closed room has none), and the logo goes into the room's file store
// first, under its `logo-<hash>.<ext>` name, unless the room has it already; the hub then points every screen at it.
// One at a time, in order, so a quick run of changes ends with the last one. True when the room took it.
let brandSending = Promise.resolve(true);
function sendBrand() {
  brandSending = brandSending.catch(() => false).then(doSendBrand);
  return brandSending;
}
async function doSendBrand() {
  if (!store || !room) return true;
  try {
    myBrand = await store.brand();
    let logo = myBrand.logo;
    if (logo) {
      const sent = await logoToRoom(logo);
      if (sent === false) return false; // refused, the reason is shown
      if (sent === null) logo = null; // the file is gone from this browser: the screens show the wordmark
    }
    net.send({ type: 'brand', ...myBrand, logo });
    return true;
  } catch {
    brandMsg(t('brandFailed'), true);
    return false;
  }
}
// True when the logo is in the room (already, or now), null when this browser no longer has the file, false (with
// the reason shown) when the room refused it.
async function logoToRoom(name) {
  const res = await fetch(pagePath('/files'), { headers: roomHeaders() });
  if (!res.ok) throw new Error(String(res.status));
  const have = await res.json();
  if (have.files.some((f) => f.name === name)) return true;
  const blob = await store.fileBlob(name);
  if (!blob) return null;
  const put = await fetch(fileUrl(name), { method: 'PUT', headers: roomHeaders(), body: blob });
  if (put.ok) return true;
  const why = await put.json().catch(() => ({}));
  if (why.error === 'media-full') brandMsg(t('mediaTotalTooBig', { max: mb(why.max ?? have.maxTotal) }), true);
  else brandMsg(t(LOGO_ERRORS[why.error] ?? 'brandFailed'), true);
  return false;
}
// An old logo is dropped from the room (the browser store dropped its copy already).
const dropFromRoom = (name) => fetch(fileUrl(name), { method: 'DELETE', headers: roomHeaders() }).catch(() => {});
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
  // Extra languages: only offered when the quiz has some (the label lists them with their flags).
  const langs = languagesOf(view.set);
  $('#languages-setting').hidden = langs.length === 0;
  const key = `${langs.join(',')}|${view.settings.lang}`;
  if ($('#languages-label').dataset.key !== key) {
    $('#languages-label').dataset.key = key;
    fill($('#languages-label'), t('quizLanguagesSetting'), ' ', langs.map((code) => h('span', { class: 'lang-tag', lang: code }, flagImg(code), languageName(code))));
  }
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

// Start: on the website the quiz's pictures and clips go into the room first (they may be gone after a restart).
$('#start').addEventListener('click', async () => {
  if (HOSTED && !(await syncRoom(view.set))) return;
  cmd({ type: 'start' });
});

// ----- the website version: the quiz's pictures and clips into the room (docs/dev/web-plan.md §3) -----
// The TV and host pages fetch a quiz's files from the room, so before a quiz is played its files are uploaded
// from this browser: list what the room has, upload what is missing (a progress line in the join card), and drop
// files of another quiz when the room's cap would be passed. Phones never get file names.
const MB = 1024 * 1024;
const mb = (n) => Math.round(n / MB);
// A file's bytes, as a Blob, or null when there is no such file: the host's own pictures and clips from the
// browser store (store-browser.js), else the built-in quizzes' files from the server.
async function fileBlob(name) {
  try {
    const own = await store?.fileBlob(name);
    if (own) return own;
    const res = await fetch(`/sets/files/${encodeURIComponent(name)}`);
    return res.ok ? await res.blob() : null;
  } catch {
    return null;
  }
}
const roomHeaders = () => ({ 'x-proquiz-key': room.key });
let mediaBusy = false;
function mediaProgress(text) {
  mediaBusy = Boolean(text);
  const line = $('#media-progress');
  line.hidden = !text;
  line.textContent = text ?? '';
  if (view) renderTeams(); // Start waits while files go up
}
// True when every file the quiz uses is in the room; false (with the reason shown) when it can't be played there.
let syncing = Promise.resolve(true);
function syncRoom(set) {
  syncing = syncing.catch(() => false).then(() => doSyncRoom(set));
  return syncing;
}
async function doSyncRoom(set) {
  if (!room) return true;
  const names = usedFiles(set);
  if (!names.length) return true;
  try {
    const res = await fetch(pagePath('/files'), { headers: roomHeaders() });
    if (!res.ok) throw new Error(String(res.status));
    const have = await res.json();
    const there = new Map(have.files.map((f) => [f.name, f.size]));
    const missing = names.filter((n) => !there.has(n));
    if (!missing.length) return true;
    mediaProgress(t('uploadingMedia', { n: 0, total: missing.length }));
    // Find the files first, so the caps are checked before anything goes up.
    const blobs = [];
    let need = 0;
    for (const name of missing) {
      const blob = await fileBlob(name);
      if (!blob) continue; // a missing file shows as missing on the TV, as on the laptop
      if (blob.size > MAX_ROOM_FILE) return mediaFail(t('mediaTooBig', { max: mb(MAX_ROOM_FILE) }));
      blobs.push([name, blob]);
      need += blob.size;
    }
    // Over the room's cap: drop another quiz's files first.
    let bytes = have.bytes;
    if (bytes + need > have.maxTotal) {
      const keep = new Set([...names, myBrand?.logo].filter(Boolean)); // the host's logo stays (sendBrand above)
      for (const [name, size] of there) {
        if (keep.has(name)) continue;
        await fetch(fileUrl(name), { method: 'DELETE', headers: roomHeaders() });
        bytes -= size;
      }
      if (bytes + need > have.maxTotal) return mediaFail(t('mediaTotalTooBig', { max: mb(have.maxTotal) }));
    }
    let n = 0;
    for (const [name, blob] of blobs) {
      mediaProgress(t('uploadingMedia', { n: n + 1, total: blobs.length }));
      const put = await fetch(fileUrl(name), { method: 'PUT', headers: roomHeaders(), body: blob });
      if (put.status === 413) {
        const why = await put.json().catch(() => ({}));
        return mediaFail(t(why.error === 'media-full' ? 'mediaTotalTooBig' : 'mediaTooBig', { max: mb(why.max ?? MAX_ROOM_FILE) }));
      }
      if (!put.ok) throw new Error(String(put.status));
      n += 1;
    }
    mediaProgress(null);
    return true;
  } catch {
    return mediaFail(t('mediaUploadFailed'));
  }
}
function mediaFail(text) {
  mediaProgress(null);
  showError(text);
  return false;
}

// The list of quizzes to choose from (fetched when the lobby shows, and when the window gets focus again).
// On the website there is no list on the server: the browser store (store-browser.js, through quizapi.js) lists
// the built-in quizzes and the host's own, each with whether its files fit a room (`ok`).
let quizList = [];
async function loadQuizzes() {
  try {
    quizList = HOSTED ? await api.list() : await (await fetch('/api/sets')).json();
  } catch {
    return;
  }
  renderSetPicker();
  if (HOSTED) refreshBackup(); // the website's backup reminder follows the list
}
// The website: the host's browser sends the quiz itself to the room (its files first, web-plan.md §3).
async function chooseQuiz(id, { quiet = false } = {}) {
  let found;
  try {
    found = await api.get(id);
  } catch {
    return quiet ? undefined : showError(t('err-set-missing'));
  }
  if (!(await syncRoom(found.set))) return;
  cmd({ type: 'loadSet', set: found.set, setId: id });
  try {
    localStorage.setItem(LAST_SET, id);
  } catch {
    // no storage
  }
}
// The editor (another tab) saved or changed a quiz: the list is fetched again, and the quiz on show in the lobby is
// reloaded when it was the one saved (like `setSaved` on the laptop), as long as it has no problems.
if (store) {
  new BroadcastChannel('proquiz-store').addEventListener('message', async (e) => {
    const msg = e.data ?? {};
    loadQuizzes();
    if (msg.type !== 'saved' || !view || view.phase !== 'lobby' || msg.id !== view.setId) return;
    const found = await api.get(msg.id).catch(() => null);
    if (found && validateSet(found.set).length === 0) chooseQuiz(msg.id);
  });
}
// ----- the website version: the game comes back from this browser (web-plan.md §5) -----
// The room sends the game after every change (`save`, kept in IndexedDB above). When this page connects to a room
// that is a fresh lobby (no teams, nothing to continue) and the browser holds a save, the quiz's pictures and clips
// go into the room and the save goes back with `restore`, exactly as the laptop reads its autosave file after a
// restart: a game with teams is offered as "Continue the last game?" (phones that reconnected are put back in their
// teams by Continue), a finished game or a plain lobby just brings its quiz and settings back. Once per connection;
// without a save, the quiz chosen last time is put back instead.
let restoreTried = true;
async function offerAutosave() {
  if (!store) return restoreLastSet();
  if (restoreTried || !view || view.phase !== 'lobby' || view.teams.length || resume) return;
  restoreTried = true;
  let saved = null;
  try {
    saved = await store.autosave();
  } catch {
    saved = null;
  }
  const usable = saved?.v === 1 && saved.state?.set && Array.isArray(saved.state.teams) && validateSet(saved.state.set).length === 0;
  if (!usable || !view || view.phase !== 'lobby' || view.teams.length || resume) return restoreLastSet();
  lastSetDone = true; // the save's quiz is the one to show
  await syncRoom(saved.state.set); // its files first (a problem is shown; the game is still offered, as on the laptop)
  net.send({ type: 'restore', saved });
}

// A new room starts with the sample quiz: put the quiz chosen last time back, once per connection, while the lobby
// is empty. Quietly, since the quiz may have been deleted in the editor since.
let lastSetDone = false;
function restoreLastSet() {
  if (!HOSTED || lastSetDone || !view || view.phase !== 'lobby' || view.teams.length) return;
  lastSetDone = true;
  let last = null;
  try {
    last = localStorage.getItem(LAST_SET);
  } catch {
    last = null;
  }
  if (last && last !== view.setId) chooseQuiz(last, { quiet: true });
}
function renderSetPicker() {
  const sel = $('#set-picker');
  // Edit opens the editor on the quiz chosen here.
  if (view?.setId) $('#edit-set').href = `/editor#${encodeURIComponent(view.setId)}`;
  renderQuizAbout();
  if (!view || sel === document.activeElement) return;
  // Quizzes put away in the editor (archived) are left out, unless one of them is the quiz chosen right now.
  const opts = quizList.filter((q) => !q.archived || q.id === view.setId).map((q) => {
    const title = q.kind === 'quick' ? `${q.title} · ${t('quickTag')}` : q.title; // a Quick quiz gets a small tag
    // A quiz with problems can't be played; on the website neither can one whose files don't fit a room.
    const why = q.problems ? t('needsFixing') : q.ok === false ? t('quizTooBig') : null;
    return h('option', { value: q.id, disabled: Boolean(why) }, why ? `${title} (${why})` : title);
  });
  if (!quizList.some((q) => q.id === view.setId)) opts.unshift(h('option', { value: view.setId ?? '' }, view.set.title));
  sel.replaceChildren(...opts);
  sel.value = view.setId ?? '';
}
// The chosen quiz's cover picture and description, under the picker (nothing when it has neither).
function renderQuizAbout() {
  const box = $('#quiz-about');
  const cover = view?.set.cover ?? '';
  const description = view?.set.description ?? '';
  const langs = view ? languagesOf(view.set) : [];
  box.hidden = !cover && !description && !langs.length;
  const key = `${cover}|${description}|${langs.join(',')}|${view?.settings.lang}`;
  if (box.dataset.key === key) return; // keep the picture as it is between updates (no flicker)
  box.dataset.key = key;
  fill(
    box,
    cover ? h('img', { class: 'quiz-cover', src: fileUrl(cover), alt: '' }) : null,
    h(
      'div',
      { class: 'quiz-about-text' },
      description ? h('p', { class: 'quiz-desc' }, description) : null,
      // "Also in: 🇳🇴 Norsk, 🇹🇭 ไทย": the extra languages phones can read the questions in.
      langs.length ? h('p', { class: 'quiz-langs' }, t('alsoIn'), ' ', langs.map((code) => h('span', { class: 'lang-tag', lang: code }, flagImg(code), languageName(code)))) : null,
    ),
  );
}
$('#set-picker').addEventListener('change', (e) => (HOSTED ? chooseQuiz(e.target.value) : net.send({ type: 'chooseSet', id: e.target.value })));
window.addEventListener('focus', loadQuizzes);
loadQuizzes();
$('#test-sound').addEventListener('click', () => net.send({ type: 'testSound' }));
// The website version has no program to quit, no tunnel (everyone joins with the code), no new-version check and no
// own music files (the branding block stays: it works on top of this browser's store, see sendBrand()).
if (HOSTED) {
  for (const id of ['#quit-row', '#join-mode-field', '#join-mode-hint', '#remote-state', '#remote-missing', '#remote-retry', '#remote-note', '#update-check-setting', '#update']) {
    $(id).hidden = true;
  }
  // The PIN is for everyone who joins (anyone with the room code can open the join page), not "players elsewhere".
  $('#remote-pin-label').dataset.t = 'pinSettingHosted';
  $('#remote-pin-hint').dataset.t = 'pinHintHosted';
}
$('#resume-yes').addEventListener('click', () => net.send({ type: 'resume' }));
$('#resume-no').addEventListener('click', () => {
  net.send({ type: 'discardSave' });
  store?.clearAutosave().catch(() => {}); // or the next fresh room would offer it again
});
// Leave the game for the main menu. It is kept, and the lobby offers to continue it.
// Quit ProQuiz (under the lobby's settings): stops the program on this laptop. The game is saved first.
$('#quit-btn').addEventListener('click', async () => {
  if (await ask({ title: t('dlgQuitTitle'), text: t('confirmQuit'), ok: t('dlgQuitOk'), danger: true })) net.send({ type: 'quit' });
});
$('#menu-btn').addEventListener('click', async () => {
  if (await ask({ title: t('dlgMainMenuTitle'), text: t('confirmMainMenu'), ok: t('dlgMainMenuOk') })) net.send({ type: 'mainMenu' });
});

function renderResume() {
  $('#resume').hidden = !resume;
  if (!resume) return;
  const time = new Date(resume.savedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  $('#resume-text').textContent = t(resume.mode === 'quick' ? 'resumeTextQuick' : resume.round === 2 ? 'resumeTextRound2' : 'resumeText', { title: resume.title, time, played: resume.played, total: resume.total });
  $('#resume-teams').replaceChildren(
    ...resume.teams.map((tm) => h('li', { class: 'plate', style: teamStyle(tm) }, face(tm), h('span', {}, tm.name), h('b', {}, pts(tm.score)))),
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
  } else if (p === 'result' || p === 'ranks') {
    const lastQ = view.pos.i + 1 >= view.set.sections[view.pos.s].questions.length;
    const lastS = view.pos.s + 1 >= view.set.sections.length;
    // After the last question's result there is no top 5: Space goes straight to the podium.
    if (p === 'result') add(' ', t(lastQ && lastS ? 'showPodium' : 'showTop'), next, 'btn-primary');
    else add(' ', t(!lastQ ? 'nextQuestion' : !lastS ? 'nextSection' : 'showPodium'), next, 'btn-primary');
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
              pts(q.value),
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
    h('p', { class: 'where' }, `${view.set.categories[q.c].name} `, h('b', {}, pts(q.value))),
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
    h('p', {}, t('doubleBetHint', { name: picker?.name ?? '', n: pts(max) })),
    h('label', { class: 'field' }, h('span', {}, t('doubleBet')), input),
    h('button', { class: 'btn', type: 'submit' }, t('doubleBetSet')),
    q.bet == null ? h('p', { class: 'muted' }, t('doubleNoBet', { n: pts(q.value) })) : null,
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
        ? t('boomResult', { name: teamName(r.teamId), n: pts(r.amount) })
        : r.type === 'correct' && q.won
          ? t('jackpotWon', { name: teamName(r.teamId), n: pts(q.value), pot: pts(q.won) })
          : r.type === 'correct'
            ? t('resultCorrect', { name: teamName(r.teamId), n: pts(q.value) })
            : q.fullPenalty && q.lockedOut.includes(q.solo)
              ? t('doubleLost', { name: teamName(q.solo), n: pts(q.value) })
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

// A picture with what it is for, and, when it was found with "Find a free picture", who made it (the host always
// sees this; the TV only after the answer, see creditFor() in game.js).
const img = (name, cls, label) => {
  if (!name) return null;
  const c = view.set.credits?.[name];
  const source = c && t(c.source === 'wikimedia' ? 'picSourceWikimedia' : 'picSourceOpenverse');
  const credit = c ? h('span', { class: 'host-credit' }, c.author ? t('picCreditLine', { author: c.author, license: licenseName(c.license), source }) : t('picCreditNoAuthor', { license: licenseName(c.license), source })) : null;
  return h('figure', { class: cls }, h('img', { src: fileUrl(name), alt: '' }), label || credit ? h('figcaption', {}, label, credit) : null);
};

function renderQuestion() {
  const q = view.q;
  const src = view.set.categories[q.c].questions[q.i];
  return h(
    'div',
    { class: 'host-q' },
    h('p', { class: 'where' }, `${view.set.categories[q.c].name} `, h('b', {}, pts(q.value)), q.special ? h('span', { class: `special-badge k-${q.special}` }, badgeFor(view)) : null),
    src.image || src.answerImage
      ? h('div', { class: 'host-imgs' }, img(src.image, 'host-img', t('picQuestion')), img(src.answerImage, 'host-img', t('picAnswer')))
      : null,
    src.question ? h('p', { class: 'question' }, src.question) : null,
    translationLines(src, 'question'),
    h('p', { class: 'answer' }, h('span', {}, `${t('answerLabel')}:`), src.answer),
    translationLines(src, 'answer', 'under-answer'),
    clipLine(src),
    unveilLine(q),
    statusLine(),
    countdown(view),
    buzzOrder(),
  );
}

// How clear the slowly appearing picture is on the TV right now (kept up to date by the loop below).
function unveilLine(q) {
  if (!q?.unveil) return null;
  if (view.phase === 'reading') return h('p', { class: 'clip-line' }, h('span', { class: 'clip-dot' }), t('unveilWaiting'));
  if (view.phase === 'ready') return h('p', { class: 'clip-line' }, h('span', { class: 'clip-dot' }), t('unveilWaitingQuick')); // a Quick quiz: it starts with the answers
  return h('p', { class: 'clip-line on', 'data-unveil-pct': '' }, h('span', { class: 'clip-dot' }), h('span', {}, unveilPct(q)));
}
const unveilPct = (q) => t('unveilPct', { n: Math.round(unveilProgress(q.unveil, net.now()) * 100) });
function runUnveilLine() {
  const tick = () => {
    const el = document.querySelector('[data-unveil-pct]');
    if (el && view?.q?.unveil) el.lastChild.textContent = unveilPct(view.q);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
runUnveilLine();

// "Sound clip: playing" / "paused", so the host knows what the room hears.
function clipLine(src) {
  if (!src.audio) return null;
  const on = view.media?.playing;
  // "(from 1:05, 10 s)": the trimmed part, when the clip has one.
  const parts = [src.audioStart ? t('clipFrom', { s: mss(src.audioStart) }) : null, src.audioLength ? lengthText(src.audioLength) : null].filter(Boolean);
  // A song clip from "Find a song clip": the host always sees the artist (the TV only after the answer).
  const c = view.set.credits?.[src.audio];
  const credit = c ? h('span', { class: 'host-credit' }, t('songCreditLine', { author: c.author || t('songUnknownArtist'), source: t('songSourceDeezer') })) : null;
  return h('p', { class: `clip-line${on ? ' on' : ''}` }, h('span', { class: 'clip-dot' }), on ? t('clipPlaying') : t('clipPaused'), parts.length ? ` (${parts.join(', ')})` : '', credit);
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
    p !== 'finalWager' ? translationLines(src, 'question') : null,
    h('p', { class: 'answer' }, h('span', {}, `${t('answerLabel')}:`), src.answer),
    translationLines(src, 'answer', 'under-answer'),
    p !== 'finalWager' ? clipLine(src) : null,
  ];
  if (p === 'finalQuestion') head.push(countdown(view));
  const rows = view.teams.map((tm) => {
    const wager = f.wagers[tm.id];
    const answer = f.answers[tm.id];
    const verdict = f.judged[tm.id];
    const cells = [h('span', { class: 'who' }, face(tm), tm.name, flagBadge(tm)), h('span', { class: 'bet' }, wager == null ? t('betWaiting') : t('betAmount', { n: pts(wager) }))];
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
    h('p', { class: 'board-hint' }, `${t('round2PicksFirst', { name: teamName(view.picker) })}. ${t('round2UpTo', { n: pts(top) })}.`),
    h('ol', { class: 'rank-list' }, ranking(view.teams).map((tm) => h('li', { class: 'plate', style: teamStyle(tm) }, h('span', {}, face(tm), tm.name), h('span', {}, pts(tm.score))))),
  );
}

function renderOver() {
  const ranked = ranking(view.teams);
  const tie = ranked.length > 1 && ranked[0].score === ranked[1].score;
  return h(
    'div',
    { class: 'host-over' },
    h('h2', {}, ranked.length ? (tie ? t('tie') : t('winner', { name: ranked[0].name })) : t('gameOver')),
    h('ol', { class: 'rank-list' }, ranked.map((tm) => h('li', { class: 'plate', style: teamStyle(tm) }, h('span', {}, face(tm), tm.name), h('span', {}, pts(tm.score))))),
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
          h('span', { class: 'name-text' }, team.name),
          flagBadge(team),
        ),
        h('span', { class: 'pts' }, pts(team.score)),
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
    q?.type === 'multi' || q?.type === 'order' ? h('span', { class: 'pts-badge kind' }, t(q.type === 'order' ? 'quickStyleOrder' : 'quickStyleMulti')) : null,
  );
}

// The options as the host sees them (in the order the TV and phones show them): the right ones marked, and after
// the answers close how many picked (ticked) each. A "put in order" question shows each option's right place.
function quickOptions() {
  const q = view.q;
  const settled = q.counts != null && ['result', 'ranks'].includes(view.phase);
  const order = q.type === 'order';
  const src = quickSection().questions[view.pos.i];
  // The shown option i in each language some player reads in (the same shuffle as the TV and the phones).
  const optionTranslations = (i) => {
    const written = q.order ? q.order[i] : i;
    const lines = usedLangs()
      .map((code) => [code, src.translations?.[code]?.options?.[written]])
      .filter(([, text]) => typeof text === 'string' && text.trim());
    return lines.length ? h('span', { class: 'host-trs inline' }, lines.map(([code, text]) => h('span', { class: 'host-tr', dir: 'auto', lang: code }, flagImg(code), h('span', {}, text)))) : null;
  };
  const rights = [].concat(q.correct ?? []); // the right options, or the shown positions in the right order
  const countKey = order ? 'quickPlaced' : q.type === 'multi' ? 'quickTicked' : 'quickPicked';
  return [
    h(
      'ol',
      { class: 'host-opts' },
      q.options.map((text, i) =>
        h(
          'li',
          { class: `host-opt${!order && rights.includes(i) ? ' right' : ''}`, style: optionStyle(OPTION_COLORS[i]) },
          order ? h('b', { class: 'opt-place' }, `${rights.indexOf(i) + 1}.`) : null,
          h('span', { class: 'opt-shape' }, shapeSvg(SHAPES[i])),
          h('span', { class: 'opt-text' }, text, optionTranslations(i)),
          !order && rights.includes(i) ? h('span', { class: 'opt-right', title: t('quickRightMark') }, '✓') : null,
          settled ? h('span', { class: 'opt-count' }, t(countKey, { n: q.counts[i] })) : null,
        ),
      ),
    ),
    order ? h('p', { class: 'host-order-note' }, t('quickHostOrderNote')) : null,
  ];
}

function quickStatus() {
  const q = view.q;
  const p = view.phase;
  const answered = Object.keys(q.answers).filter((id) => view.teams.some((tm) => tm.id === id)).length;
  if (p === 'ready') return h('p', { class: 'host-status' }, t(view.deadline == null ? 'quickHostReadyWait' : 'quickHostReady'));
  if (p === 'open') return h('p', { class: 'host-status' }, t('quickAnswered', { n: answered, total: view.teams.length }));
  const right = q.nRight ?? [].concat(q.correct ?? []).reduce((n, i) => n + (q.counts?.[i] ?? 0), 0); // everyone who got it right
  const gotKey = q.type === 'order' ? 'quickGotOrder' : q.type === 'multi' ? 'quickGotAll' : 'quickGotIt';
  const fastest = q.fastest
    ? h('span', { class: 'fastest' }, `⚡ ${fastestTitle(view.pos)}`, h('span', { class: 'plate', style: teamStyle(q.fastest) }, face(q.fastest), q.fastest.name), secondsText(q.fastest.ms))
    : null;
  if (p === 'result') return h('p', { class: 'host-status' }, q.points === 0 ? t('quickSurvey') : right ? t(gotKey, { n: right, total: view.teams.length }) : t('quickNobodyRight'), fastest);
  return h('p', { class: 'host-status' }, t('quickHostRanks'));
}

const rankLine = (e) => h('li', { class: 'plate', style: teamStyle(e) }, h('span', {}, `${e.rank}. `, face(e), e.name), h('span', {}, e.delta ? h('small', { class: 'gain' }, `+${pts(e.delta)} `) : null, pts(e.score)));

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
    translationLines(src, 'question'),
    quickOptions(),
    clipLine(src),
    unveilLine(view.q),
    quickStatus(),
    p === 'ready' || p === 'open' ? countdown(view) : null,
    p === 'ranks' ? h('ol', { class: 'rank-list' }, view.ranks.top.map(rankLine)) : null,
  );
}

// Everyone's score, highest first (a Quick quiz can have up to 100 players, so the list scrolls), with a tick for who has answered.
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
          h('span', { class: 'name-text' }, e.name),
          flagBadge(view.teams.find((tm) => tm.id === e.id)),
          answered ? h('span', { class: 'answered-tick' }, '✓') : null,
        ),
        h('span', { class: 'pts' }, gain ? h('small', { class: 'gain' }, `+${pts(gain)} `) : null, pts(e.score)),
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
    preview: (n) => t('dlgAdjustPreview', { score: pts(team.score + n) }),
  });
  if (delta) cmd({ type: 'adjust', teamId: team.id, delta });
}

// Single-screen mode: no separate TV screen is open, so this page shows the TV view (answers hidden),
// with the controls underneath. H switches to the host view and back.
const singleScreen = () => Boolean(view) && view.phase !== 'lobby' && tvs === 0;
let stage = null; // the TV view, kept between updates (moving an iframe would reload it)

function renderStage() {
  if (!stage) {
    stage = h('div', { class: 'stage-area' }, h('iframe', { src: `${pagePath('/display')}?embedded`, title: t('openDisplay'), allow: 'autoplay; fullscreen' }), h('div', { class: 'stage-controls' }));
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
  if (HOSTED) {
    try {
      localStorage.setItem('proquiz.lang', view.settings.lang); // the editor and the front page follow the lobby's language
    } catch {
      // no storage
    }
  }
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
    renderUpdate();
    renderResume();
    renderTeams();
    renderSettings();
    renderAbout();
    renderSetPicker();
    offerAutosave(); // then the quiz chosen last time, when there is no game to bring back
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

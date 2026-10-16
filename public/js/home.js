// The website's front page: a room code takes a phone to /r/<code> (the join page) or a TV to /r/<code>/display,
// and "Host a quiz" opens the host page, which makes a room. The code is checked here (6 letters and numbers,
// never 0, O, 1 or I), so a typo is caught before leaving the page.
import { normalizeCode } from '/lib/room.js';
import { t, setLang, guessLang, translatePage } from './i18n.js';
import { $ } from './ui.js';

const LANG_KEY = 'proquiz.lang';

function useLang(code) {
  setLang(code);
  translatePage();
  document.title = 'ProQuiz';
  for (const id of ['en', 'no']) $(`#lang-${id}`).classList.toggle('on', code === id);
  try {
    localStorage.setItem(LANG_KEY, code);
  } catch {
    // private mode: nothing remembered
  }
}
let saved = null;
try {
  saved = localStorage.getItem(LANG_KEY);
} catch {
  saved = null;
}
useLang(saved === 'no' || saved === 'en' ? saved : guessLang());
$('#lang-en').addEventListener('click', () => useLang('en'));
$('#lang-no').addEventListener('click', () => useLang('no'));

const input = $('#code');
const error = $('#code-error');

// Sent back here from a /r/… address that wasn't a code.
const params = new URLSearchParams(location.search);
if (params.has('bad')) {
  error.textContent = t('homeBadCode');
  error.hidden = false;
}
if (params.get('code')) input.value = params.get('code');

// What is typed shows as the code will be: upper case, no spaces.
input.addEventListener('input', () => {
  const at = input.selectionStart;
  input.value = input.value.toUpperCase().replace(/\s/g, '');
  input.setSelectionRange(at, at);
  error.hidden = true;
});

// The code, or null with the message shown.
function codeOrSay() {
  const code = normalizeCode(input.value);
  if (code) return code;
  error.textContent = t(input.value.trim() ? 'homeBadCode' : 'homeNoCode');
  error.hidden = false;
  input.focus();
  return null;
}

$('#join-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const code = codeOrSay();
  if (code) location.href = `/r/${code}`;
});
$('#tv-btn').addEventListener('click', () => {
  const code = codeOrSay();
  if (code) location.href = `/r/${code}/display`;
});

input.focus();

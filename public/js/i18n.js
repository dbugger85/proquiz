// Every piece of text the players and the host see, in English and Norwegian (bokmål).
// t('key', { name: 'Red' }) fills in {name}.

const STRINGS = {
  en: {
    // phone
    joinTitle: 'Join the quiz',
    teamName: 'Team name',
    teamNamePlaceholder: 'e.g. The Know-It-Alls',
    pickColor: 'Pick your colour',
    colorTaken: 'Taken',
    joinButton: 'Join the game',
    joining: 'Joining…',
    youreIn: 'You’re in!',
    waitStart: 'Waiting for the host to start the game.',
    changeTeam: 'Change name or colour',
    saveTeam: 'Save',
    points: '{n} points',
    reconnecting: 'Reconnecting…',
    // errors (codes from the server)
    'err-name-taken': 'Another team already has that name.',
    'err-color-taken': 'Another team just took that colour. Pick another one.',
    'err-bad-name': 'Give your team a name (up to 20 letters).',
    'err-bad-color': 'Pick a colour.',
    'err-full': 'The game is full (8 teams).',
    'err-host-only-on-laptop': 'The host screen only opens on the laptop running the game.',
    'err-bad-wager': 'That bet isn’t allowed.',
    'err-bad-settings': 'That setting isn’t allowed.',
    // host + display
    scanToJoin: 'Scan to join',
    orOpen: 'or open',
    noNetwork: 'No Wi-Fi found. Connect the laptop to Wi-Fi and restart ProQuiz.',
    teams: 'Teams',
    noTeamsYet: 'No teams yet. Scan the QR code with a phone to join.',
    online: 'Connected',
    offline: 'Not connected',
    removeTeam: 'Remove {name}',
    confirmRemove: 'Remove {name} from the game?',
    startGame: 'Start game',
    needTeam: 'At least one team must join before you can start.',
    openDisplay: 'Open TV screen',
    settings: 'Settings',
    language: 'Language',
    wrongAnswer: 'Wrong answer costs',
    penaltyNone: 'Nothing',
    penaltyHalf: 'Half the points',
    penaltyFull: 'All the points',
    allowNegative: 'Scores can go below zero',
    buzzSeconds: 'Time to buzz (seconds)',
    answerSeconds: 'Time to answer (seconds)',
    finalSeconds: 'Time for the final answer (seconds)',
    zeroOff: '0 = no timer',
    finalRound: 'Play the final round',
    questionSet: 'Questions',
    hostOnLaptopHint: 'Drag the TV screen window onto the TV and press F for full screen.',
  },
  no: {
    joinTitle: 'Bli med i quizen',
    teamName: 'Lagnavn',
    teamNamePlaceholder: 'f.eks. Vi Som Vet Alt',
    pickColor: 'Velg farge',
    colorTaken: 'Opptatt',
    joinButton: 'Bli med',
    joining: 'Kobler til…',
    youreIn: 'Du er med!',
    waitStart: 'Venter på at verten starter spillet.',
    changeTeam: 'Endre navn eller farge',
    saveTeam: 'Lagre',
    points: '{n} poeng',
    reconnecting: 'Kobler til igjen…',
    'err-name-taken': 'Et annet lag har allerede det navnet.',
    'err-color-taken': 'Et annet lag tok nettopp den fargen. Velg en annen.',
    'err-bad-name': 'Gi laget et navn (opptil 20 tegn).',
    'err-bad-color': 'Velg en farge.',
    'err-full': 'Spillet er fullt (8 lag).',
    'err-host-only-on-laptop': 'Vertsskjermen åpnes bare på PC-en som kjører spillet.',
    'err-bad-wager': 'Den innsatsen er ikke lov.',
    'err-bad-settings': 'Den innstillingen er ikke lov.',
    scanToJoin: 'Skann for å bli med',
    orOpen: 'eller åpne',
    noNetwork: 'Fant ikke noe Wi-Fi. Koble PC-en til Wi-Fi og start ProQuiz på nytt.',
    teams: 'Lag',
    noTeamsYet: 'Ingen lag ennå. Skann QR-koden med en mobil for å bli med.',
    online: 'Tilkoblet',
    offline: 'Ikke tilkoblet',
    removeTeam: 'Fjern {name}',
    confirmRemove: 'Fjerne {name} fra spillet?',
    startGame: 'Start spillet',
    needTeam: 'Minst ett lag må bli med før du kan starte.',
    openDisplay: 'Åpne TV-skjermen',
    settings: 'Innstillinger',
    language: 'Språk',
    wrongAnswer: 'Feil svar koster',
    penaltyNone: 'Ingenting',
    penaltyHalf: 'Halve poengene',
    penaltyFull: 'Alle poengene',
    allowNegative: 'Poeng kan gå under null',
    buzzSeconds: 'Tid til å buzze (sekunder)',
    answerSeconds: 'Tid til å svare (sekunder)',
    finalSeconds: 'Tid til finalesvaret (sekunder)',
    zeroOff: '0 = ingen tidsgrense',
    finalRound: 'Spill finalerunden',
    questionSet: 'Spørsmål',
    hostOnLaptopHint: 'Dra TV-skjermvinduet over på TV-en og trykk F for fullskjerm.',
  },
};

let lang = 'en';

export function setLang(l) {
  if (STRINGS[l] && l !== lang) {
    lang = l;
    document.documentElement.lang = l === 'no' ? 'nb' : 'en';
  }
}

export function getLang() {
  return lang;
}

export function t(key, params = {}) {
  const s = STRINGS[lang][key] ?? STRINGS.en[key] ?? key;
  return s.replace(/\{(\w+)\}/g, (_, k) => params[k] ?? '');
}

// Fills every element with data-t="key" (text) or data-t-placeholder / data-t-title / data-t-aria-label.
export function translatePage(root = document) {
  for (const el of root.querySelectorAll('[data-t]')) el.textContent = t(el.dataset.t);
  for (const attr of ['placeholder', 'title', 'aria-label']) {
    for (const el of root.querySelectorAll(`[data-t-${attr}]`)) el.setAttribute(attr, t(el.getAttribute(`data-t-${attr}`)));
  }
}

// Phones start in the language of the phone until the host's setting arrives.
export function guessLang() {
  return /^(nb|nn|no)\b/i.test(navigator.language || '') ? 'no' : 'en';
}

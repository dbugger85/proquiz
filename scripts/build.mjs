// Builds the double-click programs for every system into dist/, each zipped with a short "start here" note.
//
//   npm run build            (needs Deno and the zip command; downloads Deno's runtime for each system once)
//   npm run build -- windows  (only some systems: windows, mac-apple-silicon, mac-intel, linux-x64, linux-arm64)
//
// The programs contain everything: the server, the pages, the fonts, the sample quizzes.

import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const dist = join(root, 'dist');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const TARGETS = [
  { target: 'x86_64-pc-windows-msvc', name: 'windows', file: 'ProQuiz.exe', os: 'windows' },
  { target: 'aarch64-apple-darwin', name: 'mac-apple-silicon', file: 'ProQuiz', os: 'mac' },
  { target: 'x86_64-apple-darwin', name: 'mac-intel', file: 'ProQuiz', os: 'mac' },
  { target: 'x86_64-unknown-linux-gnu', name: 'linux-x64', file: 'ProQuiz', os: 'linux' },
  { target: 'aarch64-unknown-linux-gnu', name: 'linux-arm64', file: 'ProQuiz', os: 'linux' },
];

const START_HERE = {
  windows: `ProQuiz ${version}

1. Double-click ProQuiz.exe.
2. If Windows says "Windows protected your PC", click "More info" and then "Run anyway".
   (ProQuiz isn't signed by Microsoft, which costs money. It is safe.)
3. When Windows asks about network access, click "Allow". Phones can't connect without it.
4. A black window opens and your web browser shows the host screen. Keep the black window open while you play.

Your quizzes and the autosave are kept in the ProQuiz folder in your user folder.
`,
  mac: `ProQuiz ${version}

1. Right-click (or Control-click) ProQuiz and choose "Open". Then click "Open" again.
   (ProQuiz isn't signed by Apple, which costs money, so a normal double-click is blocked the first time.
   If there is no "Open" button: System Settings > Privacy & Security > "Open Anyway".)
2. A Terminal window opens and your web browser shows the host screen. Keep the Terminal window open while you play.
3. If macOS asks whether ProQuiz may accept incoming network connections, click "Allow".

Use "mac-apple-silicon" for Macs from late 2020 onwards (M1, M2, …) and "mac-intel" for older Macs.
Your quizzes and the autosave are kept in the ProQuiz folder in your home folder.
`,
  linux: `ProQuiz ${version}

1. Run ./ProQuiz in a terminal (or double-click it, if your file manager runs programs).
2. Your web browser opens the host screen. Keep the terminal open while you play.

Your quizzes and the autosave are kept in ~/ProQuiz.
`,
};

const only = process.argv.slice(2);
const targets = only.length ? TARGETS.filter((t) => only.includes(t.name)) : TARGETS;
if (!targets.length) throw new Error(`Unknown system. Use: ${TARGETS.map((t) => t.name).join(', ')}`);
// A full build starts from an empty dist/; building only some systems keeps the other zips.
if (!only.length) rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

for (const t of targets) {
  const dir = join(dist, `ProQuiz-${version}-${t.name}`);
  rmSync(dir, { recursive: true, force: true });
  rmSync(`${dir}.zip`, { force: true });
  mkdirSync(dir, { recursive: true });
  console.log(`Building ${t.name}…`);
  execFileSync(
    'deno',
    ['compile', '-A', '--quiet', '--target', t.target, '--include', 'public', '--include', 'lib', '--include', 'sets', '--output', join(dir, t.file), 'server.js'],
    { cwd: root, stdio: 'inherit' },
  );
  if (t.os !== 'windows') chmodSync(join(dir, t.file), 0o755);
  writeFileSync(join(dir, t.os === 'windows' ? 'START HERE.txt' : 'START-HERE.txt'), START_HERE[t.os].replace(/\n/g, t.os === 'windows' ? '\r\n' : '\n'));
  execFileSync('zip', ['-q', '-r', '-X', `${dir}.zip`, `ProQuiz-${version}-${t.name}`], { cwd: dist });
  rmSync(dir, { recursive: true });
}
console.log(`\nDone. The zip files are in ${dist}`);

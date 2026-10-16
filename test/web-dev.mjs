// Starts the website version for the tests: builds dist/web, runs `wrangler dev` on a port of its own (3499, never
// the owner's 3000/3001) and waits until the front page answers. Shared by test/web.test.js and test/e2e-web.mjs.
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);

// `vars` become the Worker's environment variables (web/room.js reads ROOM_IDLE_MS, so a test can close rooms fast).
export async function startWebDev({ port = 3499, vars = {}, quiet = true } = {}) {
  const build = spawnSync(process.execPath, [fileURLToPath(new URL('scripts/web-build.mjs', root))], { stdio: quiet ? 'ignore' : 'inherit' });
  if (build.status !== 0) throw new Error('web build failed');
  const args = ['dev', '--port', String(port), '--local', '--inspector-port', '9499'];
  for (const [k, v] of Object.entries(vars)) args.push('--var', `${k}:${v}`);
  const child = spawn(fileURLToPath(new URL('node_modules/.bin/wrangler', root)), args, {
    cwd: fileURLToPath(root),
    detached: true, // its own process group, so stop() also ends the workerd it starts
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' },
  });
  let log = '';
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding('utf8');
    stream.on('data', (s) => {
      log += s;
      if (!quiet) process.stderr.write(s);
    });
  }
  const base = `http://127.0.0.1:${port}`;
  const end = Date.now() + 90_000;
  let up = false;
  while (!up && Date.now() < end && child.exitCode === null) {
    await new Promise((r) => setTimeout(r, 300));
    try {
      up = (await fetch(`${base}/`)).status === 200;
    } catch {
      up = false;
    }
  }
  if (!up) {
    stop();
    throw new Error(`wrangler dev did not come up on ${port}:\n${log.slice(-2000)}`);
  }
  function stop() {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      // already gone
    }
    return new Promise((r) => {
      if (child.exitCode !== null) return r();
      child.once('exit', r);
      setTimeout(() => {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          // gone
        }
        r();
      }, 5000).unref();
    });
  }
  return { base, port, stop, log: () => log };
}

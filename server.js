// ProQuiz server: serves the pages and keeps the phones, the host laptop and the TV in sync.
// Runs with `npm start` (Node) or as a single packaged program (Deno compile), so it only
// uses node:* modules plus `ws`, and finds its files relative to this file.
//
//   PORT=3000 node server.js

import http from 'node:http';
import os from 'node:os';
import { readFile } from 'node:fs/promises';
import { WebSocketServer } from 'ws';

const ROOT = new URL('./', import.meta.url);
const START_PORT = Number(process.env.PORT) || 3000;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
};

// Short addresses for the pages. Everything else is looked up in public/ (or lib/ for shared code).
const PAGES = { '/': 'public/index.html', '/host': 'public/host.html', '/display': 'public/display.html' };

async function serveFile(req, res) {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let file = PAGES[path];
  if (!file) {
    if (path.includes('..') || path.includes('\0')) return send(res, 400, 'Bad path');
    file = path.startsWith('/lib/') ? path.slice(1) : 'public' + path;
  }
  try {
    const body = await readFile(new URL(file, ROOT));
    const ext = file.slice(file.lastIndexOf('.'));
    res.writeHead(200, { 'Content-Type': TYPES[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(body);
  } catch {
    send(res, 404, 'Not found');
  }
}

function send(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

// The address phones should use: the laptop's Wi-Fi/Ethernet IP, skipping Docker and VPN-ish ones.
export function lanAddresses() {
  const found = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    if (/^(docker|br-|veth|virbr|lo|tun|tap|wg)/.test(name)) continue;
    for (const a of addrs || []) if (a.family === 'IPv4' && !a.internal) found.push(a.address);
  }
  const rank = (ip) => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : ip.startsWith('172.') ? 2 : 3);
  return found.sort((a, b) => rank(a) - rank(b));
}

// Try 3000, then 3001, … if the port is busy.
function listen(server, port, tries = 10) {
  return new Promise((resolve, reject) => {
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE' && tries > 1) resolve(listen(server, port + 1, tries - 1));
      else reject(err);
    });
    server.listen(port, '0.0.0.0', () => resolve(port));
  });
}

export async function startServer({ port = START_PORT, quiet = false } = {}) {
  const server = http.createServer(serveFile);
  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ type: 'hello' }));
  });
  const actual = await listen(server, port);
  const ip = lanAddresses()[0];
  const info = {
    port: actual,
    hostUrl: `http://localhost:${actual}/host`,
    displayUrl: `http://localhost:${actual}/display`,
    phoneUrl: ip ? `http://${ip}:${actual}/` : null,
  };
  if (!quiet) {
    console.log('\n  ProQuiz is running!\n');
    console.log(`  Host (this laptop):  ${info.hostUrl}`);
    console.log(`  TV screen:           ${info.displayUrl}`);
    console.log(`  Phones:              ${info.phoneUrl ?? '(no Wi-Fi network found — connect to Wi-Fi and restart)'}`);
    console.log('\n  Press Ctrl+C to stop.\n');
  }
  return { server, wss, info, close: () => new Promise((r) => { wss.close(); server.close(r); server.closeAllConnections?.(); }) };
}

// Start only when run directly (not when a test imports this file). Works in Node and Deno.
if (import.meta.main) await startServer();

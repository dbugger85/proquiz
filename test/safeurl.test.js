// lib/safeurl.js: the "is this an IP address?" check (the same answers as Node's isIP) and the addresses the
// picture and song search may download from.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isIP as nodeIsIP } from 'node:net';
import { isIP, safeUrl } from '../lib/safeurl.js';

test('isIP(): IPv4, IPv6 (with or without brackets) and names, the same as Node', () => {
  const cases = [
    '127.0.0.1', '10.0.0.1', '192.168.1.255', '255.255.255.255', '0.0.0.0',
    '256.1.1.1', '1.2.3', '1.2.3.4.5', '01.2.3.4', '1.2.3.4 ', ' 1.2.3.4', '',
    '::1', '::', 'fe80::1', '2001:db8::ff00:42:8329', '1:2:3:4:5:6:7:8', '::ffff:127.0.0.1', '1:2:3:4:5:6:7::',
    '1:2:3:4:5:6:7:8:9', '1::2::3', '1:::2', '12345::', 'fe80::1%eth0', ':1', '1:', 'g::1', '::ffff:1.2.3',
    'localhost', 'example.com', 'proquiz.local', 'a.b', 'host:3000',
  ];
  for (const c of cases) assert.equal(isIP(c), nodeIsIP(c), JSON.stringify(c));
  assert.equal(isIP('[::1]'), 6); // as URL.hostname gives it
  assert.equal(isIP('[1.2.3.4]'), 4);
  assert.equal(isIP(null), 0);
  assert.equal(isIP(undefined), 0);
});

test('safeUrl(): https to a real name only, and only the given hosts', () => {
  assert.equal(safeUrl('https://live.staticflickr.com/a.jpg'), 'https://live.staticflickr.com/a.jpg');
  assert.equal(safeUrl('https://Upload.Wikimedia.org/x.png', ['upload.wikimedia.org']), 'https://upload.wikimedia.org/x.png');
  assert.equal(safeUrl('https://evil.example/x.png', ['upload.wikimedia.org']), null);
  const bad = [
    'http://live.staticflickr.com/a.jpg', // not https
    'https://127.0.0.1/x.jpg', // an IP
    'https://[::1]/x.jpg',
    'https://10.0.0.1:8443/x.jpg',
    'https://localhost/x.jpg',
    'https://intranet/x.jpg', // no dot
    'https://printer.local/x.jpg',
    'https://box.lan/x.jpg',
    'https://x.home/x.jpg',
    'https://1.0.0.10.in-addr.arpa/x.jpg',
    'https://user:pw@live.staticflickr.com/a.jpg', // credentials
    'ftp://live.staticflickr.com/a.jpg',
    'not a url',
    '',
    null,
    undefined,
  ];
  for (const u of bad) assert.equal(safeUrl(u), null, String(u));
});

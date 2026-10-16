// Addresses the server may fetch from (the editor's picture and song search), and a small "is this an IP address?"
// check, shared by pictures.js, songs.js and the pages. No Node modules, so it also runs in a browser or a Worker.

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

// 4 for an IPv4 address, 6 for an IPv6 one (with or without brackets, with or without a "%zone"), 0 for anything
// else: the same answers as Node's `isIP`. A host name never contains a colon, so a colon means IPv6 (only hex
// digits, colons and dots, as in "::ffff:127.0.0.1", and never two "::").
export function isIP(text) {
  const s = String(text ?? '')
    .replace(/^\[|\]$/g, '')
    .replace(/%[0-9a-z.:-]+$/i, '');
  if (IPV4.test(s)) return 4;
  if (!s.includes(':') || !/^[0-9a-f:.]+$/i.test(s) || s.length > 45) return 0;
  const parts = s.split('::');
  if (parts.length > 2) return 0;
  const groups = parts.flatMap((p) => (p === '' ? [] : p.split(':')));
  if (groups.some((g) => g === '')) return 0;
  const last = groups[groups.length - 1];
  const v4tail = last?.includes('.') ? 2 : 0; // "::ffff:1.2.3.4" (the IPv4 part counts as two groups)
  if (v4tail && !IPV4.test(last)) return 0;
  if (groups.slice(0, v4tail ? -1 : undefined).some((g) => !/^[0-9a-f]{1,4}$/i.test(g))) return 0;
  const count = groups.length - (v4tail ? 1 : 0) + v4tail;
  return (parts.length === 2 ? count < 8 : count === 8) ? 6 : 0;
}

// An address the server may download from: https, a real name (no IP address, no local names) and, when `hosts` is
// given, only those hosts. Returns the address as a string, or null.
export function safeUrl(u, hosts = null) {
  let url;
  try {
    url = new URL(u);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (url.protocol !== 'https:' || url.username || url.password) return null;
  if (isIP(host) || host === 'localhost' || !host.includes('.') || /\.(local|localhost|internal|lan|home|arpa)$/.test(host)) return null;
  if (hosts && !hosts.includes(host)) return null;
  return url.href;
}

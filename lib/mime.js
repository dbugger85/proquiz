// Content types by file extension, shared by server.js (the pages, /files/ and the logo) and, later, the website.
// No Node modules.

export const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.woff2': 'font/woff2',
};

// The content type for a file name (by its extension, any case), or 'application/octet-stream'.
export function typeFor(name) {
  const dot = String(name ?? '').lastIndexOf('.');
  return (dot >= 0 && TYPES[name.slice(dot).toLowerCase()]) || 'application/octet-stream';
}

// The host's logo (brand.js): PNG, JPG, WebP or SVG.
export const LOGO_TYPES = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', svg: 'image/svg+xml' };

const ascii = (b, from, text) => b.length >= from + text.length && [...text].every((ch, i) => b[from + i] === ch.charCodeAt(0));

// What kind of picture these bytes really are (the file name's extension alone isn't trusted): png, jpg, webp,
// svg or null. Works on any Uint8Array (a Node Buffer too), so the website's Worker can use it.
export function logoKind(bytes) {
  const b = bytes;
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b.length >= 12 && ascii(b, 0, 'RIFF') && ascii(b, 8, 'WEBP')) return 'webp';
  // SVG is text: an optional BOM, XML declaration, comments and doctype, then an <svg> element.
  const head = new TextDecoder().decode(b.subarray(0, Math.min(b.length, 4096))).replace(/^﻿/, '');
  const rest = head.replace(/^\s*(<\?xml[^>]*\?>\s*)?((<!--[\s\S]*?-->|<!DOCTYPE[^>]*>)\s*)*/i, '');
  if (/^<svg[\s>]/i.test(rest)) return 'svg';
  return null;
}

// What a downloaded picture really is (pictures.js): the logo kinds plus GIF.
export function imageKind(bytes) {
  if (ascii(bytes, 0, 'GIF87a') || ascii(bytes, 0, 'GIF89a')) return 'gif';
  return logoKind(bytes);
}

// Headers for the logo. The CSP and `nosniff` matter for SVG: opened directly, it can't run scripts or load anything.
export function logoHeaders(file) {
  return {
    'Content-Type': LOGO_TYPES[file.slice(file.lastIndexOf('.') + 1)],
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox",
    'Cache-Control': 'max-age=31536000, immutable', // the name changes with the content
  };
}

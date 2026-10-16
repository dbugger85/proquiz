// Security headers for every page of the website version (docs/dev/web-plan.md §6). The build script writes them
// into dist/web/_headers for the static pages, and the Worker adds them to the pages it serves itself (/r/…).
// 'unsafe-inline' for styles: the pages set team colours and the like as `style` attributes (h() in ui.js).

export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data: https:",
  "media-src 'self' blob: https:",
  "connect-src 'self'",
  "font-src 'self'",
  "frame-src 'self'",
  "frame-ancestors 'self'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

export const SECURITY_HEADERS = {
  'Content-Security-Policy': CSP,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
};

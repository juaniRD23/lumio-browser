// Passwords for email + password accounts (email-auth.ts): PBKDF2-SHA256
// through WebCrypto, with a new random 16-byte salt for every hash. A hash is
// stored as 'pbkdf2-sha256$<iterations>$<salt>$<hash>' (base64url), so the
// count can go up later: signing in with an older count saves a new hash.
// 100,000 iterations is the most Cloudflare Workers allow. Passwords are
// used as typed (never trimmed), in Unicode NFC, so the same characters
// typed on another keyboard still match.
import { base64url, timingSafeEqual } from './util.ts';

export const PBKDF2_ITERATIONS = 100000;
// The hash of a random password nobody knows. A sign-in for an email with no
// password is checked against it, so it takes as long as any other.
export const DUMMY_HASH = 'pbkdf2-sha256$100000$20zpAo84xY6F7lgnvEogEQ$SU2CZH5nvt3UD5CWKfaZJ2x-H4i3sLvzJ1Jy3TnFWzo';

function fromBase64url(s: string) {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
  try { return Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=')), (c) => c.charCodeAt(0)); } catch { return null; }
}

async function derive(password: string, salt: Uint8Array, iterations: number) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password.normalize('NFC')), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256));
}

export async function hashPassword(password: string) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2-sha256$${PBKDF2_ITERATIONS}$${base64url(salt)}$${base64url(await derive(password, salt, PBKDF2_ITERATIONS))}`;
}

// Whether the password is the one `stored` was made from. A hash Lumio
// doesn't know how to check (another algorithm, a count Workers can't run)
// simply doesn't match.
export async function verifyPassword(password: string, stored: string) {
  const [alg, count, salt64, hash64, ...rest] = stored.split('$');
  const iterations = /^\d{1,6}$/.test(count || '') ? Number(count) : 0;
  const salt = fromBase64url(salt64 || '');
  const hash = fromBase64url(hash64 || '');
  if (alg !== 'pbkdf2-sha256' || rest.length || iterations < 1 || iterations > PBKDF2_ITERATIONS || !salt || !hash) return false;
  return timingSafeEqual(await derive(password, salt, iterations), hash);
}

// A hash made with fewer iterations than today's count (saved again at the next sign-in).
export const needsUpgrade = (stored: string) => Number(stored.split('$')[1]) < PBKDF2_ITERATIONS;

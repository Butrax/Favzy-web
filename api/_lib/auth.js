// Authentification : mot de passe unique (variable d'environnement) + cookie de
// session signé en HMAC-SHA256. Aucun état côté serveur.
import crypto from 'node:crypto';
import { ConfigError, send } from './http.js';

export const COOKIE_NAME = 'favzy_session';
export const SESSION_SECONDS = 60 * 60 * 24 * 30; // 30 jours

export function env(name) {
  const value = process.env[name];
  if (!value) throw new ConfigError(`Variable d'environnement manquante : ${name}`);
  return value;
}

function hmac(data) {
  return crypto.createHmac('sha256', env('SESSION_SECRET')).update(data).digest('base64url');
}

// Comparaison en temps constant : on compare les empreintes SHA-256 (longueur fixe),
// ce qui évite aussi de révéler la longueur du mot de passe.
export function passwordMatches(input) {
  const a = crypto.createHash('sha256').update(String(input)).digest();
  const b = crypto.createHash('sha256').update(env('APP_PASSWORD')).digest();
  return crypto.timingSafeEqual(a, b);
}

export function createSessionToken(now = Date.now()) {
  const payload = Buffer.from(JSON.stringify({ exp: now + SESSION_SECONDS * 1000 })).toString('base64url');
  return `${payload}.${hmac(payload)}`;
}

export function verifySessionToken(token, now = Date.now()) {
  if (typeof token !== 'string') return false;
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra !== undefined) return false;
  const expected = Buffer.from(hmac(payload));
  const given = Buffer.from(signature);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return false;
  try {
    const { exp } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return typeof exp === 'number' && exp > now;
  } catch {
    return false;
  }
}

export function parseCookies(header = '') {
  const cookies = {};
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    cookies[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return cookies;
}

export function isAuthenticated(req) {
  return verifySessionToken(parseCookies(req.headers.cookie)[COOKIE_NAME]);
}

export function sessionCookie(req, token, maxAge) {
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}

// À appeler en tête de chaque route protégée. Renvoie false (et répond 401) si non connecté.
export function requireAuth(req, res) {
  if (isAuthenticated(req)) return true;
  send(res, 401, { error: 'Non connecté' });
  return false;
}

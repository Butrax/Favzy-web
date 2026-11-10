// Utilitaires HTTP communs aux fonctions Vercel (Node.js, sans dépendance).

export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export class ConfigError extends Error {}

export function send(res, status, body, headers = {}) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  for (const [key, value] of Object.entries(headers)) res.setHeader(key, value);
  res.end(JSON.stringify(body));
}

export function sendError(res, error) {
  if (error instanceof HttpError) {
    return send(res, error.status, { error: error.message, ...error.extra });
  }
  if (error instanceof ConfigError) {
    // Le message ne contient que le nom de la variable manquante, jamais sa valeur.
    return send(res, 500, { error: error.message });
  }
  console.error(error);
  return send(res, 500, { error: 'Erreur interne' });
}

export async function readJson(req, limit = 2 * 1024 * 1024) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'string') return parse(req.body);
    if (Buffer.isBuffer(req.body)) return parse(req.body.toString('utf8'));
    return req.body;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'Requête trop volumineuse');
    chunks.push(chunk);
  }
  return parse(Buffer.concat(chunks).toString('utf8'));
}

function parse(text) {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'JSON invalide');
  }
}

// Défense CSRF en plus du cookie SameSite=Strict : si le navigateur envoie un
// en-tête Origin, il doit correspondre à l'hôte de l'application.
export function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

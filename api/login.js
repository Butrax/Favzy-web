import { SESSION_SECONDS, createSessionToken, passwordMatches, sessionCookie } from './_lib/auth.js';
import { HttpError, readJson, send, sendError, sameOrigin, sleep } from './_lib/http.js';

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      throw new HttpError(405, 'Méthode non autorisée');
    }
    if (!sameOrigin(req)) throw new HttpError(403, 'Origine refusée');
    const body = await readJson(req);
    if (!passwordMatches(body?.password ?? '')) {
      await sleep(1000); // ralentit les tentatives répétées (sans état côté serveur)
      throw new HttpError(401, 'Mot de passe incorrect');
    }
    send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, createSessionToken(), SESSION_SECONDS) });
  } catch (error) {
    sendError(res, error);
  }
}

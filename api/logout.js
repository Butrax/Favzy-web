import { sessionCookie } from './_lib/auth.js';
import { HttpError, send, sendError, sameOrigin } from './_lib/http.js';

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      throw new HttpError(405, 'Méthode non autorisée');
    }
    if (!sameOrigin(req)) throw new HttpError(403, 'Origine refusée');
    send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, '', 0) });
  } catch (error) {
    sendError(res, error);
  }
}

import { requireAuth } from './_lib/auth.js';
import { cleanUrl } from './_lib/bookmarks.js';
import { HttpError, send, sendError } from './_lib/http.js';
import { extractMeta, fetchPage } from './_lib/safe-fetch.js';

// GET /api/title?url=... → { title, description } (vide si la page est illisible)
export default async function handler(req, res) {
  try {
    if (!requireAuth(req, res)) return;
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      throw new HttpError(405, 'Méthode non autorisée');
    }
    const target = cleanUrl(new URL(req.url, 'http://x').searchParams.get('url'));
    try {
      const page = await fetchPage(target);
      if (page.status >= 400) return send(res, 200, { title: '', description: '' });
      return send(res, 200, extractMeta(page.body, page.headers['content-type'], page.url));
    } catch (error) {
      if (error instanceof HttpError) throw error; // URL refusée par la protection SSRF
      return send(res, 200, { title: '', description: '' }); // site lent, bloqué, hors ligne…
    }
  } catch (error) {
    sendError(res, error);
  }
}

import { requireAuth } from './_lib/auth.js';
import { addBookmark, deleteBookmark, importBookmarks, setPrimaryTags, updateBookmark } from './_lib/bookmarks.js';
import { mutate, readStore } from './_lib/github.js';
import { HttpError, readJson, send, sendError, sameOrigin } from './_lib/http.js';

const short = (text) => String(text ?? '').slice(0, 60);

export default async function handler(req, res) {
  try {
    if (!requireAuth(req, res)) return;

    if (req.method === 'GET') {
      const { data } = await readStore();
      return send(res, 200, { bookmarks: data.bookmarks, primaryTags: data.primaryTags });
    }

    if (req.method !== 'POST') {
      res.setHeader('Allow', 'GET, POST');
      throw new HttpError(405, 'Méthode non autorisée');
    }
    if (!sameOrigin(req)) throw new HttpError(403, 'Origine refusée');

    const body = await readJson(req);
    const force = body.force === true;
    let message;
    let change;

    switch (body.op) {
      case 'add':
        message = `Ajout : ${short(body.bookmark?.title || body.bookmark?.url)}`;
        change = (data) => addBookmark(data, body.bookmark, { force });
        break;
      case 'update':
        message = `Modification : ${short(body.id)}`;
        change = (data) => updateBookmark(data, body.id, body.patch, { force });
        break;
      case 'delete':
        message = `Suppression : ${short(body.id)}`;
        change = (data) => deleteBookmark(data, body.id);
        break;
      case 'primaryTags':
        message = 'Tags principaux';
        change = (data) => setPrimaryTags(data, body.tags);
        break;
      case 'import':
        message = `Import de ${Array.isArray(body.bookmarks) ? body.bookmarks.length : 0} marque-pages`;
        change = (data) => {
          const result = importBookmarks(data, body.bookmarks);
          // Restauration d'un export JSON : on ajoute les tags principaux qui y figuraient.
          if (Array.isArray(body.primaryTags)) setPrimaryTags(data, [...data.primaryTags, ...body.primaryTags]);
          return result;
        };
        break;
      default:
        throw new HttpError(400, 'Opération inconnue');
    }

    const { data, result } = await mutate(change, message);
    const extra = body.op === 'import' ? result : {};
    send(res, 200, { bookmarks: data.bookmarks, primaryTags: data.primaryTags, ...extra });
  } catch (error) {
    sendError(res, error);
  }
}

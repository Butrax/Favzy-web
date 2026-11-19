// Stockage : un unique fichier JSON dans un dépôt GitHub privé, via l'API Contents.
// Chaque écriture = un commit (historique gratuit). Le sha du fichier sert de verrou
// optimiste : en cas de conflit, on relit, on rejoue la modification et on réessaie.
import { env } from './auth.js';
import { HttpError } from './http.js';

const API = 'https://api.github.com';

// L'API Contents ne renvoie le contenu d'un fichier que jusqu'à 1 Mo. On compte 1 000 000 d'octets :
// une petite marge de sécurité sous cette limite.
export const STORAGE_LIMIT = 1_000_000;
const sizeOf = (text) => Buffer.byteLength(text, 'utf8');
export function storageInfo(data) {
  return { bytes: sizeOf(serialize(data)), limit: STORAGE_LIMIT };
}

function config() {
  return {
    repo: env('GITHUB_REPO'), // « utilisateur/favzy-stock »
    token: env('GITHUB_TOKEN'),
    branch: process.env.GITHUB_BRANCH || 'main',
    path: process.env.GITHUB_FILE || 'bookmarks.json',
  };
}

async function github(method, url, token, body) {
  let response;
  try {
    response = await fetch(`${API}${url}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'favzy-web',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    throw new HttpError(502, 'GitHub injoignable');
  }
  const payload = await response.json().catch(() => ({}));
  return { status: response.status, ok: response.ok, payload };
}

function githubError(status, action) {
  if (status === 401) return new HttpError(502, 'Token GitHub invalide ou expiré');
  if (status === 403) return new HttpError(502, 'GitHub refuse l\'accès (permissions du token ou limite d\'appels)');
  if (status === 404) return new HttpError(502, 'Dépôt introuvable : vérifie GITHUB_REPO et les droits du token (Contents : Read and write)');
  return new HttpError(502, `Erreur GitHub (${status}) pendant : ${action}`);
}

export function emptyData() {
  return { version: 2, primaryTags: [], bookmarks: [] };
}

export function parseData(text) {
  if (!text.trim()) return emptyData();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpError(500, 'Le fichier de données n\'est pas un JSON valide');
  }
  const list = Array.isArray(parsed) ? parsed : parsed?.bookmarks; // tolère un simple « [] »
  if (!Array.isArray(list)) throw new HttpError(500, 'Format du fichier de données inattendu');
  const bookmarks = list.filter((b) => b && typeof b === 'object');
  for (const bookmark of bookmarks) {
    delete bookmark.folder; // ancien champ « dossier » (version 1) : supprimé à la prochaine écriture
    if (!Array.isArray(bookmark.tags)) bookmark.tags = [];
  }
  const primaryTags = Array.isArray(parsed?.primaryTags) ? parsed.primaryTags.filter((t) => typeof t === 'string') : [];
  return { version: 2, primaryTags, bookmarks };
}

// Un marque-page par ligne : diffs Git lisibles.
export function serialize(data) {
  const lines = data.bookmarks.map((b) => `    ${JSON.stringify(b)}`);
  const body = lines.length ? `[\n${lines.join(',\n')}\n  ]` : '[]';
  return `{\n  "version": 2,\n  "primaryTags": ${JSON.stringify(data.primaryTags ?? [])},\n  "bookmarks": ${body}\n}\n`;
}

export async function readStore() {
  const { repo, token, branch, path } = config();
  const result = await github('GET', `/repos/${repo}/contents/${encodeURI(path)}?ref=${encodeURIComponent(branch)}`, token);
  if (result.status === 404) {
    // Fichier absent (normal au premier lancement) ou dépôt inaccessible : on départage.
    const repoCheck = await github('GET', `/repos/${repo}`, token);
    if (!repoCheck.ok) throw githubError(repoCheck.status, 'lecture du dépôt');
    return { data: emptyData(), sha: null };
  }
  if (!result.ok) throw githubError(result.status, 'lecture des données');
  const { content, encoding, sha } = result.payload;
  if (encoding !== 'base64') throw new HttpError(500, 'Fichier de données trop volumineux pour l\'API Contents (> 1 Mo)');
  return { data: parseData(Buffer.from(content, 'base64').toString('utf8')), sha };
}

async function writeStore(data, sha, message) {
  const { repo, token, branch, path } = config();
  const result = await github('PUT', `/repos/${repo}/contents/${encodeURI(path)}`, token, {
    message,
    content: Buffer.from(serialize(data), 'utf8').toString('base64'),
    branch,
    ...(sha ? { sha } : {}),
  });
  if (result.ok) return;
  const error = githubError(result.status, 'écriture des données');
  error.conflict = result.status === 409 || result.status === 422; // sha périmé
  throw error;
}

// Lit le fichier, applique `change(data)` (qui peut lancer une HttpError), écrit le résultat.
// En cas de conflit d'écriture, recommence à partir de la version la plus récente.
export async function mutate(change, message, attempts = 4) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const { data, sha } = await readStore();
    const before = serialize(data);
    const result = change(data);
    const after = serialize(data);
    if (after === before) return { data, result }; // rien n'a changé : pas de commit inutile
    // Au-delà de la limite, le fichier ne pourrait plus être relu : on refuse tout ce qui le fait grossir.
    // (Supprimer ou raccourcir reste toujours possible.)
    if (sizeOf(after) > STORAGE_LIMIT && sizeOf(after) > sizeOf(before)) {
      throw new HttpError(413, 'Stockage plein (1 Mo atteint) : supprime des favoris ou exporte-les avant d\u2019en ajouter');
    }
    try {
      await writeStore(data, sha, message);
      return { data, result };
    } catch (error) {
      if (!error.conflict || attempt === attempts) {
        throw error.conflict ? new HttpError(503, 'Conflit d\'écriture répété, réessaie dans un instant') : error;
      }
    }
  }
}

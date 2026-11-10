// Stockage : un unique fichier JSON dans un dépôt GitHub privé, via l'API Contents.
// Chaque écriture = un commit (historique gratuit). Le sha du fichier sert de verrou
// optimiste : en cas de conflit, on relit, on rejoue la modification et on réessaie.
import { env } from './auth.js';
import { HttpError } from './http.js';

const API = 'https://api.github.com';

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
  return { version: 1, bookmarks: [] };
}

export function parseData(text) {
  if (!text.trim()) return emptyData();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpError(500, 'Le fichier de données n\'est pas un JSON valide');
  }
  if (Array.isArray(parsed)) return { version: 1, bookmarks: parsed }; // tolère un simple « [] »
  if (!parsed || !Array.isArray(parsed.bookmarks)) throw new HttpError(500, 'Format du fichier de données inattendu');
  return { version: 1, bookmarks: parsed.bookmarks };
}

// Un marque-page par ligne : diffs Git lisibles.
export function serialize(data) {
  const lines = data.bookmarks.map((b) => `    ${JSON.stringify(b)}`);
  const body = lines.length ? `[\n${lines.join(',\n')}\n  ]` : '[]';
  return `{\n  "version": 1,\n  "bookmarks": ${body}\n}\n`;
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
    const result = change(data);
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

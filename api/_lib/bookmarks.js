// Logique métier pure (sans réseau) : validation, tags, détection de doublons, opérations.
import crypto from 'node:crypto';
import { HttpError } from './http.js';

const LIMITS = { url: 2048, title: 300, description: 2000, tag: 50, tags: 30, primary: 200, import: 5000 };

// Identité d'un tag : insensible à la casse (« Musique » = « musique »).
// Même définition que tagKey dans public/tagnav.js.
export const tagKey = (name) => String(name ?? '').normalize('NFC').trim().toLowerCase();

// Même logique que normalizeUrl dans public/app.js (détection de doublons côté client).
export function normalizeUrl(href) {
  const url = new URL(href);
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    if (/^(utm_|fbclid$|gclid$)/i.test(key)) url.searchParams.delete(key);
  }
  let out = url.href;
  if (url.pathname.length > 1 && url.pathname.endsWith('/') && !url.search) out = out.slice(0, -1);
  if (url.pathname === '/' && !url.search) out = out.replace(/\/$/, '');
  return out;
}

export function cleanUrl(value) {
  let url;
  try {
    url = new URL(String(value ?? '').trim());
  } catch {
    throw new HttpError(400, 'URL invalide');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new HttpError(400, 'Seules les URL http(s) sont acceptées');
  if (url.href.length > LIMITS.url) throw new HttpError(400, 'URL trop longue');
  return url.href;
}

const text = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

// Écriture connue de chaque tag de la bibliothèque. Un tag saisi « musique » reprend
// l'écriture « Musique » si elle existe déjà : pas de doublons qui ne diffèrent que par la casse.
export function knownTags(data, { withPrimary = true, exceptId = null } = {}) {
  const known = new Map();
  const remember = (name) => {
    const key = tagKey(name);
    if (key && !known.has(key)) known.set(key, name);
  };
  for (const bookmark of data.bookmarks) {
    if (bookmark.id !== exceptId) (bookmark.tags ?? []).forEach(remember);
  }
  if (withPrimary) (data.primaryTags ?? []).forEach(remember);
  return known;
}

export function cleanTags(value, known = new Map()) {
  const list = Array.isArray(value) ? value : String(value ?? '').split(',');
  const out = new Map();
  for (const raw of list) {
    const name = text(raw, LIMITS.tag);
    const key = tagKey(name);
    if (!key || out.has(key)) continue;
    if (!known.has(key)) known.set(key, name);
    out.set(key, known.get(key));
    if (out.size >= LIMITS.tags) break;
  }
  return [...out.values()];
}

// Définit la liste complète des tags principaux. Seuls les tags utilisés par au moins un
// favori sont acceptés (c'est « parmi tous les tags attribués dans les favoris »).
export function setPrimaryTags(data, names) {
  if (!Array.isArray(names)) throw new HttpError(400, 'Liste de tags attendue');
  const known = knownTags(data, { withPrimary: false });
  const out = new Map();
  for (const raw of names) {
    const key = tagKey(text(raw, LIMITS.tag));
    if (known.has(key) && !out.has(key)) out.set(key, known.get(key));
    if (out.size >= LIMITS.primary) break;
  }
  data.primaryTags = [...out.values()];
  return data.primaryTags;
}

function findDuplicate(bookmarks, href, ignoreId) {
  const key = normalizeUrl(href);
  return bookmarks.find((b) => b.id !== ignoreId && normalizeUrl(b.url) === key);
}

function duplicateError(existing) {
  return new HttpError(409, 'Cette URL est déjà enregistrée', { duplicate: true, existing });
}

export function addBookmark(data, input, { force = false } = {}) {
  const url = cleanUrl(input?.url);
  const existing = findDuplicate(data.bookmarks, url);
  if (existing && !force) throw duplicateError(existing);
  const bookmark = {
    id: crypto.randomUUID(),
    url,
    title: text(input?.title, LIMITS.title) || new URL(url).hostname,
    description: text(input?.description, LIMITS.description),
    tags: cleanTags(input?.tags, knownTags(data)),
    favorite: Boolean(input?.favorite),
    createdAt: new Date().toISOString(),
  };
  data.bookmarks.unshift(bookmark);
  return bookmark;
}

export function updateBookmark(data, id, patch = {}, { force = false } = {}) {
  const bookmark = data.bookmarks.find((b) => b.id === id);
  if (!bookmark) throw new HttpError(404, 'Marque-page introuvable');
  if ('url' in patch) {
    const url = cleanUrl(patch.url);
    const existing = findDuplicate(data.bookmarks, url, id);
    if (existing && !force) throw duplicateError(existing);
    bookmark.url = url;
  }
  if ('title' in patch) bookmark.title = text(patch.title, LIMITS.title) || new URL(bookmark.url).hostname;
  if ('description' in patch) bookmark.description = text(patch.description, LIMITS.description);
  if ('tags' in patch) bookmark.tags = cleanTags(patch.tags, knownTags(data, { exceptId: id }));
  if ('favorite' in patch) bookmark.favorite = Boolean(patch.favorite);
  return bookmark;
}

export function deleteBookmark(data, id) {
  const index = data.bookmarks.findIndex((b) => b.id === id);
  if (index < 0) throw new HttpError(404, 'Marque-page introuvable');
  const [removed] = data.bookmarks.splice(index, 1);
  return removed;
}

export function importBookmarks(data, items) {
  if (!Array.isArray(items)) throw new HttpError(400, 'Liste de marque-pages attendue');
  if (items.length > LIMITS.import) throw new HttpError(400, `Import limité à ${LIMITS.import} marque-pages à la fois`);
  const urls = new Set(data.bookmarks.map((b) => normalizeUrl(b.url)));
  const known = knownTags(data);
  const fresh = [];
  let skipped = 0;
  for (const item of items) {
    let url;
    try {
      url = cleanUrl(item?.url);
    } catch {
      skipped++;
      continue;
    }
    const key = normalizeUrl(url);
    if (urls.has(key)) {
      skipped++;
      continue;
    }
    urls.add(key);
    const date = new Date(item?.createdAt);
    fresh.push({
      id: crypto.randomUUID(),
      url,
      title: text(item?.title, LIMITS.title) || new URL(url).hostname,
      description: text(item?.description, LIMITS.description),
      tags: cleanTags(item?.tags, known),
      favorite: Boolean(item?.favorite),
      createdAt: Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString(),
    });
  }
  data.bookmarks.unshift(...fresh);
  return { added: fresh.length, skipped };
}

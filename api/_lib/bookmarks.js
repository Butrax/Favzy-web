// Logique métier pure (sans réseau) : validation, détection de doublons, opérations.
import crypto from 'node:crypto';
import { HttpError } from './http.js';

const LIMITS = { url: 2048, title: 300, description: 2000, folder: 200, tag: 50, tags: 30, import: 5000 };

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

export function cleanTags(value) {
  const list = Array.isArray(value) ? value : String(value ?? '').split(',');
  const seen = new Set();
  for (const raw of list) {
    const tag = text(raw, LIMITS.tag).toLowerCase();
    if (tag) seen.add(tag);
    if (seen.size >= LIMITS.tags) break;
  }
  return [...seen];
}

export function cleanFolder(value) {
  return String(value ?? '')
    .split('/')
    .map((part) => text(part, LIMITS.folder))
    .filter(Boolean)
    .join('/')
    .slice(0, LIMITS.folder);
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
    tags: cleanTags(input?.tags),
    folder: cleanFolder(input?.folder),
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
  if ('tags' in patch) bookmark.tags = cleanTags(patch.tags);
  if ('folder' in patch) bookmark.folder = cleanFolder(patch.folder);
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
  const known = new Set(data.bookmarks.map((b) => normalizeUrl(b.url)));
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
    if (known.has(key)) {
      skipped++;
      continue;
    }
    known.add(key);
    const date = new Date(item?.createdAt);
    fresh.push({
      id: crypto.randomUUID(),
      url,
      title: text(item?.title, LIMITS.title) || new URL(url).hostname,
      description: text(item?.description, LIMITS.description),
      tags: cleanTags(item?.tags),
      folder: cleanFolder(item?.folder),
      favorite: Boolean(item?.favorite),
      createdAt: Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString(),
    });
  }
  data.bookmarks.unshift(...fresh);
  return { added: fresh.length, skipped };
}

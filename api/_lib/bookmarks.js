// Logique métier pure (sans réseau) : validation, tags, détection de doublons, opérations.
import crypto from 'node:crypto';
import { HttpError } from './http.js';

const LIMITS = { url: 2048, title: 300, description: 5000, tag: 50, tags: 30, primary: 200, import: 5000 };

// Identité d'un tag : insensible à la casse (« Musique » = « musique »).
// Même définition que tagKey dans public/tagnav.js.
export const tagKey = (name) => String(name ?? '').normalize('NFC').trim().toLowerCase();

// Même logique que normalizeUrl dans public/app.js (détection de doublons côté client).
export function normalizeUrl(href) {
  if (!href) return ''; // une note n'a pas d'URL
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

// URL facultative : vide = note textuelle.
export function optionalUrl(value) {
  return String(value ?? '').trim() ? cleanUrl(value) : '';
}

const text = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

// Texte multi-lignes (description) : les retours à la ligne sont conservés,
// les espaces en fin de ligne et les séries de lignes vides sont réduits.
const multiline = (value, max) =>
  String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, max)
    .trim();

// Titre : celui saisi, sinon le nom de domaine, sinon (note) la première ligne de la description.
function titleFor(url, title, description) {
  const given = text(title, LIMITS.title);
  if (given) return given;
  if (url) return new URL(url).hostname;
  const first = text(description.split('\n').find((line) => line.trim()), LIMITS.title);
  if (first) return first;
  throw new HttpError(400, 'Une note a besoin d\u2019un titre ou d\u2019une description');
}

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

// Remplace un tag dans une liste (en gardant sa place) et retire les doublons créés par la fusion.
function remapTag(list, fromKey, target) {
  const out = [];
  const seen = new Set();
  for (const tag of list ?? []) {
    const name = tagKey(tag) === fromKey ? target : tag;
    const key = tagKey(name);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(name);
    }
  }
  return out;
}

const sameList = (a, b) => a.length === b.length && a.every((value, i) => value === b[i]);

// Renomme un tag dans TOUS les favoris qui le portent (et dans les tags principaux).
//  - nouveau nom déjà utilisé par un autre tag → fusion, sans doublon, avec l'écriture existante ;
//  - le tag reste principal s'il l'était (ou si celui dans lequel il fusionne l'est) ;
//  - changement de casse seul (« musique » → « Musique ») accepté.
export function renameTag(data, from, to) {
  const fromKey = tagKey(from);
  const name = text(to, LIMITS.tag);
  const toKey = tagKey(name);
  if (!toKey) throw new HttpError(400, 'Le nom du tag ne peut pas être vide');
  if (name.includes(',')) throw new HttpError(400, 'Un tag ne peut pas contenir de virgule');
  const used = knownTags(data, { withPrimary: false });
  if (!used.has(fromKey)) throw new HttpError(404, 'Tag introuvable');

  const merged = toKey !== fromKey && used.has(toKey);
  const target = fromKey === toKey ? name : (knownTags(data).get(toKey) ?? name);

  let renamed = 0;
  for (const bookmark of data.bookmarks) {
    const next = remapTag(bookmark.tags, fromKey, target);
    if (!sameList(next, bookmark.tags ?? [])) {
      bookmark.tags = next;
      renamed++;
    }
  }
  const primary = remapTag(data.primaryTags, fromKey, target);
  const primaryChanged = !sameList(primary, data.primaryTags ?? []);
  if (!renamed && !primaryChanged) throw new HttpError(400, 'Aucun changement');
  data.primaryTags = primary;
  return { renamed, merged };
}

// Ajoute le même lot de tags à plusieurs favoris, sans toucher à leurs autres tags.
// Un tag déjà présent n'est pas dupliqué ; un tag déjà connu garde son écriture (« musique » → « Musique »).
export function addTagsToBookmarks(data, ids, tags) {
  if (!Array.isArray(ids) || !ids.length) throw new HttpError(400, 'Aucun favori sélectionné');
  if (ids.length > LIMITS.import) throw new HttpError(400, `Limité à ${LIMITS.import} favoris à la fois`);
  const added = cleanTags(tags, knownTags(data));
  if (!added.length) throw new HttpError(400, 'Aucun tag à ajouter');

  const wanted = new Set(ids.map(String));
  let updated = 0;
  let unchanged = 0;
  for (const bookmark of data.bookmarks) {
    if (!wanted.has(bookmark.id)) continue;
    const have = new Set(bookmark.tags.map(tagKey));
    const next = [...bookmark.tags];
    for (const tag of added) {
      if (!have.has(tagKey(tag)) && next.length < LIMITS.tags) next.push(tag);
    }
    if (next.length > bookmark.tags.length) {
      bookmark.tags = next;
      updated++;
    } else {
      unchanged++;
    }
  }
  return { updated, unchanged };
}

function findDuplicate(bookmarks, href, ignoreId) {
  const key = normalizeUrl(href);
  if (!key) return undefined; // les notes n'ont pas d'URL : jamais de doublon
  return bookmarks.find((b) => b.id !== ignoreId && normalizeUrl(b.url) === key);
}

function duplicateError(existing) {
  return new HttpError(409, 'Cette URL est déjà enregistrée', { duplicate: true, existing });
}

export function addBookmark(data, input, { force = false } = {}) {
  const url = optionalUrl(input?.url);
  const existing = findDuplicate(data.bookmarks, url);
  if (existing && !force) throw duplicateError(existing);
  const description = multiline(input?.description, LIMITS.description);
  const bookmark = {
    id: crypto.randomUUID(),
    url,
    title: titleFor(url, input?.title, description),
    description,
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
    const url = optionalUrl(patch.url);
    const existing = findDuplicate(data.bookmarks, url, id);
    if (existing && !force) throw duplicateError(existing);
    bookmark.url = url;
  }
  if ('description' in patch) bookmark.description = multiline(patch.description, LIMITS.description);
  if ('title' in patch || 'url' in patch || 'description' in patch) {
    bookmark.title = titleFor(bookmark.url, 'title' in patch ? patch.title : bookmark.title, bookmark.description);
  }
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
  const urls = new Set(data.bookmarks.map((b) => (b.url ? normalizeUrl(b.url) : `note\n${b.title}\n${b.description}`)));
  const known = knownTags(data);
  const fresh = [];
  let skipped = 0;
  for (const item of items) {
    let url;
    let title;
    const description = multiline(item?.description, LIMITS.description);
    try {
      url = optionalUrl(item?.url);
      title = titleFor(url, item?.title, description);
    } catch {
      skipped++;
      continue;
    }
    // Une note (sans URL) est reconnue par son titre + sa description : réimporter ne la duplique pas.
    const key = url ? normalizeUrl(url) : `note\n${title}\n${description}`;
    if (urls.has(key)) {
      skipped++;
      continue;
    }
    urls.add(key);
    const date = new Date(item?.createdAt);
    fresh.push({
      id: crypto.randomUUID(),
      url,
      title,
      description,
      tags: cleanTags(item?.tags, known),
      favorite: Boolean(item?.favorite),
      createdAt: Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString(),
    });
  }
  data.bookmarks.unshift(...fresh);
  return { added: fresh.length, skipped };
}

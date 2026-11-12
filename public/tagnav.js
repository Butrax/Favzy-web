// Moteur de navigation par tags — module pur, déterministe, sans DOM ni réseau.
//
// Règles :
//  - tous les tags sélectionnés (principaux ET secondaires) se combinent en ET strict ;
//  - les tags proposés sont uniquement ceux présents sur au moins un favori de la sélection
//    courante (donc jamais de combinaison qui mène à zéro résultat) ;
//  - les compteurs sont calculés sur ces mêmes favoris ;
//  - aucune relation entre tags n'est stockée : tout se déduit des favoris.

// Identité d'un tag : insensible à la casse. Même définition que tagKey dans api/_lib/bookmarks.js.
export const tagKey = (name) => String(name ?? '').normalize('NFC').trim().toLowerCase();

// Pour la recherche dans les boîtes : sans casse ni accents (« reverb » trouve « Réverbération »).
export const fold = (text) => String(text ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

// Tous les tags de la bibliothèque : clé → { key, name, total }. `name` est l'écriture du premier favori.
export function buildIndex(bookmarks) {
  const index = new Map();
  for (const bookmark of bookmarks) {
    for (const name of new Set((bookmark.tags ?? []).map((tag) => tag))) {
      const key = tagKey(name);
      if (!key) continue;
      const entry = index.get(key);
      if (entry) entry.total += 1;
      else index.set(key, { key, name, total: 1 });
    }
  }
  return index;
}

const byCountThenName = (a, b) => b.count - a.count || a.name.localeCompare(b.name, 'fr', { sensitivity: 'base' });

/**
 * @param bookmarks     favoris candidats (déjà restreints par la recherche texte / favoris, le cas échéant)
 * @param primaryKeys   Set des clés de tags principaux
 * @param selectedKeys  clés des tags sélectionnés (ET)
 * @param index         résultat de buildIndex sur toute la bibliothèque (pour les noms)
 * @returns results     favoris possédant tous les tags sélectionnés
 *          selected    [{ key, name, primary }] dans l'ordre de sélection
 *          primary     tags principaux disponibles (hors sélectionnés) : [{ key, name, count }]
 *          secondary   tags secondaires disponibles (hors sélectionnés)
 */
export function analyze(bookmarks, primaryKeys, selectedKeys, index) {
  const selected = [...new Set(selectedKeys)];
  const results = bookmarks.filter((bookmark) => {
    if (!selected.length) return true;
    const own = new Set((bookmark.tags ?? []).map(tagKey));
    return selected.every((key) => own.has(key));
  });

  const counts = new Map();
  for (const bookmark of results) {
    for (const key of new Set((bookmark.tags ?? []).map(tagKey))) {
      if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }

  const chosen = new Set(selected);
  const primary = [];
  const secondary = [];
  for (const [key, count] of counts) {
    if (chosen.has(key)) continue;
    const entry = { key, name: index.get(key)?.name ?? key, count };
    (primaryKeys.has(key) ? primary : secondary).push(entry);
  }

  return {
    results,
    selected: selected.map((key) => ({ key, name: index.get(key)?.name ?? key, primary: primaryKeys.has(key) })),
    primary: primary.sort(byCountThenName),
    secondary: secondary.sort(byCountThenName),
  };
}

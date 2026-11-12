// Favzy — interface (JavaScript natif, aucune dépendance).
// Tout le texte venant des données est inséré via textContent / createTextNode : jamais d'innerHTML.
import { buildNetscape, parseNetscape } from './netscape.js';
import { analyze, buildIndex, fold, tagKey } from './tagnav.js';

const $ = (selector) => document.querySelector(selector);

const state = {
  bookmarks: [],
  primaryTags: [], // noms des tags principaux (le reste est secondaire)
  query: '', // recherche texte
  favOnly: false,
  selected: [], // clés des tags sélectionnés — tous combinés en ET
  boxQuery: { primary: '', secondary: '' },
  sort: 'recent',
  editingId: null,
};

// Lien ouvert depuis le bookmarklet ou le menu « Partager » d'Android.
let incoming = readIncoming();

// --- Utilitaires ----------------------------------------------------------------

function h(tag, props = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === false || value == null) continue;
    if (key === 'class') element.className = value;
    else if (key.startsWith('on')) element.addEventListener(key.slice(2), value);
    else element.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child != null && child !== false) element.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return element;
}

// Même logique que normalizeUrl dans api/_lib/bookmarks.js (détection de doublons).
function normalizeUrl(href) {
  try {
    const url = new URL(href);
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid$|gclid$)/i.test(key)) url.searchParams.delete(key);
    }
    let out = url.href;
    if (url.pathname.length > 1 && url.pathname.endsWith('/') && !url.search) out = out.slice(0, -1);
    if (url.pathname === '/' && !url.search) out = out.replace(/\/$/, '');
    return out;
  } catch {
    return '';
  }
}

const hostOf = (href) => {
  try {
    return new URL(href).hostname.replace(/^www\./, '');
  } catch {
    return href;
  }
};
const safeHref = (href) => (/^https?:\/\//i.test(href) ? href : '#');
const hueOf = (text) => [...text].reduce((sum, c) => (sum * 31 + c.charCodeAt(0)) % 360, 7);
const byName = (a, b) => a.name.localeCompare(b.name, 'fr', { sensitivity: 'base' });

let toastTimer;
function toast(message, bad = false) {
  const element = $('#toast');
  element.textContent = message;
  element.classList.toggle('bad', bad);
  element.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (element.hidden = true), 3200);
}

class ApiError extends Error {
  constructor(status, message, data) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

async function api(path, { method = 'GET', body } = {}) {
  const response = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = await response.json().catch(() => null);
  if (response.status === 401 && path !== '/api/login') {
    showLogin();
    throw new ApiError(401, 'Session expirée : reconnecte-toi', data);
  }
  if (!response.ok) throw new ApiError(response.status, data?.error || `Erreur ${response.status}`, data);
  return data;
}

function applyData(data) {
  state.bookmarks = data.bookmarks;
  if (Array.isArray(data.primaryTags)) state.primaryTags = data.primaryTags;
}

function readIncoming() {
  const params = new URLSearchParams(location.search);
  let url = params.get('url') || '';
  if (!url) url = (params.get('text') || '').match(/https?:\/\/\S+/)?.[0] ?? '';
  if (!/^https?:\/\//i.test(url)) return null;
  history.replaceState(null, '', location.pathname); // retire les paramètres de l'adresse
  return { url, title: params.get('title') || '' };
}

// --- Connexion / session -------------------------------------------------------

function showLogin() {
  for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
  $('#app').hidden = true;
  $('#login').hidden = false;
  $('#login-password').value = '';
  $('#login-password').focus();
}

function showApp() {
  $('#login').hidden = true;
  $('#app').hidden = false;
}

async function loadAll() {
  applyData(await api('/api/bookmarks'));
  showApp();
  render();
  if (incoming) {
    const link = incoming;
    incoming = null;
    openEditor(null, link);
  }
}

$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const error = $('#login-error');
  const button = event.submitter ?? $('#login-form button');
  error.hidden = true;
  button.disabled = true;
  try {
    await api('/api/login', { method: 'POST', body: { password: $('#login-password').value } });
    await loadAll();
  } catch (e) {
    if (e.status !== 401 || $('#login').hidden === false) {
      error.textContent = e.message;
      error.hidden = false;
    }
  } finally {
    button.disabled = false;
  }
});

$('#logout').addEventListener('click', async () => {
  try {
    await api('/api/logout', { method: 'POST', body: {} });
  } catch { /* déjà déconnecté */ }
  state.bookmarks = [];
  state.primaryTags = [];
  $('#tools-dialog').close();
  showLogin();
});

// --- Navigation par tags : calcul ---------------------------------------------------

function library() {
  return { index: buildIndex(state.bookmarks), primaryKeys: new Set(state.primaryTags.map(tagKey)) };
}

// Tout est recalculé à chaque affichage à partir de l'état : aucune donnée dérivée n'est stockée.
function compute() {
  const { index, primaryKeys } = library();
  state.selected = state.selected.filter((key) => index.has(key)); // un tag qui n'existe plus est retiré
  const tokens = fold(state.query).split(/\s+/).filter(Boolean);
  const candidates = state.bookmarks.filter((b) => {
    if (state.favOnly && !b.favorite) return false;
    if (!tokens.length) return true;
    return tokens.every((token) => fold(`${b.title} ${b.url} ${b.description} ${b.tags.join(' ')}`).includes(token));
  });
  const view = analyze(candidates, primaryKeys, state.selected, index);
  const by = {
    recent: (a, b) => b.createdAt.localeCompare(a.createdAt),
    oldest: (a, b) => a.createdAt.localeCompare(b.createdAt),
    title: (a, b) => a.title.localeCompare(b.title, 'fr', { sensitivity: 'base' }),
  };
  view.results.sort(by[state.sort]);
  return { index, primaryKeys, view };
}

const filtersActive = () => state.selected.length > 0 || state.favOnly || state.query.trim() !== '';

function toggleTag(key) {
  const at = state.selected.indexOf(key);
  if (at >= 0) state.selected.splice(at, 1);
  else state.selected.push(key);
  render();
}

function addTagFilter(key) {
  if (!state.selected.includes(key)) state.selected.push(key);
  render();
}

function resetFilters() {
  state.selected = [];
  state.favOnly = false;
  state.query = '';
  state.boxQuery = { primary: '', secondary: '' };
  $('#search').value = '';
  $('#primary-search').value = '';
  $('#secondary-search').value = '';
  render();
}

// --- Navigation par tags : affichage ------------------------------------------------

function pill(entry, selected) {
  return h(
    'button',
    { class: 'tag', type: 'button', 'data-key': entry.key, 'aria-pressed': String(selected), onclick: () => toggleTag(entry.key) },
    entry.name,
    h('span', { class: 'n' }, entry.count),
  );
}

function fillBox(kind, entries, emptyMessage) {
  const query = fold(state.boxQuery[kind]).trim();
  const shown = query ? entries.filter((entry) => fold(entry.name).includes(query)) : entries;
  $(`#${kind}-list`).replaceChildren(...shown.map((entry) => pill(entry, entry.selected)));
  $(`#${kind}-note`).textContent = shown.length ? '' : query ? 'Aucun tag ne correspond.' : emptyMessage;
}

function renderBoxes({ index, primaryKeys, view }) {
  const hasPrimary = [...primaryKeys].some((key) => index.has(key));

  // Boîte 1 : tags principaux sélectionnés (en tête) puis ceux qui restent compatibles avec la sélection.
  const picked = view.selected.filter((tag) => tag.primary).map((tag) => ({ ...tag, count: view.results.length, selected: true }));
  const primary = [...picked, ...view.primary.map((tag) => ({ ...tag, selected: false }))];
  fillBox(
    'primary',
    primary,
    hasPrimary
      ? 'Aucun autre tag principal pour cette sélection.'
      : index.size
        ? 'Aucun tag principal défini. Utilise ⚙ pour en choisir parmi tes tags.'
        : 'Ajoute des tags à tes favoris pour les retrouver ici.',
  );

  // Boîte 2 : liste unique des secondaires qui coexistent avec la sélection (jamais tous d'un coup).
  const showSecondary = state.selected.length > 0 || state.boxQuery.secondary.trim() !== '';
  fillBox(
    'secondary',
    showSecondary ? view.secondary.map((tag) => ({ ...tag, selected: false })) : [],
    showSecondary
      ? 'Aucun autre tag pour cette sélection.'
      : hasPrimary
        ? 'Choisis un tag principal pour voir les tags associés.'
        : 'Définis d\'abord des tags principaux avec ⚙ ci-dessus.',
  );

  const favorites = state.bookmarks.filter((b) => b.favorite).length;
  $('#fav-count').textContent = favorites;
  $('#fav-toggle').setAttribute('aria-pressed', String(state.favOnly));
}

function renderActive(view) {
  const chips = view.selected.map((tag) =>
    h(
      'button',
      { class: `chip${tag.primary ? ' primary' : ''}`, type: 'button', 'data-key': tag.key, 'aria-label': `Retirer le filtre ${tag.name}`, onclick: () => toggleTag(tag.key) },
      tag.name,
      h('span', { 'aria-hidden': 'true' }, ' ✕'),
    ),
  );
  if (state.favOnly) {
    chips.push(h('button', { class: 'chip', type: 'button', 'aria-label': 'Retirer le filtre Favoris', onclick: () => { state.favOnly = false; render(); } }, '★ Favoris', h('span', { 'aria-hidden': 'true' }, ' ✕')));
  }
  if (state.query.trim()) {
    chips.push(h('button', { class: 'chip', type: 'button', 'aria-label': 'Effacer la recherche', onclick: () => { state.query = ''; $('#search').value = ''; render(); } }, `« ${state.query.trim()} »`, h('span', { 'aria-hidden': 'true' }, ' ✕')));
  }
  $('#active-chips').replaceChildren(...chips);
  $('#active').hidden = !filtersActive();
}

function card(b, index, primaryKeys) {
  const host = hostOf(b.url);
  const mark = h('div', { class: 'mark', 'aria-hidden': 'true' }, host.charAt(0) || '?');
  mark.style.setProperty('--hue', hueOf(host));
  const meta = [host, new Date(b.createdAt).toLocaleDateString('fr-FR')].join(' · ');
  const tags = [...b.tags].sort((x, y) => primaryKeys.has(tagKey(y)) - primaryKeys.has(tagKey(x)));
  return h(
    'article',
    { class: 'bm' },
    mark,
    h(
      'div',
      { class: 'bm-main' },
      h('a', { class: 'bm-title', href: safeHref(b.url), target: '_blank', rel: 'noopener noreferrer' }, b.title),
      h('div', { class: 'bm-meta' }, meta),
      b.description ? h('p', { class: 'bm-desc' }, b.description) : null,
      tags.length
        ? h('div', { class: 'bm-tags' }, tags.map((tag) => h('button', { class: 'tag', type: 'button', title: 'Filtrer sur ce tag', onclick: () => addTagFilter(tagKey(tag)) }, tag)))
        : null,
    ),
    h(
      'div',
      { class: 'bm-actions' },
      h('button', { class: 'icon-btn fav', type: 'button', title: 'Favori', 'aria-label': 'Favori', 'aria-pressed': String(b.favorite), onclick: () => toggleFavorite(b) }, '★'),
      h('button', { class: 'icon-btn', type: 'button', title: 'Modifier', 'aria-label': 'Modifier', onclick: () => openEditor(b) }, '✎'),
      h('button', { class: 'icon-btn', type: 'button', title: 'Supprimer', 'aria-label': 'Supprimer', onclick: () => removeBookmark(b) }, '🗑'),
    ),
  );
}

function renderList({ index, primaryKeys, view }) {
  const total = state.bookmarks.length;
  const n = view.results.length;
  $('#list-title').textContent = filtersActive() ? 'Résultats' : 'Tous les marque-pages';
  const word = (count) => `${count} ${count > 1 ? 'favoris' : 'favori'}`;
  $('#list-count').textContent = filtersActive() ? `${n} sur ${word(total)}` : word(n);
  $('#list').replaceChildren(...view.results.map((b) => card(b, index, primaryKeys)));

  const empty = $('#empty');
  empty.hidden = n > 0;
  if (n > 0) return;
  if (!total) {
    empty.replaceChildren('Aucun marque-page pour l\'instant. Clique sur « Ajouter » ou importe tes favoris depuis ⚙.');
  } else {
    empty.replaceChildren(
      h('p', {}, 'Aucun favori ne correspond à ces filtres.'),
      h('button', { class: 'btn', type: 'button', onclick: resetFilters }, 'Tout réinitialiser'),
    );
  }
}

function render() {
  const focused = document.activeElement?.closest?.('[data-key]')?.dataset.key;
  const context = compute();
  renderBoxes(context);
  renderActive(context.view);
  renderList(context);
  // Le bouton cliqué est reconstruit : on rend le focus à son équivalent (navigation au clavier).
  if (focused && !$('#app').hidden) document.querySelector(`button[data-key="${CSS.escape(focused)}"]`)?.focus();
}

$('#search').addEventListener('input', (event) => {
  state.query = event.target.value;
  render();
});
$('#primary-search').addEventListener('input', (event) => {
  state.boxQuery.primary = event.target.value;
  render();
});
$('#secondary-search').addEventListener('input', (event) => {
  state.boxQuery.secondary = event.target.value;
  render();
});
$('#sort').addEventListener('change', (event) => {
  state.sort = event.target.value;
  render();
});
$('#fav-toggle').addEventListener('click', () => {
  state.favOnly = !state.favOnly;
  render();
});
$('#reset').addEventListener('click', resetFilters);
$('#toggle-filters').addEventListener('click', (event) => {
  const open = document.body.classList.toggle('filters-open');
  event.currentTarget.setAttribute('aria-expanded', String(open));
});

document.addEventListener('keydown', (event) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? '');
  if (event.key === '/' && !typing && !event.ctrlKey && !event.metaKey && !$('#app').hidden) {
    event.preventDefault();
    $('#search').focus();
  } else if (event.key === 'Escape' && document.activeElement === $('#search')) {
    $('#search').value = '';
    state.query = '';
    render();
    $('#search').blur();
  }
});

// --- Choix des tags principaux (bouton ⚙ de la boîte 1) --------------------------------

const primaryDialog = $('#primary-dialog');
let pickEntries = [];
let pickChecked = new Set();

function updatePickCount() {
  const n = pickChecked.size;
  $('#pick-count').textContent = `${n} tag${n > 1 ? 's principaux sélectionnés' : ' principal sélectionné'} sur ${pickEntries.length}`;
}

function renderPick() {
  const query = fold($('#pick-filter').value).trim();
  const rows = pickEntries
    .filter((entry) => !query || fold(entry.name).includes(query))
    .map((entry) => {
      const input = h('input', { type: 'checkbox', 'aria-label': entry.name });
      input.checked = pickChecked.has(entry.key);
      input.addEventListener('change', () => {
        if (input.checked) pickChecked.add(entry.key);
        else pickChecked.delete(entry.key);
        updatePickCount();
      });
      return h('label', { class: 'pick' }, input, h('span', { class: 'pick-name' }, entry.name), h('span', { class: 'n' }, entry.total));
    });
  $('#pick-list').replaceChildren(...rows);
  const note = $('#pick-empty');
  note.hidden = rows.length > 0;
  note.textContent = pickEntries.length ? 'Aucun tag ne correspond.' : 'Aucun tag pour l\'instant : ajoute des tags à tes favoris.';
  updatePickCount();
}

$('#manage-primary').addEventListener('click', () => {
  const { index, primaryKeys } = library();
  pickEntries = [...index.values()].sort(byName);
  pickChecked = new Set(pickEntries.filter((entry) => primaryKeys.has(entry.key)).map((entry) => entry.key));
  $('#pick-filter').value = '';
  renderPick();
  primaryDialog.showModal();
});
$('#pick-filter').addEventListener('input', renderPick);
$('#primary-cancel').addEventListener('click', () => primaryDialog.close());
$('#primary-save').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    const tags = pickEntries.filter((entry) => pickChecked.has(entry.key)).map((entry) => entry.name);
    applyData(await api('/api/bookmarks', { method: 'POST', body: { op: 'primaryTags', tags } }));
    primaryDialog.close();
    render();
    toast('Tags principaux enregistrés');
  } catch (e) {
    if (e.status !== 401) toast(e.message, true);
  } finally {
    button.disabled = false;
  }
});

// --- Actions sur un marque-page -----------------------------------------------------

async function toggleFavorite(bookmark) {
  const previous = bookmark.favorite;
  bookmark.favorite = !previous; // mise à jour immédiate, annulée en cas d'échec
  render();
  try {
    applyData(await api('/api/bookmarks', { method: 'POST', body: { op: 'update', id: bookmark.id, patch: { favorite: !previous } } }));
  } catch (e) {
    bookmark.favorite = previous;
    if (e.status !== 401) toast(e.message, true);
  }
  render();
}

async function removeBookmark(bookmark) {
  if (!confirm(`Supprimer « ${bookmark.title} » ?`)) return;
  try {
    applyData(await api('/api/bookmarks', { method: 'POST', body: { op: 'delete', id: bookmark.id } }));
    render();
    toast('Supprimé');
  } catch (e) {
    if (e.status !== 401) toast(e.message, true);
  }
}

// --- Ajout / modification ---------------------------------------------------------

const editor = $('#edit-dialog');

function renderTagSuggestions() {
  const { index, primaryKeys } = library();
  const current = new Set($('#f-tags').value.split(',').map(tagKey).filter(Boolean));
  const entries = [...index.values()].sort(
    (a, b) => primaryKeys.has(b.key) - primaryKeys.has(a.key) || b.total - a.total || byName(a, b),
  );
  $('#tag-suggestions').replaceChildren(
    ...entries.map((entry) =>
      h('button', { class: 'tag', type: 'button', 'aria-pressed': String(current.has(entry.key)), onclick: () => toggleEditorTag(entry) }, entry.name),
    ),
  );
}

function toggleEditorTag(entry) {
  const parts = $('#f-tags').value.split(',').map((tag) => tag.trim()).filter(Boolean);
  const at = parts.findIndex((tag) => tagKey(tag) === entry.key);
  if (at >= 0) parts.splice(at, 1);
  else parts.push(entry.name);
  $('#f-tags').value = parts.join(', ');
  renderTagSuggestions();
}

function openEditor(bookmark, prefill) {
  state.editingId = bookmark?.id ?? null;
  const { index } = library();
  $('#edit-title').textContent = bookmark ? 'Modifier le marque-page' : 'Ajouter un marque-page';
  $('#f-url').value = bookmark?.url ?? prefill?.url ?? '';
  $('#f-title').value = bookmark?.title ?? prefill?.title ?? '';
  $('#f-description').value = bookmark?.description ?? '';
  // Un nouveau favori reprend les tags actuellement sélectionnés : on ajoute dans ce qu'on regarde.
  const tags = bookmark ? bookmark.tags : state.selected.map((key) => index.get(key)?.name ?? key);
  $('#f-tags').value = tags.join(', ');
  $('#f-favorite').checked = bookmark?.favorite ?? state.favOnly;
  $('#edit-error').hidden = true;
  $('#edit-force').hidden = true;
  updateDuplicateWarning();
  renderTagSuggestions();
  editor.showModal();
  if (!bookmark && prefill?.url && !prefill.title) fetchTitle({ silent: true });
  else if (!bookmark && !prefill) $('#f-url').focus();
}

function updateDuplicateWarning() {
  const key = normalizeUrl($('#f-url').value.trim());
  const existing = key && state.bookmarks.find((b) => b.id !== state.editingId && normalizeUrl(b.url) === key);
  const warning = $('#dup-warning');
  warning.hidden = !existing;
  if (existing) warning.textContent = `Déjà enregistré : « ${existing.title} »`;
}

async function fetchTitle({ silent = false } = {}) {
  const url = $('#f-url').value.trim();
  if (!url) return;
  const button = $('#fetch-title');
  button.disabled = true;
  button.textContent = 'recherche…';
  try {
    const meta = await api(`/api/title?url=${encodeURIComponent(url)}`);
    if (meta.title && (!silent || !$('#f-title').value)) $('#f-title').value = meta.title;
    if (meta.description && !$('#f-description').value) $('#f-description').value = meta.description;
    if (!meta.title && !silent) toast('Titre introuvable pour cette page', true);
  } catch (e) {
    if (!silent && e.status !== 401) toast(e.message, true);
  } finally {
    button.disabled = false;
    button.textContent = 'récupérer automatiquement';
  }
}

async function saveEditor(force = false) {
  const fields = {
    url: $('#f-url').value.trim(),
    title: $('#f-title').value,
    description: $('#f-description').value,
    tags: $('#f-tags').value.split(',').map((tag) => tag.trim()).filter(Boolean),
    favorite: $('#f-favorite').checked,
  };
  const error = $('#edit-error');
  const save = $('#edit-save');
  error.hidden = true;
  save.disabled = true;
  save.textContent = 'Enregistrement…';
  try {
    const body = state.editingId ? { op: 'update', id: state.editingId, patch: fields, force } : { op: 'add', bookmark: fields, force };
    applyData(await api('/api/bookmarks', { method: 'POST', body }));
    editor.close();
    render();
    toast('Enregistré');
  } catch (e) {
    if (e.status === 409 && e.data?.duplicate) {
      $('#edit-force').hidden = false;
      error.textContent = 'Cette adresse est déjà dans tes marque-pages.';
    } else if (e.status !== 401) {
      error.textContent = e.message;
    }
    error.hidden = e.status === 401;
  } finally {
    save.disabled = false;
    save.textContent = 'Enregistrer';
  }
}

$('#add-btn').addEventListener('click', () => openEditor(null));
$('#f-url').addEventListener('input', updateDuplicateWarning);
$('#f-url').addEventListener('change', () => {
  if (!state.editingId && !$('#f-title').value && $('#f-url').value.trim()) fetchTitle({ silent: true });
});
$('#f-tags').addEventListener('input', renderTagSuggestions);
$('#fetch-title').addEventListener('click', () => fetchTitle());
$('#edit-form').addEventListener('submit', (event) => {
  event.preventDefault();
  saveEditor(false);
});
$('#edit-force').addEventListener('click', () => saveEditor(true));
$('#edit-cancel').addEventListener('click', () => editor.close());

// Fermer un dialogue en cliquant sur le fond.
for (const dialog of document.querySelectorAll('dialog')) {
  dialog.addEventListener('mousedown', (event) => {
    if (event.target === dialog) dialog.close();
  });
}

// --- Outils : import, export, bookmarklet -----------------------------------------

const tools = $('#tools-dialog');
$('#tools-btn').addEventListener('click', () => {
  const code =
    "javascript:(()=>{window.open('" + location.origin +
    "/?url='+encodeURIComponent(location.href)+'&title='+encodeURIComponent(document.title),'_blank')})()";
  $('#bookmarklet').setAttribute('href', code);
  $('#bookmarklet-code').value = code;
  tools.showModal();
});
$('#tools-close').addEventListener('click', () => tools.close());
$('#bookmarklet').addEventListener('click', (event) => {
  event.preventDefault();
  toast('Glisse ce bouton dans ta barre de favoris');
});
$('#bookmarklet-code').addEventListener('focus', (event) => event.target.select());

function download(filename, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = h('a', { href: url, download: filename });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const today = () => new Date().toISOString().slice(0, 10);

$('#export-html').addEventListener('click', () => download(`favzy-${today()}.html`, buildNetscape(state.bookmarks), 'text/html'));
$('#export-json').addEventListener('click', () =>
  download(`favzy-${today()}.json`, JSON.stringify({ version: 2, primaryTags: state.primaryTags, bookmarks: state.bookmarks }, null, 2), 'application/json'));

$('#import-file').addEventListener('change', async (event) => {
  const input = event.target;
  const file = input.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    let items;
    let primaryTags;
    if (/\.json$/i.test(file.name)) {
      const parsed = JSON.parse(text);
      items = Array.isArray(parsed) ? parsed : parsed.bookmarks;
      primaryTags = Array.isArray(parsed.primaryTags) ? parsed.primaryTags : undefined;
    } else {
      items = parseNetscape(text);
    }
    if (!Array.isArray(items) || !items.length) throw new Error('Aucun marque-page trouvé dans ce fichier');

    toast(`Import de ${items.length} marque-pages en cours…`);
    let added = 0;
    let skipped = 0;
    for (let start = 0; start < items.length; start += 1000) {
      const result = await api('/api/bookmarks', { method: 'POST', body: { op: 'import', bookmarks: items.slice(start, start + 1000), primaryTags } });
      added += result.added;
      skipped += result.skipped;
      applyData(result);
    }
    render();
    tools.close();
    toast(`${added} ajouté${added > 1 ? 's' : ''}, ${skipped} ignoré${skipped > 1 ? 's' : ''} (doublons ou adresses invalides)`);
  } catch (e) {
    if (e.status !== 401) toast(e.message || 'Import impossible', true);
  } finally {
    input.value = '';
  }
});

// --- Démarrage ----------------------------------------------------------------

loadAll().catch((e) => {
  if (e.status === 401) return; // l'écran de connexion est déjà affiché
  showApp();
  $('#empty').hidden = false;
  $('#empty').textContent = e.message;
});

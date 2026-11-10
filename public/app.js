// Favzy — interface (JavaScript natif, aucune dépendance).
// Tout le texte venant des données est inséré via textContent / createTextNode : jamais d'innerHTML.
import { buildNetscape, parseNetscape } from './netscape.js';

const $ = (selector) => document.querySelector(selector);

const state = {
  bookmarks: [],
  query: '',
  filter: { type: 'all', value: '' }, // all | favorites | nofolder | folder | tag
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
  const data = await api('/api/bookmarks');
  state.bookmarks = data.bookmarks;
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
  $('#tools-dialog').close();
  showLogin();
});

// --- Filtrage, tri, rendu ----------------------------------------------------------

function visibleBookmarks() {
  const { type, value } = state.filter;
  const tokens = state.query.toLowerCase().split(/\s+/).filter(Boolean);
  const list = state.bookmarks.filter((b) => {
    if (type === 'favorites' && !b.favorite) return false;
    if (type === 'nofolder' && b.folder) return false;
    if (type === 'folder' && b.folder !== value) return false;
    if (type === 'tag' && !b.tags.includes(value)) return false;
    if (!tokens.length) return true;
    const haystack = `${b.title} ${b.url} ${b.description} ${b.folder} ${b.tags.join(' ')}`.toLowerCase();
    return tokens.every((token) => haystack.includes(token));
  });
  const by = {
    recent: (a, b) => b.createdAt.localeCompare(a.createdAt),
    oldest: (a, b) => a.createdAt.localeCompare(b.createdAt),
    title: (a, b) => a.title.localeCompare(b.title, 'fr', { sensitivity: 'base' }),
  };
  return list.sort(by[state.sort]);
}

function setFilter(type, value = '') {
  state.filter = { type, value };
  document.body.classList.remove('filters-open');
  $('#toggle-filters').setAttribute('aria-expanded', 'false');
  render();
}

function navItem(label, count, current, onClick) {
  return h(
    'button',
    { class: 'nav-item', type: 'button', 'aria-current': String(current), onclick: onClick },
    h('span', { class: 'label' }, label),
    h('span', { class: 'count' }, count),
  );
}

function renderSidebar() {
  const { bookmarks, filter } = state;
  const is = (type, value = '') => filter.type === type && filter.value === value;

  const main = [navItem('Tous', bookmarks.length, is('all'), () => setFilter('all'))];
  main.push(navItem('★ Favoris', bookmarks.filter((b) => b.favorite).length, is('favorites'), () => setFilter('favorites')));
  const loose = bookmarks.filter((b) => !b.folder).length;
  if (loose && loose !== bookmarks.length) main.push(navItem('Sans dossier', loose, is('nofolder'), () => setFilter('nofolder')));
  $('#nav-main').replaceChildren(...main);

  const folders = new Map();
  const tags = new Map();
  for (const b of bookmarks) {
    if (b.folder) folders.set(b.folder, (folders.get(b.folder) ?? 0) + 1);
    for (const tag of b.tags) tags.set(tag, (tags.get(tag) ?? 0) + 1);
  }
  const sortedFolders = [...folders].sort((a, b) => a[0].localeCompare(b[0], 'fr'));
  $('#nav-folders').replaceChildren(
    ...(sortedFolders.length
      ? sortedFolders.map(([name, count]) => navItem(name, count, is('folder', name), () => setFilter('folder', name)))
      : [h('p', { class: 'muted small' }, 'Aucun dossier')]),
  );
  $('#folder-list').replaceChildren(...sortedFolders.map(([name]) => h('option', { value: name })));

  const sortedTags = [...tags].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 80);
  $('#nav-tags').replaceChildren(
    ...(sortedTags.length
      ? sortedTags.map(([tag, count]) =>
          h('button', { class: 'tag', type: 'button', 'aria-pressed': String(is('tag', tag)), onclick: () => setFilter(is('tag', tag) ? 'all' : 'tag', tag) }, `${tag} · ${count}`))
      : [h('p', { class: 'muted small' }, 'Aucun tag')]),
  );
}

function card(b) {
  const host = hostOf(b.url);
  const mark = h('div', { class: 'mark', 'aria-hidden': 'true' }, host.charAt(0) || '?');
  mark.style.setProperty('--hue', hueOf(host));

  const meta = [host, b.folder, new Date(b.createdAt).toLocaleDateString('fr-FR')].filter(Boolean).join(' · ');
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
      b.tags.length
        ? h('div', { class: 'bm-tags' }, b.tags.map((tag) => h('button', { class: 'tag', type: 'button', onclick: () => setFilter('tag', tag) }, tag)))
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

function renderList() {
  const { type, value } = state.filter;
  const titles = { all: 'Tous les marque-pages', favorites: 'Favoris', nofolder: 'Sans dossier', folder: value, tag: `# ${value}` };
  $('#list-title').textContent = titles[type];

  const visible = visibleBookmarks();
  $('#list-count').textContent = `${visible.length} ${visible.length > 1 ? 'résultats' : 'résultat'}`;
  $('#list').replaceChildren(...visible.map(card));

  const empty = $('#empty');
  empty.hidden = visible.length > 0;
  empty.textContent = state.bookmarks.length
    ? 'Aucun résultat.'
    : 'Aucun marque-page pour l\'instant. Clique sur « Ajouter » ou importe tes favoris depuis ⚙.';
}

function render() {
  renderSidebar();
  renderList();
}

$('#search').addEventListener('input', (event) => {
  state.query = event.target.value;
  renderList();
});
$('#sort').addEventListener('change', (event) => {
  state.sort = event.target.value;
  renderList();
});
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
    renderList();
    $('#search').blur();
  }
});

// --- Actions sur un marque-page -----------------------------------------------------

async function toggleFavorite(bookmark) {
  const previous = bookmark.favorite;
  bookmark.favorite = !previous; // mise à jour immédiate, annulée en cas d'échec
  render();
  try {
    const data = await api('/api/bookmarks', { method: 'POST', body: { op: 'update', id: bookmark.id, patch: { favorite: !previous } } });
    state.bookmarks = data.bookmarks;
  } catch (e) {
    bookmark.favorite = previous;
    if (e.status !== 401) toast(e.message, true);
  }
  render();
}

async function removeBookmark(bookmark) {
  if (!confirm(`Supprimer « ${bookmark.title} » ?`)) return;
  try {
    const data = await api('/api/bookmarks', { method: 'POST', body: { op: 'delete', id: bookmark.id } });
    state.bookmarks = data.bookmarks;
    render();
    toast('Supprimé');
  } catch (e) {
    if (e.status !== 401) toast(e.message, true);
  }
}

// --- Ajout / modification ---------------------------------------------------------

const editor = $('#edit-dialog');

function openEditor(bookmark, prefill) {
  state.editingId = bookmark?.id ?? null;
  $('#edit-title').textContent = bookmark ? 'Modifier le marque-page' : 'Ajouter un marque-page';
  $('#f-url').value = bookmark?.url ?? prefill?.url ?? '';
  $('#f-title').value = bookmark?.title ?? prefill?.title ?? '';
  $('#f-description').value = bookmark?.description ?? '';
  $('#f-folder').value = bookmark?.folder ?? (state.filter.type === 'folder' ? state.filter.value : '');
  $('#f-tags').value = (bookmark?.tags ?? (state.filter.type === 'tag' ? [state.filter.value] : [])).join(', ');
  $('#f-favorite').checked = bookmark?.favorite ?? state.filter.type === 'favorites';
  $('#edit-error').hidden = true;
  $('#edit-force').hidden = true;
  updateDuplicateWarning();
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
    folder: $('#f-folder').value,
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
    const data = await api('/api/bookmarks', { method: 'POST', body });
    state.bookmarks = data.bookmarks;
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
  download(`favzy-${today()}.json`, JSON.stringify({ version: 1, bookmarks: state.bookmarks }, null, 2), 'application/json'));

$('#import-file').addEventListener('change', async (event) => {
  const input = event.target;
  const file = input.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    let items;
    if (/\.json$/i.test(file.name)) {
      const parsed = JSON.parse(text);
      items = Array.isArray(parsed) ? parsed : parsed.bookmarks;
    } else {
      items = parseNetscape(text);
    }
    if (!Array.isArray(items) || !items.length) throw new Error('Aucun marque-page trouvé dans ce fichier');

    toast(`Import de ${items.length} marque-pages en cours…`);
    let added = 0;
    let skipped = 0;
    for (let start = 0; start < items.length; start += 1000) {
      const result = await api('/api/bookmarks', { method: 'POST', body: { op: 'import', bookmarks: items.slice(start, start + 1000) } });
      added += result.added;
      skipped += result.skipped;
      state.bookmarks = result.bookmarks;
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

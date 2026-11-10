// Import / export du format « Netscape Bookmark File » (celui de Chrome, Firefox, Edge, Safari…).
// Module sans dépendance, utilisable dans le navigateur ou avec un DOMParser injecté (tests).

export function parseNetscape(html, Parser = globalThis.DOMParser) {
  const doc = new Parser().parseFromString(html, 'text/html');
  const top = doc.querySelector('dl');
  if (!top) return [];

  const bookmarks = [];
  const state = { last: null };

  // `pending` : nom du dossier annoncé par un <H3>, appliqué au <DL> qui suit.
  function walk(element, path) {
    let pending = null;
    for (const child of element.children) {
      switch (child.tagName) {
        case 'H3':
          pending = child.textContent.trim();
          break;
        case 'A': {
          const href = child.getAttribute('href') ?? '';
          if (!/^https?:\/\//i.test(href)) break; // ignore javascript:, place:, about:…
          const added = Number(child.getAttribute('add_date'));
          const bookmark = {
            url: href,
            title: child.textContent.trim(),
            description: '',
            tags: (child.getAttribute('tags') ?? '').split(',').map((t) => t.trim()).filter(Boolean),
            folder: path.join('/'),
            createdAt: added > 0 ? new Date(added * 1000).toISOString() : undefined,
          };
          bookmarks.push(bookmark);
          state.last = bookmark;
          break;
        }
        case 'DD':
          if (state.last && !state.last.description) state.last.description = child.textContent.trim();
          break;
        case 'DL':
          walk(child, pending != null ? [...path, pending] : path);
          pending = null;
          break;
        case 'DT':
        case 'P': {
          const inner = walk(child, path);
          if (inner != null) pending = inner;
          break;
        }
        default:
          break;
      }
    }
    return pending;
  }

  walk(top, []);
  return bookmarks;
}

const escapeHtml = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function buildNetscape(bookmarks) {
  const line = (b, indent) => {
    const date = Math.floor(new Date(b.createdAt).getTime() / 1000) || 0;
    const tags = b.tags?.length ? ` TAGS="${escapeHtml(b.tags.join(','))}"` : '';
    const description = b.description ? `\n${indent}<DD>${escapeHtml(b.description)}` : '';
    return `${indent}<DT><A HREF="${escapeHtml(b.url)}" ADD_DATE="${date}"${tags}>${escapeHtml(b.title || b.url)}</A>${description}`;
  };

  const folders = new Map();
  const root = [];
  for (const bookmark of bookmarks) {
    if (!bookmark.folder) root.push(bookmark);
    else {
      if (!folders.has(bookmark.folder)) folders.set(bookmark.folder, []);
      folders.get(bookmark.folder).push(bookmark);
    }
  }

  const out = [
    '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
    '<!-- Exporté par Favzy -->',
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    '<TITLE>Bookmarks</TITLE>',
    '<H1>Bookmarks</H1>',
    '<DL><p>',
  ];
  for (const [name, items] of [...folders].sort((a, b) => a[0].localeCompare(b[0]))) {
    out.push(`    <DT><H3>${escapeHtml(name)}</H3>`, '    <DL><p>', ...items.map((b) => line(b, '        ')), '    </DL><p>');
  }
  out.push(...root.map((b) => line(b, '    ')), '</DL><p>', '');
  return out.join('\n');
}

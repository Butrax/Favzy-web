// Import / export du format « Netscape Bookmark File » (celui de Chrome, Firefox, Edge, Safari…).
// Module sans dépendance, utilisable dans le navigateur ou avec un DOMParser injecté (tests).
// Les dossiers ne sont pas conservés (Favzy fonctionne par tags) ; l'attribut TAGS l'est.

export function parseNetscape(html, Parser = globalThis.DOMParser) {
  const doc = new Parser().parseFromString(html, 'text/html');
  const bookmarks = [];
  for (const link of doc.querySelectorAll('a[href]')) {
    const href = link.getAttribute('href') ?? '';
    if (!/^https?:\/\//i.test(href)) continue; // ignore javascript:, place:, about:…
    const added = Number(link.getAttribute('add_date'));
    const next = link.closest('dt')?.nextElementSibling; // <DD> = description
    bookmarks.push({
      url: href,
      title: link.textContent.trim(),
      description: next?.tagName === 'DD' ? next.textContent.trim() : '',
      tags: (link.getAttribute('tags') ?? '').split(',').map((tag) => tag.trim()).filter(Boolean),
      createdAt: added > 0 ? new Date(added * 1000).toISOString() : undefined,
    });
  }
  return bookmarks;
}

const escapeHtml = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function buildNetscape(bookmarks) {
  const lines = bookmarks.map((b) => {
    const date = Math.floor(new Date(b.createdAt).getTime() / 1000) || 0;
    const tags = b.tags?.length ? ` TAGS="${escapeHtml(b.tags.join(','))}"` : '';
    const description = b.description ? `\n    <DD>${escapeHtml(b.description)}` : '';
    return `    <DT><A HREF="${escapeHtml(b.url)}" ADD_DATE="${date}"${tags}>${escapeHtml(b.title || b.url)}</A>${description}`;
  });
  return [
    '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
    '<!-- Exporté par Favzy -->',
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    '<TITLE>Bookmarks</TITLE>',
    '<H1>Bookmarks</H1>',
    '<DL><p>',
    ...lines,
    '</DL><p>',
    '',
  ].join('\n');
}

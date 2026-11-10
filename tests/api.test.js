// Tests de l'API avec un GitHub simulé en mémoire : `npm test` (aucun réseau, aucune dépendance).
import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

process.env.APP_PASSWORD = 'mot-de-passe-test';
process.env.SESSION_SECRET = 'secret-de-test-assez-long-0123456789';
process.env.GITHUB_TOKEN = 'ghp_fake';
process.env.GITHUB_REPO = 'moi/favzy-stock';

const { default: login } = await import('../api/login.js');
const { default: logout } = await import('../api/logout.js');
const { default: bookmarks } = await import('../api/bookmarks.js');
const { default: title } = await import('../api/title.js');
const { createSessionToken, verifySessionToken } = await import('../api/_lib/auth.js');
const { isPrivateIp, extractMeta } = await import('../api/_lib/safe-fetch.js');
const { normalizeUrl } = await import('../api/_lib/bookmarks.js');

// --- GitHub simulé -----------------------------------------------------------------
let store; // { text, sha } ou null (fichier absent)
let beforePut; // hook pour simuler une écriture concurrente
let repoExists;
let counter;

function fakeFetch(url, init = {}) {
  const { pathname } = new URL(url);
  const json = (status, body) => new Response(JSON.stringify(body), { status });
  if (pathname === '/repos/moi/favzy-stock') return json(repoExists ? 200 : 404, {});
  if (pathname === '/repos/moi/favzy-stock/contents/bookmarks.json') {
    if (init.method === 'GET') {
      if (!store) return json(404, { message: 'Not Found' });
      return json(200, { content: Buffer.from(store.text).toString('base64') + '\n', encoding: 'base64', sha: store.sha });
    }
    if (init.method === 'PUT') {
      beforePut?.();
      const body = JSON.parse(init.body);
      if ((store?.sha ?? undefined) !== body.sha) return json(store ? 409 : 422, { message: 'conflict' });
      store = { text: Buffer.from(body.content, 'base64').toString('utf8'), sha: `sha${++counter}` };
      return json(200, { content: { sha: store.sha } });
    }
  }
  return json(500, { message: `inattendu : ${init.method} ${pathname}` });
}
globalThis.fetch = fakeFetch;

// --- Requêtes / réponses factices -----------------------------------------------------
function call(handler, { method = 'GET', url = '/', body, cookie, headers = {} } = {}) {
  const req = { method, url, body, headers: { host: 'favzy.test', ...(cookie ? { cookie } : {}), ...headers } };
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      headers: {},
      setHeader(key, value) { this.headers[key.toLowerCase()] = value; },
      end(text) { resolve({ status: this.statusCode, headers: this.headers, json: text ? JSON.parse(text) : null }); },
    };
    handler(req, res);
  });
}

const session = () => `favzy_session=${createSessionToken()}`;
const saved = () => JSON.parse(store.text).bookmarks;

beforeEach(() => {
  store = null;
  beforePut = null;
  repoExists = true;
  counter = 0;
});

describe('authentification', () => {
  test('refuse les requêtes sans cookie', async () => {
    assert.equal((await call(bookmarks)).status, 401);
    assert.equal((await call(title, { url: '/api/title?url=https://example.com' })).status, 401);
  });

  test('refuse un mauvais mot de passe, accepte le bon et pose un cookie sûr', async () => {
    const bad = await call(login, { method: 'POST', body: { password: 'non' } });
    assert.equal(bad.status, 401);
    const ok = await call(login, { method: 'POST', body: { password: 'mot-de-passe-test' }, headers: { 'x-forwarded-proto': 'https' } });
    assert.equal(ok.status, 200);
    const cookie = ok.headers['set-cookie'];
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.match(cookie, /Secure/);
    const token = /favzy_session=([^;]+)/.exec(cookie)[1];
    assert.equal(verifySessionToken(token), true);
  });

  test('refuse un cookie falsifié ou expiré', () => {
    const token = createSessionToken();
    assert.equal(verifySessionToken(token + 'x'), false);
    assert.equal(verifySessionToken('abc.def'), false);
    assert.equal(verifySessionToken(token, Date.now() + 31 * 24 * 3600 * 1000), false);
  });

  test('refuse un POST venant d\'une autre origine', async () => {
    const res = await call(login, { method: 'POST', body: { password: 'mot-de-passe-test' }, headers: { origin: 'https://evil.example' } });
    assert.equal(res.status, 403);
  });

  test('logout efface le cookie', async () => {
    const res = await call(logout, { method: 'POST' });
    assert.match(res.headers['set-cookie'], /Max-Age=0/);
  });
});

describe('marque-pages', () => {
  const post = (body) => call(bookmarks, { method: 'POST', cookie: session(), body });

  test('liste vide quand le fichier n\'existe pas encore', async () => {
    const res = await call(bookmarks, { cookie: session() });
    assert.deepEqual(res.json, { bookmarks: [] });
  });

  test('erreur claire quand le dépôt est inaccessible', async () => {
    repoExists = false;
    const res = await call(bookmarks, { cookie: session() });
    assert.equal(res.status, 502);
    assert.match(res.json.error, /Dépôt introuvable/);
  });

  test('ajout, modification, favori, suppression', async () => {
    const added = await post({ op: 'add', bookmark: { url: 'https://example.com/a', title: ' Exemple ', tags: 'Dev, outils,dev', folder: 'Travail//Veille' } });
    assert.equal(added.status, 200);
    const [item] = added.json.bookmarks;
    assert.equal(item.title, 'Exemple');
    assert.deepEqual(item.tags, ['dev', 'outils']);
    assert.equal(item.folder, 'Travail/Veille');
    assert.equal(saved().length, 1);

    const updated = await post({ op: 'update', id: item.id, patch: { favorite: true, title: 'Nouveau' } });
    assert.equal(updated.json.bookmarks[0].favorite, true);
    assert.equal(updated.json.bookmarks[0].title, 'Nouveau');

    const deleted = await post({ op: 'delete', id: item.id });
    assert.deepEqual(deleted.json.bookmarks, []);
    assert.equal((await post({ op: 'delete', id: item.id })).status, 404);
  });

  test('détecte les doublons (ancre et utm ignorés) et accepte force', async () => {
    await post({ op: 'add', bookmark: { url: 'https://example.com/page' } });
    const dup = await post({ op: 'add', bookmark: { url: 'https://Example.com/page/?utm_source=x#haut' } });
    assert.equal(dup.status, 409);
    assert.equal(dup.json.duplicate, true);
    const forced = await post({ op: 'add', force: true, bookmark: { url: 'https://example.com/page/?utm_source=x#haut' } });
    assert.equal(forced.json.bookmarks.length, 2);
  });

  test('refuse les URL non http(s)', async () => {
    for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'pas une url', '']) {
      assert.equal((await post({ op: 'add', bookmark: { url } })).status, 400, url);
    }
  });

  test('import : ignore doublons et entrées invalides', async () => {
    await post({ op: 'add', bookmark: { url: 'https://deja.example/' } });
    const res = await post({
      op: 'import',
      bookmarks: [
        { url: 'https://deja.example', title: 'doublon' },
        { url: 'https://nouveau.example/x', title: 'Nouveau', createdAt: '2020-01-02T00:00:00Z' },
        { url: 'https://nouveau.example/x#a', title: 'doublon interne' },
        { url: 'javascript:void(0)' },
      ],
    });
    assert.equal(res.json.added, 1);
    assert.equal(res.json.skipped, 3);
    assert.equal(res.json.bookmarks.length, 2);
    assert.equal(res.json.bookmarks[0].createdAt, '2020-01-02T00:00:00.000Z');
  });

  test('conflit d\'écriture : relit, rejoue et conserve la modification concurrente', async () => {
    await post({ op: 'add', bookmark: { url: 'https://un.example' } });
    let injected = false;
    beforePut = () => {
      if (injected) return;
      injected = true;
      // Un autre appareil écrit entre notre lecture et notre écriture.
      const data = JSON.parse(store.text);
      data.bookmarks.push({ id: 'autre', url: 'https://autre.example', title: 'Autre', description: '', tags: [], folder: '', favorite: false, createdAt: new Date().toISOString() });
      store = { text: JSON.stringify(data), sha: `sha${++counter}` };
    };
    const res = await post({ op: 'add', bookmark: { url: 'https://deux.example' } });
    assert.equal(res.status, 200);
    const urls = saved().map((b) => b.url);
    assert.ok(urls.includes('https://autre.example'), 'la modification concurrente doit survivre');
    assert.ok(urls.includes('https://deux.example/'));
    assert.ok(urls.includes('https://un.example/'));
  });

  test('tolère un fichier de données contenant simplement []', async () => {
    store = { text: '[]\n', sha: 'init' };
    const res = await post({ op: 'add', bookmark: { url: 'https://example.com' } });
    assert.equal(res.status, 200);
    assert.equal(saved().length, 1);
  });

  test('opération inconnue', async () => {
    assert.equal((await post({ op: 'detruire-tout' })).status, 400);
  });
});

describe('protection SSRF', () => {
  test('adresses privées reconnues', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.1', '172.16.5.5', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', '::', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:a00:1', '64:ff9b::7f00:1', '2002:7f00:1::']) {
      assert.equal(isPrivateIp(ip), true, ip);
    }
    for (const ip of ['8.8.8.8', '93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946', '172.32.0.1']) {
      assert.equal(isPrivateIp(ip), false, ip);
    }
  });

  test('/api/title refuse les cibles internes', async () => {
    for (const target of ['http://localhost/', 'http://127.0.0.1/', 'http://[::1]/', 'http://169.254.169.254/latest/meta-data', 'http://intranet/', 'http://user:pw@example.com/', 'http://example.com:6379/', 'http://monserveur.local/']) {
      const res = await call(title, { cookie: session(), url: `/api/title?url=${encodeURIComponent(target)}` });
      assert.equal(res.status, 400, target);
    }
  });

  test('extraction du titre et de la description', () => {
    const html = Buffer.from('<html><head><TITLE>\n  Caf&eacute; &amp; Co &#39;test&#39;\n</TITLE><meta property="og:description" content="Une &quot;description&quot;"></head></html>');
    const meta = extractMeta(html, 'text/html; charset=utf-8', new URL('https://example.com'));
    assert.equal(meta.title, "Caf&eacute; & Co 'test'"); // entités nommées rares : volontairement non résolues
    assert.equal(meta.description, 'Une "description"');
  });
});

test('normalizeUrl', () => {
  assert.equal(normalizeUrl('https://Example.com/'), 'https://example.com');
  assert.equal(normalizeUrl('https://example.com/a/?utm_medium=x&id=3#top'), 'https://example.com/a/?id=3');
});

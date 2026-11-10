// Récupération d'une page web pour en extraire le titre, protégée contre le SSRF :
//  - http(s) uniquement, ports 80/443 uniquement, pas d'identifiants dans l'URL ;
//  - l'adresse IP est vérifiée au moment de la connexion (lookup personnalisé),
//    ce qui neutralise aussi le DNS rebinding ;
//  - chaque redirection est revalidée ; taille et durée limitées.
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { HttpError } from './http.js';

const MAX_REDIRECTS = 3;
const MAX_BYTES = 256 * 1024;
const TOTAL_TIMEOUT_MS = 8000;

function ipv4IsPrivate(ip) {
  const [a, b, c] = ip.split('.').map(Number);
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function expandIPv6(input) {
  let ip = input.split('%')[0].toLowerCase();
  const dotted = ip.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (dotted) {
    const [p, q, r, s] = dotted.slice(1).map(Number);
    ip = ip.slice(0, -dotted[0].length) + ((p << 8) | q).toString(16) + ':' + ((r << 8) | s).toString(16);
  }
  const [head, rest] = ip.split('::');
  const left = head ? head.split(':') : [];
  const right = rest === undefined ? [] : rest ? rest.split(':') : [];
  const groups = rest === undefined ? left : [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
  return groups.map((group) => parseInt(group, 16));
}

const v4FromGroups = (hi, lo) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;

export function isPrivateIp(ip) {
  const family = net.isIP(ip);
  if (family === 4) return ipv4IsPrivate(ip);
  if (family !== 6) return true; // pas une IP valide : on refuse par prudence
  const g = expandIPv6(ip);
  if (g.every((x) => x === 0) || (g.slice(0, 7).every((x) => x === 0) && g[7] === 1)) return true; // :: et ::1
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 (adresses locales uniques)
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 (lien local)
  if ((g[0] & 0xff00) === 0xff00) return true; // multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return ipv4IsPrivate(v4FromGroups(g[6], g[7])); // ::ffff:a.b.c.d
  if (g[0] === 0x64 && g[1] === 0xff9b) return ipv4IsPrivate(v4FromGroups(g[6], g[7])); // NAT64
  if (g[0] === 0x2002) return ipv4IsPrivate(v4FromGroups(g[1], g[2])); // 6to4
  return false;
}

export function assertAllowedUrl(url) {
  const fail = () => new HttpError(400, 'URL non autorisée');
  if (!['http:', 'https:'].includes(url.protocol)) throw fail();
  if (url.username || url.password) throw fail();
  if (url.port && url.port !== '80' && url.port !== '443') throw fail();
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw fail();
    return;
  }
  if (host === 'localhost' || !host.includes('.') || /\.(local|localhost|internal|lan|home|corp)$/.test(host)) throw fail();
}

// Vérifie chaque adresse renvoyée par le DNS juste avant la connexion.
function safeLookup(hostname, options, callback) {
  if (typeof options === 'function') {
    callback = options;
    options = {};
  }
  dns.lookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error);
    if (!addresses.length || addresses.some((entry) => isPrivateIp(entry.address))) {
      const blocked = new Error('Adresse non autorisée');
      blocked.code = 'EBLOCKED';
      return callback(blocked);
    }
    if (options.all) return callback(null, addresses);
    callback(null, addresses[0].address, addresses[0].family);
  });
}

function request(url, signal) {
  return new Promise((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http;
    const req = client.request(
      url,
      {
        method: 'GET',
        lookup: safeLookup,
        signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; Favzy/1.0; +bookmark-title-fetch)',
          Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
          'Accept-Encoding': 'identity',
          'Accept-Language': 'fr,en;q=0.8',
        },
      },
      (res) => {
        const status = res.statusCode;
        if (status >= 300 && status < 400) {
          res.resume();
          return resolve({ status, headers: res.headers, body: Buffer.alloc(0) });
        }
        const chunks = [];
        let size = 0;
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          resolve({ status, headers: res.headers, body: Buffer.concat(chunks).subarray(0, MAX_BYTES) });
        };
        res.on('data', (chunk) => {
          chunks.push(chunk);
          size += chunk.length;
          if (size >= MAX_BYTES) {
            finish();
            res.destroy();
          }
        });
        res.on('end', finish);
        res.on('close', finish);
        res.on('error', finish);
      },
    );
    req.on('error', reject);
    req.end();
  });
}

export async function fetchPage(startUrl) {
  const signal = AbortSignal.timeout(TOTAL_TIMEOUT_MS);
  let url = new URL(startUrl);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    assertAllowedUrl(url);
    const page = await request(url, signal);
    if (page.status >= 300 && page.status < 400 && page.headers.location) {
      url = new URL(page.headers.location, url);
      continue;
    }
    return { ...page, url };
  }
  throw new HttpError(400, 'Trop de redirections');
}

// --- Extraction du titre et de la description -------------------------------------

function decodeEntities(value) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
    if (entity[0] === '#') {
      const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : match;
    }
    return named[entity.toLowerCase()] ?? match;
  });
}

const clean = (value) => decodeEntities(value).replace(/\s+/g, ' ').trim();

function metaContent(html, key) {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const name = /(?:name|property)\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]?.toLowerCase();
    if (name !== key) continue;
    const content = /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
    if (content) return clean(content[1] ?? content[2] ?? '');
  }
  return '';
}

function decodeBody(body, contentType = '') {
  const label = /charset=["']?([\w-]+)/i.exec(contentType)?.[1] ?? /<meta[^>]+charset=["']?([\w-]+)/i.exec(body.toString('latin1'))?.[1] ?? 'utf-8';
  try {
    return new TextDecoder(label).decode(body);
  } catch {
    return new TextDecoder('utf-8').decode(body);
  }
}

export function extractMeta(body, contentType = '', url) {
  if (contentType && !/html|xml/i.test(contentType)) {
    const last = decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() ?? '');
    return { title: last.slice(0, 300), description: '' };
  }
  const html = decodeBody(body, contentType);
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  return {
    title: clean(title ?? '') || metaContent(html, 'og:title'),
    description: metaContent(html, 'description') || metaContent(html, 'og:description'),
  };
}

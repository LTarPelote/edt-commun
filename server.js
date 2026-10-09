'use strict';
// EDT commun : chacun ajoute son lien iCal EcoleDirecte, on choisit de qui on veut voir l'emploi du temps.
// Aucune dépendance : Node 18+ suffit (node server.js).
//
// Sécurité :
//  - les liens iCal (qui contiennent un jeton secret) restent sur le serveur, jamais renvoyés au navigateur ;
//  - le serveur n'accepte que des liens https vers api.ecoledirecte.com (pas de SSRF) ;
//  - supprimer une personne demande le jeton remis à celui qui l'a ajoutée.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const ALLOWED_HOSTS = (process.env.ALLOWED_HOSTS || 'api.ecoledirecte.com')
  .split(',').map((s) => s.trim()).filter(Boolean);
const CACHE_MS = 10 * 60 * 1000;
const MAX_PEOPLE = 50;

/* ------------------------------ stockage ------------------------------ */

let people = [];
try { people = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { people = []; }
function save() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(people, null, 2), { mode: 0o600 });
}

/* ------------------------------ iCal ------------------------------ */

const parisFmt = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Europe/Paris', hour12: false,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
});

// "20261009T080000Z" | "20261009T080000" | "20261009"  ->  "2026-10-09T08:00" (heure de Paris)
function toLocal(value) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?)?(Z)?$/.exec((value || '').trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  if (h === undefined) return { iso: `${y}-${mo}-${d}T00:00`, allDay: true };
  if (z) {
    const dt = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +(s || 0)));
    const p = parisFmt.format(dt); // "2026-10-09 08:00:00"
    return { iso: p.slice(0, 10) + 'T' + p.slice(11, 16), allDay: false };
  }
  return { iso: `${y}-${mo}-${d}T${h}:${mi}`, allDay: false };
}

function unescapeText(s) {
  return (s || '')
    .replace(/\\[nN]/g, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');
}

function parseIcs(text) {
  const lines = text.replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '').split('\n');
  const events = [];
  let cur = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { cur = {}; continue; }
    if (line === 'END:VEVENT') {
      if (cur && cur.start) {
        const start = cur.start;
        const end = cur.end || { iso: start.iso, allDay: start.allDay };
        events.push({
          start: start.iso,
          end: end.iso,
          allDay: start.allDay,
          summary: unescapeText(cur.summary).trim() || '(sans titre)',
          location: unescapeText(cur.location).trim(),
          description: unescapeText(cur.description).trim().slice(0, 300),
          cancelled: /CANCEL/i.test(cur.status || ''),
        });
      }
      cur = null;
      continue;
    }
    if (!cur) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const name = line.slice(0, idx).split(';')[0].toUpperCase();
    const value = line.slice(idx + 1);
    if (name === 'DTSTART') cur.start = toLocal(value);
    else if (name === 'DTEND') cur.end = toLocal(value);
    else if (name === 'SUMMARY') cur.summary = value;
    else if (name === 'LOCATION') cur.location = value;
    else if (name === 'DESCRIPTION') cur.description = value;
    else if (name === 'STATUS') cur.status = value;
  }
  events.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  return events;
}

/* ------------------------------ récupération ------------------------------ */

function checkUrl(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch { throw new Error('Lien invalide.'); }
  const local = u.hostname === '127.0.0.1' || u.hostname === 'localhost';
  if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) {
    throw new Error('Le lien doit commencer par https://');
  }
  if (!ALLOWED_HOSTS.includes(u.hostname)) {
    throw new Error('Ce lien ne vient pas d\'EcoleDirecte (api.ecoledirecte.com).');
  }
  return u.toString();
}

async function fetchIcs(url) {
  const res = await fetch(url, {
    redirect: 'manual',
    signal: AbortSignal.timeout(10000),
    headers: { 'User-Agent': 'edt-commun' },
  });
  if (!res.ok) throw new Error(`EcoleDirecte a répondu ${res.status}. Le lien est peut-être expiré.`);
  const text = await res.text();
  if (text.length > 5_000_000) throw new Error('Calendrier trop gros.');
  if (!/BEGIN:VCALENDAR/.test(text)) throw new Error('Ce lien ne renvoie pas un calendrier iCal.');
  return text;
}

const cache = new Map(); // id -> { at, events }

async function getEvents(person) {
  const hit = cache.get(person.id);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.events;
  try {
    const events = parseIcs(await fetchIcs(person.url));
    cache.set(person.id, { at: Date.now(), events });
    return events;
  } catch (e) {
    if (hit) return hit.events; // on sert l'ancienne version plutôt que rien
    throw e;
  }
}

const dateOf = (iso) => iso.slice(0, 10);

/* ------------------------------ HTTP ------------------------------ */

function send(res, code, body, headers = {}) {
  const isObj = typeof body === 'object' && !Buffer.isBuffer(body);
  res.writeHead(code, {
    'Content-Type': isObj ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(isObj ? JSON.stringify(body) : body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 10_000) { reject(new Error('Requête trop grosse.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { reject(new Error('JSON invalide.')); }
    });
  });
}

const sameToken = (a, b) => {
  const ha = crypto.createHash('sha256').update(String(a || '')).digest();
  const hb = crypto.createHash('sha256').update(String(b || '')).digest();
  return crypto.timingSafeEqual(ha, hb);
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const publicPerson = (p) => ({ id: p.id, name: p.name });

async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]

  // GET /api/people
  if (req.method === 'GET' && parts[1] === 'people' && parts.length === 2) {
    return send(res, 200, people.map(publicPerson));
  }

  // POST /api/people  { name, url }
  if (req.method === 'POST' && parts[1] === 'people' && parts.length === 2) {
    const body = await readBody(req);
    const name = String(body.name || '').trim().slice(0, 30);
    if (!name) return send(res, 400, { error: 'Mets ton prénom.' });
    if (people.length >= MAX_PEOPLE) return send(res, 400, { error: 'Trop de monde, limite atteinte.' });
    if (people.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
      return send(res, 400, { error: 'Ce prénom existe déjà, ajoute une initiale.' });
    }
    const link = checkUrl(body.url);
    const events = parseIcs(await fetchIcs(link)); // vérifie que le lien marche vraiment
    const person = {
      id: crypto.randomBytes(6).toString('hex'),
      name,
      url: link,
      editToken: crypto.randomBytes(16).toString('hex'),
    };
    people.push(person);
    save();
    cache.set(person.id, { at: Date.now(), events });
    return send(res, 201, { ...publicPerson(person), editToken: person.editToken });
  }

  // DELETE /api/people/:id   (en-tête x-edit-token)
  if (req.method === 'DELETE' && parts[1] === 'people' && parts.length === 3) {
    const i = people.findIndex((p) => p.id === parts[2]);
    if (i < 0) return send(res, 404, { error: 'Introuvable.' });
    if (!sameToken(req.headers['x-edit-token'], people[i].editToken)) {
      return send(res, 403, { error: 'Seule la personne qui a ajouté ce lien peut le supprimer.' });
    }
    cache.delete(people[i].id);
    people.splice(i, 1);
    save();
    return send(res, 200, { ok: true });
  }

  // GET /api/schedule/:id?from=YYYY-MM-DD&to=YYYY-MM-DD
  if (req.method === 'GET' && parts[1] === 'schedule' && parts.length === 3) {
    const person = people.find((p) => p.id === parts[2]);
    if (!person) return send(res, 404, { error: 'Personne introuvable.' });
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to') || from;
    if (!DATE_RE.test(from || '') || !DATE_RE.test(to || '')) return send(res, 400, { error: 'Dates invalides.' });
    const all = await getEvents(person);
    const events = all.filter((e) => dateOf(e.start) >= from && dateOf(e.start) <= to);
    return send(res, 200, { person: publicPerson(person), events });
  }

  return send(res, 404, { error: 'Route inconnue.' });
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.png': 'image/png', '.webmanifest': 'application/manifest+json; charset=utf-8',
};

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, 'Interdit');
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'Introuvable');
    send(res, 200, buf, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  });
}

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (req.method !== 'GET') return send(res, 405, 'Méthode non autorisée');
    return serveStatic(req, res, url);
  } catch (e) {
    return send(res, 400, { error: e.message || 'Erreur.' });
  }
}).listen(PORT, () => console.log(`EDT commun : http://localhost:${PORT}`));

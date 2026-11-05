// BLTC eMAR & Care API — Cloudflare Worker + D1
// Generic synced record store with PIN login, role checks and audit trail.

const COLLECTIONS = new Set([
  'staff', 'residents', 'meds', 'admins', 'tasks', 'taskLogs',
  'vitals', 'notes', 'alerts', 'assessments', 'audit', 'settings', 'counts'
]);
// Records that are append-only for non-admins (legal record — no edits/deletes)
const APPEND_ONLY = new Set(['admins', 'taskLogs', 'vitals', 'notes', 'audit', 'counts']);
const ADMIN_ONLY = new Set(['staff', 'settings']);
const NURSE_PLUS = new Set(['meds', 'residents', 'tasks', 'alerts', 'assessments']);
const TOKEN_TTL = 1000 * 60 * 60 * 14; // 14 hours (a long shift)

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
});

let schemaReady = false;
async function ensureSchema(db) {
  if (schemaReady) return;
  await db.batch([
    db.prepare('CREATE TABLE IF NOT EXISTS records (col TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (col, id))'),
    db.prepare('CREATE INDEX IF NOT EXISTS idx_records_updated ON records(updated_at)'),
    db.prepare('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)')
  ]);
  schemaReady = true;
}

async function getMeta(db, k) {
  const r = await db.prepare('SELECT v FROM meta WHERE k=?').bind(k).first();
  return r ? r.v : null;
}
async function setMeta(db, k, v) {
  await db.prepare('INSERT INTO meta (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').bind(k, v).run();
}
function randHex(n = 32) {
  const a = new Uint8Array(n); crypto.getRandomValues(a);
  return [...a].map(b => b.toString(16).padStart(2, '0')).join('');
}
async function secret(db) {
  let s = await getMeta(db, 'secret');
  if (!s) { s = randHex(32); await setMeta(db, 'secret', s); }
  return s;
}
async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
async function hmac(key, msg) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}
async function hashPin(db, pin) { return sha256((await secret(db)) + ':pin:' + pin); }

async function makeToken(db, staffId) {
  const exp = Date.now() + TOKEN_TTL;
  const body = `${staffId}.${exp}`;
  return `${body}.${await hmac(await secret(db), body)}`;
}
async function readToken(db, req) {
  const h = req.headers.get('authorization') || '';
  const tok = h.replace(/^Bearer\s+/i, '');
  const parts = tok.split('.');
  if (parts.length !== 3) return null;
  const [id, exp, sig] = parts;
  if (+exp < Date.now()) return null;
  if (sig !== await hmac(await secret(db), `${id}.${exp}`)) return null;
  const row = await db.prepare("SELECT data FROM records WHERE col='staff' AND id=?").bind(id).first();
  if (!row) return null;
  const staff = JSON.parse(row.data);
  if (staff._deleted || staff.active === false) return null;
  return staff;
}
function publicStaff(s) { const c = { ...s }; delete c.pinHash; delete c.pin; return c; }

async function putRecord(db, col, rec) {
  const now = Date.now();
  rec.updatedAt = now;
  await db.prepare('INSERT INTO records (col,id,data,updated_at) VALUES (?,?,?,?) ON CONFLICT(col,id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at')
    .bind(col, rec.id, JSON.stringify(rec), now).run();
  return rec;
}

async function pinTaken(db, pinHash, exceptId) {
  const rows = await db.prepare("SELECT id, data FROM records WHERE col='staff'").all();
  return rows.results.some(r => r.id !== exceptId && JSON.parse(r.data).pinHash === pinHash && !JSON.parse(r.data)._deleted);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(req);
    const db = env.DB;
    if (!db) return json({ error: 'Database not bound. Add the D1 binding "DB".' }, 500);
    try {
      await ensureSchema(db);
      const path = url.pathname.slice(5).split('/').filter(Boolean);
      const method = req.method;

      if (path[0] === 'status') {
        const c = await db.prepare("SELECT COUNT(*) AS n FROM records WHERE col='staff'").first();
        const fac = await getMeta(db, 'facility');
        return json({ ok: true, mode: 'cloud', setup: c.n > 0, facility: fac || 'BLTC' });
      }

      if (path[0] === 'setup' && method === 'POST') {
        const c = await db.prepare("SELECT COUNT(*) AS n FROM records WHERE col='staff'").first();
        if (c.n > 0) return json({ error: 'Already set up' }, 400);
        const b = await req.json();
        if (!b.name || !/^\d{4,8}$/.test(b.pin || '')) return json({ error: 'Name and a 4–8 digit PIN are required' }, 400);
        await setMeta(db, 'facility', b.facility || 'BLTC');
        const staff = { id: 'stf_' + randHex(6), name: b.name, role: 'Admin', initials: b.initials || initialsOf(b.name), active: true, pinHash: await hashPin(db, b.pin), createdAt: Date.now() };
        await putRecord(db, 'staff', staff);
        await putRecord(db, 'settings', { id: 'facility', name: b.facility || 'BLTC', passWindowMin: 60, prnFollowUpMin: 60, shifts: defaultShifts(), passTimes: defaultPassTimes() });
        return json({ token: await makeToken(db, staff.id), staff: publicStaff(staff) });
      }

      if (path[0] === 'login' && method === 'POST') {
        const b = await req.json();
        const ph = await hashPin(db, String(b.pin || ''));
        const rows = await db.prepare("SELECT data FROM records WHERE col='staff'").all();
        const s = rows.results.map(r => JSON.parse(r.data)).find(x => x.pinHash === ph && !x._deleted && x.active !== false);
        if (!s) return json({ error: 'PIN not recognized' }, 401);
        await putRecord(db, 'audit', { id: 'aud_' + randHex(8), at: Date.now(), staffId: s.id, staffName: s.name, action: 'login', detail: 'Signed in' });
        return json({ token: await makeToken(db, s.id), staff: publicStaff(s) });
      }

      const me = await readToken(db, req);
      if (!me) return json({ error: 'Not signed in' }, 401);

      if (path[0] === 'sync' && method === 'GET') {
        const since = +(url.searchParams.get('since') || 0);
        const rows = await db.prepare('SELECT col, data, updated_at FROM records WHERE updated_at > ? ORDER BY updated_at').bind(since).all();
        const out = {}; let max = since;
        for (const r of rows.results) {
          let d = JSON.parse(r.data);
          if (r.col === 'staff') d = publicStaff(d);
          (out[r.col] ||= []).push(d);
          if (r.updated_at > max) max = r.updated_at;
        }
        return json({ data: out, now: max, me: publicStaff(me), facility: (await getMeta(db, 'facility')) || 'BLTC' });
      }

      if (path[0] === 'rec' && path[1] && method === 'PUT') {
        const col = path[1];
        if (!COLLECTIONS.has(col)) return json({ error: 'Unknown collection' }, 400);
        const role = me.role;
        const isAdmin = role === 'Admin';
        const nursePlus = isAdmin || role === 'Nurse';
        if (ADMIN_ONLY.has(col) && !isAdmin) return json({ error: 'Admins only' }, 403);
        if (NURSE_PLUS.has(col) && !nursePlus) return json({ error: 'Nurse or Admin only' }, 403);
        const rec = await req.json();
        if (!rec.id) return json({ error: 'Missing id' }, 400);
        const existing = await db.prepare('SELECT data FROM records WHERE col=? AND id=?').bind(col, rec.id).first();
        if (existing && APPEND_ONLY.has(col) && !isAdmin) {
          // allow only follow-up fields on own PRN records / strikeouts with reason
          const old = JSON.parse(existing.data);
          const allowed = ['followUp', 'followUpAt', 'followUpBy', 'followUpByName', 'struck', 'struckReason', 'struckBy', 'struckAt'];
          const merged = { ...old };
          for (const k of allowed) if (k in rec) merged[k] = rec[k];
          return json(await putRecord(db, col, merged));
        }
        if (col === 'staff') {
          const old = existing ? JSON.parse(existing.data) : {};
          if (rec.pin) {
            if (!/^\d{4,8}$/.test(rec.pin)) return json({ error: 'PIN must be 4–8 digits' }, 400);
            rec.pinHash = await hashPin(db, rec.pin);
            if (await pinTaken(db, rec.pinHash, rec.id)) return json({ error: 'That PIN is already used by someone else' }, 400);
          } else rec.pinHash = old.pinHash;
          delete rec.pin;
          if (!rec.pinHash) return json({ error: 'A PIN is required for new staff' }, 400);
          const saved = await putRecord(db, col, rec);
          return json(publicStaff(saved));
        }
        if (!existing) {
          // the server stamps who documented a new record — this is the e-signature on the MAR
          rec.by = me.id; rec.byName = me.name; rec.byInitials = me.initials;
        } else {
          const old = JSON.parse(existing.data);
          rec.by = old.by; rec.byName = old.byName; rec.byInitials = old.byInitials; rec.createdAt = old.createdAt;
        }
        return json(await putRecord(db, col, rec));
      }

      if (path[0] === 'facility' && method === 'PUT') {
        if (me.role !== 'Admin') return json({ error: 'Admins only' }, 403);
        const b = await req.json();
        await setMeta(db, 'facility', b.name || 'BLTC');
        return json({ ok: true });
      }

      return json({ error: 'Not found' }, 404);
    } catch (e) {
      return json({ error: e.message || String(e) }, 500);
    }
  }
};

function initialsOf(n) { return (n || '').split(/\s+/).filter(Boolean).map(w => w[0].toUpperCase()).join('').slice(0, 3); }
function defaultShifts() {
  return [
    { id: 'day', name: 'Day', start: '07:00', end: '15:00' },
    { id: 'eve', name: 'Evening', start: '15:00', end: '23:00' },
    { id: 'night', name: 'Night', start: '23:00', end: '07:00' }
  ];
}
function defaultPassTimes() {
  return [
    { label: 'Morning', time: '08:00' }, { label: 'Noon', time: '12:00' },
    { label: 'Evening', time: '17:00' }, { label: 'Bedtime', time: '20:00' }
  ];
}

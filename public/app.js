/* BLTC eMAR & Care — caregiver / med passer app
   Works two ways:
   - Cloud mode: served by the Cloudflare Worker (shared D1 database, all staff see the same data)
   - Device mode: opened anywhere else (e.g. GitHub Pages) — data stays in this browser only
*/
'use strict';

/* ---------------- helpers ---------------- */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = p => p + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const p2 = n => String(n).padStart(2, '0');
const ymd = (d = new Date()) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
const hm = (d = new Date()) => `${p2(d.getHours())}:${p2(d.getMinutes())}`;
const addDays = (s, n) => { const d = new Date(s + 'T12:00'); d.setDate(d.getDate() + n); return ymd(d); };
const t12 = t => { if (!t) return ''; let [h, m] = t.split(':').map(Number); const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12; return `${h}:${p2(m)} ${ap}`; };
const fTime = ts => ts ? t12(hm(new Date(ts))) : '';
const fDate = s => { if (!s) return ''; const d = typeof s === 'number' ? new Date(s) : new Date(s + (String(s).length === 10 ? 'T12:00' : '')); return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); };
const fDT = ts => ts ? `${new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${fTime(ts)}` : '';
const age = dob => { if (!dob) return ''; const b = new Date(dob + 'T12:00'), n = new Date(); let a = n.getFullYear() - b.getFullYear(); if (n < new Date(n.getFullYear(), b.getMonth(), b.getDate())) a--; return a; };
const initials = n => (n || '').split(/\s+/).filter(Boolean).map(w => w[0].toUpperCase()).join('').slice(0, 3);
const minsOf = t => { const [h, m] = (t || '0:0').split(':').map(Number); return h * 60 + m; };
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
async function sha256(t) { const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t)); return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join(''); }
function val(id) { const el = document.getElementById(id); if (!el) return ''; if (el.type === 'checkbox') return el.checked; return el.value.trim(); }
function num(id) { const v = val(id); return v === '' ? null : Number(v); }
function toast(msg, ms = 2400) { const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg; document.body.appendChild(t); setTimeout(() => t.remove(), ms); }
function csvDownload(name, rows) {
  const csv = rows.map(r => r.map(c => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); a.download = name; a.click();
}

const ICON = {
  home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/></svg>',
  pill: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="2.5" y="8" width="19" height="8" rx="4" transform="rotate(-40 12 12)"/><path d="M9 9l6 6" transform="rotate(5 12 12)"/></svg>',
  people: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6"/><circle cx="17" cy="9" r="2.6"/><path d="M17 14c2.6 0 4.5 1.8 4.5 4.5"/></svg>',
  tasks: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 9l2 2 4-4M8 16h8"/></svg>',
  more: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 6h16M4 12h16M4 18h16"/></svg>'
};

/* ---------------- state ---------------- */
const COLS = ['staff', 'residents', 'meds', 'admins', 'tasks', 'taskLogs', 'vitals', 'notes', 'alerts', 'assessments', 'audit', 'settings', 'counts'];
const S = {
  mode: null, token: null, me: null, facility: 'BLTC', setup: true,
  data: Object.fromEntries(COLS.map(c => [c, []])),
  since: 0, outbox: [], online: true, ver: 0, lastActive: Date.now()
};
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { console.warn(e); } }
};
const cacheKey = () => S.mode === 'cloud' ? 'bltc_cloud_cache' : 'bltc_local_db';

function loadCache() {
  const c = LS.get(cacheKey(), null);
  if (c && c.data) { for (const k of COLS) S.data[k] = c.data[k] || []; S.since = c.since || 0; S.facility = c.facility || S.facility; }
  S.outbox = LS.get('bltc_outbox', []);
}
function saveCache() { LS.set(cacheKey(), { data: S.data, since: S.since, facility: S.facility }); LS.set('bltc_outbox', S.outbox); }

const all = col => (S.data[col] || []).filter(r => !r._deleted);
const byId = (col, id) => (S.data[col] || []).find(r => r.id === id);
function upsertLocal(col, rec) {
  const arr = S.data[col] || (S.data[col] = []);
  const i = arr.findIndex(r => r.id === rec.id);
  if (i >= 0) arr[i] = rec; else arr.push(rec);
  S.ver++;
}
const settings = () => byId('settings', 'facility') || { id: 'facility', name: S.facility, passWindowMin: 60, prnFollowUpMin: 60, lockMin: 15, shifts: [{ id: 'day', name: 'Day', start: '07:00', end: '15:00' }, { id: 'eve', name: 'Evening', start: '15:00', end: '23:00' }, { id: 'night', name: 'Night', start: '23:00', end: '07:00' }], passTimes: [{ label: 'Morning', time: '08:00' }, { label: 'Noon', time: '12:00' }, { label: 'Evening', time: '17:00' }, { label: 'Bedtime', time: '20:00' }] };
const isAdmin = () => S.me?.role === 'Admin';
const isNurse = () => ['Admin', 'Nurse'].includes(S.me?.role);
const canPassMeds = () => ['Admin', 'Nurse', 'Med Tech'].includes(S.me?.role);

/* ---------------- backend ---------------- */
async function api(path, method = 'GET', body) {
  const r = await fetch('/api/' + path, { method, headers: { 'content-type': 'application/json', ...(S.token ? { authorization: 'Bearer ' + S.token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let j = {}; try { j = await r.json(); } catch { }
  if (!r.ok) { const e = new Error(j.error || ('HTTP ' + r.status)); e.status = r.status; throw e; }
  return j;
}

const AUDITED = { residents: 'Resident', meds: 'Medication', staff: 'Staff', settings: 'Settings', tasks: 'Care plan task', alerts: 'Alert', assessments: 'Assessment' };

async function save(col, rec, { audit = true, quiet = false } = {}) {
  rec = { ...rec };
  if (!rec.id) rec.id = uid(col.slice(0, 3));
  if (!rec.createdAt) rec.createdAt = Date.now();
  if (!rec.by) { rec.by = S.me?.id; rec.byName = S.me?.name; rec.byInitials = S.me?.initials; }
  if (S.mode === 'local') {
    if (col === 'staff') {
      if (rec.pin) {
        rec.pinHash = await sha256('local:' + rec.pin);
        if (all('staff').some(s => s.id !== rec.id && s.pinHash === rec.pinHash)) { toast('That PIN is already used by someone else'); return null; }
        delete rec.pin;
      } else rec.pinHash = byId('staff', rec.id)?.pinHash;
      if (!rec.pinHash) { toast('A PIN is required'); return null; }
    }
    rec.updatedAt = Date.now();
    upsertLocal(col, rec);
  } else {
    const local = { ...rec }; delete local.pin;
    local.updatedAt = Date.now();
    upsertLocal(col, local);
    S.outbox.push({ col, rec });
  }
  if (audit && AUDITED[col] && col !== 'audit') {
    const a = { id: uid('aud'), at: Date.now(), staffId: S.me?.id, staffName: S.me?.name, action: rec._deleted ? 'delete' : 'save', detail: `${AUDITED[col]}: ${rec.name || rec.text || [rec.first, rec.last].filter(Boolean).join(' ') || rec.id}` };
    if (S.mode === 'local') upsertLocal('audit', { ...a, updatedAt: Date.now() }); else { upsertLocal('audit', a); S.outbox.push({ col: 'audit', rec: a }); }
  }
  saveCache();
  if (S.mode === 'cloud') flush();
  if (!quiet) render();
  return rec;
}

let flushing = false;
async function flush() {
  if (flushing || S.mode !== 'cloud' || !S.token) return;
  flushing = true;
  try {
    while (S.outbox.length) {
      const { col, rec } = S.outbox[0];
      try {
        const saved = await api('rec/' + col, 'PUT', rec);
        upsertLocal(col, saved);
        S.outbox.shift(); saveCache(); S.online = true;
      } catch (e) {
        if (e.status === 401) { S.outbox.shift(); lock(); break; }
        if (e.status && e.status < 500) { S.outbox.shift(); saveCache(); toast('Not saved: ' + e.message, 4000); S.since = 0; sync(); continue; }
        S.online = false; break; // offline – retry later
      }
    }
  } finally { flushing = false; syncDot(); }
}

let syncing = false;
async function sync(force) {
  if (S.mode !== 'cloud' || !S.token || syncing) return;
  syncing = true;
  try {
    await flush();
    const r = await api('sync?since=' + Math.max(0, S.since - 3000));
    let changed = false;
    for (const [col, recs] of Object.entries(r.data || {})) {
      for (const rec of recs) {
        const cur = byId(col, rec.id);
        if (!cur || (cur.updatedAt || 0) <= (rec.updatedAt || 0)) { if (JSON.stringify(cur) !== JSON.stringify(rec)) { upsertLocal(col, rec); changed = true; } }
      }
    }
    S.since = r.now || S.since; S.me = r.me || S.me; S.facility = r.facility || S.facility; S.online = true;
    saveCache();
    if (changed || force) softRender();
  } catch (e) {
    if (e.status === 401) lock(); else S.online = false;
  } finally { syncing = false; syncDot(); }
}
function syncDot() { const d = $('.topbar .sync'); if (d) { d.classList.toggle('off', !S.online || S.outbox.length > 0); d.title = S.online ? (S.outbox.length ? 'Saving…' : 'Synced') : 'Offline — changes will save when back online'; } }

/* ---------------- indexes & clinical logic ---------------- */
let IDX = null;
function idx() {
  if (IDX && IDX.v === S.ver) return IDX;
  const slot = new Map(), prnByMed = new Map(), givenByMed = new Map(), tlog = new Map(), lastV = new Map(), staff = new Map();
  for (const a of all('admins')) {
    if (a.struck) continue;
    if (a.scheduledFor) slot.set(a.medId + '|' + a.scheduledFor, a);
    if (a.prn) { if (!prnByMed.has(a.medId)) prnByMed.set(a.medId, []); prnByMed.get(a.medId).push(a); }
    if (a.status === 'given') { if (!givenByMed.has(a.medId)) givenByMed.set(a.medId, []); givenByMed.get(a.medId).push(a); }
  }
  for (const l of all('taskLogs')) if (!l.struck) tlog.set(`${l.taskId}|${l.date}|${l.shiftId}`, l);
  for (const v of all('vitals').sort((a, b) => a.at - b.at)) lastV.set(v.residentId, v);
  for (const s of S.data.staff) staff.set(s.id, s);
  IDX = { v: S.ver, slot, prnByMed, givenByMed, tlog, lastV, staff };
  return IDX;
}
const residentsActive = () => all('residents').filter(r => (r.status || 'active') === 'active').sort(roomSort);
const residentsAll = () => all('residents').sort(roomSort);
function roomSort(a, b) { return String(a.room || '').localeCompare(String(b.room || ''), undefined, { numeric: true }) || (a.last || '').localeCompare(b.last || ''); }
const rName = r => r ? `${r.first || ''} ${r.last || ''}`.trim() : 'Unknown';
const medsFor = rid => all('meds').filter(m => m.residentId === rid && m.status !== 'dc');
function medActiveOn(m, date) {
  if (m.status === 'dc' || m.status === 'hold') return false;
  if (m.start && m.start > date) return false;
  if (m.end && m.end < date) return false;
  if (m.days && m.days.length && !m.days.includes(new Date(date + 'T12:00').getDay())) return false;
  return true;
}
function medLabel(m) { return `${m.name}${m.strength ? ' ' + m.strength : ''}`; }
function medSig(m) { return [m.dose, m.form, m.route].filter(Boolean).join(' · '); }

function slotState(date, time, adm) {
  if (adm) return adm.status;
  const W = settings().passWindowMin || 60;
  const today = ymd();
  if (date > today) return 'upcoming';
  const due = new Date(date + 'T' + time);
  const diff = (Date.now() - due) / 60000;
  if (diff < -W) return 'upcoming';
  if (diff <= W) return 'due';
  return 'late';
}
function slotsFor(date, rid) {
  const I = idx(); const out = [];
  const rs = rid ? [byId('residents', rid)].filter(Boolean) : residentsActive();
  for (const r of rs) {
    if ((r.status || 'active') !== 'active' && !rid) continue;
    for (const m of all('meds').filter(x => x.residentId === r.id && !x.prn && medActiveOn(x, date))) {
      for (const t of (m.times || [])) {
        const key = `${date}T${t}`;
        const adm = I.slot.get(m.id + '|' + key);
        out.push({ r, m, t, key, date, adm, state: (r.status || 'active') !== 'active' && !adm ? 'away' : slotState(date, t, adm) });
      }
    }
  }
  return out.sort((a, b) => roomSort(a.r, b.r) || a.t.localeCompare(b.t));
}
function passFor(t) {
  const pts = settings().passTimes || [];
  if (!pts.length) return null;
  let best = pts[0], bd = 1e9;
  for (const p of pts) { const d = Math.abs(minsOf(p.time) - minsOf(t)); if (d < bd) { bd = d; best = p; } }
  return best.label;
}
function currentShift(d = new Date()) {
  const m = d.getHours() * 60 + d.getMinutes();
  for (const s of settings().shifts || []) {
    const a = minsOf(s.start), b = minsOf(s.end);
    if (a < b ? (m >= a && m < b) : (m >= a || m < b)) return s;
  }
  return (settings().shifts || [])[0] || { id: 'day', name: 'Day' };
}
function onHand(m) {
  if (m.onHand == null || m.onHand === '') return null;
  const since = m.onHandAt || 0;
  const used = (idx().givenByMed.get(m.id) || []).filter(a => a.at > since).reduce((s, a) => s + (Number(m.unitsPerDose) || 1), 0);
  return Number(m.onHand) - used;
}
function needsRefill(m) { const o = onHand(m); return o != null && m.refillAt != null && m.refillAt !== '' && o <= Number(m.refillAt); }
function prnInfo(m) {
  const list = (idx().prnByMed.get(m.id) || []).filter(a => a.status === 'given').sort((a, b) => b.at - a.at);
  const last = list[0];
  const day = list.filter(a => a.at > Date.now() - 864e5).length;
  const minH = Number(m.prnMinHours) || 0;
  const nextOk = last && minH ? last.at + minH * 36e5 : 0;
  return { last, day, tooSoon: nextOk > Date.now(), nextOk, maxed: m.prnMaxPerDay ? day >= Number(m.prnMaxPerDay) : false };
}
function prnFollowUpsDue(rid) {
  return all('admins').filter(a => a.prn && a.status === 'given' && !a.struck && !a.followUp && a.followUpDue && a.followUpDue <= Date.now() && (!rid || a.residentId === rid)).sort((a, b) => a.followUpDue - b.followUpDue);
}
function alertsFor(r) {
  const today = ymd();
  return all('alerts').filter(a => a.active !== false && (!a.expires || a.expires >= today) && (
    a.scope === 'all' || (a.scope === 'resident' && a.residentId === r.id) || (a.scope === 'careLevel' && String(a.careLevel) === String(r.careLevel))
  ));
}
function tasksFor(r, date, shiftId) {
  const dow = new Date(date + 'T12:00').getDay();
  return all('tasks').filter(t => t.residentId === r.id && t.active !== false && (t.shifts || []).includes(shiftId) && (!t.days || !t.days.length || t.days.includes(dow)));
}
function holdCheck(m, v) {
  const out = [];
  const hp = m.hold || {};
  const chk = (lbl, x, lo, hi) => { if (x == null || x === '') return; if (lo != null && lo !== '' && Number(x) < Number(lo)) out.push(`${lbl} ${x} is below ${lo}`); if (hi != null && hi !== '' && Number(x) > Number(hi)) out.push(`${lbl} ${x} is above ${hi}`); };
  chk('Systolic BP', v.bpSys, hp.sbpBelow, hp.sbpAbove);
  chk('Pulse', v.pulse, hp.pulseBelow, hp.pulseAbove);
  chk('Blood sugar', v.bs, hp.bsBelow, hp.bsAbove);
  return out;
}
function avatar(r, lg) { return `<div class="av${lg ? ' lg' : ''}">${r?.photo ? `<img src="${r.photo}" alt="">` : esc(initials(rName(r)))}</div>`; }
const STATUS = {
  given: ['Given', 'ok'], refused: ['Refused', 'warn'], held: ['Held', 'warn'], unavailable: ['Not available', 'warn'],
  due: ['Due', 'info'], late: ['Late', 'bad'], upcoming: ['Upcoming', ''], away: ['Out of facility', ''], loa: ['LOA', ''], hospital: ['Hospital', '']
};
const pill = st => { const [l, c] = STATUS[st] || [st, '']; return `<span class="pill ${c}">${esc(l)}</span>`; };

/* ---------------- sheets ---------------- */
function sheet({ title, body, foot = '', wide }) {
  const o = document.createElement('div'); o.className = 'overlay';
  o.innerHTML = `<div class="sheet"${wide ? ' style="max-width:900px"' : ''}><header><h3>${title}</h3><button class="x" aria-label="Close">×</button></header><div class="body">${body}</div>${foot ? `<footer>${foot}</footer>` : ''}</div>`;
  o.addEventListener('click', e => { if (e.target === o || e.target.classList.contains('x')) o.remove(); });
  document.body.appendChild(o);
  return o;
}
const closeSheet = () => { const o = $$('.overlay').pop(); if (o) o.remove(); };
function confirmBox(msg, yes = 'Yes') {
  return new Promise(res => {
    const o = sheet({ title: 'Please confirm', body: `<p>${msg}</p>`, foot: `<button class="btn sec2" id="cNo">Cancel</button><button class="btn bad" id="cYes">${yes}</button>` });
    $('#cNo', o).onclick = () => { o.remove(); res(false); };
    $('#cYes', o).onclick = () => { o.remove(); res(true); };
  });
}

/* ---------------- login / setup / lock ---------------- */
let pinBuf = '';
function renderLogin(err = '') {
  document.body.classList.remove('authed');
  const app = $('#app');
  if (!S.setup) return renderSetup();
  app.innerHTML = `<div class="login"><div class="box">
    <img class="logo" src="icon.svg" alt="">
    <h1>${esc(S.facility)}</h1><div class="muted">eMAR &amp; Care · Enter your PIN</div>
    <div class="pinDots">${[0, 1, 2, 3, 4, 5].map(i => `<i class="${i < pinBuf.length ? 'f' : ''}"></i>`).join('')}</div>
    <div class="pad">${[1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => `<button data-k="${n}">${n}</button>`).join('')}<button data-k="del">⌫</button><button data-k="0">0</button><button data-k="go" style="background:var(--brand);color:#fff">✓</button></div>
    <div class="err">${esc(err)}</div>
    ${S.mode === 'local' ? '<div class="small muted" style="margin-top:8px">Device mode — data is stored on this device only.</div>' : ''}
  </div></div>`;
  $$('.pad button').forEach(b => b.onclick = () => pinKey(b.dataset.k));
}
function pinKey(k) {
  if (k === 'del') pinBuf = pinBuf.slice(0, -1);
  else if (k === 'go') return doLogin();
  else if (pinBuf.length < 8) pinBuf += k;
  $$('.pinDots i').forEach((d, i) => d.classList.toggle('f', i < pinBuf.length));
}
document.addEventListener('keydown', e => {
  if (S.me || !S.setup || !$('.pad') || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
  if (/^\d$/.test(e.key)) pinKey(e.key); else if (e.key === 'Backspace') pinKey('del'); else if (e.key === 'Enter') pinKey('go');
});
async function doLogin() {
  const pin = pinBuf; pinBuf = '';
  if (pin.length < 4) return renderLogin('PIN must be at least 4 digits');
  try {
    if (S.mode === 'cloud') {
      const r = await api('login', 'POST', { pin });
      S.token = r.token; S.me = r.staff; LS.set('bltc_token', S.token);
    } else {
      const h = await sha256('local:' + pin);
      const s = all('staff').find(x => x.pinHash === h && x.active !== false);
      if (!s) throw new Error('PIN not recognized');
      S.me = s;
      upsertLocal('audit', { id: uid('aud'), at: Date.now(), staffId: s.id, staffName: s.name, action: 'login', detail: 'Signed in', updatedAt: Date.now() }); saveCache();
    }
    S.lastActive = Date.now();
    start();
  } catch (e) { renderLogin(e.message); }
}
function renderSetup(err = '') {
  $('#app').innerHTML = `<div class="login"><div class="box" style="text-align:left">
    <img class="logo" src="icon.svg" alt=""><h1 style="text-align:center">Welcome</h1>
    <p class="muted" style="text-align:center;margin-top:2px">Set up your community and the first administrator.</p>
    <label class="f"><span>Community name</span><input type="text" id="suFac" value="BLTC"></label>
    <label class="f"><span>Your full name</span><input type="text" id="suName" autocomplete="name"></label>
    <label class="f"><span>Your PIN (4–8 digits)</span><input type="password" id="suPin" inputmode="numeric" maxlength="8"></label>
    <label class="f"><span>Confirm PIN</span><input type="password" id="suPin2" inputmode="numeric" maxlength="8"></label>
    <button class="btn block" id="suGo">Create &amp; sign in</button>
    <div class="err">${esc(err)}</div>
    ${S.mode === 'local' ? '<div class="small muted">Device mode — data stays on this device. Deploy to Cloudflare to share between staff.</div>' : ''}
  </div></div>`;
  $('#suGo').onclick = async () => {
    const facility = val('suFac') || 'BLTC', name = val('suName'), pin = val('suPin');
    if (!name) return renderSetup('Enter your name');
    if (!/^\d{4,8}$/.test(pin)) return renderSetup('PIN must be 4–8 digits');
    if (pin !== val('suPin2')) return renderSetup('PINs do not match');
    try {
      if (S.mode === 'cloud') {
        const r = await api('setup', 'POST', { facility, name, pin, initials: initials(name) });
        S.token = r.token; S.me = r.staff; S.facility = facility; LS.set('bltc_token', S.token);
      } else {
        const s = { id: uid('stf'), name, role: 'Admin', initials: initials(name), active: true, pinHash: await sha256('local:' + pin), createdAt: Date.now(), updatedAt: Date.now() };
        upsertLocal('staff', s); S.facility = facility;
        upsertLocal('settings', { ...settings(), id: 'facility', name: facility, updatedAt: Date.now() });
        saveCache(); S.me = s;
      }
      S.setup = true; start();
    } catch (e) { renderSetup(e.message); }
  };
}
function lock() {
  S.me = null; S.token = null; LS.set('bltc_token', null); pinBuf = '';
  $$('.overlay').forEach(o => o.remove());
  renderLogin();
}
['click', 'keydown', 'touchstart', 'scroll'].forEach(ev => document.addEventListener(ev, () => { S.lastActive = Date.now(); }, { passive: true }));
setInterval(() => { if (S.me && Date.now() - S.lastActive > (settings().lockMin || 15) * 60000) lock(); }, 30000);

/* ---------------- shell & routing ---------------- */
const NAV = [['home', 'Home', ICON.home], ['pass', 'Med Pass', ICON.pill], ['residents', 'Residents', ICON.people], ['tasks', 'Tasks', ICON.tasks], ['more', 'More', ICON.more]];
function route() { const h = location.hash.replace(/^#\/?/, ''); const [p, ...rest] = h.split('/'); return { page: p || 'home', args: rest.map(decodeURIComponent) }; }
function go(h) { location.hash = '#/' + h; }
window.addEventListener('hashchange', () => { render(); window.scrollTo(0, 0); });

function shell() {
  $('#app').innerHTML = `<div class="topbar"><button class="back hidden" id="tbBack">‹</button><h1 id="tbTitle"></h1><div class="who"><b>${esc(S.me.name)}</b><br>${esc(S.me.role)} · ${esc(currentShift().name)}</div><span class="sync" title="Synced"></span><button class="btn sm sec2" id="tbLock" title="Lock / switch user" style="min-height:32px;padding:5px 9px">🔒</button></div>
  <main id="main"></main>
  <nav class="bottomnav">${NAV.map(([k, l, i]) => `<button data-nav="${k}">${i}<span>${l}</span><b class="dot hidden"></b></button>`).join('')}</nav>`;
  $$('[data-nav]').forEach(b => b.onclick = () => go(b.dataset.nav));
  $('#tbLock').onclick = lock;
  $('#tbBack').onclick = () => history.back();
}
function setTitle(t, back) { $('#tbTitle').textContent = t; $('#tbBack').classList.toggle('hidden', !back); }
function softRender() {
  const a = document.activeElement;
  if (a && $('#main')?.contains(a) && /INPUT|TEXTAREA|SELECT/.test(a.tagName)) return;
  render();
}
function render() {
  if (!S.me) return renderLogin();
  if (!$('#main')) shell();
  const { page, args } = route();
  const navKey = { resident: 'residents', residentpass: 'pass' }[page] || (NAV.some(n => n[0] === page) ? page : 'more');
  $$('[data-nav]').forEach(b => b.classList.toggle('on', b.dataset.nav === navKey));
  const late = slotsFor(ymd()).filter(s => s.state === 'late').length;
  const pd = $('[data-nav="pass"] .dot'); pd.classList.toggle('hidden', !late); pd.textContent = late;
  const fn = PAGES[page] || PAGES.home;
  const m = $('#main');
  m.innerHTML = fn(...args) || '';
  syncDot();
}

/* ---------------- pages ---------------- */
const PAGES = {};
let passFilter = 'now', passDate = null, taskShift = null, taskDate = null, resTab = 'overview', resSearch = '', resStatus = 'active';

PAGES.home = () => {
  setTitle(S.facility);
  const today = ymd(), slots = slotsFor(today);
  const due = slots.filter(s => s.state === 'due'), late = slots.filter(s => s.state === 'late'), done = slots.filter(s => s.adm);
  const fu = prnFollowUpsDue();
  const sh = currentShift();
  let tTot = 0, tDone = 0;
  for (const r of residentsActive()) for (const t of tasksFor(r, today, sh.id)) { tTot++; if (idx().tlog.has(`${t.id}|${today}|${sh.id}`)) tDone++; }
  const refills = all('meds').filter(m => m.status !== 'dc' && needsRefill(m));
  const facilityAlerts = all('alerts').filter(a => a.active !== false && (!a.expires || a.expires >= today));
  const flagged = all('notes').filter(n => n.flagged && n.at > Date.now() - 864e5 && !n.struck).sort((a, b) => b.at - a.at);
  const hr = new Date().getHours();
  return `
  <div class="card" style="background:linear-gradient(135deg,#0f5c6e,#127f8f);color:#fff">
    <div class="small" style="opacity:.85">${new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })} · ${esc(sh.name)} shift</div>
    <div style="font-size:21px;font-weight:700;margin-top:2px">Good ${hr < 12 ? 'morning' : hr < 17 ? 'afternoon' : 'evening'}, ${esc(S.me.name.split(' ')[0])}</div>
    <div class="row" style="margin-top:12px;gap:8px">${canPassMeds() ? `<button class="btn sec2" onclick="go('pass')">💊 Start med pass</button>` : ''}<button class="btn sec2" onclick="go('tasks')">✓ Shift tasks</button></div>
  </div>
  <div class="grid g4">
    <button class="stat ${late.length ? 'bad' : 'ok'}" onclick="passFilter='late';go('pass')"><div class="n">${late.length}</div><div class="l">Late / missed doses</div></button>
    <button class="stat info" onclick="passFilter='now';go('pass')"><div class="n">${due.length}</div><div class="l">Due now</div></button>
    <button class="stat ok" onclick="passFilter='all';go('pass')"><div class="n">${done.length}<span class="small muted">/${slots.length}</span></div><div class="l">Doses documented today</div></button>
    <button class="stat ${fu.length ? 'warn' : ''}" onclick="A.followUps()"><div class="n">${fu.length}</div><div class="l">PRN follow-ups due</div></button>
    <button class="stat ${tTot - tDone ? 'info' : 'ok'}" onclick="go('tasks')"><div class="n">${tDone}<span class="small muted">/${tTot}</span></div><div class="l">${esc(sh.name)} tasks done</div></button>
    <button class="stat ${refills.length ? 'warn' : ''}" onclick="go('reports/refills')"><div class="n">${refills.length}</div><div class="l">Meds to reorder</div></button>
    <button class="stat" onclick="go('residents')"><div class="n">${residentsActive().length}</div><div class="l">Residents in building</div></button>
    <button class="stat ${flagged.length ? 'warn' : ''}" onclick="go('notes')"><div class="n">${flagged.length}</div><div class="l">Flagged notes (24h)</div></button>
  </div>
  ${facilityAlerts.length ? `<div class="sec">Active care alerts</div><div class="card">${facilityAlerts.slice(0, 8).map(a => `<div class="alertbar ${a.severity || 'info'}"><b>${a.scope === 'all' ? 'All residents' : a.scope === 'careLevel' ? 'Care level ' + esc(a.careLevel) : esc(rName(byId('residents', a.residentId)))}:</b> ${esc(a.text)}</div>`).join('')}</div>` : ''}
  ${late.length ? `<div class="sec">Late doses</div><div class="list">${late.slice(0, 12).map(s => `<button class="item" onclick="go('residentpass/${s.r.id}')">${avatar(s.r)}<div class="grow"><div class="b">${esc(rName(s.r))} <span class="muted small">Rm ${esc(s.r.room)}</span></div><div class="small muted">${esc(medLabel(s.m))} · due ${t12(s.t)}</div></div>${pill('late')}</button>`).join('')}</div>` : ''}
  ${flagged.length ? `<div class="sec">Shift report — flagged notes</div><div class="list">${flagged.slice(0, 6).map(noteItem).join('')}</div>` : ''}
  ${!residentsActive().length ? `<div class="card empty">No residents yet.${isNurse() ? `<br><br><button class="btn" onclick="A.editResident()">Add your first resident</button>` : ''}</div>` : ''}`;
};

/* ---- Med Pass ---- */
PAGES.pass = () => {
  setTitle('Med Pass');
  const date = passDate || ymd();
  const slots = slotsFor(date);
  const pts = settings().passTimes || [];
  const filters = [['now', 'Due now'], ['late', 'Late'], ...pts.map(p => [p.label, `${p.label}`]), ['all', 'All']];
  const match = s => passFilter === 'all' ? true : passFilter === 'now' ? (s.state === 'due' || s.state === 'late') : passFilter === 'late' ? s.state === 'late' : passFor(s.t) === passFilter;
  const sel = slots.filter(match);
  const groups = new Map();
  for (const s of sel) { if (!groups.has(s.r.id)) groups.set(s.r.id, []); groups.get(s.r.id).push(s); }
  const away = all('residents').filter(r => r.status && r.status !== 'active' && r.status !== 'discharged');
  return `
  <div class="row noprint" style="margin-bottom:10px"><input type="date" id="pDate" value="${date}" style="max-width:170px" onchange="passDate=this.value;render()"><div class="grow"></div>${date !== ymd() ? `<button class="btn sm sec2" onclick="passDate=null;render()">Today</button>` : ''}</div>
  <div class="chips" style="margin-bottom:12px">${filters.map(([k, l]) => `<button class="chip ${passFilter === k ? 'on' : ''}" onclick="passFilter='${esc(k)}';render()">${esc(l)}${k === 'late' ? ` (${slots.filter(s => s.state === 'late').length})` : ''}</button>`).join('')}</div>
  ${!canPassMeds() ? `<div class="alertbar warn" style="margin-bottom:10px">Your role (${esc(S.me.role)}) can view the med pass but only Med Techs, Nurses and Admins can document doses.</div>` : ''}
  ${groups.size ? `<div class="list">${[...groups.entries()].map(([rid, ss]) => {
    const r = ss[0].r; const pend = ss.filter(s => !s.adm).length; const lt = ss.filter(s => s.state === 'late').length;
    const al = alertsFor(r);
    return `<button class="item" onclick="go('residentpass/${rid}')">${avatar(r)}<div class="grow"><div class="b">${esc(rName(r))} <span class="muted small">Rm ${esc(r.room || '—')}</span></div>
      <div class="small muted">${pend ? `${pend} to pass` : 'All documented'}${r.allergies ? ' · <span style="color:var(--bad)">Allergies</span>' : ''}${al.length ? ` · ⚠️ ${al.length} alert${al.length > 1 ? 's' : ''}` : ''}</div></div>
      ${lt ? `<span class="pill bad">${lt} late</span>` : pend ? `<span class="pill info">${pend}</span>` : `<span class="pill ok">✓</span>`}<span class="chev">›</span></button>`;
  }).join('')}</div>` : `<div class="card empty">${slots.length ? 'Nothing in this view. 🎉' : 'No scheduled medications for this date.'}</div>`}
  ${away.length ? `<div class="sec">Out of building</div><div class="list">${away.map(r => `<button class="item" onclick="go('resident/${r.id}')">${avatar(r)}<div class="grow"><div class="b">${esc(rName(r))}</div><div class="small muted">Rm ${esc(r.room)}</div></div>${pill(r.status)}</button>`).join('')}</div>` : ''}
  <div class="sec">PRN (as needed)</div>
  <div class="card small muted">Open a resident to give a PRN. PRN follow-ups due: <b>${prnFollowUpsDue().length}</b> <button class="btn ghost" onclick="A.followUps()">View</button></div>`;
};

PAGES.residentpass = rid => {
  const r = byId('residents', rid);
  if (!r) return '<div class="card empty">Resident not found</div>';
  setTitle('Pass · ' + rName(r), true);
  const date = passDate || ymd();
  const slots = slotsFor(date, rid);
  const pending = slots.filter(s => !s.adm && s.state !== 'upcoming');
  const upcoming = slots.filter(s => !s.adm && s.state === 'upcoming');
  const done = slots.filter(s => s.adm);
  const prns = all('meds').filter(m => m.residentId === rid && m.prn && m.status !== 'dc' && m.status !== 'hold');
  const fu = prnFollowUpsDue(rid);
  const canGive = canPassMeds() && (r.status || 'active') === 'active';
  const row = s => {
    const m = s.m;
    const flags = [m.controlled ? '<span class="flag bad">CONTROLLED</span>' : '', m.vitals?.length ? `<span class="flag">CHECK ${m.vitals.map(v => v.toUpperCase()).join('/')}</span>` : '', m.crush === 'no' ? '<span class="flag bad">DO NOT CRUSH</span>' : '', needsRefill(m) ? '<span class="flag">REORDER</span>' : ''].filter(Boolean).join(' ');
    if (s.adm) {
      const a = s.adm;
      return `<div class="medrow done" onclick="A.adminDetail('${a.id}')"><div class="row"><span class="timechip">${t12(s.t)}</span><div class="grow"><div class="mn">${esc(medLabel(m))}</div><div class="md">${esc(medSig(m))}</div></div>${pill(a.status)}</div>
        <div class="small muted" style="margin-top:6px">${esc(a.byInitials || '')} ${esc(a.byName || '')} · ${fDT(a.at)}${a.late ? ' · <b style="color:var(--warn)">late entry</b>' : ''}${a.reason ? ' · ' + esc(a.reason) : ''}</div></div>`;
    }
    return `<div class="medrow ${s.state === 'late' ? 'late' : ''}"><div class="row">${canGive ? `<input type="checkbox" class="selMed" value="${m.id}|${s.key}" checked>` : ''}<div class="grow"><div class="row between"><span class="mn">${esc(medLabel(m))}</span><span class="timechip">${t12(s.t)}</span></div>
      <div class="md">${esc(medSig(m))}${m.indication ? ' · for ' + esc(m.indication) : ''}</div>
      ${m.instructions ? `<div class="small" style="margin-top:3px">${esc(m.instructions)}</div>` : ''}
      <div style="margin-top:3px">${flags} ${s.state === 'late' ? '<span class="flag bad">LATE</span>' : ''}</div></div></div>
      ${canGive ? `<div class="acts"><button class="btn sm sec2" onclick="A.exception('${m.id}','${s.key}','refused')">Refused</button><button class="btn sm sec2" onclick="A.exception('${m.id}','${s.key}','held')">Held</button><button class="btn sm sec2" onclick="A.exception('${m.id}','${s.key}','unavailable')">Not avail.</button></div>` : ''}</div>`;
  };
  return `
  ${residentHeader(r)}
  ${fu.map(a => `<div class="alertbar warn" style="margin-bottom:8px;cursor:pointer" onclick="A.followUp('${a.id}')">⏱ PRN follow-up due: <b>${esc(a.medName)}</b> given ${fTime(a.at)} — tap to document effectiveness</div>`).join('')}
  ${(r.status || 'active') !== 'active' ? `<div class="alertbar warn" style="margin-bottom:8px">Resident is marked <b>${esc(STATUS[r.status]?.[0] || r.status)}</b>. Doses are not expected while out.</div>` : ''}
  <div class="sec">To pass ${date !== ymd() ? '· ' + fDate(date) : ''}</div>
  ${pending.length ? pending.map(row).join('') : '<div class="card empty small">Nothing due right now.</div>'}
  ${pending.length && canGive ? `<div style="position:sticky;bottom:calc(var(--nav) + 10px + env(safe-area-inset-bottom));z-index:5;margin:10px 0"><button class="btn ok block" style="box-shadow:0 6px 18px rgba(31,138,76,.35);min-height:52px;font-size:16px" onclick="A.givePass('${rid}')">✓ Give selected &amp; sign</button></div>` : ''}
  ${prns.length ? `<div class="sec">PRN · as needed</div><div class="list">${prns.map(m => { const p = prnInfo(m); return `<button class="item" ${canGive ? `onclick="A.givePrn('${m.id}')"` : ''}><div class="grow"><div class="b">${esc(medLabel(m))}</div><div class="small muted">${esc(medSig(m))}${m.indication ? ' · ' + esc(m.indication) : ''}</div><div class="small muted">Last: ${p.last ? fDT(p.last.at) : 'never'} · ${p.day} in 24h${m.prnMaxPerDay ? ' (max ' + esc(m.prnMaxPerDay) + ')' : ''}</div></div>${p.maxed ? '<span class="pill bad">Max reached</span>' : p.tooSoon ? `<span class="pill warn">After ${fTime(p.nextOk)}</span>` : '<span class="pill ok">Available</span>'}</button>`; }).join('')}</div>` : ''}
  ${upcoming.length ? `<div class="sec">Later today</div>${upcoming.map(s => `<div class="medrow" style="opacity:.7"><div class="row"><span class="timechip">${t12(s.t)}</span><div class="grow"><div class="mn">${esc(medLabel(s.m))}</div><div class="md">${esc(medSig(s.m))}</div></div></div></div>`).join('')}` : ''}
  ${done.length ? `<div class="sec">Documented</div>${done.map(row).join('')}` : ''}
  <div class="row noprint" style="margin-top:14px"><button class="btn sec2 grow" onclick="A.addVitals('${rid}')">+ Vitals</button><button class="btn sec2 grow" onclick="A.addNote('${rid}')">+ Note</button><button class="btn sec2 grow" onclick="go('mar/${rid}')">MAR</button></div>`;
};

function residentHeader(r) {
  const al = alertsFor(r);
  const v = idx().lastV.get(r.id);
  return `<div class="card"><div class="row">${avatar(r, true)}<div class="grow"><div style="font-size:19px;font-weight:750">${esc(rName(r))}</div>
    <div class="small muted">Room ${esc(r.room || '—')}${r.dob ? ` · ${age(r.dob)} yrs · DOB ${fDate(r.dob)}` : ''}${r.careLevel ? ` · Care level ${esc(r.careLevel)}` : ''}</div>
    <div class="row wrap" style="gap:5px;margin-top:5px">${r.codeStatus ? `<span class="pill ${/dnr/i.test(r.codeStatus) ? 'bad' : 'brand'}">${esc(r.codeStatus)}</span>` : ''}${r.diet ? `<span class="pill">${esc(r.diet)}</span>` : ''}${r.status && r.status !== 'active' ? pill(r.status) : ''}</div></div></div>
    <div class="allergy" style="margin-top:10px">Allergies: ${esc(r.allergies || 'NKDA (none known)')}</div>
    ${al.map(a => `<div class="alertbar ${a.severity || 'info'}">⚠️ ${esc(a.text)}</div>`).join('')}
    ${v ? `<div class="small muted" style="margin-top:8px">Last vitals ${fDT(v.at)}: ${vitalsLine(v)}</div>` : ''}</div>`;
}
function vitalsLine(v) {
  return [v.bpSys ? `BP ${v.bpSys}/${v.bpDia || '?'}` : '', v.pulse ? `P ${v.pulse}` : '', v.temp ? `T ${v.temp}°` : '', v.resp ? `R ${v.resp}` : '', v.o2 ? `O₂ ${v.o2}%` : '', v.bs ? `BS ${v.bs}` : '', v.weight ? `Wt ${v.weight} lb` : '', v.pain != null && v.pain !== '' ? `Pain ${v.pain}/10` : ''].filter(Boolean).join(' · ') || '—';
}

/* ---- Residents ---- */
PAGES.residents = () => {
  setTitle('Residents');
  const q = resSearch.toLowerCase();
  const list = residentsAll().filter(r => (resStatus === 'all' || (resStatus === 'active' ? (r.status || 'active') !== 'discharged' : r.status === 'discharged')) && (!q || `${rName(r)} ${r.room}`.toLowerCase().includes(q)));
  return `<div class="row" style="margin-bottom:10px"><input type="search" placeholder="Search name or room" value="${esc(resSearch)}" oninput="resSearch=this.value;A.refreshResList()" id="resQ">${isNurse() ? `<button class="btn" onclick="A.editResident()">+ Add</button>` : ''}</div>
  <div class="seg" style="margin-bottom:12px">${[['active', 'Current'], ['discharged', 'Discharged'], ['all', 'All']].map(([k, l]) => `<button class="${resStatus === k ? 'on' : ''}" onclick="resStatus='${k}';render()">${l}</button>`).join('')}</div>
  <div id="resList">${resListHtml(list)}</div>`;
};
function resListHtml(list) {
  return list.length ? `<div class="list">${list.map(r => `<button class="item" onclick="resTab='overview';go('resident/${r.id}')">${avatar(r)}<div class="grow"><div class="b">${esc(rName(r))}</div><div class="small muted">Rm ${esc(r.room || '—')}${r.careLevel ? ' · Level ' + esc(r.careLevel) : ''} · ${medsFor(r.id).length} meds</div></div>${r.status && r.status !== 'active' ? pill(r.status) : ''}${alertsFor(r).length ? '<span class="pill warn">⚠️</span>' : ''}<span class="chev">›</span></button>`).join('')}</div>` : '<div class="card empty">No residents found.</div>';
}

PAGES.resident = rid => {
  const r = byId('residents', rid);
  if (!r) return '<div class="card empty">Resident not found</div>';
  setTitle(rName(r), true);
  const tabs = [['overview', 'Overview'], ['meds', 'Meds'], ['care', 'Care plan'], ['vitals', 'Vitals'], ['notes', 'Notes']];
  let body = '';
  if (resTab === 'overview') {
    const F = (l, v) => v ? `<tr><th style="width:38%">${l}</th><td>${esc(v)}</td></tr>` : '';
    const lastA = all('assessments').filter(a => a.residentId === rid).sort((a, b) => b.at - a.at)[0];
    body = `<div class="card"><table class="simple">${F('Status', STATUS[r.status || 'active']?.[0] || 'In building')}${F('Admitted', r.admitDate && fDate(r.admitDate))}${F('Diagnoses', r.diagnoses)}${F('Diet / texture', r.diet)}${F('Code status', r.codeStatus)}${F('Physician', [r.physician, r.physicianPhone].filter(Boolean).join(' · '))}${F('Pharmacy', [r.pharmacy, r.pharmacyPhone].filter(Boolean).join(' · '))}${F('Emergency contact', [r.contactName, r.contactPhone].filter(Boolean).join(' · '))}${F('Notes', r.notes)}</table></div>
    <div class="card"><div class="row between"><h2 style="margin:0">Assessment</h2>${isNurse() ? `<button class="btn sm" onclick="A.assessment('${rid}')">New assessment</button>` : ''}</div>
    ${lastA ? `<div class="small" style="margin-top:8px">Last: ${fDate(lastA.at)} by ${esc(lastA.byName || '')} · Score ${lastA.total} → <b>Care level ${lastA.careLevel}</b></div>` : '<div class="small muted" style="margin-top:8px">No assessment yet. Completing one builds the care plan task list automatically.</div>'}</div>
    <div class="grid g2 noprint">${canPassMeds() ? `<button class="btn" onclick="go('residentpass/${rid}')">💊 Med pass</button>` : ''}<button class="btn sec2" onclick="go('mar/${rid}')">📋 MAR</button>${isNurse() ? `<button class="btn sec2" onclick="A.editResident('${rid}')">Edit resident</button><button class="btn sec2" onclick="A.setStatus('${rid}')">Status / LOA</button><button class="btn sec2" onclick="A.editAlert(null,'${rid}')">+ Care alert</button>` : ''}</div>`;
  } else if (resTab === 'meds') {
    const ms = all('meds').filter(m => m.residentId === rid).sort((a, b) => (a.status === 'dc') - (b.status === 'dc') || (a.prn ? 1 : 0) - (b.prn ? 1 : 0) || a.name.localeCompare(b.name));
    body = `${isNurse() ? `<button class="btn block" style="margin-bottom:10px" onclick="A.editMed(null,'${rid}')">+ Add medication / order</button>` : ''}
    ${ms.length ? `<div class="list">${ms.map(m => { const o = onHand(m); return `<button class="item" onclick="A.medDetail('${m.id}')" style="${m.status === 'dc' ? 'opacity:.55' : ''}"><div class="grow"><div class="b">${esc(medLabel(m))} ${m.controlled ? '<span class="pill bad">C</span>' : ''}</div><div class="small muted">${esc(medSig(m))} · ${m.prn ? 'PRN' + (m.prnMinHours ? ' q' + esc(m.prnMinHours) + 'h' : '') : (m.times || []).map(t12).join(', ')}${m.days?.length ? ' · ' + m.days.map(d => DOW[d]).join('/') : ''}</div>${o != null ? `<div class="small ${needsRefill(m) ? '' : 'muted'}" style="${needsRefill(m) ? 'color:var(--warn);font-weight:650' : ''}">On hand: ${o}${needsRefill(m) ? ' — reorder' : ''}</div>` : ''}</div>${m.status === 'dc' ? '<span class="pill">D/C</span>' : m.status === 'hold' ? '<span class="pill warn">On hold</span>' : ''}<span class="chev">›</span></button>`; }).join('')}</div>` : '<div class="card empty">No medications on file.</div>'}`;
  } else if (resTab === 'care') {
    const ts = all('tasks').filter(t => t.residentId === rid);
    const cats = [...new Set(ts.map(t => t.category || 'Other'))];
    const shName = id => (settings().shifts || []).find(s => s.id === id)?.name || id;
    body = `${isNurse() ? `<div class="row" style="margin-bottom:10px"><button class="btn grow" onclick="A.assessment('${rid}')">Run assessment</button><button class="btn sec2 grow" onclick="A.editTask(null,'${rid}')">+ Task</button></div>` : ''}
    ${ts.length ? cats.map(c => `<div class="sec">${esc(c)}</div><div class="list">${ts.filter(t => (t.category || 'Other') === c).map(t => `<button class="item" ${isNurse() ? `onclick="A.editTask('${t.id}')"` : ''} style="${t.active === false ? 'opacity:.5' : ''}"><div class="grow"><div class="b">${esc(t.name)}</div><div class="small muted">${(t.shifts || []).map(shName).join(', ')}${t.days?.length ? ' · ' + t.days.map(d => DOW[d]).join('/') : ' · daily'}${t.auto ? ' · from assessment' : ''}</div>${t.instructions ? `<div class="small">${esc(t.instructions)}</div>` : ''}</div></button>`).join('')}</div>`).join('') : '<div class="card empty">No care plan tasks yet. Run an assessment to generate them automatically.</div>'}`;
  } else if (resTab === 'vitals') {
    const vs = all('vitals').filter(v => v.residentId === rid).sort((a, b) => b.at - a.at);
    body = `<button class="btn block" style="margin-bottom:10px" onclick="A.addVitals('${rid}')">+ Record vitals</button>
    ${vs.length ? `<div class="card" style="overflow-x:auto"><table class="simple"><tr><th>When</th><th>BP</th><th>P</th><th>T</th><th>R</th><th>O₂</th><th>BS</th><th>Wt</th><th>Pain</th><th>By</th></tr>${vs.slice(0, 100).map(v => `<tr><td>${fDT(v.at)}</td><td>${v.bpSys ? esc(v.bpSys + '/' + (v.bpDia || '')) : ''}</td><td>${esc(v.pulse ?? '')}</td><td>${esc(v.temp ?? '')}</td><td>${esc(v.resp ?? '')}</td><td>${esc(v.o2 ?? '')}</td><td>${esc(v.bs ?? '')}</td><td>${esc(v.weight ?? '')}</td><td>${esc(v.pain ?? '')}</td><td>${esc(v.byInitials || '')}</td></tr>`).join('')}</table></div>` : '<div class="card empty">No vitals recorded.</div>'}`;
  } else if (resTab === 'notes') {
    const ns = all('notes').filter(n => n.residentId === rid).sort((a, b) => b.at - a.at);
    body = `<button class="btn block" style="margin-bottom:10px" onclick="A.addNote('${rid}')">+ Add note</button>${ns.length ? `<div class="list">${ns.map(noteItem).join('')}</div>` : '<div class="card empty">No notes yet.</div>'}`;
  }
  return `${residentHeader(r)}<div class="seg" style="margin-bottom:12px">${tabs.map(([k, l]) => `<button class="${resTab === k ? 'on' : ''}" onclick="resTab='${k}';render()">${l}</button>`).join('')}</div>${body}`;
};

/* ---- Tasks ---- */
PAGES.tasks = () => {
  setTitle('Shift Tasks');
  const date = taskDate || ymd();
  const shifts = settings().shifts || [];
  const sh = shifts.find(s => s.id === taskShift) || currentShift();
  const I = idx();
  const rs = residentsActive().map(r => ({ r, ts: tasksFor(r, date, sh.id) })).filter(x => x.ts.length);
  const tot = rs.reduce((s, x) => s + x.ts.length, 0), done = rs.reduce((s, x) => s + x.ts.filter(t => I.tlog.has(`${t.id}|${date}|${sh.id}`)).length, 0);
  return `<div class="row" style="margin-bottom:10px"><input type="date" value="${date}" style="max-width:170px" onchange="taskDate=this.value;render()"><div class="grow"></div><span class="pill ${done === tot ? 'ok' : 'info'}">${done}/${tot} done</span></div>
  <div class="seg" style="margin-bottom:12px">${shifts.map(s => `<button class="${s.id === sh.id ? 'on' : ''}" onclick="taskShift='${s.id}';render()">${esc(s.name)}</button>`).join('')}</div>
  ${rs.length ? rs.map(({ r, ts }) => {
    const left = ts.filter(t => !I.tlog.has(`${t.id}|${date}|${sh.id}`));
    return `<div class="card"><div class="row" style="margin-bottom:8px">${avatar(r)}<div class="grow"><div class="b">${esc(rName(r))}</div><div class="small muted">Rm ${esc(r.room)} · ${ts.length - left.length}/${ts.length} done</div></div>${left.length > 1 ? `<button class="btn sm sec2" onclick="A.taskAll('${r.id}','${date}','${sh.id}')">All done</button>` : ''}</div>
    ${alertsFor(r).map(a => `<div class="alertbar ${a.severity || 'info'}" style="margin-bottom:6px">⚠️ ${esc(a.text)}</div>`).join('')}
    ${ts.map(t => { const l = I.tlog.get(`${t.id}|${date}|${sh.id}`); return `<div class="row" style="padding:8px 0;border-top:1px solid var(--line)"><div class="grow"><div class="b" style="${l ? 'color:var(--mute)' : ''}">${l?.status === 'done' ? '✅ ' : ''}${esc(t.name)}</div>${t.instructions ? `<div class="small muted">${esc(t.instructions)}</div>` : ''}${l ? `<div class="small muted">${esc(l.status === 'done' ? 'Done' : l.status === 'refused' ? 'Refused' : 'N/A')} · ${esc(l.byInitials || '')} ${fTime(l.at)}${l.note ? ' · ' + esc(l.note) : ''}</div>` : ''}</div>
      ${l ? '' : `<button class="btn sm ok" onclick="A.taskLog('${t.id}','${date}','${sh.id}','done')">✓</button><button class="btn sm sec2" onclick="A.taskLogNote('${t.id}','${date}','${sh.id}')">…</button>`}</div>`; }).join('')}</div>`;
  }).join('') : `<div class="card empty">No care tasks scheduled for the ${esc(sh.name)} shift.<br><span class="small">Tasks come from each resident's care plan (run an assessment on the resident's Care plan tab).</span></div>`}`;
};

/* ---- More ---- */
PAGES.more = () => {
  setTitle('More');
  const items = [
    ['mar', '📋', 'MAR (monthly record)', 'Printable medication administration record'],
    ['notes', '📝', 'Notes & shift report', 'Progress, shift, incident and behavior notes'],
    ['vitalsall', '❤️', 'Vitals log', 'All residents'],
    ['count', '🔐', 'Controlled-drug count', 'Shift count with witness'],
    ['alerts', '⚠️', 'Care alerts', 'By resident, care level or community'],
    ['reports', '📊', 'Reports', 'Missed/late doses, refusals, PRN use, reorders, audit'],
    ...(isAdmin() ? [['staff', '👥', 'Staff & PINs', 'Add caregivers, med techs, nurses'], ['settings', '⚙️', 'Settings & backup', 'Pass times, shifts, windows, export']] : [])
  ];
  return `<div class="list">${items.map(([k, i, l, d]) => `<button class="item" onclick="go('${k}')"><div class="av" style="border-radius:12px">${i}</div><div class="grow"><div class="b">${l}</div><div class="small muted">${d}</div></div><span class="chev">›</span></button>`).join('')}</div>
  <div class="card small muted">${S.mode === 'cloud' ? `Connected to the ${esc(S.facility)} server. Data is shared by all staff devices.` : `<b>Device mode:</b> data is stored on this device only. Deploy the repo to Cloudflare so every caregiver shares the same records.`}<br>Signed in as ${esc(S.me.name)} (${esc(S.me.role)}). Auto-locks after ${settings().lockMin || 15} min idle.</div>
  <button class="btn sec2 block" onclick="lock()">🔒 Lock / switch user</button>`;
};

/* ---- MAR ---- */
let marMonth = null;
PAGES.mar = rid => {
  setTitle('MAR', true);
  const rs = residentsAll().filter(r => r.status !== 'discharged' || r.id === rid);
  rid = rid || rs[0]?.id;
  const r = byId('residents', rid);
  const month = marMonth || ymd().slice(0, 7);
  if (!r) return '<div class="card empty">No residents yet.</div>';
  const [Y, M] = month.split('-').map(Number);
  const nDays = new Date(Y, M, 0).getDate();
  const days = Array.from({ length: nDays }, (_, i) => `${month}-${p2(i + 1)}`);
  const today = ymd(); const I = idx();
  const ms = all('meds').filter(m => m.residentId === rid && (!m.start || m.start <= days[nDays - 1]) && (!m.end || m.end >= days[0])).sort((a, b) => (a.prn ? 1 : 0) - (b.prn ? 1 : 0) || a.name.localeCompare(b.name));
  const CODE = { refused: 'R', held: 'H', unavailable: 'U', loa: 'L', hospital: 'Hx' };
  let rows = '';
  for (const m of ms) {
    if (m.prn) {
      const list = (I.prnByMed.get(m.id) || []).filter(a => a.status === 'given');
      rows += `<tr><td class="medc"><b>${esc(medLabel(m))}</b><br><span class="muted">${esc(medSig(m))} · PRN</span></td>${days.map(d => { const n = list.filter(a => ymd(new Date(a.at)) === d); return `<td class="${n.length ? 'g' : ''} ${d === today ? 'today' : ''}" title="${n.map(a => fTime(a.at) + ' ' + (a.byInitials || '')).join(', ')}">${n.length ? n.map(a => esc(a.byInitials || '✓')).join('<br>') : ''}</td>`; }).join('')}</tr>`;
      continue;
    }
    for (const t of m.times || []) {
      rows += `<tr><td class="medc"><b>${esc(medLabel(m))}</b><br><span class="muted">${esc(medSig(m))} · ${t12(t)}</span></td>${days.map(d => {
        if (!medActiveOn(m, d) && !I.slot.get(`${m.id}|${d}T${t}`)) return `<td class="na ${d === today ? 'today' : ''}"></td>`;
        const a = I.slot.get(`${m.id}|${d}T${t}`);
        if (a) return a.status === 'given' ? `<td class="g ${d === today ? 'today' : ''}" title="${fDT(a.at)} ${esc(a.byName || '')}">${esc(a.byInitials || '✓')}</td>` : `<td class="o ${d === today ? 'today' : ''}" title="${esc(a.status)}: ${esc(a.reason || '')}">${CODE[a.status] || '?'}</td>`;
        const st = slotState(d, t, null);
        return st === 'late' ? `<td class="x ${d === today ? 'today' : ''}" title="Not documented">✗</td>` : `<td class="${d === today ? 'today' : ''}"></td>`;
      }).join('')}</tr>`;
    }
  }
  return `<div class="row wrap noprint" style="margin-bottom:10px"><select style="flex:1;min-width:180px" onchange="go('mar/'+this.value)">${rs.map(x => `<option value="${x.id}" ${x.id === rid ? 'selected' : ''}>${esc(rName(x))} — Rm ${esc(x.room)}</option>`).join('')}</select><input type="month" value="${month}" style="max-width:160px;width:auto" onchange="marMonth=this.value;render()"><button class="btn sec2" onclick="window.print()">🖨 Print</button></div>
  <div class="card"><div class="row between wrap"><div><b style="font-size:16px">${esc(rName(r))}</b> · Rm ${esc(r.room)} · DOB ${fDate(r.dob)}</div><div class="small">${new Date(Y, M - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })} · ${esc(S.facility)}</div></div>
  <div class="small" style="margin-top:4px"><b style="color:var(--bad)">Allergies: ${esc(r.allergies || 'NKDA')}</b> · Physician: ${esc(r.physician || '—')} · Pharmacy: ${esc(r.pharmacy || '—')}</div></div>
  ${ms.length ? `<div class="marwrap"><table class="mar"><tr><th class="medc">Medication / time</th>${days.map((d, i) => `<th>${i + 1}<br><span class="muted" style="font-weight:500">${DOW[new Date(d + 'T12:00').getDay()][0]}</span></th>`).join('')}</tr>${rows}</table></div>` : '<div class="card empty">No medications for this month.</div>'}
  <div class="card small" style="margin-top:10px">Key: <b style="color:var(--ok)">initials</b> = given · <b style="color:var(--warn)">R</b> refused · <b style="color:var(--warn)">H</b> held · <b style="color:var(--warn)">U</b> unavailable · <b style="color:var(--bad)">✗</b> not documented (missed) · shaded = not scheduled</div>
  <div class="card small"><b>Staff signatures</b><br>${[...new Set(all('admins').filter(a => a.residentId === rid && a.scheduledFor?.startsWith(month) || (a.residentId === rid && a.prn && ymd(new Date(a.at)).startsWith(month))).map(a => a.by))].map(id => { const s = I.staff.get(id); return s ? `${esc(s.initials)} = ${esc(s.name)} (${esc(s.role)})` : ''; }).filter(Boolean).join(' · ') || '—'}</div>`;
};

/* ---- Notes ---- */
let noteFilter = 'all';
function noteItem(n) {
  const r = n.residentId && byId('residents', n.residentId);
  return `<div class="item" style="cursor:default;align-items:flex-start;${n.struck ? 'opacity:.5;text-decoration:line-through' : ''}"><div class="grow"><div class="row between"><span class="b">${n.flagged ? '🚩 ' : ''}${esc(n.type || 'Note')}${r ? ' · ' + esc(rName(r)) : ''}</span><span class="small muted">${fDT(n.at)}</span></div><div style="white-space:pre-wrap;margin-top:3px">${esc(n.text)}</div><div class="small muted" style="margin-top:3px">— ${esc(n.byName || '')}</div></div></div>`;
}
PAGES.notes = () => {
  setTitle('Notes', true);
  const types = ['all', 'Shift report', 'Progress', 'Incident', 'Change of condition', 'Behavior', 'Family contact', 'Physician contact'];
  const ns = all('notes').filter(n => noteFilter === 'all' || n.type === noteFilter).sort((a, b) => b.at - a.at).slice(0, 200);
  return `<button class="btn block" style="margin-bottom:10px" onclick="A.addNote()">+ New note</button>
  <div class="chips" style="margin-bottom:10px">${types.map(t => `<button class="chip ${noteFilter === t ? 'on' : ''}" onclick="noteFilter='${t}';render()">${t === 'all' ? 'All' : t}</button>`).join('')}</div>
  ${ns.length ? `<div class="list">${ns.map(noteItem).join('')}</div>` : '<div class="card empty">No notes.</div>'}`;
};
PAGES.vitalsall = () => {
  setTitle('Vitals log', true);
  const vs = all('vitals').sort((a, b) => b.at - a.at).slice(0, 300);
  return `<div class="card" style="overflow-x:auto"><table class="simple"><tr><th>When</th><th>Resident</th><th>Vitals</th><th>By</th></tr>${vs.map(v => `<tr><td>${fDT(v.at)}</td><td>${esc(rName(byId('residents', v.residentId)))}</td><td>${vitalsLine(v)}</td><td>${esc(v.byInitials || '')}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">None yet</td></tr>'}</table></div>`;
};

/* ---- Alerts ---- */
PAGES.alerts = () => {
  setTitle('Care alerts', true);
  const as = all('alerts').sort((a, b) => (b.active !== false) - (a.active !== false) || b.createdAt - a.createdAt);
  return `${isNurse() ? `<button class="btn block" style="margin-bottom:10px" onclick="A.editAlert()">+ New alert</button>` : ''}
  ${as.length ? `<div class="list">${as.map(a => `<button class="item" ${isNurse() ? `onclick="A.editAlert('${a.id}')"` : ''} style="${a.active === false ? 'opacity:.5' : ''}"><div class="grow"><div class="b">${a.scope === 'all' ? 'All residents' : a.scope === 'careLevel' ? 'Care level ' + esc(a.careLevel) : esc(rName(byId('residents', a.residentId)))}</div><div class="small">${esc(a.text)}</div><div class="small muted">${a.expires ? 'Until ' + fDate(a.expires) : 'No end date'}${a.active === false ? ' · inactive' : ''}</div></div><span class="pill ${a.severity === 'critical' ? 'bad' : a.severity === 'warn' ? 'warn' : 'info'}">${esc(a.severity || 'info')}</span></button>`).join('')}</div>` : '<div class="card empty">No alerts. Alerts show on the resident header during med pass and tasks.</div>'}`;
};

/* ---- Controlled count ---- */
PAGES.count = () => {
  setTitle('Controlled-drug count', true);
  const cms = all('meds').filter(m => m.controlled && m.status !== 'dc').sort((a, b) => roomSort(byId('residents', a.residentId) || {}, byId('residents', b.residentId) || {}));
  const hist = all('counts').sort((a, b) => b.at - a.at).slice(0, 30);
  return `<div class="card"><h2>New shift count</h2>${cms.length ? `
    ${cms.map(m => `<div class="row" style="padding:8px 0;border-bottom:1px solid var(--line)"><div class="grow"><div class="b">${esc(medLabel(m))}</div><div class="small muted">${esc(rName(byId('residents', m.residentId)))} · Expected <b>${onHand(m) ?? '—'}</b></div></div><input type="number" inputmode="numeric" class="cnt" data-id="${m.id}" placeholder="Count" style="width:96px"></div>`).join('')}
    <label class="f" style="margin-top:10px"><span>Witness</span><select id="cWit"><option value="">— select —</option>${all('staff').filter(s => s.id !== S.me.id && s.active !== false).map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select></label>
    <button class="btn block" onclick="A.saveCount()">Save count</button>` : '<div class="muted small">No controlled medications on file. Mark a med as "Controlled substance" in its order to include it here.</div>'}</div>
  <div class="sec">History</div>${hist.length ? `<div class="list">${hist.map(c => `<div class="item" style="cursor:default"><div class="grow"><div class="b">${fDT(c.at)} · ${esc(c.byName)}${c.witnessName ? ' / ' + esc(c.witnessName) : ''}</div><div class="small muted">${c.items.length} items</div>${c.items.filter(i => i.counted !== i.expected).map(i => `<div class="small" style="color:var(--bad)">${esc(i.name)}: expected ${i.expected}, counted ${i.counted}</div>`).join('')}</div>${c.discrepancy ? '<span class="pill bad">Discrepancy</span>' : '<span class="pill ok">OK</span>'}</div>`).join('')}</div>` : '<div class="card empty small">No counts yet.</div>'}`;
};

/* ---- Reports ---- */
let repFrom = null, repTo = null;
PAGES.reports = (tab = 'exceptions') => {
  setTitle('Reports', true);
  const tabs = [['exceptions', 'Missed & late'], ['refusals', 'Refused/held'], ['prn', 'PRN use'], ['refills', 'Reorder'], ['audit', 'Audit log']];
  const from = repFrom || addDays(ymd(), -6), to = repTo || ymd();
  let body = '', csv = null;
  const range = `<div class="row noprint" style="margin-bottom:10px"><input type="date" value="${from}" onchange="repFrom=this.value;render()"><span>to</span><input type="date" value="${to}" onchange="repTo=this.value;render()"></div>`;
  if (tab === 'exceptions') {
    const rows = [];
    for (let d = from; d <= to && d <= ymd(); d = addDays(d, 1)) {
      for (const s of slotsFor(d)) {
        if (s.state === 'late') rows.push([d, t12(s.t), rName(s.r), s.r.room, medLabel(s.m), 'Not documented']);
        else if (s.adm?.late) rows.push([d, t12(s.t), rName(s.r), s.r.room, medLabel(s.m), `Late entry ${fDT(s.adm.at)} by ${s.adm.byName}`]);
      }
    }
    csv = [['Date', 'Time', 'Resident', 'Room', 'Medication', 'Issue'], ...rows];
    body = range + (rows.length ? `<div class="card" style="overflow-x:auto"><table class="simple"><tr><th>Date</th><th>Time</th><th>Resident</th><th>Med</th><th>Issue</th></tr>${rows.map(r => `<tr><td>${fDate(r[0])}</td><td>${r[1]}</td><td>${esc(r[2])}</td><td>${esc(r[4])}</td><td style="color:${r[5] === 'Not documented' ? 'var(--bad)' : 'var(--warn)'}">${esc(r[5])}</td></tr>`).join('')}</table></div>` : '<div class="card empty">No gaps in this range. 🎉</div>');
  } else if (tab === 'refusals') {
    const list = all('admins').filter(a => !a.struck && ['refused', 'held', 'unavailable'].includes(a.status) && ymd(new Date(a.at)) >= from && ymd(new Date(a.at)) <= to).sort((a, b) => b.at - a.at);
    csv = [['When', 'Resident', 'Medication', 'Status', 'Reason', 'Note', 'By'], ...list.map(a => [fDT(a.at), rName(byId('residents', a.residentId)), a.medName, a.status, a.reason, a.note, a.byName])];
    body = range + (list.length ? `<div class="list">${list.map(a => `<div class="item" style="cursor:default"><div class="grow"><div class="b">${esc(rName(byId('residents', a.residentId)))} · ${esc(a.medName)}</div><div class="small muted">${fDT(a.at)} · ${esc(a.byName)} · ${esc(a.reason || '')}${a.note ? ' — ' + esc(a.note) : ''}${a.notified ? ' · notified: ' + esc(a.notified) : ''}</div></div>${pill(a.status)}</div>`).join('')}</div>` : '<div class="card empty">None in this range.</div>');
  } else if (tab === 'prn') {
    const list = all('admins').filter(a => !a.struck && a.prn && ymd(new Date(a.at)) >= from && ymd(new Date(a.at)) <= to).sort((a, b) => b.at - a.at);
    csv = [['When', 'Resident', 'Medication', 'Reason', 'Follow-up', 'Follow-up by', 'Given by'], ...list.map(a => [fDT(a.at), rName(byId('residents', a.residentId)), a.medName, a.prnReason, a.followUp || 'PENDING', a.followUpByName, a.byName])];
    body = range + (list.length ? `<div class="list">${list.map(a => `<div class="item" style="cursor:pointer" onclick="${a.followUp ? '' : `A.followUp('${a.id}')`}"><div class="grow"><div class="b">${esc(rName(byId('residents', a.residentId)))} · ${esc(a.medName)}</div><div class="small muted">${fDT(a.at)} · ${esc(a.byName)} · for: ${esc(a.prnReason || '')}</div></div>${a.followUp ? `<span class="pill ${/^effective/i.test(a.followUp) ? 'ok' : 'warn'}">${esc(a.followUp)}</span>` : '<span class="pill bad">Follow-up</span>'}</div>`).join('')}</div>` : '<div class="card empty">No PRNs in this range.</div>');
  } else if (tab === 'refills') {
    const list = all('meds').filter(m => m.status !== 'dc' && onHand(m) != null).sort((a, b) => (needsRefill(b) - needsRefill(a)) || onHand(a) - onHand(b));
    csv = [['Resident', 'Medication', 'Rx #', 'Pharmacy', 'On hand', 'Reorder at'], ...list.map(m => [rName(byId('residents', m.residentId)), medLabel(m), m.rx, m.pharmacy || byId('residents', m.residentId)?.pharmacy, onHand(m), m.refillAt])];
    body = list.length ? `<div class="list">${list.map(m => `<button class="item" onclick="A.medDetail('${m.id}')"><div class="grow"><div class="b">${esc(medLabel(m))}</div><div class="small muted">${esc(rName(byId('residents', m.residentId)))}${m.rx ? ' · Rx ' + esc(m.rx) : ''}</div></div><div style="text-align:right"><div class="b" style="${needsRefill(m) ? 'color:var(--warn)' : ''}">${onHand(m)}</div><div class="small muted">reorder at ${esc(m.refillAt ?? '—')}</div></div></button>`).join('')}</div>` : '<div class="card empty">Add "On hand" quantities to medication orders to track reorders.</div>';
  } else if (tab === 'audit') {
    const list = all('audit').sort((a, b) => b.at - a.at).slice(0, 400);
    csv = [['When', 'Staff', 'Action', 'Detail'], ...list.map(a => [fDT(a.at), a.staffName, a.action, a.detail])];
    body = `<div class="card" style="overflow-x:auto"><table class="simple"><tr><th>When</th><th>Staff</th><th>Action</th></tr>${list.map(a => `<tr><td>${fDT(a.at)}</td><td>${esc(a.staffName)}</td><td>${esc(a.action)} · ${esc(a.detail)}</td></tr>`).join('')}</table></div>`;
  }
  window._csv = csv;
  return `<div class="chips noprint" style="margin-bottom:10px">${tabs.map(([k, l]) => `<button class="chip ${tab === k ? 'on' : ''}" onclick="go('reports/${k}')">${l}</button>`).join('')}</div>${body}
  <div class="row noprint" style="margin-top:10px">${csv ? `<button class="btn sec2 grow" onclick="csvDownload('bltc-${tab}.csv', window._csv)">⬇ Export CSV</button>` : ''}<button class="btn sec2 grow" onclick="window.print()">🖨 Print</button></div>`;
};

/* ---- Staff ---- */
const ROLES = ['Caregiver', 'Med Tech', 'Nurse', 'Admin'];
PAGES.staff = () => {
  setTitle('Staff', true);
  if (!isAdmin()) return '<div class="card empty">Admins only.</div>';
  const ss = all('staff').sort((a, b) => (b.active !== false) - (a.active !== false) || a.name.localeCompare(b.name));
  return `<button class="btn block" style="margin-bottom:10px" onclick="A.editStaff()">+ Add staff member</button>
  <div class="list">${ss.map(s => `<button class="item" onclick="A.editStaff('${s.id}')" style="${s.active === false ? 'opacity:.5' : ''}"><div class="av">${esc(s.initials || initials(s.name))}</div><div class="grow"><div class="b">${esc(s.name)}</div><div class="small muted">${esc(s.role)}${s.active === false ? ' · inactive' : ''}</div></div><span class="chev">›</span></button>`).join('')}</div>
  <div class="card small muted">Roles: <b>Caregiver</b> — tasks, vitals, notes · <b>Med Tech</b> — + med pass · <b>Nurse</b> — + orders, residents, care plans, alerts · <b>Admin</b> — everything incl. staff &amp; settings.</div>`;
};

/* ---- Settings ---- */
PAGES.settings = () => {
  setTitle('Settings', true);
  if (!isAdmin()) return '<div class="card empty">Admins only.</div>';
  const st = settings();
  return `<div class="card"><h2>Community</h2>
    <label class="f"><span>Name</span><input type="text" id="stName" value="${esc(S.facility)}"></label>
    <div class="grid g3"><label class="f"><span>Med window ± min</span><input type="number" id="stWin" value="${st.passWindowMin || 60}"></label>
    <label class="f"><span>PRN follow-up (min)</span><input type="number" id="stFu" value="${st.prnFollowUpMin || 60}"></label>
    <label class="f"><span>Auto-lock (min)</span><input type="number" id="stLock" value="${st.lockMin || 15}"></label></div></div>
  <div class="card"><h2>Med pass times</h2><div id="stPts">${(st.passTimes || []).map((p, i) => `<div class="row" style="margin-bottom:6px"><input type="text" class="ptL" value="${esc(p.label)}"><input type="time" class="ptT" value="${p.time}" style="max-width:130px"><button class="btn sm sec2" onclick="this.parentNode.remove()">✕</button></div>`).join('')}</div>
    <button class="btn sm sec2" onclick="document.getElementById('stPts').insertAdjacentHTML('beforeend','<div class=&quot;row&quot; style=&quot;margin-bottom:6px&quot;><input type=&quot;text&quot; class=&quot;ptL&quot; placeholder=&quot;Label&quot;><input type=&quot;time&quot; class=&quot;ptT&quot; style=&quot;max-width:130px&quot;><button class=&quot;btn sm sec2&quot; onclick=&quot;this.parentNode.remove()&quot;>✕</button></div>')">+ Pass time</button></div>
  <div class="card"><h2>Shifts</h2>${(st.shifts || []).map(s => `<div class="row" style="margin-bottom:6px"><input type="text" class="shN" data-id="${s.id}" value="${esc(s.name)}"><input type="time" class="shS" value="${s.start}" style="max-width:120px"><input type="time" class="shE" value="${s.end}" style="max-width:120px"></div>`).join('')}</div>
  <button class="btn block" onclick="A.saveSettings()">Save settings</button>
  <div class="card" style="margin-top:14px"><h2>Backup</h2><div class="row wrap"><button class="btn sec2" onclick="A.exportAll()">⬇ Download backup (JSON)</button>${S.mode === 'local' ? `<label class="btn sec2">⬆ Restore backup<input type="file" accept=".json" hidden onchange="A.importAll(this.files[0])"></label>` : ''}</div>
  ${S.mode === 'local' ? `<div class="small muted" style="margin-top:8px">Demo data helps you try the app: <button class="btn ghost" onclick="A.demo()">Load sample residents</button></div>` : `<div class="small muted" style="margin-top:8px"><button class="btn ghost" onclick="A.demo()">Load sample residents</button> (adds 3 fake residents for training)</div>`}</div>`;
};

/* ---------------- actions ---------------- */
const A = window.A = {};
A.refreshResList = () => {
  const q = resSearch.toLowerCase();
  const list = residentsAll().filter(r => (resStatus === 'all' || (resStatus === 'active' ? (r.status || 'active') !== 'discharged' : r.status === 'discharged')) && (!q || `${rName(r)} ${r.room}`.toLowerCase().includes(q)));
  $('#resList').innerHTML = resListHtml(list);
};

function mkAdmin(m, extra) {
  return { id: uid('adm'), residentId: m.residentId, medId: m.id, medName: medLabel(m), dose: m.dose, route: m.route, at: Date.now(), by: S.me.id, byName: S.me.name, byInitials: S.me.initials, ...extra };
}
function isLateKey(key) { const W = settings().passWindowMin || 60; return (Date.now() - new Date(key)) / 60000 > W; }

A.givePass = rid => {
  const sel = $$('.selMed:checked').map(c => { const [mid, key] = c.value.split('|'); return { m: byId('meds', mid), key }; }).filter(x => x.m);
  if (!sel.length) return toast('Select at least one medication');
  const needV = [...new Set(sel.flatMap(x => x.m.vitals || []))];
  const controlled = sel.filter(x => x.m.controlled);
  const anyLate = sel.some(x => isLateKey(x.key));
  const early = sel.some(x => (new Date(x.key) - Date.now()) / 60000 > (settings().passWindowMin || 60));
  const r = byId('residents', rid);
  const lastV = idx().lastV.get(rid);
  const vf = { bp: ['bpSys', 'Systolic', 'bpDia', 'Diastolic'], pulse: ['pulse', 'Pulse'], bs: ['bs', 'Blood sugar'], o2: ['o2', 'O₂ %'], temp: ['temp', 'Temp'], pain: ['pain', 'Pain 0–10'] };
  const o = sheet({
    title: 'Confirm & sign',
    body: `<div class="b" style="margin-bottom:6px">${esc(rName(r))} · Rm ${esc(r.room)}</div><div class="allergy" style="margin-bottom:10px">Allergies: ${esc(r.allergies || 'NKDA')}</div>
    ${sel.map(x => `<div class="medrow"><div class="row between"><span class="mn">${esc(medLabel(x.m))}</span><span class="timechip">${t12(x.key.slice(11))}</span></div><div class="md">${esc(medSig(x.m))}</div><div class="holdWarn small" data-mid="${x.m.id}" style="color:var(--bad);font-weight:650"></div></div>`).join('')}
    ${needV.length ? `<div class="sec">Required vitals</div><div class="grid g2">${needV.map(v => v === 'bp' ? `<label class="f"><span>Systolic</span><input type="number" inputmode="numeric" id="gv_bpSys" class="gv"></label><label class="f"><span>Diastolic</span><input type="number" inputmode="numeric" id="gv_bpDia" class="gv"></label>` : `<label class="f"><span>${vf[v]?.[1] || v}</span><input type="number" inputmode="decimal" id="gv_${vf[v]?.[0] || v}" class="gv"></label>`).join('')}</div>${lastV ? `<div class="small muted">Last recorded ${fDT(lastV.at)}: ${vitalsLine(lastV)}</div>` : ''}` : ''}
    ${controlled.length ? `<div class="sec">Controlled substance count</div>${controlled.map(x => { const left = (onHand(x.m) ?? 0) - (Number(x.m.unitsPerDose) || 1); return `<label class="f"><span>${esc(medLabel(x.m))} — count remaining after this dose (expected ${onHand(x.m) == null ? '—' : left})</span><input type="number" inputmode="numeric" id="cc_${x.m.id}" data-exp="${onHand(x.m) == null ? '' : left}"></label>`; }).join('')}` : ''}
    ${anyLate || early ? `<label class="f"><span>${anyLate ? 'Late' : 'Early'} administration — reason (required)</span><input type="text" id="gLateR" placeholder="e.g. resident sleeping, at appointment"></label>` : ''}
    <label class="f"><span>Note (optional)</span><input type="text" id="gNote"></label>
    <div class="small muted">By signing you confirm the right resident, medication, dose, route and time. Signed electronically as <b>${esc(S.me.name)}</b> (${esc(S.me.initials)}).</div>`,
    foot: `<button class="btn sec2" onclick="closeSheet()">Cancel</button><button class="btn ok" id="gSign">Sign — ${sel.length} given</button>`
  });
  const recheck = () => {
    const v = { bpSys: num('gv_bpSys'), pulse: num('gv_pulse'), bs: num('gv_bs') };
    sel.forEach(x => { const w = holdCheck(x.m, v); const el = $(`.holdWarn[data-mid="${x.m.id}"]`, o); el.textContent = w.length ? '⚠️ Hold parameter: ' + w.join('; ') + ' — consider holding & notify nurse' : ''; });
  };
  $$('.gv', o).forEach(i => i.oninput = recheck);
  $('#gSign', o).onclick = async () => {
    const vit = {}; let hasV = false;
    for (const k of ['bpSys', 'bpDia', 'pulse', 'bs', 'o2', 'temp', 'pain']) { const n = num('gv_' + k); if (n != null) { vit[k] = n; hasV = true; } }
    for (const v of needV) { const k = vf[v]?.[0]; if (k && vit[k] == null) return toast(`Enter ${vf[v][1]} before giving`); }
    const v = { bpSys: vit.bpSys, pulse: vit.pulse, bs: vit.bs };
    const holds = sel.filter(x => holdCheck(x.m, v).length);
    if (holds.length && !await confirmBox(`Hold parameters are met for <b>${holds.map(x => esc(x.m.name)).join(', ')}</b>.<br><br>Give anyway? (Choose Cancel, then use <b>Held</b> to document holding it.)`, 'Give anyway')) return;
    const counts = {};
    for (const x of controlled) { const el = $('#cc_' + x.m.id, o); if (el.value === '') return toast('Enter the remaining count for ' + x.m.name); counts[x.m.id] = { counted: Number(el.value), expected: el.dataset.exp === '' ? null : Number(el.dataset.exp) }; }
    const lateR = val('gLateR');
    if ((anyLate || early) && !lateR) return toast('Enter a reason for the late/early pass');
    const note = val('gNote');
    if (hasV) await save('vitals', { id: uid('vit'), residentId: rid, at: Date.now(), ...vit, source: 'med pass' }, { quiet: true });
    for (const x of sel) {
      const c = counts[x.m.id];
      const late = isLateKey(x.key);
      await save('admins', mkAdmin(x.m, { scheduledFor: x.key, status: 'given', note, vitals: hasV ? vit : undefined, late: late || undefined, lateReason: (late || early) ? lateR : undefined, holdOverride: holds.includes(x) ? holdCheck(x.m, v).join('; ') : undefined, count: c, countDiscrepancy: c && c.expected != null && c.counted !== c.expected ? true : undefined }), { quiet: true });
      if (c && c.expected != null && c.counted !== c.expected) await save('notes', { id: uid('not'), residentId: rid, at: Date.now(), type: 'Incident', flagged: true, text: `Controlled count discrepancy — ${medLabel(x.m)}: expected ${c.expected}, counted ${c.counted}.` }, { quiet: true });
    }
    closeSheet(); toast(`✓ ${sel.length} dose${sel.length > 1 ? 's' : ''} signed`); render();
  };
};

const REASONS = {
  refused: ['Resident refused', 'Resident asleep — refused when woken', 'Spit out / unable to swallow', 'Other'],
  held: ['Hold parameter met (vitals)', 'Nurse / physician order to hold', 'NPO for procedure', 'Resident sick / vomiting', 'Other'],
  unavailable: ['Not delivered by pharmacy', 'Out of stock — reordered', 'Awaiting prior authorization', 'Other']
};
A.exception = (mid, key, status) => {
  const m = byId('meds', mid);
  const o = sheet({
    title: `${STATUS[status][0]} — ${esc(medLabel(m))}`,
    body: `<div class="small muted" style="margin-bottom:10px">Scheduled ${t12(key.slice(11))} · ${fDate(key.slice(0, 10))}</div>
    <label class="f"><span>Reason</span><select id="exR">${REASONS[status].map(r => `<option>${r}</option>`).join('')}</select></label>
    <label class="f"><span>Details / follow-up</span><textarea id="exN" placeholder="${status === 'refused' ? 'Reapproached at…, educated on…' : ''}"></textarea></label>
    <label class="f"><span>Who was notified?</span><select id="exNot"><option value="">—</option><option>Nurse</option><option>Physician</option><option>Pharmacy</option><option>Family/POA</option><option>Administrator</option></select></label>
    <label class="check"><input type="checkbox" id="exFlag" ${status !== 'refused' ? 'checked' : ''}> Flag for shift report</label>`,
    foot: `<button class="btn sec2" onclick="closeSheet()">Cancel</button><button class="btn warn" id="exGo">Save</button>`
  });
  $('#exGo', o).onclick = async () => {
    const reason = val('exR'), note = val('exN');
    if (reason === 'Other' && !note) return toast('Add details for "Other"');
    await save('admins', mkAdmin(m, { scheduledFor: key, status, reason, note, notified: val('exNot') || undefined }), { quiet: true });
    if (val('exFlag')) await save('notes', { id: uid('not'), residentId: m.residentId, at: Date.now(), type: 'Progress', flagged: true, text: `${STATUS[status][0]}: ${medLabel(m)} (${t12(key.slice(11))}) — ${reason}${note ? '. ' + note : ''}${val('exNot') ? '. Notified ' + val('exNot') + '.' : ''}` }, { quiet: true });
    closeSheet(); toast('Saved'); render();
  };
};

A.givePrn = mid => {
  const m = byId('meds', mid); const p = prnInfo(m); const r = byId('residents', m.residentId);
  const warn = p.maxed ? `Maximum of ${m.prnMaxPerDay} doses in 24 hours already reached.` : p.tooSoon ? `Too soon — minimum ${m.prnMinHours} h between doses. Next allowed at ${fTime(p.nextOk)}.` : '';
  const o = sheet({
    title: 'Give PRN',
    body: `<div class="b">${esc(medLabel(m))}</div><div class="small muted">${esc(medSig(m))}${m.indication ? ' · for ' + esc(m.indication) : ''}</div>${m.instructions ? `<div class="small" style="margin-top:4px">${esc(m.instructions)}</div>` : ''}
    <div class="allergy" style="margin:10px 0">${esc(rName(r))} · Allergies: ${esc(r.allergies || 'NKDA')}</div>
    <div class="small muted">Last given: ${p.last ? fDT(p.last.at) + ' by ' + esc(p.last.byName) : 'never'} · ${p.day} dose(s) in last 24 h</div>
    ${warn ? `<div class="alertbar critical" style="margin:8px 0">⛔ ${warn}</div><label class="f"><span>Override reason (nurse/physician approval)</span><input type="text" id="prO"></label>` : ''}
    <label class="f" style="margin-top:8px"><span>Reason given / symptoms (required)</span><textarea id="prR" placeholder="e.g. c/o headache 6/10"></textarea></label>
    <label class="f"><span>Pain before (0–10, if applicable)</span><input type="number" min="0" max="10" id="prP" inputmode="numeric"></label>
    ${m.controlled ? `<label class="f"><span>Count remaining after this dose (expected ${onHand(m) == null ? '—' : onHand(m) - (Number(m.unitsPerDose) || 1)})</span><input type="number" id="prC" inputmode="numeric"></label>` : ''}
    <div class="small muted">A follow-up on effectiveness will be due in ${settings().prnFollowUpMin || 60} minutes.</div>`,
    foot: `<button class="btn sec2" onclick="closeSheet()">Cancel</button><button class="btn ok" id="prGo">Sign — give PRN</button>`
  });
  $('#prGo', o).onclick = async () => {
    const reason = val('prR'); if (!reason) return toast('Enter the reason for the PRN');
    if (warn && !val('prO')) return toast('Enter an override reason or cancel');
    let count;
    if (m.controlled) { if (val('prC') === '') return toast('Enter the remaining count'); const exp = onHand(m) == null ? null : onHand(m) - (Number(m.unitsPerDose) || 1); count = { counted: num('prC'), expected: exp }; }
    const pain = num('prP');
    await save('admins', mkAdmin(m, { prn: true, status: 'given', prnReason: reason, painBefore: pain ?? undefined, override: val('prO') || undefined, followUpDue: Date.now() + (settings().prnFollowUpMin || 60) * 60000, count }), { quiet: true });
    if (pain != null) await save('vitals', { id: uid('vit'), residentId: m.residentId, at: Date.now(), pain, source: 'PRN' }, { quiet: true });
    closeSheet(); toast('✓ PRN documented'); render();
  };
};

A.followUps = () => {
  const fu = prnFollowUpsDue();
  sheet({ title: 'PRN follow-ups due', body: fu.length ? `<div class="list">${fu.map(a => `<button class="item" onclick="closeSheet();A.followUp('${a.id}')"><div class="grow"><div class="b">${esc(rName(byId('residents', a.residentId)))} · ${esc(a.medName)}</div><div class="small muted">Given ${fDT(a.at)} by ${esc(a.byName)} · for ${esc(a.prnReason || '')}</div></div><span class="chev">›</span></button>`).join('')}</div>` : '<div class="empty">All caught up.</div>' });
};
A.followUp = aid => {
  const a = byId('admins', aid);
  const o = sheet({
    title: 'PRN effectiveness',
    body: `<div class="b">${esc(rName(byId('residents', a.residentId)))} · ${esc(a.medName)}</div><div class="small muted" style="margin-bottom:10px">Given ${fDT(a.at)} for: ${esc(a.prnReason || '')}${a.painBefore != null ? ' · pain before ' + a.painBefore + '/10' : ''}</div>
    <div class="seg" id="fuSeg" style="margin-bottom:10px">${['Effective', 'Partially effective', 'Not effective'].map((t, i) => `<button class="${i === 0 ? 'on' : ''}" data-v="${t}">${t}</button>`).join('')}</div>
    <label class="f"><span>Pain after (0–10, optional)</span><input type="number" id="fuP" min="0" max="10"></label>
    <label class="f"><span>Notes</span><textarea id="fuN"></textarea></label>`,
    foot: `<button class="btn sec2" onclick="closeSheet()">Cancel</button><button class="btn" id="fuGo">Save follow-up</button>`
  });
  $$('#fuSeg button', o).forEach(b => b.onclick = () => { $$('#fuSeg button', o).forEach(x => x.classList.remove('on')); b.classList.add('on'); });
  $('#fuGo', o).onclick = async () => {
    const res = $('#fuSeg .on', o).dataset.v; const pa = num('fuP');
    await save('admins', { ...a, followUp: res + (pa != null ? ` (pain ${pa}/10)` : '') + (val('fuN') ? ' — ' + val('fuN') : ''), followUpAt: Date.now(), followUpBy: S.me.id, followUpByName: S.me.name }, { quiet: true });
    if (res === 'Not effective') await save('notes', { id: uid('not'), residentId: a.residentId, at: Date.now(), type: 'Change of condition', flagged: true, text: `PRN ${a.medName} not effective. ${val('fuN')}` }, { quiet: true });
    closeSheet(); toast('Follow-up saved'); render();
  };
};

A.adminDetail = aid => {
  const a = byId('admins', aid);
  const mine = a.by === S.me.id;
  const o = sheet({
    title: 'Administration record',
    body: `<table class="simple">${[['Medication', a.medName], ['Status', STATUS[a.status]?.[0] || a.status], ['Scheduled', a.scheduledFor ? fDT(new Date(a.scheduledFor).getTime()) : 'PRN'], ['Documented', fDT(a.at)], ['By', a.byName], ['Reason', a.reason || a.prnReason], ['Late reason', a.lateReason], ['Note', a.note], ['Vitals', a.vitals ? vitalsLine(a.vitals) : ''], ['Hold override', a.holdOverride], ['Count', a.count ? `${a.count.counted}${a.count.expected != null ? ' (expected ' + a.count.expected + ')' : ''}` : ''], ['Follow-up', a.followUp]].filter(x => x[1]).map(([k, v]) => `<tr><th>${k}</th><td>${esc(v)}</td></tr>`).join('')}</table>
    ${(mine || isNurse()) && !a.struck ? `<label class="f" style="margin-top:12px"><span>Entered in error? Give a reason to strike this entry</span><input type="text" id="stR"></label>` : ''}`,
    foot: (mine || isNurse()) && !a.struck ? `<button class="btn sec2" onclick="closeSheet()">Close</button><button class="btn bad" id="stGo">Strike entry</button>` : ''
  });
  const b = $('#stGo', o);
  if (b) b.onclick = async () => { if (!val('stR')) return toast('Reason required'); await save('admins', { ...a, struck: true, struckReason: val('stR'), struckBy: S.me.name, struckAt: Date.now() }, { quiet: true }); closeSheet(); toast('Entry struck — dose can be re-documented'); render(); };
};

A.taskLog = async (tid, date, shiftId, status, note) => {
  const t = byId('tasks', tid);
  await save('taskLogs', { id: uid('tl'), taskId: tid, residentId: t.residentId, taskName: t.name, date, shiftId, status, note, at: Date.now() }, { quiet: true });
  render();
};
A.taskLogNote = (tid, date, shiftId) => {
  const t = byId('tasks', tid);
  const o = sheet({ title: esc(t.name), body: `<div class="seg" id="tlSeg" style="margin-bottom:10px">${[['done', 'Done'], ['refused', 'Refused'], ['na', 'N/A']].map(([k, l], i) => `<button class="${i === 0 ? 'on' : ''}" data-v="${k}">${l}</button>`).join('')}</div><label class="f"><span>Note${t.category === 'Eating' ? ' (e.g. % of meal eaten)' : ''}</span><textarea id="tlN"></textarea></label>`, foot: `<button class="btn sec2" onclick="closeSheet()">Cancel</button><button class="btn" id="tlGo">Save</button>` });
  $$('#tlSeg button', o).forEach(b => b.onclick = () => { $$('#tlSeg button', o).forEach(x => x.classList.remove('on')); b.classList.add('on'); });
  $('#tlGo', o).onclick = async () => { const st = $('#tlSeg .on', o).dataset.v; if (st !== 'done' && !val('tlN')) return toast('Add a note'); closeSheet(); await A.taskLog(tid, date, shiftId, st, val('tlN')); };
};
A.taskAll = async (rid, date, shiftId) => {
  const r = byId('residents', rid);
  for (const t of tasksFor(r, date, shiftId)) if (!idx().tlog.has(`${t.id}|${date}|${shiftId}`)) await save('taskLogs', { id: uid('tl'), taskId: t.id, residentId: rid, taskName: t.name, date, shiftId, status: 'done', at: Date.now() }, { quiet: true });
  toast('All tasks done for ' + r.first); render();
};

/* ---- resident editing ---- */
function resizeImage(file, max = 256) {
  return new Promise(res => { const img = new Image(); img.onload = () => { const c = document.createElement('canvas'); const s = Math.min(1, max / Math.max(img.width, img.height)); c.width = img.width * s; c.height = img.height * s; c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); res(c.toDataURL('image/jpeg', .8)); }; img.src = URL.createObjectURL(file); });
}
A.editResident = rid => {
  const r = rid ? byId('residents', rid) : { status: 'active', careLevel: 1 };
  const I = (id, l, v, t = 'text', ex = '') => `<label class="f"><span>${l}</span><input type="${t}" id="${id}" value="${esc(v ?? '')}" ${ex}></label>`;
  let photo = r.photo || '';
  const o = sheet({
    title: rid ? 'Edit resident' : 'New resident',
    body: `<div class="row" style="margin-bottom:10px"><div class="av lg" id="erAv">${photo ? `<img src="${photo}">` : '📷'}</div><label class="btn sm sec2">Photo (for ID at med pass)<input type="file" accept="image/*" capture="user" hidden id="erPh"></label></div>
    <div class="grid g2">${I('erF', 'First name', r.first)}${I('erL', 'Last name', r.last)}${I('erRm', 'Room', r.room)}${I('erDob', 'Date of birth', r.dob, 'date')}</div>
    <label class="f"><span>Allergies</span><input type="text" id="erAl" value="${esc(r.allergies || '')}" placeholder="NKDA if none"></label>
    ${I('erDx', 'Diagnoses', r.diagnoses)}
    <div class="grid g2">${I('erDiet', 'Diet / texture', r.diet)}<label class="f"><span>Code status</span><select id="erCode">${['', 'Full code', 'DNR', 'DNR/DNI', 'POLST on file'].map(c => `<option ${r.codeStatus === c ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
    <label class="f"><span>Care level</span><select id="erLvl">${[1, 2, 3, 4].map(c => `<option ${String(r.careLevel) === String(c) ? 'selected' : ''}>${c}</option>`).join('')}</select></label>${I('erAdm', 'Admit date', r.admitDate, 'date')}
    ${I('erDoc', 'Physician', r.physician)}${I('erDocP', 'Physician phone', r.physicianPhone, 'tel')}${I('erPh2', 'Pharmacy', r.pharmacy)}${I('erPhP', 'Pharmacy phone', r.pharmacyPhone, 'tel')}${I('erCn', 'Emergency contact / POA', r.contactName)}${I('erCp', 'Contact phone', r.contactPhone, 'tel')}</div>
    <label class="f"><span>Notes</span><textarea id="erN">${esc(r.notes || '')}</textarea></label>`,
    foot: `<button class="btn sec2" onclick="closeSheet()">Cancel</button><button class="btn" id="erGo">Save</button>`
  });
  $('#erPh', o).onchange = async e => { if (e.target.files[0]) { photo = await resizeImage(e.target.files[0]); $('#erAv', o).innerHTML = `<img src="${photo}">`; } };
  $('#erGo', o).onclick = async () => {
    if (!val('erF') || !val('erL')) return toast('First and last name required');
    const rec = { ...r, first: val('erF'), last: val('erL'), room: val('erRm'), dob: val('erDob'), allergies: val('erAl'), diagnoses: val('erDx'), diet: val('erDiet'), codeStatus: val('erCode'), careLevel: Number(val('erLvl')), admitDate: val('erAdm'), physician: val('erDoc'), physicianPhone: val('erDocP'), pharmacy: val('erPh2'), pharmacyPhone: val('erPhP'), contactName: val('erCn'), contactPhone: val('erCp'), notes: val('erN'), photo };
    const s = await save('residents', rec, { quiet: true }); closeSheet();
    if (!rid) { resTab = 'meds'; go('resident/' + s.id); } else render();
  };
};
A.setStatus = rid => {
  const r = byId('residents', rid);
  const o = sheet({ title: 'Resident status', body: `<label class="f"><span>Status</span><select id="ssS">${[['active', 'In building'], ['loa', 'Leave of absence (LOA)'], ['hospital', 'Hospital'], ['discharged', 'Discharged / moved out']].map(([k, l]) => `<option value="${k}" ${(r.status || 'active') === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label><label class="f"><span>Note (where, why, expected return)</span><textarea id="ssN"></textarea></label>`, foot: `<button class="btn sec2" onclick="closeSheet()">Cancel</button><button class="btn" id="ssGo">Save</button>` });
  $('#ssGo', o).onclick = async () => {
    const st = val('ssS');
    await save('residents', { ...r, status: st }, { quiet: true });
    await save('notes', { id: uid('not'), residentId: rid, at: Date.now(), type: 'Change of condition', flagged: true, text: `Status changed to ${STATUS[st]?.[0] || (st === 'active' ? 'In building' : 'Discharged')}. ${val('ssN')}` }, { quiet: true });
    closeSheet(); render();
  };
};

/* ---- meds ---- */
const FREQ = { daily: ['08:00'], bid: ['08:00', '20:00'], tid: ['08:00', '14:00', '20:00'], qid: ['08:00', '12:00', '17:00', '20:00'], hs: ['20:00'], am: ['08:00'] };
A.editMed = (mid, rid) => {
  const m = mid ? byId('meds', mid) : { residentId: rid, times: ['08:00'], route: 'By mouth', form: 'tablet', start: ymd(), status: 'active', vitals: [], days: [], hold: {} };
  const r = byId('residents', m.residentId);
  const hp = m.hold || {};
  const I = (id, l, v, t = 'text', ex = '') => `<label class="f"><span>${l}</span><input type="${t}" id="${id}" value="${esc(v ?? '')}" ${ex}></label>`;
  const o = sheet({
    title: (mid ? 'Edit order' : 'New medication order') + ' · ' + esc(rName(r)),
    body: `<div class="grid g2">${I('emN', 'Medication name', m.name, 'text', 'placeholder="e.g. Lisinopril"')}${I('emS', 'Strength', m.strength, 'text', 'placeholder="10 mg"')}${I('emD', 'Dose', m.dose, 'text', 'placeholder="1 tablet"')}
    <label class="f"><span>Form</span><select id="emF">${['tablet', 'capsule', 'liquid', 'patch', 'inhaler', 'drops', 'cream', 'injection', 'suppository', 'powder', 'other'].map(x => `<option ${m.form === x ? 'selected' : ''}>${x}</option>`).join('')}</select></label>
    <label class="f"><span>Route</span><select id="emR">${['By mouth', 'Sublingual', 'Topical', 'Transdermal', 'Inhaled', 'Eye', 'Ear', 'Nasal', 'Subcutaneous', 'Rectal', 'G-tube', 'Other'].map(x => `<option ${m.route === x ? 'selected' : ''}>${x}</option>`).join('')}</select></label>
    ${I('emInd', 'Indication / used for', m.indication)}</div>
    ${I('emIns', 'Instructions', m.instructions, 'text', 'placeholder="Give with food, hold if…"')}
    <div class="seg" id="emType" style="margin:6px 0 12px"><button data-v="sched" class="${!m.prn ? 'on' : ''}">Scheduled</button><button data-v="prn" class="${m.prn ? 'on' : ''}">PRN (as needed)</button></div>
    <div id="emSched" class="${m.prn ? 'hidden' : ''}">
      <div class="small b muted" style="margin-bottom:4px">Quick frequency</div>
      <div class="chips" style="margin-bottom:8px">${[['daily', 'Daily'], ['bid', 'BID'], ['tid', 'TID'], ['qid', 'QID'], ['hs', 'Bedtime']].map(([k, l]) => `<button class="chip" data-f="${k}">${l}</button>`).join('')}</div>
      <label class="f"><span>Times (comma-separated, 24h)</span><input type="text" id="emT" value="${esc((m.times || []).join(', '))}" placeholder="08:00, 20:00"></label>
      <div class="small b muted" style="margin-bottom:4px">Days (leave all off = every day)</div>
      <div class="chips" id="emDays" style="margin-bottom:10px">${DOW.map((d, i) => `<button class="chip ${(m.days || []).includes(i) ? 'on' : ''}" data-d="${i}">${d}</button>`).join('')}</div>
    </div>
    <div id="emPrn" class="${m.prn ? '' : 'hidden'}"><div class="grid g2">${I('emMin', 'Minimum hours between doses', m.prnMinHours, 'number')}${I('emMax', 'Max doses per 24 h', m.prnMaxPerDay, 'number')}</div></div>
    <div class="grid g2">${I('emSt', 'Start date', m.start, 'date')}${I('emEn', 'Stop date (optional)', m.end, 'date')}${I('emRx', 'Rx #', m.rx)}${I('emPr', 'Prescriber', m.prescriber)}${I('emOH', 'On hand (qty)', m.onHand == null ? '' : onHand(m), 'number')}${I('emRA', 'Reorder when at or below', m.refillAt, 'number')}${I('emU', 'Units used per dose', m.unitsPerDose || 1, 'number')}
    <label class="f"><span>Crushable?</span><select id="emCr"><option value="">—</option><option value="yes" ${m.crush === 'yes' ? 'selected' : ''}>OK to crush</option><option value="no" ${m.crush === 'no' ? 'selected' : ''}>Do NOT crush</option></select></label></div>
    <label class="check"><input type="checkbox" id="emC" ${m.controlled ? 'checked' : ''}> Controlled substance (count on each dose &amp; shift count)</label>
    <div class="small b muted" style="margin:6px 0 4px">Check before giving</div>
    <div class="chips" id="emV" style="margin-bottom:10px">${[['bp', 'Blood pressure'], ['pulse', 'Pulse'], ['bs', 'Blood sugar'], ['o2', 'O₂ sat'], ['temp', 'Temp'], ['pain', 'Pain']].map(([k, l]) => `<button class="chip ${(m.vitals || []).includes(k) ? 'on' : ''}" data-v="${k}">${l}</button>`).join('')}</div>
    <div class="small b muted" style="margin-bottom:4px">Hold parameters (warns the med passer)</div>
    <div class="grid g2">${I('hpSb', 'Hold if systolic below', hp.sbpBelow, 'number')}${I('hpSa', 'Hold if systolic above', hp.sbpAbove, 'number')}${I('hpPb', 'Hold if pulse below', hp.pulseBelow, 'number')}${I('hpPa', 'Hold if pulse above', hp.pulseAbove, 'number')}${I('hpBb', 'Hold if blood sugar below', hp.bsBelow, 'number')}${I('hpBa', 'Hold if blood sugar above', hp.bsAbove, 'number')}</div>
    <label class="f"><span>Order status</span><select id="emStat"><option value="active" ${m.status !== 'hold' && m.status !== 'dc' ? 'selected' : ''}>Active</option><option value="hold" ${m.status === 'hold' ? 'selected' : ''}>On hold</option><option value="dc" ${m.status === 'dc' ? 'selected' : ''}>Discontinued</option></select></label>`,
    foot: `<button class="btn sec2" onclick="closeSheet()">Cancel</button><button class="btn" id="emGo">Save order</button>`
  });
  const tog = (sel) => $$(sel, o).forEach(b => b.onclick = () => b.classList.toggle('on'));
  tog('#emDays .chip'); tog('#emV .chip');
  $$('#emType button', o).forEach(b => b.onclick = () => { $$('#emType button', o).forEach(x => x.classList.remove('on')); b.classList.add('on'); $('#emSched', o).classList.toggle('hidden', b.dataset.v === 'prn'); $('#emPrn', o).classList.toggle('hidden', b.dataset.v !== 'prn'); });
  $$('[data-f]', o).forEach(b => b.onclick = () => { $('#emT', o).value = FREQ[b.dataset.f].join(', '); });
  $('#emGo', o).onclick = async () => {
    if (!val('emN')) return toast('Medication name required');
    const prn = $('#emType .on', o).dataset.v === 'prn';
    const times = val('emT').split(/[,\s]+/).filter(Boolean).map(t => { let [h, mi] = t.split(':'); h = Number(h); mi = Number(mi || 0); return isNaN(h) ? null : `${p2(h)}:${p2(mi)}`; }).filter(Boolean).sort();
    if (!prn && !times.length) return toast('Add at least one time');
    const oh = num('emOH');
    const ohChanged = oh != null && oh !== onHand(m);
    const rec = {
      ...m, name: val('emN'), strength: val('emS'), dose: val('emD'), form: val('emF'), route: val('emR'), indication: val('emInd'), instructions: val('emIns'),
      prn, times: prn ? [] : times, days: $$('#emDays .chip.on', o).map(b => Number(b.dataset.d)), prnMinHours: num('emMin'), prnMaxPerDay: num('emMax'),
      start: val('emSt'), end: val('emEn'), rx: val('emRx'), prescriber: val('emPr'), refillAt: num('emRA'), unitsPerDose: num('emU') || 1, crush: val('emCr'),
      controlled: val('emC'), vitals: $$('#emV .chip.on', o).map(b => b.dataset.v), status: val('emStat'),
      hold: { sbpBelow: num('hpSb'), sbpAbove: num('hpSa'), pulseBelow: num('hpPb'), pulseAbove: num('hpPa'), bsBelow: num('hpBb'), bsAbove: num('hpBa') }
    };
    if (ohChanged || (oh == null && m.onHand != null)) { rec.onHand = oh; rec.onHandAt = Date.now(); }
    await save('meds', rec, { quiet: true }); closeSheet(); toast('Order saved'); render();
  };
};
A.medDetail = mid => {
  const m = byId('meds', mid); const o2 = onHand(m);
  const hp = m.hold || {}; const hps = [hp.sbpBelow && `SBP<${hp.sbpBelow}`, hp.sbpAbove && `SBP>${hp.sbpAbove}`, hp.pulseBelow && `P<${hp.pulseBelow}`, hp.pulseAbove && `P>${hp.pulseAbove}`, hp.bsBelow && `BS<${hp.bsBelow}`, hp.bsAbove && `BS>${hp.bsAbove}`].filter(Boolean).join(', ');
  const hist = all('admins').filter(a => a.medId === mid).sort((a, b) => b.at - a.at).slice(0, 15);
  const o = sheet({
    title: esc(medLabel(m)),
    body: `<table class="simple">${[['Resident', rName(byId('residents', m.residentId))], ['Dose', medSig(m)], ['Schedule', m.prn ? `PRN${m.prnMinHours ? ' every ' + m.prnMinHours + ' h' : ''}${m.prnMaxPerDay ? ', max ' + m.prnMaxPerDay + '/24h' : ''}` : (m.times || []).map(t12).join(', ') + (m.days?.length ? ' · ' + m.days.map(d => DOW[d]).join('/') : '')], ['For', m.indication], ['Instructions', m.instructions], ['Check', (m.vitals || []).join(', ').toUpperCase()], ['Hold if', hps], ['Dates', `${fDate(m.start)}${m.end ? ' – ' + fDate(m.end) : ''}`], ['Rx / prescriber', [m.rx, m.prescriber].filter(Boolean).join(' · ')], ['On hand', o2 != null ? `${o2}${m.refillAt != null ? ' (reorder at ' + m.refillAt + ')' : ''}` : ''], ['Controlled', m.controlled ? 'Yes' : ''], ['Status', m.status === 'dc' ? 'Discontinued' : m.status === 'hold' ? 'On hold' : 'Active']].filter(x => x[1]).map(([k, v]) => `<tr><th style="width:36%">${k}</th><td>${esc(v)}</td></tr>`).join('')}</table>
    <div class="sec">Recent administrations</div>${hist.length ? hist.map(a => `<div class="small" style="padding:4px 0;border-bottom:1px solid var(--line);${a.struck ? 'text-decoration:line-through;opacity:.5' : ''}">${fDT(a.at)} · ${esc(STATUS[a.status]?.[0] || a.status)} · ${esc(a.byName)}${a.reason ? ' · ' + esc(a.reason) : ''}</div>`).join('') : '<div class="small muted">None yet</div>'}`,
    foot: isNurse() ? `<button class="btn sec2" id="mdRf">+ Receive refill</button><button class="btn" id="mdEd">Edit order</button>` : ''
  });
  if (isNurse()) {
    $('#mdEd', o).onclick = () => { closeSheet(); A.editMed(mid); };
    $('#mdRf', o).onclick = async () => {
      const q = prompt('Quantity received:'); if (!q || isNaN(q)) return;
      await save('meds', { ...m, onHand: (onHand(m) || 0) + Number(q), onHandAt: Date.now() }, { quiet: true });
      closeSheet(); toast(`Added ${q} to on-hand`); render();
    };
  }
};

/* ---- vitals & notes ---- */
A.addVitals = rid => {
  const rs = residentsActive();
  const F = (id, l, ex = '') => `<label class="f"><span>${l}</span><input type="number" inputmode="decimal" id="${id}" ${ex}></label>`;
  const o = sheet({
    title: 'Record vitals',
    body: `<label class="f"><span>Resident</span><select id="vR">${rs.map(r => `<option value="${r.id}" ${r.id === rid ? 'selected' : ''}>${esc(rName(r))} — Rm ${esc(r.room)}</option>`).join('')}</select></label>
    <div class="grid g2">${F('vS', 'BP systolic')}${F('vD', 'BP diastolic')}${F('vP', 'Pulse')}${F('vT', 'Temp °F', 'step="0.1"')}${F('vRr', 'Respirations')}${F('vO', 'O₂ sat %')}${F('vB', 'Blood sugar')}${F('vW', 'Weight (lb)', 'step="0.1"')}${F('vPn', 'Pain 0–10')}</div>`,
    foot: `<button class="btn sec2" onclick="closeSheet()">Cancel</button><button class="btn" id="vGo">Save</button>`
  });
  $('#vGo', o).onclick = async () => {
    const v = { bpSys: num('vS'), bpDia: num('vD'), pulse: num('vP'), temp: num('vT'), resp: num('vRr'), o2: num('vO'), bs: num('vB'), weight: num('vW'), pain: num('vPn') };
    Object.keys(v).forEach(k => v[k] == null && delete v[k]);
    if (!Object.keys(v).length) return toast('Enter at least one value');
    const flags = [];
    if (v.bpSys && (v.bpSys < 90 || v.bpSys > 180)) flags.push(`BP ${v.bpSys}/${v.bpDia || ''}`);
    if (v.pulse && (v.pulse < 50 || v.pulse > 120)) flags.push(`pulse ${v.pulse}`);
    if (v.temp && v.temp >= 100.4) flags.push(`temp ${v.temp}`);
    if (v.o2 && v.o2 < 90) flags.push(`O₂ ${v.o2}%`);
    if (v.bs && (v.bs < 70 || v.bs > 300)) flags.push(`BS ${v.bs}`);
    const residentId = val('vR');
    await save('vitals', { id: uid('vit'), residentId, at: Date.now(), ...v }, { quiet: true });
    if (flags.length) { await save('notes', { id: uid('not'), residentId, at: Date.now(), type: 'Change of condition', flagged: true, text: `Abnormal vitals: ${flags.join(', ')}. Nurse to be notified.` }, { quiet: true }); toast('⚠️ Abnormal vitals flagged for the nurse', 3500); } else toast('Vitals saved');
    closeSheet(); render();
  };
};
A.addNote = rid => {
  const rs = residentsActive();
  const o = sheet({
    title: 'New note',
    body: `<label class="f"><span>Resident</span><select id="nR"><option value="">— General / shift report —</option>${rs.map(r => `<option value="${r.id}" ${r.id === rid ? 'selected' : ''}>${esc(rName(r))} — Rm ${esc(r.room)}</option>`).join('')}</select></label>
    <label class="f"><span>Type</span><select id="nT">${['Shift report', 'Progress', 'Incident', 'Change of condition', 'Behavior', 'Family contact', 'Physician contact'].map(t => `<option ${t === (rid ? 'Progress' : 'Shift report') ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
    <label class="f"><span>Note</span><textarea id="nX" style="min-height:130px"></textarea></label>
    <label class="check"><input type="checkbox" id="nF"> 🚩 Flag for next shift</label>`,
    foot: `<button class="btn sec2" onclick="closeSheet()">Cancel</button><button class="btn" id="nGo">Save note</button>`
  });
  $('#nT', o).onchange = () => { if (['Incident', 'Change of condition'].includes(val('nT'))) $('#nF', o).checked = true; };
  $('#nGo', o).onclick = async () => { if (!val('nX')) return toast('Write the note'); await save('notes', { id: uid('not'), residentId: val('nR') || null, at: Date.now(), type: val('nT'), text: val('nX'), flagged: val('nF') }, { quiet: true }); closeSheet(); toast('Note saved'); render(); };
};

/* ---- alerts ---- */
A.editAlert = (aid, rid) => {
  const a = aid ? byId('alerts', aid) : { scope: rid ? 'resident' : 'all', residentId: rid, severity: 'warn', active: true };
  const o = sheet({
    title: aid ? 'Edit care alert' : 'New care alert',
    body: `<label class="f"><span>Applies to</span><select id="aS"><option value="all" ${a.scope === 'all' ? 'selected' : ''}>All residents</option><option value="careLevel" ${a.scope === 'careLevel' ? 'selected' : ''}>A care level</option><option value="resident" ${a.scope === 'resident' ? 'selected' : ''}>One resident</option></select></label>
    <label class="f" id="aRW"><span>Resident</span><select id="aR">${residentsAll().map(r => `<option value="${r.id}" ${r.id === a.residentId ? 'selected' : ''}>${esc(rName(r))}</option>`).join('')}</select></label>
    <label class="f" id="aLW"><span>Care level</span><select id="aL">${[1, 2, 3, 4].map(l => `<option ${String(a.careLevel) === String(l) ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    <label class="f"><span>Alert text</span><textarea id="aX" placeholder="e.g. Fall risk — 2-person assist for transfers">${esc(a.text || '')}</textarea></label>
    <div class="grid g2"><label class="f"><span>Severity</span><select id="aV">${[['info', 'Info'], ['warn', 'Caution'], ['critical', 'Critical']].map(([k, l]) => `<option value="${k}" ${a.severity === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label><label class="f"><span>Expires (optional)</span><input type="date" id="aE" value="${esc(a.expires || '')}"></label></div>
    <label class="check"><input type="checkbox" id="aA" ${a.active !== false ? 'checked' : ''}> Active</label>`,
    foot: `<button class="btn sec2" onclick="closeSheet()">Cancel</button><button class="btn" id="aGo">Save alert</button>`
  });
  const upd = () => { $('#aRW', o).classList.toggle('hidden', val('aS') !== 'resident'); $('#aLW', o).classList.toggle('hidden', val('aS') !== 'careLevel'); };
  $('#aS', o).onchange = upd; upd();
  $('#aGo', o).onclick = async () => { if (!val('aX')) return toast('Enter alert text'); await save('alerts', { ...a, scope: val('aS'), residentId: val('aS') === 'resident' ? val('aR') : null, careLevel: val('aS') === 'careLevel' ? val('aL') : null, text: val('aX'), severity: val('aV'), expires: val('aE'), active: val('aA') }, { quiet: true }); closeSheet(); render(); };
};

/* ---- care plan: tasks & assessment ---- */
const CATS = ['Bathing', 'Dressing', 'Grooming', 'Toileting', 'Continence', 'Mobility', 'Eating', 'Safety', 'Cognition', 'Behavior', 'Skin', 'Activities', 'Other'];
A.editTask = (tid, rid) => {
  const t = tid ? byId('tasks', tid) : { residentId: rid, shifts: [currentShift().id], days: [], category: 'Other', active: true };
  const o = sheet({
    title: tid ? 'Edit task' : 'New care task',
    body: `<label class="f"><span>Task</span><input type="text" id="tN" value="${esc(t.name || '')}" placeholder="e.g. Assist with shower"></label>
    <label class="f"><span>Category</span><select id="tC">${CATS.map(c => `<option ${t.category === c ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
    <label class="f"><span>Instructions</span><input type="text" id="tI" value="${esc(t.instructions || '')}"></label>
    <div class="small b muted" style="margin-bottom:4px">Shifts</div><div class="chips" id="tS" style="margin-bottom:10px">${(settings().shifts || []).map(s => `<button class="chip ${(t.shifts || []).includes(s.id) ? 'on' : ''}" data-s="${s.id}">${esc(s.name)}</button>`).join('')}</div>
    <div class="small b muted" style="margin-bottom:4px">Days (none = every day)</div><div class="chips" id="tD" style="margin-bottom:10px">${DOW.map((d, i) => `<button class="chip ${(t.days || []).includes(i) ? 'on' : ''}" data-d="${i}">${d}</button>`).join('')}</div>
    <label class="check"><input type="checkbox" id="tA" ${t.active !== false ? 'checked' : ''}> Active</label>`,
    foot: `<button class="btn sec2" onclick="closeSheet()">Cancel</button><button class="btn" id="tGo">Save</button>`
  });
  $$('#tS .chip,#tD .chip', o).forEach(b => b.onclick = () => b.classList.toggle('on'));
  $('#tGo', o).onclick = async () => {
    if (!val('tN')) return toast('Task name required');
    const shifts = $$('#tS .chip.on', o).map(b => b.dataset.s); if (!shifts.length) return toast('Pick at least one shift');
    await save('tasks', { ...t, name: val('tN'), category: val('tC'), instructions: val('tI'), shifts, days: $$('#tD .chip.on', o).map(b => Number(b.dataset.d)), active: val('tA') }, { quiet: true }); closeSheet(); render();
  };
};

const ASSESS = [
  ['bathing', 'Bathing', 'Bathing'], ['dressing', 'Dressing', 'Dressing'], ['grooming', 'Grooming / oral care', 'Grooming'],
  ['toileting', 'Toileting', 'Toileting'], ['continence', 'Continence', 'Continence'], ['mobility', 'Transfers / walking', 'Mobility'],
  ['eating', 'Eating', 'Eating'], ['meds', 'Medication management', 'Other'], ['cognition', 'Memory / orientation', 'Cognition'],
  ['behavior', 'Behaviors', 'Behavior'], ['night', 'Night-time needs', 'Safety']
];
const LEVELS = ['Indep.', 'Superv.', 'Assist', 'Total'];
function tasksFromAssessment(sc, fall, skin) {
  const D = 'day', E = 'eve', N = 'night', ALL = [D, E, N];
  const out = [];
  const add = (name, category, shifts, instructions = '', days = []) => out.push({ name, category, shifts, instructions, days });
  if (sc.bathing >= 1) add(sc.bathing >= 2 ? 'Assist with shower/bath' : 'Cue & supervise shower', 'Bathing', [D], sc.bathing === 3 ? 'Full assist — 2-person if needed' : '', [2, 5]);
  if (sc.dressing >= 1) add(sc.dressing >= 2 ? 'Assist with dressing (AM)' : 'Cue to dress (AM)', 'Dressing', [D]), add(sc.dressing >= 2 ? 'Assist with changing for bed' : 'Cue to change for bed', 'Dressing', [E]);
  if (sc.grooming >= 1) add('Oral care & grooming', 'Grooming', [D, E], sc.grooming >= 2 ? 'Hands-on assist' : 'Set up & cue');
  if (sc.toileting >= 1) add(sc.toileting >= 2 ? 'Toileting assist' : 'Toileting reminder', 'Toileting', ALL, sc.toileting >= 2 ? 'Every 2–3 hours and as needed' : '');
  if (sc.continence >= 1) add(sc.continence >= 2 ? 'Incontinence check & change' : 'Offer brief / check dryness', 'Continence', ALL, 'Document skin condition');
  if (sc.mobility >= 1) add(sc.mobility >= 2 ? 'Transfer/ambulation assist' : 'Stand-by assist when walking', 'Mobility', ALL, sc.mobility === 3 ? 'Mechanical lift / 2-person' : 'Use walker/gait belt as care plan states');
  if (sc.eating >= 1) add(sc.eating >= 2 ? 'Feeding assist — record % eaten' : 'Meal set-up & cueing — record % eaten', 'Eating', [D, E]);
  if (sc.meds >= 1) { /* covered by eMAR */ }
  if (sc.cognition >= 1) add(sc.cognition >= 2 ? 'Safety & whereabouts check every 2 hrs' : 'Orientation / reminders', 'Cognition', sc.cognition >= 2 ? ALL : [D, E]);
  if (sc.behavior >= 1) add('Behavior monitoring — document episodes', 'Behavior', ALL);
  if (sc.night >= 1) add(sc.night >= 2 ? 'Reposition every 2 hrs / night checks' : 'Night rounds check', 'Safety', [N]);
  if (fall) add('Fall-risk safety check (bed low, call light & walker in reach, non-skid socks)', 'Safety', ALL);
  if (skin) add('Skin check & pressure relief', 'Skin', [D, N]);
  add('Activity / social engagement offered', 'Activities', [D]);
  return out;
}
A.assessment = rid => {
  const r = byId('residents', rid);
  const prev = all('assessments').filter(a => a.residentId === rid).sort((a, b) => b.at - a.at)[0];
  const sc = { ...(prev?.scores || {}) };
  const o = sheet({
    title: 'Care assessment · ' + esc(rName(r)),
    body: `<div class="small muted" style="margin-bottom:6px">Score each area: Independent (0), Supervision/cueing (1), Limited assist (2), Extensive/total (3).</div>
    ${ASSESS.map(([k, l]) => `<div class="scoreRow"><span class="b small">${l}</span><div class="seg" data-k="${k}">${LEVELS.map((x, i) => `<button class="${(sc[k] || 0) === i ? 'on' : ''}" data-v="${i}">${x}</button>`).join('')}</div></div>`).join('')}
    <label class="check" style="margin-top:12px"><input type="checkbox" id="asF" ${prev?.fallRisk ? 'checked' : ''}> High fall risk / fall in last 90 days</label>
    <label class="check"><input type="checkbox" id="asSk" ${prev?.skinRisk ? 'checked' : ''}> Skin breakdown risk</label>
    <label class="f"><span>Notes</span><textarea id="asN"></textarea></label>
    <div class="card" style="background:var(--brandSoft)"><b>Score <span id="asT">0</span> → Care level <span id="asL">1</span></b><div class="small muted">Saving replaces this resident's auto-generated tasks with a new care plan. Tasks you added by hand are kept.</div></div>`,
    foot: `<button class="btn sec2" onclick="closeSheet()">Cancel</button><button class="btn" id="asGo">Save &amp; build care plan</button>`
  });
  const calc = () => { const t = Object.values(sc).reduce((s, v) => s + v, 0) + ($('#asF', o).checked ? 2 : 0); const l = t <= 6 ? 1 : t <= 14 ? 2 : t <= 22 ? 3 : 4; $('#asT', o).textContent = t; $('#asL', o).textContent = l; return [t, l]; };
  $$('.seg[data-k]', o).forEach(sg => $$('button', sg).forEach(b => b.onclick = () => { $$('button', sg).forEach(x => x.classList.remove('on')); b.classList.add('on'); sc[sg.dataset.k] = Number(b.dataset.v); calc(); }));
  $('#asF', o).onchange = calc; calc();
  $('#asGo', o).onclick = async () => {
    ASSESS.forEach(([k]) => { sc[k] = sc[k] || 0; });
    const [total, level] = calc();
    const as = await save('assessments', { id: uid('asm'), residentId: rid, at: Date.now(), scores: sc, fallRisk: val('asF'), skinRisk: val('asSk'), notes: val('asN'), total, careLevel: level }, { quiet: true });
    for (const t of all('tasks').filter(t => t.residentId === rid && t.auto)) await save('tasks', { ...t, _deleted: true, active: false }, { quiet: true, audit: false });
    for (const t of tasksFromAssessment(sc, val('asF'), val('asSk'))) await save('tasks', { id: uid('tsk'), residentId: rid, ...t, auto: true, assessmentId: as.id, active: true }, { quiet: true, audit: false });
    await save('residents', { ...r, careLevel: level }, { quiet: true });
    closeSheet(); toast(`Care plan built · level ${level}`); resTab = 'care'; render();
  };
};

/* ---- count ---- */
A.saveCount = async () => {
  const items = $$('.cnt').map(i => { const m = byId('meds', i.dataset.id); return { medId: m.id, name: medLabel(m) + ' — ' + rName(byId('residents', m.residentId)), expected: onHand(m), counted: i.value === '' ? null : Number(i.value) }; });
  if (items.some(i => i.counted == null)) return toast('Enter a count for every item');
  const wid = val('cWit'); if (!wid) return toast('Select a witness');
  const w = byId('staff', wid);
  const discrepancy = items.some(i => i.expected != null && i.counted !== i.expected);
  await save('counts', { id: uid('cnt'), at: Date.now(), shiftId: currentShift().id, items, witness: wid, witnessName: w?.name, discrepancy }, { quiet: true });
  if (discrepancy) await save('notes', { id: uid('not'), at: Date.now(), type: 'Incident', flagged: true, text: 'Controlled-drug count discrepancy: ' + items.filter(i => i.expected != null && i.counted !== i.expected).map(i => `${i.name} expected ${i.expected}, counted ${i.counted}`).join('; ') }, { quiet: true });
  toast(discrepancy ? '⚠️ Discrepancy recorded & flagged' : '✓ Count saved'); render();
};

/* ---- staff & settings ---- */
A.editStaff = sid => {
  const s = sid ? byId('staff', sid) : { role: 'Caregiver', active: true };
  const o = sheet({
    title: sid ? 'Edit staff' : 'New staff member',
    body: `<label class="f"><span>Full name</span><input type="text" id="sN" value="${esc(s.name || '')}"></label>
    <div class="grid g2"><label class="f"><span>Initials (MAR signature)</span><input type="text" id="sI" maxlength="4" value="${esc(s.initials || '')}"></label>
    <label class="f"><span>Role</span><select id="sR">${ROLES.map(r => `<option ${s.role === r ? 'selected' : ''}>${r}</option>`).join('')}</select></label></div>
    <label class="f"><span>${sid ? 'New PIN (leave blank to keep)' : 'PIN (4–8 digits, unique)'}</span><input type="password" inputmode="numeric" id="sP" maxlength="8"></label>
    <label class="check"><input type="checkbox" id="sA" ${s.active !== false ? 'checked' : ''}> Active (can sign in)</label>`,
    foot: `<button class="btn sec2" onclick="closeSheet()">Cancel</button><button class="btn" id="sGo">Save</button>`
  });
  $('#sGo', o).onclick = async () => {
    const pin = val('sP');
    if (!val('sN')) return toast('Name required');
    if (pin && !/^\d{4,8}$/.test(pin)) return toast('PIN must be 4–8 digits');
    if (!sid && !pin) return toast('PIN required');
    if (sid === S.me.id && (val('sR') !== 'Admin' || !val('sA'))) return toast("You can't remove your own admin access");
    const rec = { ...s, name: val('sN'), initials: (val('sI') || initials(val('sN'))).toUpperCase(), role: val('sR'), active: val('sA') };
    if (pin) rec.pin = pin;
    const r = await save('staff', rec, { quiet: true }); if (r) { closeSheet(); toast('Saved'); render(); }
  };
};
A.saveSettings = async () => {
  const st = settings();
  const passTimes = $$('#stPts .row').map(r => ({ label: $('.ptL', r).value.trim(), time: $('.ptT', r).value })).filter(p => p.label && p.time).sort((a, b) => a.time.localeCompare(b.time));
  const shifts = $$('.shN').map(i => ({ id: i.dataset.id, name: i.value.trim() || i.dataset.id, start: i.parentNode.querySelector('.shS').value, end: i.parentNode.querySelector('.shE').value }));
  const name = val('stName') || 'BLTC';
  await save('settings', { ...st, id: 'facility', name, passWindowMin: num('stWin') || 60, prnFollowUpMin: num('stFu') || 60, lockMin: num('stLock') || 15, passTimes, shifts }, { quiet: true });
  S.facility = name; saveCache();
  if (S.mode === 'cloud') { try { await api('facility', 'PUT', { name }); } catch { } }
  toast('Settings saved'); render();
};
A.exportAll = () => {
  const data = { ...S.data, staff: S.data.staff.map(s => { const c = { ...s }; if (S.mode === 'cloud') delete c.pinHash; return c; }) };
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify({ facility: S.facility, exportedAt: new Date().toISOString(), mode: S.mode, data }, null, 1)], { type: 'application/json' })); a.download = `bltc-backup-${ymd()}.json`; a.click();
};
A.importAll = async file => {
  if (!file) return;
  try {
    const j = JSON.parse(await file.text());
    if (!j.data) throw new Error('Not a BLTC backup');
    if (!await confirmBox('Replace all data on this device with the backup?', 'Restore')) return;
    for (const c of COLS) S.data[c] = j.data[c] || [];
    S.facility = j.facility || S.facility; S.ver++; saveCache(); toast('Restored'); lock();
  } catch (e) { toast('Restore failed: ' + e.message); }
};
A.demo = async () => {
  if (!await confirmBox('Add 3 sample (fake) residents with medications for training?', 'Add samples')) return;
  const mk = async (r, meds) => { const res = await save('residents', { id: uid('res'), status: 'active', ...r }, { quiet: true }); for (const m of meds) await save('meds', { id: uid('med'), residentId: res.id, status: 'active', start: ymd(), route: 'By mouth', form: 'tablet', days: [], vitals: [], hold: {}, unitsPerDose: 1, onHandAt: Date.now(), ...m }, { quiet: true }); return res; };
  await mk({ first: 'Sample', last: 'Resident A', room: '101', dob: '1938-04-12', allergies: 'Penicillin', diet: 'Regular', codeStatus: 'DNR', careLevel: 2, physician: 'Dr. Example' }, [
    { name: 'Lisinopril', strength: '10 mg', dose: '1 tablet', times: ['08:00'], indication: 'Blood pressure', vitals: ['bp'], hold: { sbpBelow: 100 }, onHand: 30, refillAt: 7 },
    { name: 'Metformin', strength: '500 mg', dose: '1 tablet', times: ['08:00', '17:00'], indication: 'Diabetes', instructions: 'Give with meals', onHand: 60, refillAt: 14 },
    { name: 'Acetaminophen', strength: '500 mg', dose: '2 tablets', prn: true, times: [], prnMinHours: 6, prnMaxPerDay: 4, indication: 'Pain / fever' }]);
  await mk({ first: 'Sample', last: 'Resident B', room: '102', dob: '1945-09-30', allergies: '', diet: 'Mechanical soft', codeStatus: 'Full code', careLevel: 3 }, [
    { name: 'Donepezil', strength: '10 mg', dose: '1 tablet', times: ['20:00'], indication: 'Memory' },
    { name: 'Hydrocodone/APAP', strength: '5/325 mg', dose: '1 tablet', prn: true, times: [], prnMinHours: 6, prnMaxPerDay: 3, controlled: true, onHand: 20, refillAt: 5, indication: 'Moderate pain' }]);
  await mk({ first: 'Sample', last: 'Resident C', room: '103', dob: '1941-01-22', allergies: 'Sulfa, latex', diet: 'Diabetic', codeStatus: 'Full code', careLevel: 1 }, [
    { name: 'Levothyroxine', strength: '50 mcg', dose: '1 tablet', times: ['06:00'], instructions: 'Empty stomach, 30 min before breakfast' },
    { name: 'Metoprolol', strength: '25 mg', dose: '1 tablet', times: ['08:00', '20:00'], vitals: ['bp', 'pulse'], hold: { sbpBelow: 100, pulseBelow: 55 }, crush: 'no' }]);
  toast('Sample residents added'); go('pass');
};

/* ---------------- boot ---------------- */
let started = false;
function start() {
  $('#app').innerHTML = '';
  if (!location.hash) location.hash = '#/home';
  render();
  if (!started) {
    started = true;
    setInterval(() => sync(), 20000);
    setInterval(() => { if (S.me) softRender(); }, 60000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) sync(true); });
    window.addEventListener('online', () => sync(true));
  }
  sync(true);
}
(async function boot() {
  try {
    const r = await fetch('/api/status', { cache: 'no-store' });
    const j = r.ok ? await r.json() : null;
    if (j && j.mode === 'cloud') { S.mode = 'cloud'; S.setup = j.setup; S.facility = j.facility; }
    else throw 0;
  } catch {
    // offline or not on the Worker: use cloud cache if we have a token, else device mode
    if (LS.get('bltc_token', null) && LS.get('bltc_cloud_cache', null)) { S.mode = 'cloud'; S.online = false; }
    else S.mode = 'local';
  }
  loadCache();
  if (S.mode === 'local') S.setup = all('staff').length > 0;
  S.token = S.mode === 'cloud' ? LS.get('bltc_token', null) : null;
  if (S.mode === 'cloud' && S.token) {
    try { const r = await api('sync?since=' + Date.now()); S.me = r.me; } catch (e) { if (e.status === 401) S.token = null; else { S.me = LS.get('bltc_me', null); } }
    if (S.me) { LS.set('bltc_me', S.me); return start(); }
  }
  renderLogin();
})();

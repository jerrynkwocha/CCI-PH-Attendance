// store.js — client data layer (Stage 1).
// The UI imports only createStore(). To move to Supabase later, write another class
// with the same methods and change the one line in createStore().
//
// Interface: login(code,pin,usher) · start(date) · stop() · subscribe(fn) · view()
//   checkIn({teenId | teenRefOpId, branchId, serviceId, date}) → {opId, guardianCode, done}
//   checkOut(row,{note,code,skipCode}) · checkOutAll({serviceId,date})
//   undoCheckIn(row) · undoCheckOut(row) · addTeen(teen) → {opId, done}
//   admin(action, params)   (online only: saveTeen, saveBranch, saveService, setSecrets, attendanceRange, bulkAdd)
// subscribe(fn) calls fn(view, status) where status is 'saved' | 'syncing' | 'offline'.

const K = { auth: 'att.auth', cache: 'att.cache', queue: 'att.queue' };
const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(16).slice(2));
const code4 = () => String(crypto.getRandomValues(new Uint32Array(1))[0] % 10000).padStart(4, '0');
const RETRY = new Set(['network', 'server_error', 'busy']);
const EMPTY = { teens: [], branches: [], services: [], attendance: [], rev: null, role: null, teamCode: null, date: null };

export const todayStr = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export const ageOf = t => {
  const m = String(t.dob || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) { const n = new Date(); let a = n.getFullYear() - +m[1]; if (n.getMonth() + 1 < +m[2] || (n.getMonth() + 1 === +m[2] && n.getDate() < +m[3])) a--; return a; }
  return t.age && !isNaN(+t.age) ? +t.age : NaN;
};

export const HOME = 'Home campus'; // label for a teen's default campus (change here to rename everywhere)
export const svcBranches = s => String(s.branchId || '').replace(/[\[\]]/g, '').split(/[;,]/).map(x => x.trim()).filter(Boolean);
export const svcAt = (s, branchId) => { const b = svcBranches(s); return !b.length || b.includes(branchId); };

export const createStore = cfg => new AppsScriptStore(cfg.url, cfg);

class AppsScriptStore {
  constructor(url, { pollMs = 4000, onError } = {}) {
    this.url = url; this.pollMs = pollMs; this.onError = onError;
    this.auth = load(K.auth, {});            // {code, pin, usher}
    this.cache = load(K.cache, EMPTY);       // last server snapshot, used for instant search
    this.queue = load(K.queue, []);          // offline-safe write queue
    this.listeners = new Set(); this.waiters = new Map();
    this.status = 'saved'; this.busy = false; this.locked = false; this.netFail = false; this.date = null;
    addEventListener('online', () => { this.flush(); this.refresh(); });
    addEventListener('offline', () => this._status());
    document.addEventListener('visibilitychange', () => { if (!document.hidden) this.refresh(); });
  }

  /* --- plumbing --- */
  async _call(body) {
    let res;
    try {
      // text/plain avoids a CORS preflight, which Apps Script cannot answer
      res = await fetch(this.url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ ...this.auth, ...body }) });
      res = await res.json();
    } catch { this.netFail = true; throw Object.assign(new Error('Network error'), { code: 'network' }); }
    this.netFail = false;
    if (!res.ok) throw Object.assign(new Error(res.message), { code: res.error });
    return res.data;
  }
  subscribe(fn) { this.listeners.add(fn); fn(this.view(), this.status); return () => this.listeners.delete(fn); }
  _status() {
    this.status = !navigator.onLine || this.netFail ? 'offline' : (this.queue.length || this.busy ? 'syncing' : 'saved');
    this.listeners.forEach(f => f(this.view(), this.status));
  }

  /* --- session + polling --- */
  async login(code, pin, usher) {
    const prev = this.auth; this.auth = { code, pin, usher };
    try { await this.refresh(true, true); } catch (e) { this.auth = prev; throw e; }
    this.locked = false; save(K.auth, this.auth); this.flush();
  }
  start(date) {
    this.date = date; this.refresh(true); this.flush();
    clearInterval(this.timer);
    this.timer = setInterval(() => { if (!document.hidden) this.flush().then(() => this.refresh()); }, this.pollMs);
  }
  stop() { clearInterval(this.timer); }
  async refresh(force = false, strict = false) {
    if (!this.auth.code && !this.auth.pin) return;
    try {
      const sameDay = this.cache.date === this.date;
      const d = await this._call({ action: 'state', date: this.date, rev: force || !sameDay ? null : this.cache.rev });
      if (d.unchanged) this.cache.role = d.role;
      else { this.cache = { ...d, date: this.date }; }
      save(K.cache, this.cache);
    } catch (e) {
      if (strict) throw e;
      if (e.code === 'unauthorized') this.locked = true;
    }
    this._status();
  }

  /* --- writes: queued first (instant UI), then synced in order --- */
  dispatch(action, params = {}) {
    const op = { opId: uid(), action, params, at: new Date().toISOString() };
    if (action === 'checkIn') op.params.guardianCode = code4(); // shown immediately, even offline
    this.queue.push(op); save(K.queue, this.queue);
    const done = new Promise((ok, err) => this.waiters.set(op.opId, { ok, err }));
    done.catch(() => {});
    this.flush(); this._status();
    return { opId: op.opId, guardianCode: op.params.guardianCode, done };
  }
  async flush() {
    if (this.busy || this.locked) return;
    this.busy = true; this._status();
    while (this.queue.length) {
      const op = this.queue[0], w = this.waiters.get(op.opId);
      try {
        const res = await this._call({ action: op.action, opId: op.opId, at: op.at, by: this.auth.usher || '', ...op.params });
        this._apply(op, res); this.queue.shift(); save(K.queue, this.queue); w?.ok(res); this.waiters.delete(op.opId);
      } catch (e) {
        if (e.code === 'unauthorized') { this.locked = true; break; }   // keep ops; resume after re-login
        if (RETRY.has(e.code)) break;                                    // keep ops; retry when online
        this.queue.shift(); save(K.queue, this.queue);                   // business error (e.g. duplicate): drop and report
        w?.err(e); this.waiters.delete(op.opId); this.onError?.(op, e);
      }
    }
    this.busy = false; this._status();
    if (this.queue.length && !this.locked) setTimeout(() => this.flush(), 5000);
  }
  _apply(op, res) { // merge the server's answer so the UI never flickers between "queued" and "synced"
    const c = this.cache;
    const up = (list, rec) => { const i = list.findIndex(x => x.id === rec.id || (rec.opId && x.opId === rec.opId)); i < 0 ? list.push(rec) : (list[i] = rec); };
    if (res.record) {
      if (op.action === 'undoCheckIn') c.attendance = c.attendance.filter(r => r.id !== res.record.id);
      else up(c.attendance, res.record);
    }
    if (res.teen) up(c.teens, res.teen);
    save(K.cache, c);
  }

  checkIn(p) { return this.dispatch('checkIn', p); }
  checkOut(row, o = {}) { return this.dispatch('checkOut', { ...this._ref(row), note: o.note || '', code: o.code || '', skipCode: !!o.skipCode }); }
  checkOutAll(p) { return this.dispatch('checkOutAll', p); }
  undoCheckIn(row) { return this.dispatch('undoCheckIn', this._ref(row)); }
  undoCheckOut(row) { return this.dispatch('undoCheckOut', this._ref(row)); }
  addTeen(teen) { return this.dispatch('addTeen', { teen }); }
  _ref(row) { return { id: String(row.id).startsWith('tmp_') ? undefined : row.id, refOpId: row.opId }; }

  read(action, params = {}) { return this._call({ action, ...params }); } // online reads/writes that skip the queue
  async admin(action, params = {}) {
    const d = await this._call({ action, ...params });
    this.refresh(true);
    return d;
  }

  /* --- what the UI renders: server snapshot + not-yet-synced ops --- */
  view() {
    const c = this.cache, teens = c.teens.slice(); let att = c.attendance.map(r => ({ ...r }));
    const find = p => att.find(r => (p.id && r.id === p.id) || (p.refOpId && r.opId === p.refOpId));
    for (const { action, params: p, opId, at } of this.queue) {
      if (action === 'addTeen') teens.push({ ...p.teen, id: 'tmp_' + opId, opId, status: 'active', pending: true });
      if (action === 'checkIn' && !att.some(r => r.opId === opId))
        att.push({ id: 'tmp_' + opId, opId, teenId: p.teenId || 'tmp_' + p.teenRefOpId, branchId: p.branchId, serviceId: p.serviceId, date: p.date, checkIn: at, checkOut: '', guardianCode: p.guardianCode, status: 'in', pending: true });
      if (action === 'checkOut') { const r = find(p); if (r) Object.assign(r, { checkOut: at, checkoutNote: p.note, pending: true }); }
      if (action === 'undoCheckOut') { const r = find(p); if (r) Object.assign(r, { checkOut: '', pending: true }); }
      if (action === 'undoCheckIn') { const r = find(p); att = att.filter(x => x !== r); }
      if (action === 'checkOutAll') att.forEach(r => { if (r.serviceId === p.serviceId && r.date === p.date && !r.checkOut) { r.checkOut = at; r.pending = true; } });
    }
    return { ...c, teens, attendance: att, queued: this.queue.length };
  }
}

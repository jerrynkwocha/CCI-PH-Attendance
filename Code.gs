/**
 * Church Attendance backend (Stage 1) — Google Apps Script web app.
 * Setup: Sheet > Extensions > Apps Script > paste this > run setup() once >
 * Deploy > New deployment > Web app (Execute as: Me, Access: Anyone).
 * The browser only ever talks to this script, never to the Sheet.
 */
const SCHEMA = {
  Teenagers: ['id','fullName','gender','age','dob','phone','guardianName','guardianPhone','homeBranchId','medicalNotes','dateAdded','status','opId','firstTimer'],
  Branches:  ['id','name','location'],
  Services:  ['id','name','day','time','branchId'],
  Attendance:['id','teenId','branchId','serviceId','date','checkIn','checkOut','checkoutNote','guardianCode','checkedInBy','checkedOutBy','codeCheck','status','opId']
};
const TEEN_EDIT = ['fullName','gender','age','dob','phone','guardianName','guardianPhone','homeBranchId','medicalNotes','status','firstTimer'];
const ADMIN_ONLY = ['guardianPhone','medicalNotes'];

function setup() {
  const ss = SpreadsheetApp.getActive();
  Object.keys(SCHEMA).forEach(name => {
    const sh = ss.getSheetByName(name) || ss.insertSheet(name), h = SCHEMA[name];
    sh.getRange(1, 1, 1, h.length).setValues([h]).setFontWeight('bold');
    sh.setFrozenRows(1);
    sh.getRange(2, 1, sh.getMaxRows() - 1, h.length).setNumberFormat('@'); // keep phones/dates/codes as typed
  });
  const p = PropertiesService.getScriptProperties();
  if (!p.getProperty('TEAM_CODE')) p.setProperty('TEAM_CODE', 'change-me');
  if (!p.getProperty('ADMIN_PIN')) p.setProperty('ADMIN_PIN', '0000');
  if (!p.getProperty('REV')) p.setProperty('REV', String(Date.now()));
}

/* ---------- HTTP entry ---------- */
function doGet() { return json_({ ok: true, service: 'attendance' }); }
function doPost(e) {
  try {
    const p = JSON.parse(e.postData.contents);
    return json_({ ok: true, data: route_(p, role_(p)) });
  } catch (err) {
    return json_({ ok: false, error: err.code || 'server_error', message: String(err.message || err) });
  }
}
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function fail_(code, msg) { const e = new Error(msg || code); e.code = code; return e; }

function role_(p) {
  const pr = PropertiesService.getScriptProperties();
  if (p.pin && p.pin === pr.getProperty('ADMIN_PIN')) return 'admin';
  if (p.code && p.code === pr.getProperty('TEAM_CODE')) return 'team';
  throw fail_('unauthorized', 'Wrong access code');
}

const ROUTES = { // [handler, adminOnly]
  state: [state_, false], checkIn: [checkIn_, false], checkOut: [checkOut_, false], checkOutAll: [checkOutAll_, false],
  undoCheckIn: [undoCheckIn_, false], undoCheckOut: [undoCheckOut_, false], addTeen: [addTeen_, false],
  saveTeen: [saveTeen_, true], saveBranch: [p => saveSimple_('Branches', ['name','location'], 'b', p.item), true],
  saveService: [p => saveSimple_('Services', ['name','day','time','branchId'], 's', p.item), true],
  setSecrets: [setSecrets_, true], attendanceRange: [attendanceRange_, false], bulkAdd: [bulkAdd_, true], readSheet: [readSheet_, true]
};
function route_(p, role) {
  const r = ROUTES[p.action];
  if (!r) throw fail_('bad_action');
  if (r[1] && role !== 'admin') throw fail_('admin_only', 'Admin PIN required');
  return r[0](p, role);
}

/* ---------- Sheet helpers ---------- */
function tbl_(name) {
  const sh = SpreadsheetApp.getActive().getSheetByName(name), cols = SCHEMA[name];
  const row = o => cols.map(c => o[c] == null ? '' : String(o[c]));
  return {
    all() {
      const n = sh.getLastRow() - 1;
      if (n < 1) return [];
      return sh.getRange(2, 1, n, cols.length).getValues().map((v, i) => {
        const o = { _row: i + 2 }; cols.forEach((c, j) => o[c] = String(v[j])); return o;
      });
    },
    add(o) { const r = sh.getLastRow() + 1; sh.getRange(r, 1, 1, cols.length).setNumberFormat('@').setValues([row(o)]); o._row = r; },
    addMany(list) { if (list.length) sh.getRange(sh.getLastRow() + 1, 1, list.length, cols.length).setNumberFormat('@').setValues(list.map(row)); },
    set(o) { sh.getRange(o._row, 1, 1, cols.length).setValues([row(o)]); }
  };
}
const strip_ = o => { const c = Object.assign({}, o); delete c._row; return c; };
const pubTeen_ = (t, role) => { const o = strip_(t); if (role !== 'admin') ADMIN_ONLY.forEach(f => delete o[f]); return o; };
const pubAtt_ = (a, role) => { const o = strip_(a); if (role !== 'admin') delete o.guardianCode; return o; };
const newId_ = prefix => prefix + '_' + Utilities.getUuid().replace(/-/g, '').slice(0, 10);
const today_ = () => Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
const time_ = at => { const now = Date.now(), t = at ? Date.parse(at) : NaN; return new Date(isNaN(t) || t > now + 300000 ? now : t).toISOString(); };
function pick_(src) { const o = {}; TEEN_EDIT.forEach(k => { if (src[k] != null) o[k] = String(src[k]).trim(); }); return o; }

// All writes go through here: one writer at a time, then bump the revision so polling clients refresh.
function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    const r = fn();
    PropertiesService.getScriptProperties().setProperty('REV', String(Date.now()));
    return r;
  } finally { lock.releaseLock(); }
}

/* ---------- Reads ---------- */
function state_(p, role) {
  const pr = PropertiesService.getScriptProperties(), rev = pr.getProperty('REV');
  if (p.rev && p.rev === rev) return { rev, role, unchanged: true };
  return {
    rev, role,
    teamCode: role === 'admin' ? pr.getProperty('TEAM_CODE') : null,
    teens: tbl_('Teenagers').all().filter(t => role === 'admin' || t.status !== 'archived').map(t => pubTeen_(t, role)),
    attendance: tbl_('Attendance').all().filter(r => r.date === p.date && r.status !== 'void').map(r => pubAtt_(r, role)),
    branches: tbl_('Branches').all().map(strip_),
    services: tbl_('Services').all().map(strip_)
  };
}
function attendanceRange_(p) {
  return { attendance: tbl_('Attendance').all().filter(r => r.status !== 'void' && r.date >= p.from && r.date <= p.to && (!p.teenId || r.teenId === p.teenId)).map(r => p.slim ? { id: r.id, teenId: r.teenId, branchId: r.branchId, serviceId: r.serviceId, date: r.date, checkIn: r.checkIn, checkOut: r.checkOut, by: r.checkedInBy } : pubAtt_(r, 'team')) };
}

/* ---------- Attendance writes (append-only; opId makes retries safe) ---------- */
function find_(rows, p) {
  const r = rows.find(x => (p.id && x.id === p.id) || (p.refOpId && x.opId === p.refOpId));
  if (!r) throw fail_('not_found', 'Record not found');
  return r;
}
function checkIn_(p) {
  return withLock_(() => {
    if (!p.opId) throw fail_('missing_field', 'opId required');
    const A = tbl_('Attendance'), rows = A.all();
    const replay = rows.find(r => r.opId === p.opId);
    if (replay) return { record: pubAtt_(replay, 'admin'), replayed: true };
    const teen = tbl_('Teenagers').all().find(t => t.status !== 'archived' && ((p.teenId && t.id === p.teenId) || (p.teenRefOpId && t.opId === p.teenRefOpId)));
    if (!teen) throw fail_('no_teen', 'Teen not found');
    if (rows.some(r => r.teenId === teen.id && r.serviceId === p.serviceId && r.date === p.date && r.status !== 'void'))
      throw fail_('duplicate', 'Already checked in for this service');
    // Code is generated on the device so it can show offline; codes only need to match their own row.
    const code = /^\d{4}$/.test(p.guardianCode || '') ? p.guardianCode : String(Math.floor(Math.random() * 10000)).padStart(4, '0');
    const rec = { id: newId_('att'), teenId: teen.id, branchId: p.branchId, serviceId: p.serviceId, date: p.date, checkIn: time_(p.at),
      checkOut: '', checkoutNote: '', guardianCode: code, checkedInBy: p.by || '', checkedOutBy: '', codeCheck: '', status: 'in', opId: p.opId };
    A.add(rec);
    return { record: pubAtt_(rec, 'admin') };
  });
}
function checkOut_(p) {
  return withLock_(() => {
    const A = tbl_('Attendance'), r = find_(A.all(), p);
    if (r.status === 'void') throw fail_('voided', 'This check-in was undone');
    if (r.checkOut) return { record: pubAtt_(r, 'admin'), replayed: true };
    if (!p.skipCode && r.guardianCode && String(p.code || '') !== r.guardianCode) throw fail_('bad_code', 'Code does not match');
    Object.assign(r, { checkOut: time_(p.at), checkoutNote: p.note || '', checkedOutBy: p.by || '', codeCheck: p.skipCode ? 'skipped' : 'verified' });
    A.set(r);
    return { record: pubAtt_(r, 'admin') };
  });
}
function checkOutAll_(p) {
  return withLock_(() => {
    const A = tbl_('Attendance'), t = time_(p.at); let n = 0;
    A.all().filter(r => r.serviceId === p.serviceId && r.date === p.date && (!p.branchId || r.branchId === p.branchId) && r.status !== 'void' && !r.checkOut).forEach(r => {
      Object.assign(r, { checkOut: t, checkoutNote: 'Bulk check-out', checkedOutBy: p.by || '', codeCheck: 'bulk' });
      A.set(r); n++;
    });
    return { count: n };
  });
}
function undoCheckIn_(p) {
  return withLock_(() => {
    const A = tbl_('Attendance'), r = find_(A.all(), p);
    r.status = 'void'; A.set(r);
    return { record: pubAtt_(r, 'admin') };
  });
}
function undoCheckOut_(p) {
  return withLock_(() => {
    const A = tbl_('Attendance'), r = find_(A.all(), p);
    Object.assign(r, { checkOut: '', checkoutNote: '', checkedOutBy: '', codeCheck: '' }); A.set(r);
    return { record: pubAtt_(r, 'admin') };
  });
}

/* ---------- Teens ---------- */
function addTeen_(p, role) { // quick-add; allowed for the team
  return withLock_(() => {
    const T = tbl_('Teenagers'), t0 = p.teen || {};
    const hit = p.opId && T.all().find(t => t.opId === p.opId);
    if (hit) return { teen: pubTeen_(hit, role), replayed: true };
    ['fullName', 'gender', 'phone'].forEach(k => { if (!String(t0[k] || '').trim()) throw fail_('missing_field', k + ' is required'); });
    if (!String(t0.age || '').trim() && !String(t0.dob || '').trim()) throw fail_('missing_field', 'age or birthday is required');
    const t = Object.assign({ id: newId_('t'), dateAdded: today_(), status: 'active', opId: p.opId }, pick_(t0));
    T.add(t);
    return { teen: pubTeen_(t, role) };
  });
}
function saveTeen_(p) { // admin: create/edit/archive (status: 'archived'); no hard delete
  return withLock_(() => {
    const T = tbl_('Teenagers'), inc = p.teen || {};
    let t = T.all().find(r => r.id === inc.id);
    if (t) { Object.assign(t, pick_(inc)); T.set(t); }
    else { t = Object.assign({ id: newId_('t'), dateAdded: today_(), status: 'active', opId: '' }, pick_(inc)); T.add(t); }
    return { teen: pubTeen_(t, 'admin') };
  });
}

/* ---------- Admin ---------- */
function saveSimple_(name, fields, prefix, item) { // branches & services (edit only, so history never breaks)
  return withLock_(() => {
    const T = tbl_(name); item = item || {};
    let r = T.all().find(x => x.id === item.id);
    if (!r) { r = { id: newId_(prefix) }; fields.forEach(k => r[k] = String(item[k] || '')); T.add(r); }
    else { fields.forEach(k => { if (k in item) r[k] = String(item[k]); }); T.set(r); }
    return { item: strip_(r) };
  });
}
function setSecrets_(p) {
  return withLock_(() => {
    const pr = PropertiesService.getScriptProperties();
    if (p.teamCode != null) { if (String(p.teamCode).length < 4) throw fail_('weak', 'Team code needs 4+ characters'); pr.setProperty('TEAM_CODE', String(p.teamCode)); }
    if (p.newPin != null) { if (!/^\d{4,8}$/.test(String(p.newPin))) throw fail_('weak', 'PIN must be 4-8 digits'); pr.setProperty('ADMIN_PIN', String(p.newPin)); }
    return { ok: true };
  });
}
function bulkAdd_(p) { // used by the Stage 4 import tool; max 500 rows per call
  return withLock_(() => {
    const name = p.table;
    if (['Teenagers', 'Attendance'].indexOf(name) < 0) throw fail_('bad_table');
    let rows = (p.rows || []).slice(0, 500).map(r => {
      const o = Object.assign({}, r, { id: newId_(name === 'Teenagers' ? 't' : 'att') });
      if (name === 'Teenagers') { o.status = o.status || 'active'; o.dateAdded = o.dateAdded || today_(); }
      else o.status = o.status || 'in';
      return o;
    });
    let skipped = 0;
    if (name === 'Attendance') { // never double-count a teen at the same service and date
      const seen = new Set(tbl_('Attendance').all().filter(r => r.status !== 'void').map(r => r.teenId + '|' + r.serviceId + '|' + r.date));
      rows = rows.filter(r => { const k = r.teenId + '|' + r.serviceId + '|' + r.date; if (seen.has(k)) { skipped++; return false; } seen.add(k); return true; });
    }
    tbl_(name).addMany(rows);
    return { added: rows.length, skipped, ids: rows.map(r => r.id) };
  });
}

// Reads one tab of a Google Sheet your account can open (used by Import > Connect Google Sheet).
function readSheet_(p) {
  const m = String(p.url || '').match(/\/d\/([a-zA-Z0-9_-]+)/);
  if (!m) throw fail_('bad_url', 'That is not a Google Sheets link');
  let ss; try { ss = SpreadsheetApp.openById(m[1]); } catch (e) { throw fail_('no_access', 'Cannot open that Sheet. Share it with the Google account that owns this script.'); }
  const gid = (String(p.url).match(/[#&?]gid=(\d+)/) || [])[1];
  const sh = (gid && ss.getSheets().find(s => String(s.getSheetId()) === gid)) || ss.getSheets()[0];
  return { name: ss.getName() + ' / ' + sh.getName(), rows: sh.getDataRange().getDisplayValues().slice(0, 5000) };
}

// records.js — Stage 3: teen list, profile, edit/archive, CSV export, multi-source import.
import { todayStr, ageOf, svcBranches, HOME } from './store.js';

// Import fields. Order matters for auto-mapping (specific headers before generic ones).
const TF = [
  ['guardianPhone', 'Guardian phone', /(guardian|parent|next of kin).*(phone|mobile|tel|contact|number)|(phone|mobile|tel).*(guardian|parent)/i],
  ['guardianName', 'Guardian name', /guardian|parent|next of kin/i],
  ['fullName', 'Full name', /name/i], ['gender', 'Gender', /gender|sex/i], ['age', 'Age', /^age/i],
  ['dob', 'Date of birth', /dob|birth/i], ['phone', 'Teen phone', /phone|mobile|tel|whatsapp|contact/i],
  ['homeBranch', HOME, /branch|campus|location/i], ['medicalNotes', 'Medical notes', /medical|allerg|health/i],
  ['dateAdded', 'Date joined', /join|added|register|since/i], ['firstTimer', 'First timer (yes/no)', /first.?time/i]
];
const AF = [
  ['name', 'Teen name', /name/i], ['phone', 'Phone (helps matching)', /phone|mobile|tel/i], ['date', 'Date', /date|day/i],
  ['service', 'Service', /service|event/i], ['checkIn', 'Check-in time', /check.?in|arriv|time.?in|^in$/i],
  ['checkOut', 'Check-out time', /check.?out|leav|depart|time.?out|^out$/i]
];
const autoMap = (heads, defs) => {
  const map = {}, used = new Set();
  defs.forEach(([k, , re]) => { const i = heads.findIndex((h, j) => !used.has(j) && re.test(h)); if (i >= 0) { map[k] = i; used.add(i); } });
  return map;
};

function parseCsv(text) {
  const rows = []; let r = [], c = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { c += '"'; i++; } else q = false; } else c += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { r.push(c); c = ''; }
    else if (ch === '\n') { r.push(c); rows.push(r); r = []; c = ''; }
    else if (ch !== '\r') c += ch;
  }
  if (c || r.length) { r.push(c); rows.push(r); }
  return rows.filter(x => x.some(v => v.trim()));
}
const csv = rows => rows.map(r => r.map(c => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
const download = (name, text) => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['\ufeff' + text], { type: 'text/csv' })); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
};
const ymd = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
function pDate(s) { // yyyy-mm-dd, or day-first dd/mm/yyyy
  s = String(s || '').trim(); let m;
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) return ymd(+m[1], +m[2], +m[3]);
  if ((m = s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})/))) return ymd(+m[3] < 100 ? 2000 + +m[3] : +m[3], +m[2], +m[1]);
  const d = new Date(s); return s && !isNaN(d) ? todayStr(d) : '';
}
function pTime(date, s) {
  const m = String(s || '').match(/(\d{1,2})[:.](\d{2})\s*(am|pm)?/i); if (!m) return '';
  let h = +m[1]; const ap = (m[3] || '').toLowerCase();
  if (ap === 'pm' && h < 12) h += 12; if (ap === 'am' && h === 12) h = 0;
  const [y, mo, d] = date.split('-'); return new Date(+y, +mo - 1, +d, h, +m[2]).toISOString();
}
const gender = v => { const g = String(v).trim().toLowerCase(); return /^(m|male|boy|man)$/.test(g) ? 'Male' : /^(f|female|girl|woman)$/.test(g) ? 'Female' : ''; };

export function initRecords({ store, getV, esc, toast, sheet, closeSheet }) {
  const $ = s => document.querySelector(s);
  const isAdmin = () => getV().role === 'admin';
  const f = { q: '', b: '', g: '', min: '', max: '', arch: false };
  let built = false, att = null, attAt = 0, src = [], plan = null;

  const bName = id => getV().branches.find(b => b.id === id)?.name || '';
  const svcName = id => getV().services.find(s => s.id === id)?.name || '';
  const hm = iso => iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '–';
  const filtered = () => {
    const words = f.q.toLowerCase().split(/\s+/).filter(Boolean);
    return getV().teens.filter(t => (f.arch || t.status !== 'archived') && (!f.b || (f.b === '__none' ? !t.homeBranchId : t.homeBranchId === f.b)) && (!f.g || t.gender === f.g)
      && words.every(w => t.fullName.toLowerCase().includes(w))
      && (f.min === '' || ageOf(t) >= +f.min) && (f.max === '' || ageOf(t) <= +f.max))
      .sort((a, b) => a.fullName.localeCompare(b.fullName));
  };

  /* ---------- list ---------- */
  function build() {
    $('#records').innerHTML = `<input id="r-q" type="search" placeholder="Search teens…" autocomplete="off">
      <div class="two"><select id="r-b"></select><select id="r-g"><option value="">All genders</option><option>Male</option><option>Female</option></select></div>
      <div class="two"><input id="r-min" type="number" inputmode="numeric" placeholder="Min age"><input id="r-max" type="number" inputmode="numeric" placeholder="Max age"></div>
      <div id="r-tools"></div><p class="muted" id="r-n"></p><div id="r-list"></div>`;
    $('#r-q').oninput = e => { f.q = e.target.value; list(); };
    $('#r-b').onchange = e => { f.b = e.target.value; list(); };
    $('#r-g').onchange = e => { f.g = e.target.value; list(); };
    $('#r-min').oninput = e => { f.min = e.target.value; list(); };
    $('#r-max').oninput = e => { f.max = e.target.value; list(); };
    $('#r-list').onclick = e => { const b = e.target.closest('button'); if (b) profile(b.dataset.id); };
    $('#r-tools').onclick = e => {
      const a = e.target.closest('button')?.dataset.a;
      if (a === 'add') form(); else if (a === 'imp') { src = []; plan = null; drawImport(); } else if (a === 'exp') exportCsv();
      else if (a === 'arch') { f.arch = !f.arch; tools(); list(); } else if (a === 'unlock') unlock();
    };
    built = true;
  }
  function tools() {
    const h = isAdmin()
      ? `<div class="three"><button class="btn" data-a="add">+ Add</button><button class="btn" data-a="imp">Import</button><button class="btn" data-a="exp">Export</button></div><button class="btn ghost" data-a="arch">${f.arch ? 'Hide' : 'Show'} archived</button>`
      : `<button class="btn ghost" data-a="unlock">Unlock editing (Admin PIN)</button>`;
    const el = $('#r-tools'); if (el.dataset.h !== h) { el.innerHTML = h; el.dataset.h = h; }
    const act = getV().teens.filter(t => t.status !== 'archived'), cnt = id => act.filter(t => t.homeBranchId === id).length, none = act.filter(t => !t.homeBranchId).length;
    const bs = `<option value="">All campuses (${act.length})</option>` + getV().branches.map(b => `<option value="${esc(b.id)}">${esc(b.name)} (${cnt(b.id)})</option>`).join('') + (none ? `<option value="__none">No ${HOME.toLowerCase()} (${none})</option>` : '');
    const sel = $('#r-b'); if (sel.dataset.h !== bs) { sel.innerHTML = bs; sel.dataset.h = bs; } sel.value = f.b;
  }
  function list() {
    const rows = filtered();
    $('#r-n').textContent = `${rows.length} teen${rows.length === 1 ? '' : 's'}${rows.length > 100 ? ' · showing first 100' : ''}`;
    $('#r-list').innerHTML = rows.slice(0, 100).map(t => `<button class="row" data-id="${esc(t.id)}"><span><b>${esc(t.fullName)}</b><small>${esc([ageOf(t) || '', t.gender, bName(t.homeBranchId), t.status === 'archived' ? 'Archived' : ''].filter(Boolean).join(' · '))}</small></span><i>›</i></button>`).join('');
  }
  async function unlock() {
    const pin = prompt('Admin PIN'); if (!pin) return;
    try { await store.login(store.auth.code, pin, store.auth.usher); } catch (e) { return toast(e.message, 'err'); }
    if (getV().role !== 'admin') { toast('Wrong PIN', 'err'); store.auth.pin = undefined; } else toast('Admin unlocked');
    tools(); list();
  }

  /* ---------- attendance data for profiles (last 6 months, cached for a minute) ---------- */
  async function loadAtt() {
    if (att && Date.now() - attAt < 60000) return att;
    const d = await store.read('attendanceRange', { from: todayStr(new Date(Date.now() - 183 * 864e5)), to: todayStr() });
    att = d.attendance; attAt = Date.now(); return att;
  }
  function stats(t, all) {
    const mine = all.filter(r => r.teenId === t.id), key = r => r.serviceId + '|' + r.date;
    const start = [t.dateAdded, ...mine.map(r => r.date)].filter(Boolean).sort()[0] || '';
    const held = new Set(all.filter(r => r.date >= start && (!t.homeBranchId || r.branchId === t.homeBranchId)).map(key));
    const went = new Set(mine.map(key)); went.forEach(k => held.add(k));
    return { n: went.size, held: held.size, pct: held.size ? Math.round(100 * went.size / held.size) : 0, hist: mine.sort((a, b) => b.date.localeCompare(a.date)) };
  }

  /* ---------- profile, edit, archive ---------- */
  async function profile(id) {
    const t = getV().teens.find(x => x.id === id); if (!t) return;
    const admin = isAdmin(), age = ageOf(t);
    const row = (k, v) => v ? `<div class="stat"><span class="muted">${k}</span><b>${esc(v)}</b></div>` : '';
    sheet(`<div class="left"><h2>${esc(t.fullName)}${t.status === 'archived' ? ' (archived)' : ''}</h2>
      ${row('Gender', t.gender)}${row('Age', isNaN(age) ? '' : age)}${row('Date of birth', t.dob)}${row('Phone', t.phone)}${row('Guardian', t.guardianName)}
      ${admin ? row('Guardian phone', t.guardianPhone) + row('Medical notes', t.medicalNotes) : ''}${row(HOME, bName(t.homeBranchId))}${row('Added', t.dateAdded)}${row('First-time visitor at sign-up', t.firstTimer === 'yes' ? 'Yes' : t.firstTimer === 'no' ? 'No' : '')}
      <h3>Attendance</h3><div id="p-att" class="muted">Loading…</div>
      ${admin ? `<button class="btn" id="p-edit">Edit</button><button class="btn" id="p-arch">${t.status === 'archived' ? 'Restore' : 'Archive'}</button>` : ''}
      <button class="btn primary" id="p-x">Close</button></div>`);
    $('#p-x').onclick = closeSheet;
    if (admin) {
      $('#p-edit').onclick = () => form(t);
      $('#p-arch').onclick = () => { if (confirm(t.status === 'archived' ? 'Restore this teen?' : 'Archive this teen? History is kept.')) save({ id: t.id, status: t.status === 'archived' ? 'active' : 'archived' }); };
    }
    try {
      const s = stats(t, await loadAtt()), el = $('#p-att'); if (!el) return;
      el.className = '';
      el.innerHTML = s.held ? `<div class="stat"><span>Attendance rate (6 months)</span><b>${s.pct}% · ${s.n}/${s.held}</b></div>` +
        s.hist.slice(0, 10).map(r => `<div class="stat"><span>${esc(r.date)} · ${esc(svcName(r.serviceId))}</span><span class="muted">${hm(r.checkIn)}–${hm(r.checkOut)}</span></div>`).join('') : '<span class="muted">No attendance yet.</span>';
    } catch { const el = $('#p-att'); if (el) el.textContent = 'Could not load attendance (offline?).'; }
  }
  async function save(teen) {
    try { await store.admin('saveTeen', { teen }); closeSheet(); toast('Saved'); } catch (e) { toast(e.message, 'err'); }
  }
  function form(t = {}) {
    let g = t.gender || '';
    const inp = (k, ph, type = 'text') => `<input id="f-${k}" type="${type}" placeholder="${ph}" value="${esc(t[k] || '')}">`;
    sheet(`<div class="left"><h2>${t.id ? 'Edit' : 'Add'} teen</h2>${inp('fullName', 'Full name *')}
      <div class="seg2">${['Male', 'Female'].map(x => `<button data-g="${x}" class="${g === x ? 'on' : ''}">${x}</button>`).join('')}</div>
      ${inp('age', 'Age', 'number')}${inp('dob', 'Date of birth (YYYY-MM-DD)')}${inp('phone', "Teen's phone *", 'tel')}${inp('guardianName', 'Guardian name')}${inp('guardianPhone', 'Guardian phone', 'tel')}
      <select id="f-homeBranchId"><option value="">${HOME}</option>${getV().branches.map(b => `<option value="${esc(b.id)}"${b.id === t.homeBranchId ? ' selected' : ''}>${esc(b.name)}</option>`).join('')}</select>
      <select id="f-firstTimer"><option value="">First time visiting at sign-up?</option><option value="yes"${t.firstTimer === 'yes' ? ' selected' : ''}>Yes, first time</option><option value="no"${t.firstTimer === 'no' ? ' selected' : ''}>No, been before</option></select>
      ${inp('medicalNotes', 'Allergies / medical notes')}
      <button class="btn primary" id="f-save">Save</button><button class="btn ghost" id="f-x">Cancel</button></div>`);
    document.querySelectorAll('.seg2 button').forEach(b => b.onclick = () => { g = b.dataset.g; document.querySelectorAll('.seg2 button').forEach(x => x.classList.toggle('on', x === b)); });
    $('#f-x').onclick = closeSheet;
    $('#f-save').onclick = () => {
      const v = {}; ['fullName', 'age', 'dob', 'phone', 'guardianName', 'guardianPhone', 'homeBranchId', 'medicalNotes', 'firstTimer'].forEach(k => v[k] = $('#f-' + k).value.trim());
      if (!v.fullName || (!t.id && !v.phone)) return toast('Name and teen phone are required', 'err');
      save({ ...(t.id ? { id: t.id } : {}), ...v, gender: g });
    };
  }

  /* ---------- export ---------- */
  function exportCsv() {
    const H = ['fullName', 'gender', 'age', 'dob', 'phone', 'guardianName', 'guardianPhone', 'homeBranch', 'medicalNotes', 'dateAdded', 'status', 'firstTimer'];
    download(`teens-${todayStr()}.csv`, csv([H.map(k => k === 'homeBranch' ? 'homeCampus' : k), ...filtered().map(t => H.map(k => k === 'homeBranch' ? bName(t.homeBranchId) : t[k]))]));
    toast('Exported ' + filtered().length + ' teens');
  }

  /* ---------- import: many sources, map columns, merge duplicates, preview, save ---------- */
  function addSource(name, rows) {
    if (rows.length < 2) return toast(`${name}: no data rows`, 'err');
    const heads = rows[0].map(h => String(h).trim());
    const kind = heads.some(h => /date/i.test(h)) && heads.some(h => /service|check/i.test(h)) ? 'att' : 'teens';
    src.push({ name, rows: [heads, ...rows.slice(1)], kind, map: autoMap(heads, kind === 'att' ? AF : TF), svc: '', hb: '' });
    plan = null;
  }
  const srcCard = (s, i) => {
    const heads = k => s.rows[0].map((h, j) => `<option value="${j}"${s.map[k] === j ? ' selected' : ''}>${esc(h || 'Column ' + (j + 1))}</option>`).join('');
    return `<div class="src"><div class="stat"><b>${esc(s.name)}</b><button class="x" data-rm="${i}">✕</button></div><small class="muted">${s.rows.length - 1} rows</small>
      <select data-kind="${i}"><option value="teens"${s.kind === 'teens' ? ' selected' : ''}>These are teenagers</option><option value="att"${s.kind === 'att' ? ' selected' : ''}>This is past attendance</option></select>
      ${(s.kind === 'att' ? AF : TF).map(([k, label]) => `<div class="map"><span>${label}</span><select data-map="${i}:${k}"><option value="">— none —</option>${heads(k)}</select></div>`).join('')}
      ${s.kind === 'teens' ? `<div class="map"><span>If campus is missing</span><select data-hb="${i}"><option value="">— none —</option>${getV().branches.map(v => `<option value="${esc(v.id)}"${s.hb === v.id ? ' selected' : ''}>${esc(v.name)}</option>`).join('')}</select></div>` : ''}
      ${s.kind === 'att' ? `<div class="map"><span>If service is missing</span><select data-svc="${i}"><option value="">— skip —</option>${getV().services.map(v => `<option value="${esc(v.id)}"${s.svc === v.id ? ' selected' : ''}>${esc(v.name)}</option>`).join('')}</select></div>` : ''}</div>`;
  };
  const planHtml = () => {
    const p = plan.stats, line = (k, v) => `<div class="stat"><span>${k}</span><b>${v}</b></div>`;
    return `<div class="src" id="i-plan"><b>Preview</b>${line('New teens', plan.newTeens.length)}${line('Duplicates merged', p.merged)}${line('Already in database (skipped)', p.existing)}
      ${p.flag ? line('Same name, different phone (kept separate)', p.flag) : ''}${p.noCampus ? line('Campus not recognised (left blank)', p.noCampus) : ''}${plan.att.length || p.attBad ? line('Attendance records', plan.att.length) : ''}${p.attBad ? line('Attendance skipped (no teen, date or service match)', p.attBad) : ''}
      <table class="tbl">${plan.newTeens.slice(0, 6).map(e => `<tr><td>${esc(e.teen.fullName)}</td><td>${esc(e.teen.gender)}</td><td>${esc(e.teen.age)}</td><td>${esc(e.teen.guardianPhone || e.teen.phone)}</td></tr>`).join('')}</table></div>`;
  };
  function drawImport() {
    sheet(`<div class="left"><h2>Import</h2><p class="muted">Add CSV files or Google Sheets, check the column mapping, then preview. Teens with the same name and phone are merged.</p>
      ${src.map(srcCard).join('')}
      <div class="two"><button class="btn" id="i-file">Upload CSV</button><button class="btn" id="i-gs">Connect Google Sheet</button></div>
      <input type="file" id="i-input" accept=".csv,text/csv" multiple hidden>
      ${plan ? planHtml() : ''}
      <button class="btn primary" id="i-go">${plan ? 'Import now' : 'Preview'}</button><button class="btn ghost" id="i-x">Close</button></div>`);
    const card = $('#sheet'), reset = () => { plan = null; $('#i-plan')?.remove(); $('#i-go').textContent = 'Preview'; };
    $('#i-file').onclick = () => $('#i-input').click();
    $('#i-input').onchange = async e => { for (const file of e.target.files) addSource(file.name, parseCsv((await file.text()).replace(/^\ufeff/, ''))); drawImport(); };
    $('#i-gs').onclick = async () => {
      const url = prompt('Paste the Google Sheet link (open the tab you want before copying it)'); if (!url) return;
      try { const d = await store.read('readSheet', { url }); addSource(d.name, d.rows); drawImport(); } catch (e) { toast(e.message, 'err'); }
    };
    card.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => { src.splice(+b.dataset.rm, 1); plan = null; drawImport(); });
    card.querySelectorAll('[data-kind]').forEach(el => el.onchange = () => { const s = src[+el.dataset.kind]; s.kind = el.value; s.map = autoMap(s.rows[0], s.kind === 'att' ? AF : TF); plan = null; drawImport(); });
    card.querySelectorAll('[data-map]').forEach(el => el.onchange = () => { const [i, k] = el.dataset.map.split(':'); if (el.value === '') delete src[+i].map[k]; else src[+i].map[k] = +el.value; reset(); });
    card.querySelectorAll('[data-hb]').forEach(el => el.onchange = () => { src[+el.dataset.hb].hb = el.value; reset(); });
    card.querySelectorAll('[data-svc]').forEach(el => el.onchange = () => { src[+el.dataset.svc].svc = el.value; reset(); });
    $('#i-x').onclick = closeSheet;
    $('#i-go').onclick = () => {
      if (plan) return commit();
      if (!src.length) return toast('Add a file or Google Sheet first', 'err');
      const bad = src.find(s => s.map[s.kind === 'att' ? 'name' : 'fullName'] == null);
      if (bad) return toast(`Map the name column for ${bad.name}`, 'err');
      plan = buildPlan(); drawImport(); $('#sheet .card').scrollTop = 1e6;
    };
  }
  function buildPlan() {
    const V = getV(), norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const tail = s => { const d = String(s || '').replace(/\D/g, ''); return d.length >= 7 ? d.slice(-10) : ''; };
    const cell = (r, s, k) => s.map[k] == null ? '' : String(r[s.map[k]] ?? '').trim();
    const phones = (...a) => new Set(a.map(tail).filter(Boolean));
    const pool = V.teens.map(t => ({ n: norm(t.fullName), ph: phones(t.phone, t.guardianPhone), id: t.id, old: true, teen: t, dates: [] }));
    // same name + (a shared phone, or a phone missing on either side) = same person
    const find = (n, ph) => pool.find(p => p.n === n && (!p.ph.size || !ph.size || [...ph].some(x => p.ph.has(x))));
    const st = { merged: 0, existing: 0, flag: 0, attBad: 0, noCampus: 0 };
    // campus text may be "Akpajo" or "Akpajo campus"; falls back to the campus chosen for that file
    const hbOf = (s, txt) => V.branches.find(b => { const x = norm(b.name), y = norm(txt); return y && (y === x || y.includes(x) || x.includes(y)); })?.id || s.hb || '';
    const yn = v => /^(y|yes|true|1)$/i.test(v) ? 'yes' : /^(n|no|false|0)$/i.test(v) ? 'no' : '';
    for (const s of src.filter(s => s.kind === 'teens')) for (const r of s.rows.slice(1)) {
      const name = cell(r, s, 'fullName'); if (!name) continue;
      const t = {
        fullName: name, gender: gender(cell(r, s, 'gender')), age: (cell(r, s, 'age').match(/\d+/) || [''])[0], dob: pDate(cell(r, s, 'dob')),
        phone: cell(r, s, 'phone'), guardianName: cell(r, s, 'guardianName'), guardianPhone: cell(r, s, 'guardianPhone'), medicalNotes: cell(r, s, 'medicalNotes'),
        dateAdded: pDate(cell(r, s, 'dateAdded')), homeBranchId: hbOf(s, cell(r, s, 'homeBranch')), firstTimer: yn(cell(r, s, 'firstTimer'))
      };
      const n = norm(name), ph = phones(t.phone, t.guardianPhone), hit = find(n, ph);
      if (cell(r, s, 'homeBranch') && !t.homeBranchId) st.noCampus++;
      if (hit) { if (hit.old) st.existing++; else { st.merged++; Object.keys(t).forEach(k => { if (!hit.teen[k]) hit.teen[k] = t[k]; }); ph.forEach(x => hit.ph.add(x)); } }
      else { if (pool.some(p => p.n === n)) st.flag++; pool.push({ n, ph, teen: t, dates: [] }); }
    }
    const att = [], seen = new Set(), svcBy = new Map(V.services.map(v => [norm(v.name), v]));
    for (const s of src.filter(s => s.kind === 'att')) for (const r of s.rows.slice(1)) {
      const name = cell(r, s, 'name'); if (!name) continue;
      const e = find(norm(name), phones(cell(r, s, 'phone'))), date = pDate(cell(r, s, 'date'));
      const sv = svcBy.get(norm(cell(r, s, 'service'))) || V.services.find(x => x.id === s.svc);
      if (!e || !date || !sv) { st.attBad++; continue; }
      const k = `${pool.indexOf(e)}|${sv.id}|${date}`; if (seen.has(k)) continue; seen.add(k);
      e.dates.push(date);
      att.push({ e, sv, date, checkIn: pTime(date, cell(r, s, 'checkIn')) || pTime(date, '9:00'), checkOut: pTime(date, cell(r, s, 'checkOut')) });
    }
    const newTeens = pool.filter(p => !p.old);
    newTeens.forEach(e => { if (!e.teen.dateAdded && e.dates.length) e.teen.dateAdded = e.dates.slice().sort()[0]; }); // so imported teens don't count as "new" later
    return { newTeens, att, stats: st };
  }
  async function commit() {
    const b = $('#i-go'); b.disabled = true; b.textContent = 'Importing… keep this open';
    const chunks = (a, n = 400) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));
    try {
      let off = 0, added = 0;
      for (const c of chunks(plan.newTeens)) {
        const r = await store.read('bulkAdd', { table: 'Teenagers', rows: c.map(e => e.teen) });
        r.ids.forEach((id, j) => { plan.newTeens[off + j].id = id; }); off += c.length;
      }
      const rows = plan.att.map(a => ({ teenId: a.e.id, branchId: (() => { const sb = svcBranches(a.sv), hb = a.e.teen.homeBranchId; return (hb && (!sb.length || sb.includes(hb)) ? hb : sb[0]) || hb || getV().branches[0]?.id || ''; })(), serviceId: a.sv.id, date: a.date, checkIn: a.checkIn, checkOut: a.checkOut, checkedInBy: 'import', codeCheck: 'import', status: 'in' }));
      for (const c of chunks(rows)) added += (await store.read('bulkAdd', { table: 'Attendance', rows: c })).added;
      att = null; await store.refresh(true); closeSheet();
      toast(`Imported ${plan.newTeens.length} teens, ${added} attendance records`);
    } catch (e) { toast(e.message + ' — preview again before retrying', 'err'); b.disabled = false; b.textContent = 'Import now'; }
  }

  return {
    unlock,
    show() { if (!built) build(); tools(); list(); loadAtt().catch(() => {}); },
    onData() { if (built && !$('#records').hidden) { tools(); list(); } }
  };
}

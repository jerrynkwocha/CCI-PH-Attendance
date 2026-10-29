// dashboard.js — Stage 4: metrics, charts, absentees (full view for Admin; today's totals for the team).
import { todayStr, ageOf, svcAt } from './store.js';

const addDays = (d, n) => { const x = new Date(d + 'T00:00:00'); x.setDate(x.getDate() + n); return todayStr(x); };
const wk = d => { const x = new Date(d + 'T00:00:00'); x.setDate(x.getDate() - (x.getDay() + 6) % 7); return todayStr(x); }; // Monday of that week
const m = (v, k) => `<div class="m"><b>${v}</b><span>${k}</span></div>`;

export function initDashboard({ store, getV, esc, toast, unlock }) {
  const $ = s => document.querySelector(s), today = todayStr();
  const f = { b: '', s: '', from: addDays(today, -55), to: today };
  let built = false, all = null, at = 0, loading = false;
  const isAdmin = () => getV().role === 'admin';
  const setBody = h => { const el = $('#d-body'); if (el.dataset.h !== h) { el.innerHTML = h; el.dataset.h = h; } };

  function build() {
    $('#dash').innerHTML = `<div id="d-f"><div><select id="d-b"></select><select id="d-s"></select></div>
      <div class="two"><input id="d-from" type="date"><input id="d-to" type="date"></div></div><div id="d-body"></div>`;
    $('#d-from').value = f.from; $('#d-to').value = f.to;
    $('#d-b').onchange = e => { f.b = e.target.value; f.s = ''; render(); };
    $('#d-s').onchange = e => { f.s = e.target.value; render(); };
    $('#d-from').onchange = e => { f.from = e.target.value || f.from; render(); };
    $('#d-to').onchange = e => { f.to = e.target.value || f.to; render(); };
    $('#d-body').onclick = e => { const a = e.target.closest('button')?.dataset.a; if (a === 'unlock') unlock(); else if (a === 'reload') load(true); };
    built = true;
  }
  function filters() {
    const V = getV(), fill = (id, h, v) => { const el = $(id); if (el.dataset.h !== h) { el.innerHTML = h; el.dataset.h = h; } el.value = v; };
    fill('#d-b', '<option value="">All branches</option>' + V.branches.map(b => `<option value="${esc(b.id)}">${esc(b.name)}</option>`).join(''), f.b);
    fill('#d-s', '<option value="">All services</option>' + V.services.filter(s => !f.b || svcAt(s, f.b)).map(s => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join(''), f.s);
  }
  async function load(force) {
    if (loading || (!force && all && Date.now() - at < 120000)) return;
    loading = true; if (!all) setBody('<p class="muted">Loading…</p>');
    try { all = (await store.read('attendanceRange', { from: '2000-01-01', to: today, slim: true })).attendance; at = Date.now(); }
    catch { if (!all) setBody('<p class="muted">Could not load. Check your connection.</p><button class="btn" data-a="reload">Try again</button>'); }
    loading = false; if (all) compute();
  }
  function mini() {
    const rows = getV().attendance.filter(r => r.date === today && r.status !== 'void');
    setBody(`<div class="mg">${m(rows.length, 'Attended today')}${m(rows.filter(r => !r.checkOut).length, 'Checked in now')}${m(rows.filter(r => r.checkOut).length, 'Checked out')}</div>
      <p class="muted">The Admin PIN unlocks the full dashboard.</p><button class="btn" data-a="unlock">Unlock (Admin PIN)</button>`);
  }
  function render() {
    if (!built) return;
    $('#d-f').hidden = !isAdmin();
    if (!isAdmin()) return mini();
    filters(); if (!all) load(); else compute();
  }

  function compute() {
    if (f.from > f.to) return setBody('<p class="muted">“From” must be before “To”.</p>');
    const V = getV(), tm = new Map(V.teens.map(t => [t.id, t]));
    const inB = r => !f.b || r.branchId === f.b, inS = r => !f.s || r.serviceId === f.s;
    const inR = r => r.date >= f.from && r.date <= f.to;
    const base = all.filter(r => inB(r) && inS(r)), rows = base.filter(inR);
    const uniq = [...new Set(rows.map(r => r.teenId))].map(id => tm.get(id)).filter(Boolean);
    const nowIn = V.attendance.filter(r => r.date === today && r.status !== 'void' && !r.checkOut && inB(r) && inS(r)).length;
    const first = new Map(); all.forEach(r => { const c = first.get(r.teenId); if (!c || r.date < c.date) first.set(r.teenId, r); });
    const firstTimers = [...first.values()].filter(r => inB(r) && inS(r) && inR(r)).length;
    const newTeens = V.teens.filter(t => t.dateAdded >= f.from && t.dateAdded <= f.to && (!f.b || t.homeBranchId === f.b)).length;
    const sessions = new Set(rows.map(r => r.serviceId + '|' + r.date)).size;
    const mins = rows.filter(r => r.checkIn && r.checkOut).map(r => (Date.parse(r.checkOut) - Date.parse(r.checkIn)) / 6e4).filter(x => x > 0 && x < 720);
    const avgMin = mins.length ? Math.round(mins.reduce((a, b) => a + b, 0) / mins.length) : null;
    const never = rows.filter(r => r.date < today && !r.checkOut && r.by !== 'import').length;

    const g = { Male: 0, Female: 0, Other: 0 };
    uniq.forEach(t => g[t.gender === 'Male' || t.gender === 'Female' ? t.gender : 'Other']++);
    const ab = [['Under 13', 0], ['13–15', 0], ['16–18', 0], ['19+', 0], ['Unknown', 0]];
    uniq.forEach(t => { const a = ageOf(t); ab[isNaN(a) ? 4 : a < 13 ? 0 : a <= 15 ? 1 : a <= 18 ? 2 : 3][1]++; });

    const wmap = new Map();
    for (let w = wk(f.from), n = 0; w <= f.to && n < 160; w = addDays(w, 7), n++) wmap.set(w, 0);
    rows.forEach(r => { const w = wk(r.date); wmap.set(w, (wmap.get(w) || 0) + 1); });
    const weeks = [...wmap], wmax = Math.max(1, ...weeks.map(x => x[1]));
    const bc = V.branches.map(b => [b.name, all.filter(r => r.branchId === b.id && inS(r) && inR(r)).length]), bmax = Math.max(1, ...bc.map(x => x[1]));
    const hb = (items, max) => items.map(([k, n]) => `<div class="hb"><span>${esc(k)}</span><div><i style="width:${n / max * 100}%"></i></div><b>${n}</b></div>`).join('');

    // Absentees: missed 3+ consecutive services (counted on the service each teen mostly attends)
    const dates = new Map(), went = new Map();
    base.forEach(r => {
      if (!dates.has(r.serviceId)) dates.set(r.serviceId, new Set());
      dates.get(r.serviceId).add(r.date);
      if (!went.has(r.teenId)) went.set(r.teenId, new Map());
      const w = went.get(r.teenId); if (!w.has(r.serviceId)) w.set(r.serviceId, new Set()); w.get(r.serviceId).add(r.date);
    });
    const sorted = new Map([...dates].map(([k, v]) => [k, [...v].sort().reverse()]));
    const abs = [];
    went.forEach((bySvc, id) => {
      const t = tm.get(id); if (!t || t.status === 'archived') return;
      const svc = f.s || [...bySvc].sort((a, b) => b[1].size - a[1].size)[0][0], mine = bySvc.get(svc), ds = sorted.get(svc) || [];
      let miss = 0; while (miss < ds.length && !mine?.has(ds[miss])) miss++;
      if (miss >= 3 && miss < ds.length) abs.push({ t, miss, last: ds[miss] });
    });
    abs.sort((a, b) => b.miss - a.miss);

    setBody(`<div class="mg">${m(rows.length, 'Total attendance')}${m(nowIn, 'Checked in now')}${m(rows.filter(r => r.checkOut).length, 'Checked out')}${m(newTeens, 'New teens')}
        ${m(firstTimers, 'First-timers')}${m(sessions ? (rows.length / sessions).toFixed(1) : '–', 'Avg per service')}${m(avgMin == null ? '–' : avgMin + ' min', 'Avg time spent')}${m(never, 'Never checked out')}</div>
      <div class="src"><b>Weekly trend</b><div class="vb">${weeks.map(([w, n]) => `<div title="${w}: ${n}">${weeks.length <= 16 ? `<small>${n}</small>` : ''}<i style="height:${Math.max(2, n / wmax * 85)}%"></i></div>`).join('')}</div>
        <div class="axis"><span>${weeks[0]?.[0] || ''}</span><span>${weeks.at(-1)?.[0] || ''}</span></div></div>
      <div class="src"><b>Branch comparison</b>${hb(bc, bmax) || '<p class="muted">No branches yet.</p>'}</div>
      <div class="src"><b>Gender</b> <small class="muted">(different teens)</small>${hb(Object.entries(g), Math.max(1, uniq.length))}</div>
      <div class="src"><b>Age</b>${hb(ab, Math.max(1, uniq.length))}</div>
      <div class="src"><b>Absentees</b> <small class="muted">missed 3+ services in a row</small>
        ${abs.slice(0, 40).map(a => `<div class="stat"><span>${esc(a.t.fullName)}</span><span class="muted">missed ${a.miss} · last ${esc(a.last)}</span></div>`).join('') || '<p class="muted">None.</p>'}</div>
      <button class="btn ghost" data-a="reload">Refresh data</button>`);
  }

  return { show() { if (!built) build(); render(); if (isAdmin()) load(true); }, onData() { if (built && !$('#dash').hidden) render(); } };
}

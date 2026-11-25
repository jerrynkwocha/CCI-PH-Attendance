// followup.js — the "Follow up" tab: absentees and birthdays for the whole team,
// with call / WhatsApp buttons, follow-up statuses and sharing.
import { todayStr, ageOf } from './store.js';

const STATUS = { called: 'Called, spoke to them', willcome: "Said they'll come", noanswer: 'No answer', away: 'Away / travelling', moved: 'Moved away / left' };
const SNOOZE = { called: 7, willcome: 7, away: 14 }; // days a teen is hidden from "Needs follow-up" (moved = hidden for good)
const WINDOW = 120;                                  // days of attendance history used

export function initFollowup({ store, getV, getCtx, esc, toast, sheet, closeSheet }) {
  const $ = s => document.querySelector(s);
  const f = { campus: null, min: 3, show: 'need' };           // campus null = this phone's campus, chosen on first use
  const ex = { abs: null, bd: null, grp: {} };                // expanded? null = automatic (open when 10 or fewer)
  const last = { abs: true, bd: true, grp: {} };
  let built = false, rows = null, at = 0, loading = false;
  try { const c = JSON.parse(localStorage.getItem('att.fu') || 'null'); if (c && c.rows) { rows = c.rows; at = c.at; } } catch {}

  /* ---------- small helpers ---------- */
  const dShort = d => d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
  const sShort = s => dShort(new Date(s + 'T00:00:00'));
  const bName = id => getV().branches.find(b => b.id === id)?.name || '';
  const tel = p => 'tel:' + String(p || '').replace(/[^\d+]/g, '');
  const waUrl = (p, text) => {
    const raw = String(p || '').trim(); let x = raw.replace(/\D/g, '');
    if (x && !raw.startsWith('+')) { if (x.startsWith('234')) x = x.slice(3); x = '234' + x.replace(/^0/, ''); }
    return `https://wa.me/${x}?text=${encodeURIComponent(text)}`;
  };
  const camp = () => f.campus ?? 'all';
  const inCampus = t => camp() === 'all' || (camp() === '__none' ? !getV().branches.some(b => b.id === t.homeBranchId) : t.homeBranchId === camp());
  function initCampus() {
    if (f.campus === null && getV().branches.length) f.campus = getV().branches.some(b => b.id === getCtx().branchId) ? getCtx().branchId : 'all';
  }

  /* ---------- who is absent ---------- */
  // Sessions = the dates a teen's usual service was held (before today). Missed = sessions after the last day they were seen at ANY campus or service.
  function absList() {
    if (!rows) return [];
    const t0 = todayStr(), tm = new Map(getV().teens.map(t => [t.id, t])), per = new Map(), svcDates = new Map();
    rows.forEach(r => {
      let p = per.get(r.teenId); if (!p) per.set(r.teenId, p = { dates: new Set(), svc: new Map() });
      p.dates.add(r.date); p.svc.set(r.serviceId, (p.svc.get(r.serviceId) || 0) + 1);
      if (r.date < t0) { let s = svcDates.get(r.serviceId); if (!s) svcDates.set(r.serviceId, s = new Set()); s.add(r.date); }
    });
    const out = [];
    per.forEach((p, id) => {
      const t = tm.get(id); if (!t || t.status === 'archived') return;
      const lastSeen = [...p.dates].sort().pop(), svc = [...p.svc].sort((a, b) => b[1] - a[1])[0][0];
      const missed = [...(svcDates.get(svc) || [])].filter(d => d > lastSeen).length;
      if (missed >= f.min) out.push({ t, missed, last: lastSeen, fu: fuOf(id, lastSeen) });
    });
    return out.sort((a, b) => b.missed - a.missed || a.t.fullName.localeCompare(b.t.fullName));
  }
  // latest follow-up made AFTER they were last seen; some statuses hide the teen for a while
  function fuOf(id, lastSeen) {
    const x = (getV().followups || []).filter(r => r.teenId === id && String(r.at).slice(0, 10) > lastSeen).sort((a, b) => String(b.at).localeCompare(String(a.at)))[0];
    if (!x) return null;
    const days = (Date.now() - Date.parse(x.at)) / 864e5;
    return { ...x, hidden: x.status === 'moved' || (!!SNOOZE[x.status] && days < SNOOZE[x.status]) };
  }
  const visibleAbs = () => absList().filter(a => inCampus(a.t) && (f.show === 'all' || !(a.fu && a.fu.hidden)));

  function birthdays() { // Monday to Sunday of this week
    const now = new Date(), mon = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (now.getDay() + 6) % 7);
    const days = Array.from({ length: 7 }, (_, i) => new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + i)), out = [];
    getV().teens.forEach(t => {
      const m = String(t.dob || '').match(/^(\d{4})-(\d{2})-(\d{2})/); if (!m || t.status === 'archived') return;
      const d = days.find(x => x.getMonth() + 1 === +m[2] && x.getDate() === +m[3]);
      if (d) out.push({ d, t, age: d.getFullYear() - +m[1] });
    });
    return out.sort((a, b) => a.d - b.d || a.t.fullName.localeCompare(b.t.fullName));
  }
  function groupsOf(list) { // one block per home campus
    const V = getV(), known = new Set(V.branches.map(b => b.id));
    const gs = V.branches.map(b => ({ id: b.id, name: b.name, items: list.filter(x => x.t.homeBranchId === b.id) }));
    gs.push({ id: '__none', name: 'No home campus', items: list.filter(x => !known.has(x.t.homeBranchId)) });
    return gs.filter(g => g.items.length);
  }

  /* ---------- sharing (names, dates and contacts: only vetted people use the app) ---------- */
  const absLine = a => `• ${a.t.fullName}: missed ${a.missed}, last seen ${sShort(a.last)}\n   Teen ${a.t.phone || '–'}${a.t.guardianName || a.t.guardianPhone ? ' | Guardian ' + [a.t.guardianName, a.t.guardianPhone].filter(Boolean).join(' ') : ''}`;
  async function shareText(text) {
    if (text.length < 3000) return window.open('https://wa.me/?text=' + encodeURIComponent(text), '_blank');
    try { if (navigator.share) return await navigator.share({ text }); await navigator.clipboard.writeText(text); toast('Copied. Paste it into WhatsApp.'); } catch {}
  }
  function share(kind, id) {
    const gs = kind === 'a' ? groupsOf(visibleAbs()) : groupsOf(birthdays().filter(x => inCampus(x.t))), g = gs.find(x => x.id === id); if (!g) return;
    shareText(kind === 'a'
      ? `📋 Absentees · ${g.name} (${g.items.length})\n` + g.items.map(absLine).join('\n')
      : `🎂 Birthdays this week · ${g.name}\n` + g.items.map(x => `${dShort(x.d)}: ${x.t.fullName} (turns ${x.age})${x.t.phone ? ' · ' + x.t.phone : ''}`).join('\n'));
  }

  /* ---------- the tab ---------- */
  const setBody = h => { const el = $('#fu-body'); if (el.dataset.h !== h) { el.innerHTML = h; el.dataset.h = h; } };
  function build() {
    $('#fu').innerHTML = `<select id="fu-c"></select>
      <div class="two"><select id="fu-m"><option value="3">Missed 3 or more</option><option value="4">Missed 4 or more</option><option value="5">Missed 5 or more</option></select>
      <select id="fu-s"><option value="need">Needs follow-up</option><option value="all">Everyone absent</option></select></div><div id="fu-body"></div>`;
    $('#fu-c').onchange = e => { f.campus = e.target.value; render(); badge(); };
    $('#fu-m').onchange = e => { f.min = +e.target.value; render(); badge(); };
    $('#fu-s').onchange = e => { f.show = e.target.value; render(); badge(); };
    $('#fu-body').onclick = onClick;
    built = true;
  }
  function onClick(e) {
    const b = e.target.closest('button'); if (!b) return; const d = b.dataset;
    if (d.sec) { ex[d.sec] = !last[d.sec]; return render(); }
    if (d.grp) { ex.grp[d.grp] = !last.grp[d.grp]; return render(); }
    if (d.do === 'viewall') return viewAll();
    if (d.do && d.do.startsWith('share:')) { const [, k, ...id] = d.do.split(':'); return share(k, id.join(':')); }
    if (d.t) return detail(d.t, d.k);
  }
  function render() {
    if (!built) return;
    initCampus();
    const V = getV(), fill = (id, h, v) => { const el = $(id); if (el.dataset.h !== h) { el.innerHTML = h; el.dataset.h = h; } el.value = v; };
    const noCamp = V.teens.some(t => t.status !== 'archived' && !V.branches.some(b => b.id === t.homeBranchId));
    fill('#fu-c', '<option value="all">All campuses</option>' + V.branches.map(b => `<option value="${esc(b.id)}">${esc(b.name)}</option>`).join('') + (noCamp ? '<option value="__none">No home campus</option>' : ''), camp());
    $('#fu-m').value = String(f.min); $('#fu-s').value = f.show;
    if (!rows) return setBody('<p class="muted">Loading…</p>');
    const abs = visibleAbs(), bd = birthdays().filter(x => inCampus(x.t));
    const chev = o => `<em class="chev ${o ? 'up' : ''}"></em>`;
    let h = '';
    const aOpen = last.abs = ex.abs === null ? abs.length <= 10 : ex.abs;
    h += `<button class="acc" data-sec="abs"><span>Absentees <small class="muted">${abs.length}</small></span>${chev(aOpen)}</button>`;
    if (aOpen) {
      h += abs.length ? '<div class="fubar"><button class="chip" data-do="viewall">View all details</button></div>' : '<p class="muted">Nobody to follow up. 🎉</p>';
      groupsOf(abs).forEach(g => {
        const key = 'a:' + g.id, gOpen = last.grp[key] = ex.grp[key] ?? g.items.length <= 10;
        h += `<div class="grph"><button class="grpt" data-grp="${esc(key)}"><b>${esc(g.name)}</b><small class="muted">${g.items.length}</small>${chev(gOpen)}</button><button class="chip" data-do="share:a:${esc(g.id)}">Share</button></div>`;
        if (gOpen) h += '<div class="arow h"><span>Name</span><span>Missed</span><span>Last seen</span></div>' + g.items.map(a =>
          `<button class="arow" data-t="${esc(a.t.id)}" data-k="a"><span class="an"><b>${esc(a.t.fullName)}</b>${a.fu ? `<small class="stch">${esc(STATUS[a.fu.status] || a.fu.status)} · ${esc(dShort(new Date(a.fu.at)))}</small>` : ''}</span><span class="am">${a.missed}</span><span class="al">${esc(sShort(a.last))}</span></button>`).join('');
      });
    }
    const bOpen = last.bd = ex.bd === null ? bd.length <= 10 : ex.bd;
    h += `<button class="acc" style="margin-top:12px" data-sec="bd"><span>Birthdays this week <small class="muted">${bd.length}</small></span>${chev(bOpen)}</button>`;
    if (bOpen) {
      if (!bd.length) h += '<p class="muted">No birthdays this week.</p>';
      groupsOf(bd).forEach(g => {
        const key = 'b:' + g.id, gOpen = last.grp[key] = ex.grp[key] ?? g.items.length <= 10;
        h += `<div class="grph"><button class="grpt" data-grp="${esc(key)}"><b>${esc(g.name)}</b><small class="muted">${g.items.length}</small>${chev(gOpen)}</button><button class="chip" data-do="share:b:${esc(g.id)}">Share</button></div>`;
        if (gOpen) h += g.items.map(x => `<button class="arow b" data-t="${esc(x.t.id)}" data-k="b"><span class="an"><b>${esc(x.t.fullName)}</b><small class="muted">turns ${x.age}</small></span><span class="al">${x.d.toDateString() === new Date().toDateString() ? '🎂 Today' : esc(dShort(x.d))}</span></button>`).join('');
      });
    }
    setBody(h);
  }
  function badge() { // number on the tab: teens who still need a follow-up on this phone's campus
    initCampus(); const el = document.getElementById('fu-badge'); if (!el) return;
    const n = rows ? absList().filter(a => inCampus(a.t) && !(a.fu && a.fu.hidden)).length : 0;
    el.textContent = n > 99 ? '99+' : String(n); el.hidden = !n;
  }
  async function load(force) {
    if (loading || (!force && rows && Date.now() - at < 300000)) return;
    if (!navigator.onLine || (!store.auth.code && !store.auth.pin)) return;
    loading = true;
    try {
      const d = await store.read('attendanceRange', { from: todayStr(new Date(Date.now() - WINDOW * 864e5)), to: todayStr(), slim: true });
      rows = d.attendance; at = Date.now();
      try { localStorage.setItem('att.fu', JSON.stringify({ rows, at })); } catch {}
    } catch {}
    loading = false; render(); badge();
  }

  /* ---------- everyone at a glance (full details, search, share) ---------- */
  const links = (p, msg) => p ? `<span class="ph">${esc(p)}</span><a class="mini" href="${tel(p)}">Call</a><a class="mini" href="${esc(waUrl(p, msg))}" target="_blank" rel="noopener">WhatsApp</a>` : '<span class="muted">no number</span>';
  const missMsg = t => `Hi ${t.fullName}, we missed you at Celebteens recently. We hope you're doing well and would love to see you this Sunday!`;
  const guardMsg = t => `Hello, this is Celebteens. We have missed ${t.fullName} at our recent services. We hope all is well and would love to see them again.`;
  function viewAll() {
    let vq = '', vc = 'all';
    const V = getV();
    const list = () => { const w = vq.toLowerCase().split(/\s+/).filter(Boolean);
      return absList().filter(a => (f.show === 'all' || !(a.fu && a.fu.hidden)) && (vc === 'all' || (vc === '__none' ? !V.branches.some(b => b.id === a.t.homeBranchId) : a.t.homeBranchId === vc)) && w.every(x => a.t.fullName.toLowerCase().includes(x))); };
    sheet(`<div class="left"><div class="hd"><h2>All absentees</h2><button class="x" id="va-x" aria-label="Close">✕</button></div>
      <input id="va-q" type="search" placeholder="Search name…" autocomplete="off">
      <select id="va-c"><option value="all">All campuses</option>${V.branches.map(b => `<option value="${esc(b.id)}">${esc(b.name)}</option>`).join('')}</select>
      <div class="selrow"><span class="muted" id="va-n"></span><button class="chip" id="va-share">Share</button></div><div id="va-list"></div></div>`);
    const draw = () => {
      const l = list(); $('#va-n').textContent = `${l.length} teen${l.length === 1 ? '' : 's'}, longest absence first`;
      $('#va-list').innerHTML = l.map(a => `<div class="vcard" data-t="${esc(a.t.id)}"><div class="vh"><b>${esc(a.t.fullName)}</b><small class="muted">${esc(bName(a.t.homeBranchId))}</small></div>
        <div class="vs">Missed ${a.missed} · Last seen ${esc(sShort(a.last))}${a.fu ? ` · <em class="tag">${esc(STATUS[a.fu.status] || a.fu.status)}</em>` : ''}</div>
        <div class="vl"><span class="muted">Teen</span>${links(a.t.phone, missMsg(a.t))}</div>
        <div class="vl"><span class="muted">${esc(a.t.guardianName || 'Guardian')}</span>${links(a.t.guardianPhone, guardMsg(a.t))}</div></div>`).join('') || '<p class="muted">No match.</p>';
    };
    draw();
    $('#va-x').onclick = closeSheet;
    $('#va-q').oninput = e => { vq = e.target.value; draw(); };
    $('#va-c').onchange = e => { vc = e.target.value; draw(); };
    $('#va-share').onclick = () => { const l = list(); if (l.length) shareText(`📋 Absentees (${l.length})\n` + l.map(absLine).join('\n')); };
    $('#va-list').onclick = e => { if (e.target.closest('a')) return; const c = e.target.closest('.vcard'); if (c) detail(c.dataset.t, 'a', viewAll); };
  }

  /* ---------- one teen: contacts, status, history ---------- */
  function detail(id, kind, back) {
    const V = getV(), t = V.teens.find(x => x.id === id); if (!t) return;
    const a = kind === 'a' ? absList().find(x => x.t.id === id) : null, b = kind === 'b' ? birthdays().find(x => x.t.id === id) : null;
    const age = ageOf(t), stat = (k, v) => v ? `<div class="stat"><span class="muted">${k}</span><b>${esc(v)}</b></div>` : '';
    const hist = (V.followups || []).filter(x => x.teenId === id).sort((p, q) => String(q.at).localeCompare(String(p.at))).slice(0, 4);
    const bdMsg = `Happy birthday ${t.fullName}! 🎂 Everyone at Celebteens is celebrating you today. Have a blessed year ahead!`;
    let pick = '';
    sheet(`<div class="left"><div class="hd"><h2>${esc(t.fullName)}</h2><button class="x" id="d-x" aria-label="Close">✕</button></div>
      <p class="muted" style="margin:0 0 6px">${esc([isNaN(age) ? '' : age + ' yrs', t.gender, bName(t.homeBranchId)].filter(Boolean).join(' · '))}</p>
      ${a ? stat('Services missed', a.missed) + stat('Last seen', sShort(a.last)) : ''}${b ? stat('Birthday', dShort(b.d)) + stat('Turns', b.age) : ''}
      <div class="vl big"><span class="muted">Teen</span>${links(t.phone, b ? bdMsg : missMsg(t))}</div>
      <div class="vl big"><span class="muted">${esc(t.guardianName || 'Guardian')}</span>${links(t.guardianPhone, b ? bdMsg : guardMsg(t))}</div>
      ${a ? `<h3>What happened?</h3><div class="stgrid">${Object.entries(STATUS).map(([k, v]) => `<button class="st" data-s="${k}">${esc(v)}</button>`).join('')}</div>
        <input id="d-note" placeholder="Note (optional)" style="margin-top:10px"><button class="btn primary" id="d-save">Save follow-up</button>` : ''}
      ${hist.length ? `<h3>History</h3>${hist.map(x => `<div class="stat"><span>${esc(STATUS[x.status] || x.status)}${x.note ? ' · ' + esc(x.note) : ''}</span><span class="muted">${esc(dShort(new Date(x.at)))}${x.by ? ' · ' + esc(x.by) : ''}</span></div>`).join('')}` : ''}
      ${back ? '<button class="btn ghost" id="d-back">Back</button>' : ''}</div>`);
    $('#d-x').onclick = closeSheet;
    if (back) $('#d-back').onclick = back;
    document.querySelectorAll('.stgrid .st').forEach(s => s.onclick = () => { pick = s.dataset.s; document.querySelectorAll('.stgrid .st').forEach(x => x.classList.toggle('on', x === s)); });
    const save = $('#d-save');
    if (save) save.onclick = () => {
      if (!pick) return toast('Choose what happened first', 'err');
      store.addFollowUp({ teenId: id, status: pick, note: $('#d-note').value.trim() });
      closeSheet(); toast('Follow-up saved');
    };
  }

  return {
    show() { if (!built) build(); render(); load(); badge(); },
    onData() { badge(); if (built && !$('#fu').hidden) render(); },
    load,
  };
}

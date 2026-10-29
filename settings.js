// settings.js — Stage 4: branches, services, team access code, Admin PIN, birthdays this week (Admin only).
const FOOT = '<p class="made">Built with ❤️ by <a href="https://primeflowtechnology.com.ng" target="_blank" rel="noopener">PrimeFlow Technology Limited</a></p>';
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

import { svcBranches } from './store.js';

export function initSettings({ store, getV, esc, toast, sheet, closeSheet, unlock }) {
  const $ = s => document.querySelector(s);
  const isAdmin = () => getV().role === 'admin';
  let last = '', wired = false;
  const bName = id => getV().branches.find(b => b.id === id)?.name || '';

  function birthdays() { // Monday–Sunday of the current week
    const now = new Date(), mon = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (now.getDay() + 6) % 7);
    const days = Array.from({ length: 7 }, (_, i) => new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + i)), out = [];
    getV().teens.forEach(t => {
      const m = String(t.dob || '').match(/^(\d{4})-(\d{2})-(\d{2})/); if (!m || t.status === 'archived') return;
      const d = days.find(x => x.getMonth() + 1 === +m[2] && x.getDate() === +m[3]);
      if (d) out.push({ d, t, age: d.getFullYear() - +m[1] });
    });
    return out.sort((a, b) => a.d - b.d);
  }

  function draw() {
    const V = getV(), root = $('#set');
    if (!wired) { root.onclick = onClick; wired = true; }
    let h;
    if (!isAdmin()) h = `<h2>Settings</h2><p class="muted">Settings need the Admin PIN.</p><button class="btn" data-a="unlock">Unlock (Admin PIN)</button>`;
    else {
      const bd = birthdays();
      h = `<h2>Team access code</h2><div class="src"><input id="s-code" value="${esc(V.teamCode || '')}" placeholder="Team access code"><button class="btn" data-a="code">Save code</button></div>
        <h2>Admin PIN</h2><div class="src"><input id="s-pin" type="password" inputmode="numeric" placeholder="New PIN (4–8 digits)"><button class="btn" data-a="pin">Change PIN</button></div>
        <h2>Branches</h2>${V.branches.map(b => `<button class="row" data-a="b-edit" data-id="${esc(b.id)}"><span><b>${esc(b.name)}</b><small>${esc(b.location)}</small></span><i>Edit</i></button>`).join('')}
        <button class="btn" data-a="b-new">+ Add branch</button>
        <h2>Services</h2>${V.services.map(s => `<button class="row" data-a="s-edit" data-id="${esc(s.id)}"><span><b>${esc(s.name)}</b><small>${esc([s.day, s.time, svcBranches(s).map(bName).join(', ')].filter(Boolean).join(' · '))}</small></span><i>Edit</i></button>`).join('')}
        <button class="btn" data-a="s-new">+ Add service</button>
        <h2>Birthdays this week</h2>${bd.map(x => `<div class="stat"><span><b>${esc(x.t.fullName)}</b></span><span class="muted">${x.d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })} · turns ${x.age}</span></div>`).join('') || '<p class="muted">No birthdays this week.</p>'}`;
    }
    h += FOOT;
    if (h !== last) { root.innerHTML = h; last = h; }
  }

  async function onClick(e) {
    const el = e.target.closest('button'); if (!el) return;
    const a = el.dataset.a, V = getV();
    if (a === 'unlock') unlock();
    else if (a === 'code') secret({ teamCode: $('#s-code').value.trim() }, (v) => store.login(v.teamCode, store.auth.pin, store.auth.usher), 'Team code updated');
    else if (a === 'pin') secret({ newPin: $('#s-pin').value.trim() }, (v) => store.login(store.auth.code, v.newPin, store.auth.usher), 'Admin PIN changed');
    else if (a === 'b-new') branchForm();
    else if (a === 'b-edit') branchForm(V.branches.find(b => b.id === el.dataset.id));
    else if (a === 's-new') svcForm();
    else if (a === 's-edit') svcForm(V.services.find(s => s.id === el.dataset.id));
  }
  async function secret(body, relogin, msg) {
    try { await store.read('setSecrets', body); await relogin(body); toast(msg); } catch (e) { toast(e.message, 'err'); }
  }
  async function save(action, item) {
    try { await store.admin(action, { item }); closeSheet(); toast('Saved'); } catch (e) { toast(e.message, 'err'); }
  }
  function branchForm(b = {}) {
    sheet(`<div class="left"><h2>${b.id ? 'Edit' : 'Add'} branch</h2><input id="b-name" placeholder="Branch name *" value="${esc(b.name || '')}"><input id="b-loc" placeholder="Location" value="${esc(b.location || '')}">
      <button class="btn primary" id="b-save">Save</button><button class="btn ghost" id="b-x">Cancel</button></div>`);
    $('#b-x').onclick = closeSheet;
    $('#b-save').onclick = () => { const name = $('#b-name').value.trim(); if (!name) return toast('Name is required', 'err'); save('saveBranch', { id: b.id, name, location: $('#b-loc').value.trim() }); };
  }
  function svcForm(s = {}) {
    sheet(`<div class="left"><h2>${s.id ? 'Edit' : 'Add'} service</h2><input id="v-name" placeholder="Service name *" value="${esc(s.name || '')}">
      <select id="v-day">${DAYS.map(d => `<option${d === s.day ? ' selected' : ''}>${d}</option>`).join('')}</select>
      <input id="v-time" type="time" value="${esc(s.time || '09:00')}">
      <p class="muted" style="margin:2px 0 8px">Held at (tap to select; none selected = all branches)</p>
      <div class="seg2" id="v-br">${getV().branches.map(b => `<button data-b="${esc(b.id)}" class="${svcBranches(s).includes(b.id) ? 'on' : ''}">${esc(b.name)}</button>`).join('')}</div>
      <button class="btn primary" id="v-save">Save</button><button class="btn ghost" id="v-x">Cancel</button></div>`);
    $('#v-x').onclick = closeSheet;
    document.querySelectorAll('#v-br button').forEach(b => b.onclick = () => b.classList.toggle('on'));
    $('#v-save').onclick = () => {
      const name = $('#v-name').value.trim(); if (!name) return toast('Name is required', 'err');
      save('saveService', { id: s.id, name, day: $('#v-day').value, time: $('#v-time').value, branchId: [...document.querySelectorAll('#v-br button.on')].map(b => b.dataset.b).join(';') });
    };
  }

  return { show: draw, onData() { if (!$('#set').hidden) draw(); } };
}

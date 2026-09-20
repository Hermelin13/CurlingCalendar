const state = {
  config: null,
  events: [],
  users: [],
  month: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
  user: null,
  token: sessionStorage.getItem('cbSession') || '',
  selectedEvent: null,
  attendanceSummary: {},
  filters: new Set(['excel', 'pdf', 'ical', 'manual']),
};

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const pad = (n) => String(n).padStart(2, '0');
const isoDate = (d) => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
const sourceType = (e) => e?.source?.type || 'manual';

function apiUrl(path) {
  const base = String(state.config.apiBase || '').replace(/\/$/, '');
  if (!base || base.includes('TVOJE-SUBDOMENA')) throw new Error('V config/config.json doplň adresu Cloudflare Worker API.');
  return `${base}${path}`;
}

async function loadJson(url) {
  const res = await fetch(`${url}${url.includes('?') ? '&' : '?'}t=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function api(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  const res = await fetch(apiUrl(path), { ...options, headers });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && state.token) logout(false);
    throw new Error(body.error || `API ${res.status}`);
  }
  return body;
}

async function loadEvents() {
  try {
    const body = await api('/api/events', { method: 'GET' });
    return body.events || [];
  } catch (err) {
    console.warn('Cloudflare API není dostupné, zobrazuji statickou kopii events.json.', err);
    showToast('API není dostupné – zobrazuji jen statická data.');
    return loadJson('data/events.json');
  }
}

async function loadUsers() {
  try {
    const body = await api('/api/users', { method: 'GET' });
    state.users = body.users || [];
  } catch (err) {
    console.warn('Uživatele se nepodařilo načíst.', err);
    state.users = [];
  }
  renderUserSelect();
}

async function loadAttendanceSummary() {
  try {
    const body = await api('/api/attendance-summary', { method: 'GET' });
    state.attendanceSummary = body.events || {};
  } catch (err) {
    console.warn('Souhrn účasti se nepodařilo načíst.', err);
    state.attendanceSummary = {};
  }
}

function initials(name='') {
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts.length === 1 ? parts[0].slice(0,2) : parts.slice(0,2).map(p=>p[0]).join('')).toUpperCase();
}

function availabilityHtml(eventId, compact = true) {
  const rows = state.attendanceSummary[eventId] || [];
  if (!rows.length) return '';

  const cls = compact ? 'availability-strip compact' : 'availability-strip full-names';

  return `<span class="${cls}" aria-label="Docházka">${rows.map(r => {
    const status = r.status || 'unknown';
    const label = status === 'yes' ? 'Ano' : status === 'maybe' ? 'Možná' : status === 'no' ? 'Ne' : 'Bez odpovědi';
    const text = compact ? initials(r.name) : r.name;

    return `<span class="availability-person status-${status}" title="${escapeHtml(r.name)}: ${label}" aria-label="${escapeHtml(r.name)}: ${label}">${escapeHtml(text)}</span>`;
  }).join('')}</span>`;
}

function normalizeTime(t) {
  if (!t) return '';
  const [h, m] = t.split(':');
  return `${pad(Number(h))}:${pad(Number(m || 0))}`;
}

function formatDateCZ(dateStr, long = true) {
  const d = new Date(`${dateStr}T12:00:00`);
  return new Intl.DateTimeFormat('cs-CZ', long ? { weekday:'long', day:'numeric', month:'long', year:'numeric' } : { day:'numeric', month:'short' }).format(d);
}

function eventDateTime(e) {
  return new Date(`${e.date}T${normalizeTime(e.startTime) || '00:00'}:00`);
}

function visibleEvents() {
  return state.events.filter(e => state.filters.has(sourceType(e)));
}

function renderCalendar() {
  const month = state.month;
  $('#month-title').textContent = new Intl.DateTimeFormat('cs-CZ', { month:'long', year:'numeric' }).format(month);
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const startOffset = (first.getDay() + 6) % 7;
  const gridStart = new Date(first);
  gridStart.setDate(first.getDate() - startOffset);
  const today = isoDate(new Date());
  const events = visibleEvents();
  const cal = $('#calendar');
  cal.innerHTML = '';

  for (let i=0; i<42; i++) {
    const d = new Date(gridStart);
    d.setDate(gridStart.getDate() + i);
    const key = isoDate(d);
    const day = document.createElement('div');
    day.className = 'day';
    if (d.getMonth() !== month.getMonth()) day.classList.add('outside');
    if (key === today) day.classList.add('today');
    day.innerHTML = `<div class="day-number">${d.getDate()}</div>`;
    events.filter(e => e.date === key).sort((a,b)=>(a.startTime||'').localeCompare(b.startTime||'')).forEach(e => {
      const btn = document.createElement('button');
      btn.className = `event-chip source-${sourceType(e)}`;
      const time = e.allDay ? 'celý den' : (e.startTime || '');
      btn.innerHTML = `<strong>${escapeHtml(e.title)}</strong><small>${escapeHtml(time)}${e.rink ? ` • dráha ${escapeHtml(e.rink)}` : ''}</small>${e.attendanceEnabled ? availabilityHtml(e.id) : ''}`;
      btn.addEventListener('click', () => openEvent(e));
      day.appendChild(btn);
    });
    cal.appendChild(day);
  }
}

function renderUpcoming() {
  const now = new Date(); now.setHours(0,0,0,0);
  const events = visibleEvents().filter(e => eventDateTime(e) >= now).sort((a,b)=>eventDateTime(a)-eventDateTime(b));
  $('#event-count').textContent = events.length;
  const box = $('#upcoming-list'); box.innerHTML = '';
  events.slice(0, 10).forEach(e => {
    const d = new Date(`${e.date}T12:00:00`);
    const btn = document.createElement('button');
    btn.className = 'upcoming-item';
    btn.innerHTML = `<span class="date-box"><strong>${d.getDate()}</strong><span>${new Intl.DateTimeFormat('cs-CZ',{month:'short'}).format(d)}</span></span><span><h3>${escapeHtml(e.title)}</h3><p>${escapeHtml(e.startTime || 'celý den')}${e.location ? ` • ${escapeHtml(e.location)}` : ''}</p>${e.attendanceEnabled ? availabilityHtml(e.id, false) : ''}</span>`;
    btn.addEventListener('click', ()=>openEvent(e)); box.appendChild(btn);
  });
  if (!events.length) box.innerHTML = '<p class="empty">Žádné nadcházející události.</p>';
}

async function openEvent(e) {
  state.selectedEvent = e;
  $('#event-source').textContent = `${sourceLabel(sourceType(e))}${e.competition ? ` • ${e.competition}` : ''}`;
  $('#event-title').textContent = e.title;
  const meta = [
    ['Datum', formatDateCZ(e.date)],
    ['Čas', e.allDay ? 'Celý den' : [e.startTime, e.endTime].filter(Boolean).join('–')],
    ['Místo', e.location || '—'], ['Dráha', e.rink || '—'], ['Soupeř', e.opponent || '—'],
  ];
  $('#event-meta').innerHTML = meta.map(([k,v])=>`<div class="meta-row"><span>${k}</span><strong>${escapeHtml(v)}</strong></div>`).join('');
  $('#event-description').textContent = e.description || '';
  $('#event-description').classList.toggle('hidden', !e.description);

  $('#attendance-section').classList.toggle('hidden', !e.attendanceEnabled);
  if (e.attendanceEnabled) await renderAttendance(e);

  const actions = $('#event-actions'); actions.innerHTML = '';
  if (sourceType(e) === 'manual' && state.user?.canManageTrainings) {
    const del = document.createElement('button');
    del.type = 'button'; del.className = 'button danger'; del.textContent = 'Smazat trénink';
    del.onclick = () => deleteManualEvent(e); actions.appendChild(del);
  }
  $('#event-dialog').showModal();
}

async function renderAttendance(event) {
  const list = $('#attendance-list');
  list.innerHTML = '<p class="empty">Načítám účast…</p>';
  try {
    const body = await api(`/api/attendance?eventId=${encodeURIComponent(event.id)}`, { method:'GET' });
    let yes=0, maybe=0, no=0; list.innerHTML='';
    (body.attendance || []).forEach(rowData => {
      const status = rowData.status || null;
      if (status==='yes') yes++; else if (status==='maybe') maybe++; else if (status==='no') no++;
      const row = document.createElement('div'); row.className='attendance-row';
      row.innerHTML = `<div class="attendance-name">${escapeHtml(rowData.name)}</div>`;
      [['yes','Ano'],['maybe','Možná'],['no','Ne']].forEach(([key,label]) => {
        const b=document.createElement('button'); b.type='button'; b.className=`rsvp ${key} ${status===key?'active':''}`; b.textContent=label;
        const mine = state.user && state.user.id === rowData.id;
        b.disabled = !mine;
        if (mine) b.addEventListener('click', () => saveAttendance(event.id, key));
        row.appendChild(b);
      });
      list.appendChild(row);
    });
    $('#attendance-summary').textContent = `${yes} ano • ${maybe} možná • ${no} ne`;
  } catch (err) {
    list.innerHTML = `<p class="error">${escapeHtml(err.message)}</p>`;
  }
}

async function saveAttendance(eventId, status) {
  if (!state.user || !state.token) return showToast('Nejdřív se přihlas PINem.');
  try {
    await api('/api/attendance', { method:'PUT', body:JSON.stringify({ eventId, status }) });
    showToast('Účast uložena.'); await Promise.all([renderAttendance(state.selectedEvent), loadAttendanceSummary()]); renderAll();
  } catch (err) { showToast(`Uložení se nepovedlo: ${err.message}`); }
}

async function addTraining(formEvent) {
  formEvent.preventDefault();
  if (!state.user?.canManageTrainings) return;
  try {
    $('#training-error').textContent='';
    const body = await api('/api/trainings', { method:'POST', body:JSON.stringify({
      date:$('#training-date').value, startTime:$('#training-start').value,
      endTime:$('#training-end').value || null, location:$('#training-location').value.trim() || null,
      rink:$('#training-rink').value.trim() || null, description:$('#training-description').value.trim() || null,
    })});
    state.events.push(body.event); state.events.sort((a,b)=>eventDateTime(a)-eventDateTime(b)); await loadAttendanceSummary(); renderAll();
    $('#training-dialog').close(); $('#training-form').reset(); $('#training-location').value='Curling Brno'; showToast('Trénink přidán.');
  } catch (err) { $('#training-error').textContent=err.message; }
}

async function deleteManualEvent(event) {
  if (!confirm(`Smazat „${event.title}“ ${formatDateCZ(event.date, false)}?`)) return;
  try {
    await api(`/api/trainings/${encodeURIComponent(event.id)}`, { method:'DELETE' });
    state.events = state.events.filter(e => e.id !== event.id); $('#event-dialog').close(); renderAll(); showToast('Trénink smazán.');
  } catch (err) { showToast(err.message); }
}

async function login(userId, pin) {
  const body = await api('/api/login', { method:'POST', body:JSON.stringify({ userId, pin }) });
  state.token = body.token; state.user = body.user; sessionStorage.setItem('cbSession', body.token); updateLoginUI();
}

async function changePin(currentPin, newPin) {
  await api('/api/change-pin', { method:'POST', body:JSON.stringify({ currentPin, newPin }) });
}

function icsEscape(value='') {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/\r?\n/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
}

function icsDate(date) { return String(date || '').replace(/-/g, ''); }
function icsDateTime(date, time) { return `${icsDate(date)}T${String(time || '00:00').replace(':','')}00`; }

function exportCalendar() {
  const events = visibleEvents().slice().sort((a,b)=>eventDateTime(a)-eventDateTime(b));
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//CB BUTchers//Team Calendar//CS',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:CB BUTchers',
    'X-WR-TIMEZONE:Europe/Prague'
  ];
  for (const e of events) {
    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${icsEscape(e.id)}@cb-butchers`);
    lines.push(`DTSTAMP:${new Date().toISOString().replace(/[-:]/g,'').replace(/\.\d{3}Z$/,'Z')}`);
    if (e.allDay || !e.startTime) {
      lines.push(`DTSTART;VALUE=DATE:${icsDate(e.date)}`);
    } else {
      lines.push(`DTSTART;TZID=Europe/Prague:${icsDateTime(e.date, e.startTime)}`);
      if (e.endTime) lines.push(`DTEND;TZID=Europe/Prague:${icsDateTime(e.date, e.endTime)}`);
    }
    lines.push(`SUMMARY:${icsEscape(e.title)}`);
    if (e.location) lines.push(`LOCATION:${icsEscape(e.location)}`);
    const description = [e.competition, e.opponent ? `Soupeř: ${e.opponent}` : '', e.rink ? `Dráha: ${e.rink}` : '', e.description || ''].filter(Boolean).join('\n');
    if (description) lines.push(`DESCRIPTION:${icsEscape(description)}`);
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  const blob = new Blob([lines.join('\r\n') + '\r\n'], { type:'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'cb-butchers-kalendar.ics'; document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
  showToast(`Exportováno ${events.length} událostí.`);
}

async function restoreLogin() {
  if (!state.token) return updateLoginUI();
  try { const body = await api('/api/me', { method:'GET' }); state.user=body.user; }
  catch (_) { state.token=''; state.user=null; sessionStorage.removeItem('cbSession'); }
  updateLoginUI();
}

function logout(toast=true) {
  state.token=''; state.user=null; sessionStorage.removeItem('cbSession'); updateLoginUI(); if (toast) showToast('Odhlášeno.');
}

function renderUserSelect() {
  const select = $('#user-select');
  select.innerHTML = '<option value="">Vyber své jméno</option>' + state.users.map(u => `<option value="${escapeHtml(u.id)}">${escapeHtml(u.name)}</option>`).join('');
}

function updateLoginUI() {
  $('#login-state').textContent = state.user ? state.user.name : 'Nepřihlášen';
  $('#login-btn').classList.toggle('hidden', !!state.user); $('#logout-btn').classList.toggle('hidden', !state.user);
  $('#change-pin-btn').classList.toggle('hidden', !state.user);
  $('#add-training-btn').classList.toggle('hidden', !state.user?.canManageTrainings);
}

function sourceLabel(type) { return ({excel:'Brněnský pohár', pdf:'MČR / divize', ical:'iCal', manual:'Ruční trénink'})[type] || type; }
function escapeHtml(value='') { return String(value).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#039;','"':'&quot;'}[c])); }
function showToast(text) { const t=$('#toast'); t.textContent=text; t.classList.add('show'); clearTimeout(showToast.timer); showToast.timer=setTimeout(()=>t.classList.remove('show'),3000); }
function renderAll() { renderCalendar(); renderUpcoming(); }

function wireUI() {
  $('#prev-month').onclick=()=>{ state.month=new Date(state.month.getFullYear(),state.month.getMonth()-1,1); renderCalendar(); };
  $('#next-month').onclick=()=>{ state.month=new Date(state.month.getFullYear(),state.month.getMonth()+1,1); renderCalendar(); };
  $('#today-btn').onclick=()=>{ const n=new Date(); state.month=new Date(n.getFullYear(),n.getMonth(),1); renderCalendar(); };
  $$('.filters input').forEach(i=>i.addEventListener('change',()=>{ i.checked?state.filters.add(i.value):state.filters.delete(i.value); renderAll(); }));
  $('#login-btn').onclick=()=>$('#login-dialog').showModal(); $('#logout-btn').onclick=()=>logout();
  $('#export-btn').onclick=exportCalendar;
  $('#change-pin-btn').onclick=()=>{ $('#change-pin-form').reset(); $('#change-pin-error').textContent=''; $('#change-pin-dialog').showModal(); };
  $('#add-training-btn').onclick=()=>{ $('#training-date').value=isoDate(new Date()); $('#training-dialog').showModal(); };
  $$('[data-close]').forEach(b=>b.onclick=()=>document.getElementById(b.dataset.close).close());
  $('#login-form').addEventListener('submit', async e=>{
    e.preventDefault(); $('#login-error').textContent='';
    try { await login($('#user-select').value, $('#pin-input').value); $('#pin-input').value=''; $('#login-dialog').close(); showToast('Přihlášeno.'); }
    catch(err) { $('#login-error').textContent=err.message; }
  });
  $('#change-pin-form').addEventListener('submit', async e=>{
    e.preventDefault(); $('#change-pin-error').textContent='';
    const currentPin=$('#current-pin-input').value, newPin=$('#new-pin-input').value, confirmPin=$('#new-pin-confirm-input').value;
    if (newPin !== confirmPin) return $('#change-pin-error').textContent='Nové PINy se neshodují.';
    if (!/^\d{4,12}$/.test(newPin)) return $('#change-pin-error').textContent='Nový PIN musí mít 4 až 12 číslic.';
    try { await changePin(currentPin, newPin); $('#change-pin-dialog').close(); showToast('PIN byl změněn.'); }
    catch(err) { $('#change-pin-error').textContent=err.message; }
  });
  $('#training-form').addEventListener('submit', addTraining);
}

async function boot() {
  state.config = await loadJson('config/config.json');
  document.title=state.config.siteTitle || document.title; $('#site-title').textContent=state.config.siteTitle || 'Kalendář týmu';
  wireUI();
  await Promise.all([loadUsers(), restoreLogin()]);
  state.events = await loadEvents();
  await loadAttendanceSummary();
  const firstFuture=state.events.filter(e=>eventDateTime(e)>=new Date()).sort((a,b)=>eventDateTime(a)-eventDateTime(b))[0];
  if (firstFuture) { const d=eventDateTime(firstFuture); state.month=new Date(d.getFullYear(),d.getMonth(),1); }
  renderAll();
}

boot().catch(err=>{
  console.error(err);
  document.body.innerHTML=`<main style="padding:30px;font-family:system-ui"><h1>Kalendář se nepodařilo načíst</h1><p>${escapeHtml(err.message)}</p></main>`;
});

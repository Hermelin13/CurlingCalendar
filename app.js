const SESSION_KEY = 'cbSession';

// Přihlášení držíme i po zavření prohlížeče.
// Zároveň jednorázově převedeme starý token ze sessionStorage,
// aby se uživatel po nasazení změny nemusel znovu přihlašovat.
const storedSessionToken =
  localStorage.getItem(SESSION_KEY) ||
  sessionStorage.getItem(SESSION_KEY) ||
  '';

if (storedSessionToken) localStorage.setItem(SESSION_KEY, storedSessionToken);
sessionStorage.removeItem(SESSION_KEY);

const state = {
  config: null,
  events: [],
  users: [],
  month: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
  user: null,
  token: storedSessionToken,
  selectedEvent: null,
  attendanceSummary: {},
  filters: new Set(['excel', 'pdf', 'ical', 'manual']),
};

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const pad = (n) => String(n).padStart(2, '0');
const isoDate = (d) => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
const sourceType = (e) => e?.source?.type || 'manual';
const filterType = (e) => sourceType(e) === 'training_sheet' ? 'manual' : sourceType(e);
const isEliskaTraining = (e) => sourceType(e) === 'training_sheet' && Boolean(e?.eliskaAvailable);


const quickRsvp = {
  timer: null,
  active: false,
  event: null,
  pointerId: null,
  startX: 0,
  startY: 0,
  selected: null,
  picker: null,
  suppressClickUntil: 0,
};

function canQuickRsvp(event) {
  return Boolean(
    event?.attendanceEnabled &&
    !event?.cancelled &&
    state.user &&
    state.token
  );
}

function canCancelEvent(event) {
  if (!state.user || !state.token || event?.cancelled) return false;
  if (state.user.isCaptain) return true;

  const source = sourceType(event);
  return event?.type === 'training' && (source === 'manual' || source === 'training_sheet');
}

function clearQuickRsvpTimer() {
  if (quickRsvp.timer) {
    clearTimeout(quickRsvp.timer);
    quickRsvp.timer = null;
  }
}

function removeQuickRsvpPicker() {
  quickRsvp.picker?.remove();
  quickRsvp.picker = null;
  quickRsvp.selected = null;
  document.body.classList.remove('quick-rsvp-active');
}

function cancelQuickRsvp() {
  clearQuickRsvpTimer();
  if (quickRsvp.active) removeQuickRsvpPicker();
  quickRsvp.active = false;
  quickRsvp.event = null;
  quickRsvp.pointerId = null;
}

function showQuickRsvpPicker(clientX, clientY) {
  removeQuickRsvpPicker();

  const picker = document.createElement('div');
  picker.className = 'quick-rsvp-picker';
  picker.setAttribute('role', 'menu');
  picker.setAttribute('aria-label', 'Rychlá volba účasti');
  picker.innerHTML = `
    <button type="button" class="quick-rsvp-option yes" data-quick-status="yes">Ano</button>
    <button type="button" class="quick-rsvp-option maybe" data-quick-status="maybe">Možná</button>
    <button type="button" class="quick-rsvp-option no" data-quick-status="no">Ne</button>
  `;
  document.body.appendChild(picker);

  // Volbu umístíme nad prst. Na okrajích obrazovky ji posuneme dovnitř.
  const rect = picker.getBoundingClientRect();
  const margin = 10;
  const desiredLeft = clientX - rect.width / 2;
  const left = Math.max(margin, Math.min(window.innerWidth - rect.width - margin, desiredLeft));
  const desiredTop = clientY - rect.height - 42;
  const top = Math.max(margin, Math.min(window.innerHeight - rect.height - margin, desiredTop));

  picker.style.left = `${left}px`;
  picker.style.top = `${top}px`;

  quickRsvp.picker = picker;
  document.body.classList.add('quick-rsvp-active');

  if (navigator.vibrate) navigator.vibrate(18);
}

function updateQuickRsvpSelection(clientX, clientY) {
  if (!quickRsvp.picker) return;

  const target = document.elementFromPoint(clientX, clientY);
  const option = target?.closest?.('[data-quick-status]');
  const status = option && quickRsvp.picker.contains(option)
    ? option.dataset.quickStatus
    : null;

  if (status === quickRsvp.selected) return;
  quickRsvp.selected = status;

  quickRsvp.picker.querySelectorAll('[data-quick-status]').forEach(el => {
    el.classList.toggle('selected', el.dataset.quickStatus === status);
  });

  if (status && navigator.vibrate) navigator.vibrate(8);
}

async function finishQuickRsvp() {
  const event = quickRsvp.event;
  const status = quickRsvp.selected;

  clearQuickRsvpTimer();
  quickRsvp.suppressClickUntil = Date.now() + 700;
  quickRsvp.active = false;
  quickRsvp.event = null;
  quickRsvp.pointerId = null;
  removeQuickRsvpPicker();

  if (!event || !status) {
    showToast('Volba účasti zrušena.');
    return;
  }

  await saveAttendanceQuick(event.id, status);
}

async function saveAttendanceQuick(eventId, status) {
  if (!state.user || !state.token) return showToast('Nejdřív se přihlas PINem.');

  const labels = { yes: 'Ano', maybe: 'Možná', no: 'Ne' };
  try {
    await api('/api/attendance', {
      method: 'PUT',
      body: JSON.stringify({ eventId, status })
    });

    await loadAttendanceSummary();
    renderAll();

    // Pokud je otevřen detail stejné události, aktualizuj i jeho docházku.
    if (state.selectedEvent?.id === eventId && $('#event-dialog')?.open) {
      await renderAttendance(state.selectedEvent);
    }

    showToast(`Účast: ${labels[status]}.`);
  } catch (err) {
    showToast(`Uložení se nepovedlo: ${err.message}`);
  }
}

function attachQuickAttendance(element, event) {
  // Myš necháváme beze změny. Zkratka je určená pro dotyk / stylus.
  element.addEventListener('pointerdown', ev => {
    if (ev.pointerType === 'mouse' || !canQuickRsvp(event)) return;
    if (quickRsvp.active) cancelQuickRsvp();

    quickRsvp.event = event;
    quickRsvp.pointerId = ev.pointerId;
    quickRsvp.startX = ev.clientX;
    quickRsvp.startY = ev.clientY;
    quickRsvp.selected = null;

    clearQuickRsvpTimer();
    quickRsvp.timer = setTimeout(() => {
      quickRsvp.timer = null;
      quickRsvp.active = true;
      quickRsvp.suppressClickUntil = Date.now() + 700;

      try { element.setPointerCapture(ev.pointerId); } catch {}
      showQuickRsvpPicker(quickRsvp.startX, quickRsvp.startY);
    }, 500);
  });

  element.addEventListener('pointermove', ev => {
    if (ev.pointerType === 'mouse' || ev.pointerId !== quickRsvp.pointerId) return;

    const dx = ev.clientX - quickRsvp.startX;
    const dy = ev.clientY - quickRsvp.startY;
    const distance = Math.hypot(dx, dy);

    // Před aktivací povol normální scroll. Větší pohyb long-press zruší.
    if (!quickRsvp.active) {
      if (distance > 12) {
        clearQuickRsvpTimer();
        quickRsvp.event = null;
        quickRsvp.pointerId = null;
      }
      return;
    }

    ev.preventDefault();
    updateQuickRsvpSelection(ev.clientX, ev.clientY);
  });

  element.addEventListener('pointerup', ev => {
    if (ev.pointerType === 'mouse' || ev.pointerId !== quickRsvp.pointerId) return;

    if (!quickRsvp.active) {
      clearQuickRsvpTimer();
      quickRsvp.event = null;
      quickRsvp.pointerId = null;
      return;
    }

    ev.preventDefault();
    finishQuickRsvp();
  });

  element.addEventListener('pointercancel', ev => {
    if (ev.pointerId === quickRsvp.pointerId) cancelQuickRsvp();
  });

  element.addEventListener('contextmenu', ev => {
    if (canQuickRsvp(event)) ev.preventDefault();
  });
}

function openEventFromTap(event) {
  if (Date.now() < quickRsvp.suppressClickUntil) return;
  openEvent(event);
}

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
    return (body.events || []).filter(event => !event?.cancelled);
  } catch (err) {
    console.warn('Cloudflare API není dostupné, zobrazuji statickou kopii events.json.', err);
    showToast('API není dostupné – zobrazuji jen statická data.');
    const fallback = await loadJson('data/events.json');
    return (fallback || []).filter(event => !event?.cancelled);
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

function isMatch(e) {
  return e?.type === 'match' || Boolean(e?.opponent);
}

function resultBadgeHtml(e) {
  if (!e?.result) return '';
  const a = Number(e.result.ourScore);
  const b = Number(e.result.opponentScore);
  const outcome = a > b ? 'win' : a < b ? 'loss' : 'draw';
  return `<span class="result-badge result-${outcome}" title="Výsledek">${a}:${b}</span>`;
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
  return state.events.filter(e => !e?.cancelled && state.filters.has(filterType(e)));
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
      btn.className = `event-chip source-${sourceType(e)}${isEliskaTraining(e) ? ' training-eliska' : ''}${e.cancelled ? ' cancelled' : ''}`;
      const time = e.allDay ? 'celý den' : ([e.startTime, e.endTime].filter(Boolean).join('–') || '');
      btn.innerHTML = `<strong>${e.cancelled ? '<span class="cancelled-badge">ZRUŠENO</span> ' : ''}${escapeHtml(e.title)} ${resultBadgeHtml(e)}</strong><small>${escapeHtml(time)}${e.rink ? ` • dráha ${escapeHtml(e.rink)}` : ''}</small>${e.attendanceEnabled && !e.cancelled ? availabilityHtml(e.id) : ''}`;
      attachQuickAttendance(btn, e);
      btn.addEventListener('click', () => openEventFromTap(e));
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
    btn.className = `upcoming-item${isEliskaTraining(e) ? ' training-eliska' : ''}${e.cancelled ? ' cancelled' : ''}`;
    btn.innerHTML = `<span class="date-box"><strong>${d.getDate()}</strong><span>${new Intl.DateTimeFormat('cs-CZ',{month:'short'}).format(d)}</span></span><span><h3>${e.cancelled ? '<span class="cancelled-badge">ZRUŠENO</span> ' : ''}${escapeHtml(e.title)} ${resultBadgeHtml(e)}</h3><p>${escapeHtml(e.allDay ? 'celý den' : ([e.startTime, e.endTime].filter(Boolean).join('–') || 'celý den'))}${e.location ? ` • ${escapeHtml(e.location)}` : ''}</p>${e.attendanceEnabled && !e.cancelled ? availabilityHtml(e.id, false) : ''}</span>`;
    attachQuickAttendance(btn, e);
    btn.addEventListener('click', ()=>openEventFromTap(e));
    box.appendChild(btn);
  });
  if (!events.length) box.innerHTML = '<p class="empty">Žádné nadcházející události.</p>';
}

async function openEvent(e) {
  state.selectedEvent = e;
  $('#event-source').textContent = `${sourceLabel(sourceType(e))}${e.competition ? ` • ${e.competition}` : ''}`;
  $('#event-title').textContent = e.title;
  const meta = [
    ...(e.cancelled ? [['Stav', 'ZRUŠENO']] : []),
    ['Datum', formatDateCZ(e.date)],
    ['Čas', e.allDay ? 'Celý den' : [e.startTime, e.endTime].filter(Boolean).join('–')],
    ['Místo', e.location || '—'], ['Dráha', e.rink || '—'], ['Soupeř', e.opponent || '—'],
  ];
  $('#event-meta').innerHTML = meta.map(([k,v])=>`<div class="meta-row"><span>${k}</span><strong>${escapeHtml(v)}</strong></div>`).join('');
  const eventDescription = $('#event-description');
  eventDescription.textContent = e.description || '';
  eventDescription.classList.toggle('hidden', !e.description);

  renderResultSection(e);

  $('#attendance-section').classList.toggle('hidden', !e.attendanceEnabled || e.cancelled);
  if (e.attendanceEnabled && !e.cancelled) await renderAttendance(e);

  const actions = $('#event-actions'); actions.innerHTML = '';
  if (canCancelEvent(e)) {
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'button danger';
    cancel.textContent = state.user?.isCaptain ? 'Zrušit událost' : 'Zrušit trénink';
    cancel.onclick = () => cancelEvent(e);
    actions.appendChild(cancel);
  }
  $('#event-dialog').showModal();
}


function renderResultSection(event) {
  const section = $('#result-section');
  const readonly = $('#result-readonly');
  const editor = $('#result-editor');

  const match = isMatch(event);
  section.classList.toggle('hidden', !match);
  if (!match) return;

  if (event.result) {
    const a = Number(event.result.ourScore);
    const b = Number(event.result.opponentScore);
    const outcomeText = a > b ? 'Výhra' : a < b ? 'Prohra' : 'Remíza';
    readonly.innerHTML = `
      <div class="result-display">
        <strong>${a}:${b}</strong>
        <span>${outcomeText}${event.result.note ? ` • ${escapeHtml(event.result.note)}` : ''}</span>
      </div>`;
  } else {
    readonly.innerHTML = '<p class="small-muted">Výsledek zatím není zadaný.</p>';
  }

  editor.classList.toggle('hidden', !state.user || event.cancelled);
  if (state.user && !event.cancelled) {
    $('#result-our-score').value = event.result?.ourScore ?? '';
    $('#result-opponent-score').value = event.result?.opponentScore ?? '';
    $('#result-note').value = event.result?.note || '';
    $('#result-delete-btn').classList.toggle('hidden', !event.result);
    $('#result-error').textContent = '';
  }
}

async function saveResult(event) {
  if (!state.user) return showToast('Nejdřív se přihlas.');

  const ourScoreInput = $('#result-our-score');
  const opponentScoreInput = $('#result-opponent-score');
  const resultNote = $('#result-note');
  const resultError = $('#result-error');

  const ourScore = Number(ourScoreInput.value);
  const opponentScore = Number(opponentScoreInput.value);
  const note = resultNote.value.trim();

  if (!Number.isInteger(ourScore) || !Number.isInteger(opponentScore) ||
      ourScore < 0 || ourScore > 99 || opponentScore < 0 || opponentScore > 99) {
    resultError.textContent = 'Zadej skóre 0–99 pro oba týmy.';
    return;
  }

  try {
    const body = await api('/api/results', {
      method: 'PUT',
      body: JSON.stringify({ eventId: event.id, ourScore, opponentScore, note })
    });
    event.result = body.result;
    renderResultSection(event);
    renderAll();
    showToast('Výsledek uložen.');
  } catch (err) {
    resultError.textContent = err.message;
  }
}

async function deleteResult(event) {
  if (!state.user || !event.result) return;
  if (!confirm(`Smazat výsledek zápasu „${event.title}“?`)) return;
  try {
    await api(`/api/results?eventId=${encodeURIComponent(event.id)}`, { method: 'DELETE' });
    delete event.result;
    renderResultSection(event);
    renderAll();
    showToast('Výsledek smazán.');
  } catch (err) {
    $('#result-error').textContent = err.message;
  }
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
        const canEdit = Boolean(mine || state.user?.isCaptain);
        b.disabled = !canEdit;
        if (canEdit) {
          b.addEventListener('click', () => saveAttendance(event.id, key, rowData.id));
          if (!mine && state.user?.isCaptain) b.title = `Upravit účast: ${rowData.name}`;
        }
        row.appendChild(b);
      });
      list.appendChild(row);
    });
    $('#attendance-summary').textContent = `${yes} ano • ${maybe} možná • ${no} ne`;
  } catch (err) {
    list.innerHTML = `<p class="error">${escapeHtml(err.message)}</p>`;
  }
}

async function saveAttendance(eventId, status, userId = state.user?.id) {
  if (!state.user || !state.token) return showToast('Nejdřív se přihlas PINem.');
  try {
    await api('/api/attendance', {
      method:'PUT',
      body:JSON.stringify({ eventId, status, userId })
    });
    showToast('Účast uložena.'); await Promise.all([renderAttendance(state.selectedEvent), loadAttendanceSummary()]); renderAll();
  } catch (err) { showToast(`Uložení se nepovedlo: ${err.message}`); }
}

async function addTraining(formEvent) {
  formEvent.preventDefault();
  if (!state.user?.canManageTrainings) return;

  const trainingError = $('#training-error');
  const trainingLocation = $('#training-location');
  const trainingDate = $('#training-date');
  const trainingStart = $('#training-start');
  const trainingEnd = $('#training-end');
  const trainingRink = $('#training-rink');
  const trainingDescription = $('#training-description');
  const trainingDialog = $('#training-dialog');
  const trainingForm = $('#training-form');

  try {
    trainingError.textContent = '';

    const body = await api('/api/trainings', {
      method: 'POST',
      body: JSON.stringify({
        date: trainingDate.value,
        startTime: trainingStart.value,
        endTime: trainingEnd.value || null,
        location: trainingLocation.value.trim() || null,
        rink: trainingRink.value.trim() || null,
        description: trainingDescription.value.trim() || null,
      })
    });

    state.events.push(body.event);
    state.events.sort((a, b) => eventDateTime(a) - eventDateTime(b));
    await loadAttendanceSummary();
    renderAll();

    trainingDialog.close();
    trainingForm.reset();
    trainingLocation.value = 'Curling Brno';
    showToast('Trénink přidán.');
  } catch (err) {
    trainingError.textContent = err.message;
  }
}

async function cancelEvent(event) {
  if (!canCancelEvent(event)) {
    return showToast('Tuto událost nemáš oprávnění zrušit.');
  }

  const label = event.type === 'training' ? 'trénink' : 'událost';
  if (!confirm(`Opravdu zrušit ${label} „${event.title}“ ${formatDateCZ(event.date, false)}? Zůstane uložený v databázi a import ho už neobnoví.`)) return;

  try {
    await api('/api/events/cancel', {
      method: 'PUT',
      body: JSON.stringify({ eventId: event.id })
    });

    state.events = state.events.filter(item => item.id !== event.id);
    state.selectedEvent = null;

    await loadAttendanceSummary();
    $('#event-dialog').close();
    renderAll();
    showToast('Událost byla zrušena a zmizela z kalendáře.');
  } catch (err) {
    showToast(err.message);
  }
}

async function login(userId, pin) {
  const body = await api('/api/login', { method:'POST', body:JSON.stringify({ userId, pin }) });
  state.token = body.token; state.user = body.user; localStorage.setItem(SESSION_KEY, body.token); updateLoginUI();
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
  catch (_) {
    state.token='';
    state.user=null;
    localStorage.removeItem(SESSION_KEY);
    sessionStorage.removeItem(SESSION_KEY);
  }
  updateLoginUI();
}

function logout(toast=true) {
  state.token='';
  state.user=null;
  localStorage.removeItem(SESSION_KEY);
  sessionStorage.removeItem(SESSION_KEY);
  updateLoginUI();
  if (toast) showToast('Odhlášeno.');
}

function renderUserSelect() {
  const select = $('#user-select');
  select.innerHTML = '<option value="">Vyber své jméno</option>' + state.users.map(u => `<option value="${escapeHtml(u.id)}">${escapeHtml(u.name)}</option>`).join('');
}

function attendanceStatusLabel(status) {
  return ({
    yes: 'Ano',
    maybe: 'Možná',
    no: 'Ne',
    unknown: '—'
  })[status || 'unknown'] || '—';
}

function renderAttendanceOverview() {
  const host = $('#attendance-overview');
  if (!host) return;

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const events = state.events
    .filter(event =>
      !event?.cancelled &&
      event?.attendanceEnabled &&
      eventDateTime(event) >= today
    )
    .sort((a, b) => eventDateTime(a) - eventDateTime(b));

  const users = [...state.users].sort((a, b) =>
    String(a.name || '').localeCompare(String(b.name || ''), 'cs')
  );

  if (!events.length || !users.length) {
    host.innerHTML = '<p class="empty">Není co zobrazit.</p>';
    return;
  }

  const head = users
    .map(user => `<th scope="col">${escapeHtml(user.name)}</th>`)
    .join('');

  const rows = events.map(event => {
    const attendance = new Map(
      (state.attendanceSummary[event.id] || []).map(row => [
        String(row.userId || row.id || ''),
        row.status || 'unknown'
      ])
    );

    // Souhrn API vrací jméno i user_id. Starší odpověď může mít jen id.
    const byName = new Map(
      (state.attendanceSummary[event.id] || []).map(row => [
        String(row.name || '').trim().toLocaleLowerCase('cs'),
        row.status || 'unknown'
      ])
    );

    const cells = users.map(user => {
      const status =
        attendance.get(String(user.id)) ||
        byName.get(String(user.name || '').trim().toLocaleLowerCase('cs')) ||
        'unknown';
      return `<td><span class="attendance-table-status status-${status}" title="${escapeHtml(attendanceStatusLabel(status))}">${escapeHtml(attendanceStatusLabel(status))}</span></td>`;
    }).join('');

    const when = `${formatDateCZ(event.date, false)}${event.allDay ? '' : ` ${escapeHtml([event.startTime, event.endTime].filter(Boolean).join('–'))}`}`;

    return `<tr>
      <th scope="row">
        <strong>${escapeHtml(event.title || 'Událost')}</strong>
        <small>${when}</small>
      </th>
      ${cells}
    </tr>`;
  }).join('');

  host.innerHTML = `
    <div class="attendance-table-scroll">
      <table class="attendance-overview-table">
        <thead>
          <tr>
            <th scope="col">Událost</th>
            ${head}
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

function openAttendanceOverview() {
  renderAttendanceOverview();
  $('#attendance-table-dialog').showModal();
}

function closeTopMenus() {
  $$('.menu-dropdown[open]').forEach(menu => menu.removeAttribute('open'));
}

function updateLoginUI() {
  const loggedIn = Boolean(state.user);
  const userMenu = $('#user-menu');
  $('#login-btn').classList.toggle('hidden', loggedIn);
  userMenu.classList.toggle('hidden', !loggedIn);

  if (loggedIn) {
    $('#login-state').textContent = state.user.name;
  } else {
    userMenu.removeAttribute('open');
  }

  $('#change-pin-btn').classList.toggle('hidden', !loggedIn);
  $('#add-training-btn').classList.toggle('hidden', !state.user?.canManageTrainings);

  const mobileState = $('#mobile-user-state');
  if (mobileState) mobileState.textContent = loggedIn ? state.user.name : 'Přihlásit';
  $('#mobile-login-btn')?.classList.toggle('hidden', loggedIn);
  $('#mobile-logout-btn')?.classList.toggle('hidden', !loggedIn);
  $('#mobile-change-pin-btn')?.classList.toggle('hidden', !loggedIn);
  $('#mobile-add-training-btn')?.classList.toggle('hidden', !state.user?.canManageTrainings);
}

function sourceLabel(type) { return ({excel:'Brněnský pohár', pdf:'MČR / divize', ical:'iCal', manual:'Ruční trénink', training_sheet:'Tréninkový kalendář'})[type] || type; }
function escapeHtml(value='') { return String(value).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#039;','"':'&quot;'}[c])); }
function showToast(text) { const t=$('#toast'); t.textContent=text; t.classList.add('show'); clearTimeout(showToast.timer); showToast.timer=setTimeout(()=>t.classList.remove('show'),3000); }
function renderAll() { renderCalendar(); renderUpcoming(); }

function wireUI() {
  const prevMonthBtn = $('#prev-month');
  const nextMonthBtn = $('#next-month');
  const todayBtn = $('#today-btn');
  const filterInputs = $$('.filters input');

  const loginBtn = $('#login-btn');
  const logoutBtn = $('#logout-btn');
  const loginDialog = $('#login-dialog');
  const loginForm = $('#login-form');
  const loginError = $('#login-error');
  const userSelect = $('#user-select');
  const pinInput = $('#pin-input');

  const exportBtn = $('#export-btn');
  const changePinBtn = $('#change-pin-btn');
  const changePinForm = $('#change-pin-form');
  const changePinError = $('#change-pin-error');
  const changePinDialog = $('#change-pin-dialog');
  const currentPinInput = $('#current-pin-input');
  const newPinInput = $('#new-pin-input');
  const newPinConfirmInput = $('#new-pin-confirm-input');

  const addTrainingBtn = $('#add-training-btn');
  const trainingDate = $('#training-date');
  const trainingDialog = $('#training-dialog');
  const trainingForm = $('#training-form');
  const attendanceTableBtn = $('#attendance-table-btn');

  const mobileMenuDialog = $('#mobile-menu-dialog');
  const mobileMenuBtn = $('#mobile-menu-btn');
  const mobileMenuClose = $('#mobile-menu-close');
  const mobileLoginBtn = $('#mobile-login-btn');
  const mobileLogoutBtn = $('#mobile-logout-btn');
  const mobileAddTrainingBtn = $('#mobile-add-training-btn');
  const mobileExportBtn = $('#mobile-export-btn');
  const mobileChangePinBtn = $('#mobile-change-pin-btn');
  const mobileAttendanceTableBtn = $('#mobile-attendance-table-btn');

  const resultSaveBtn = $('#result-save-btn');
  const resultDeleteBtn = $('#result-delete-btn');

  const menuDropdowns = $$('.menu-dropdown');
  const menuSummaries = $$('.menu-dropdown > summary');
  const menuLinks = $$('.menu-link');
  const mobileMenuLinks = $$('#mobile-menu-dialog a');
  const closeButtons = $$('[data-close]');

  prevMonthBtn.onclick = () => {
    state.month = new Date(state.month.getFullYear(), state.month.getMonth() - 1, 1);
    renderCalendar();
  };

  nextMonthBtn.onclick = () => {
    state.month = new Date(state.month.getFullYear(), state.month.getMonth() + 1, 1);
    renderCalendar();
  };

  todayBtn.onclick = () => {
    const now = new Date();
    state.month = new Date(now.getFullYear(), now.getMonth(), 1);
    renderCalendar();
  };

  filterInputs.forEach(input => {
    input.addEventListener('change', () => {
      if (input.checked) state.filters.add(input.value);
      else state.filters.delete(input.value);

      filterInputs.forEach(other => {
        if (other.value === input.value) other.checked = input.checked;
      });

      renderAll();
    });
  });

  loginBtn.onclick = () => loginDialog.showModal();
  logoutBtn.onclick = () => {
    closeTopMenus();
    logout();
  };

  menuSummaries.forEach(summary => {
    summary.addEventListener('click', () => {
      const current = summary.parentElement;
      menuDropdowns.forEach(other => {
        if (other !== current && other.open) other.removeAttribute('open');
      });
    });
  });

  menuDropdowns.forEach(menu => {
    menu.addEventListener('toggle', () => {
      if (!menu.open) return;
      menuDropdowns.forEach(other => {
        if (other !== menu && other.open) other.removeAttribute('open');
      });
    });
  });

  menuLinks.forEach(link => {
    link.addEventListener('click', closeTopMenus);
  });

  document.addEventListener('click', event => {
    if (!event.target.closest('.menu-dropdown')) closeTopMenus();
  });

  exportBtn.onclick = () => {
    closeTopMenus();
    exportCalendar();
  };

  const openChangePinDialog = () => {
    changePinForm.reset();
    changePinError.textContent = '';
    changePinDialog.showModal();
  };

  changePinBtn.onclick = () => {
    closeTopMenus();
    openChangePinDialog();
  };

  const openTrainingDialog = () => {
    trainingDate.value = isoDate(new Date());
    trainingDialog.showModal();
  };

  addTrainingBtn.onclick = () => {
    closeTopMenus();
    openTrainingDialog();
  };

  attendanceTableBtn.onclick = () => {
    closeTopMenus();
    openAttendanceOverview();
  };

  const openMobileMenu = () => {
    mobileMenuDialog.classList.add('is-open');
    mobileMenuDialog.setAttribute('aria-hidden', 'false');
    document.body.classList.add('mobile-menu-open');
  };

  const closeMobileMenu = () => {
    mobileMenuDialog.classList.remove('is-open');
    mobileMenuDialog.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('mobile-menu-open');
  };

  mobileMenuBtn.onclick = openMobileMenu;
  mobileMenuClose.onclick = closeMobileMenu;

  mobileMenuDialog.addEventListener('click', event => {
    if (event.target === mobileMenuDialog) closeMobileMenu();
  });

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && mobileMenuDialog.classList.contains('is-open')) {
      closeMobileMenu();
    }
  });

  mobileLoginBtn.onclick = () => {
    closeMobileMenu();
    loginDialog.showModal();
  };

  mobileLogoutBtn.onclick = () => {
    closeMobileMenu();
    logout();
  };

  mobileAddTrainingBtn.onclick = () => {
    closeMobileMenu();
    openTrainingDialog();
  };

  mobileExportBtn.onclick = () => {
    closeMobileMenu();
    exportCalendar();
  };

  mobileChangePinBtn.onclick = () => {
    closeMobileMenu();
    openChangePinDialog();
  };

  mobileAttendanceTableBtn.onclick = () => {
    closeMobileMenu();
    openAttendanceOverview();
  };

  mobileMenuLinks.forEach(link => {
    link.addEventListener('click', closeMobileMenu);
  });

  closeButtons.forEach(button => {
    button.onclick = () => document.getElementById(button.dataset.close).close();
  });

  loginForm.addEventListener('submit', async event => {
    event.preventDefault();
    loginError.textContent = '';

    try {
      await login(userSelect.value, pinInput.value);
      pinInput.value = '';
      loginDialog.close();
      showToast('Přihlášeno.');
    } catch (error) {
      loginError.textContent = error.message;
    }
  });

  changePinForm.addEventListener('submit', async event => {
    event.preventDefault();
    changePinError.textContent = '';

    const currentPin = currentPinInput.value;
    const newPin = newPinInput.value;
    const confirmPin = newPinConfirmInput.value;

    if (newPin !== confirmPin) {
      changePinError.textContent = 'Nové PINy se neshodují.';
      return;
    }

    if (!/^\d{4,12}$/.test(newPin)) {
      changePinError.textContent = 'Nový PIN musí mít 4 až 12 číslic.';
      return;
    }

    try {
      await changePin(currentPin, newPin);
      changePinDialog.close();
      showToast('PIN byl změněn.');
    } catch (error) {
      changePinError.textContent = error.message;
    }
  });

  trainingForm.addEventListener('submit', addTraining);
  resultSaveBtn.addEventListener('click', () => state.selectedEvent && saveResult(state.selectedEvent));
  resultDeleteBtn.addEventListener('click', () => state.selectedEvent && deleteResult(state.selectedEvent));
}

async function boot() {
  state.config = await loadJson('config/config.json');
  document.title=state.config.siteTitle || document.title; $('#site-title').textContent=state.config.siteTitle || 'Kalendář týmu';
  wireUI();
  await Promise.all([loadUsers(), restoreLogin()]);
  state.events = (await loadEvents()).filter(event => !event?.cancelled);
  await loadAttendanceSummary();
  const firstFuture=state.events.filter(e=>eventDateTime(e)>=new Date()).sort((a,b)=>eventDateTime(a)-eventDateTime(b))[0];
  if (firstFuture) { const d=eventDateTime(firstFuture); state.month=new Date(d.getFullYear(),d.getMonth(),1); }
  renderAll();
}

boot().catch(err=>{
  console.error(err);
  document.body.innerHTML=`<main style="padding:30px;font-family:system-ui"><h1>Kalendář se nepodařilo načíst</h1><p>${escapeHtml(err.message)}</p></main>`;
});

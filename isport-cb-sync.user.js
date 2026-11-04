// ==UserScript==
// @name         CB Butchers – synchronizace iSport
// @namespace    cb-butchers
// @version      1.0.0
// @description  Synchronizuje obsazenost a naše rezervace Curling Brno do kalendáře CB Butchers.
// @match        https://curlingbrno.isportsystem.cz/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(() => {
  'use strict';

  const SPORT_ID = '18';
  const ISPORT_ENDPOINT = '/ajax/ajax.schema.php';
  const API_BASE = 'https://cb-butchers-api.adamdaliborj.workers.dev';
  const BUTTON_ID = 'cb-butchers-sync-btn';
  const OVERLAY_ID = 'cb-butchers-sync-overlay';
  const DEFAULT_WEEKS = 8;

  // Jména se porovnávají pouze uvnitř tohoto prohlížeče.
  // Do našeho API se posílá jen kind='ours' nebo kind='busy'.
  const TEAM_ALIASES = ['jurcik', 'ulrich', 'sovadina', 'sima', 'prokes', 'hegr'];

  let apiToken = '';

  const pad = value => String(value).padStart(2, '0');

  function normalizeText(value) {
    return String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLocaleLowerCase('cs')
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function normalizeTime(value) {
    const match = String(value || '').trim().match(/^(\d{1,2}):(\d{2})$/);
    if (!match) return null;
    return `${pad(Number(match[1]))}:${pad(Number(match[2]))}`;
  }

  function isoLocalDate(date) {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  function startOfWeek(date = new Date()) {
    const result = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const day = result.getDay() || 7;
    result.setDate(result.getDate() - day + 1);
    result.setHours(0, 0, 0, 0);
    return result;
  }

  function addDays(date, count) {
    const result = new Date(date);
    result.setDate(result.getDate() + count);
    return result;
  }

  function parseTimeRange(value) {
    const box = document.createElement('div');
    box.innerHTML = String(value || '');
    const text = (box.textContent || '').replace(/\s+/g, ' ').trim();
    const match = text.match(/(\d{1,2}:\d{2})\s*[–—-]\s*(\d{1,2}:\d{2})/);
    if (!match) return null;
    const startTime = normalizeTime(match[1]);
    const endTime = normalizeTime(match[2]);
    return startTime && endTime ? { startTime, endTime } : null;
  }

  function isOurReservation(titleHtml) {
    const box = document.createElement('div');
    box.innerHTML = String(titleHtml || '');
    const normalized = ` ${normalizeText(box.textContent || '')} `;
    return TEAM_ALIASES.some(alias => normalized.includes(` ${alias} `));
  }

  function findDate(container) {
    const dated = container.querySelector(
      '.schemaSaunaContainer[data-date], ' +
      '.schemaParamContainer[data-date], ' +
      '.schemaErrorContainer[data-date], ' +
      '.schemaButtonContainer[data-date], ' +
      '[data-date]'
    );
    return dated?.dataset?.date || null;
  }

  function parseSchedule(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const dates = new Set();
    const lanes = new Set();
    const slotsByKey = new Map();

    for (const container of doc.querySelectorAll('.schemaFullContainer')) {
      const date = findDate(container);
      const table = container.querySelector('table.schema');
      if (!date || !table) continue;
      dates.add(date);

      for (const row of table.querySelectorAll('tr[class*="trSchemaLane_"]')) {
        const lane = row.querySelector('th')?.textContent?.replace(/\s+/g, ' ').trim();
        if (!lane) continue;
        lanes.add(lane);

        for (const cell of row.querySelectorAll('td.booked')) {
          const title = cell.getAttribute('title') || '';
          const time = parseTimeRange(title);
          if (!time) continue;

          const slot = {
            date,
            lane,
            startTime: time.startTime,
            endTime: time.endTime,
            kind: isOurReservation(title) ? 'ours' : 'busy'
          };
          const key = `${slot.date}|${slot.lane}|${slot.startTime}|${slot.endTime}`;
          const previous = slotsByKey.get(key);
          if (!previous || slot.kind === 'ours') slotsByKey.set(key, slot);
        }
      }
    }

    return {
      dates: [...dates].sort(),
      lanes: [...lanes].sort((a, b) => a.localeCompare(b, 'cs')),
      slots: [...slotsByKey.values()]
    };
  }

  async function loadWeek(date) {
    const body = new URLSearchParams({
      id_sport: SPORT_ID,
      day: String(date.getDate()),
      month: String(date.getMonth() + 1),
      year: String(date.getFullYear()),
      event: 'init',
      timetableWidth: String(Math.max(643, window.innerWidth || 643)),
      noticeCheckRequested: '0',
      noticeCheck: '0',
      idNoticeCheck: '0'
    });

    const response = await fetch(ISPORT_ENDPOINT, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest'
      },
      body
    });

    if (!response.ok) throw new Error(`iSport vrátil HTTP ${response.status}.`);
    const html = await response.text();
    if (!html.includes('schema') || !html.includes('ČLENOVÉ')) {
      throw new Error('iSport nevrátil členský rozpis. Zkontroluj přihlášení.');
    }

    const parsed = parseSchedule(html);
    if (!parsed.dates.length || !parsed.lanes.length) {
      throw new Error('V odpovědi iSportu jsem nenašel dny nebo dráhy.');
    }
    return parsed;
  }

  async function api(path, options = {}) {
    const response = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(apiToken ? { Authorization: `Bearer ${apiToken}` } : {}),
        ...(options.headers || {})
      }
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `API vrátil HTTP ${response.status}.`);
    return body;
  }

  async function loginAdam(pin) {
    const body = await api('/api/login', {
      method: 'POST',
      body: JSON.stringify({ userId: 'adam', pin })
    });
    if (!body.token || !body.user?.isCaptain) throw new Error('Přihlášení Adama se nepodařilo.');
    apiToken = body.token;
  }

  async function syncWeeks(weeks, progress) {
    const monday = startOfWeek(new Date());
    const totals = {
      weeks: 0,
      slots: 0,
      ours: 0,
      activated: 0,
      skippedExisting: 0,
      skippedCancelled: 0
    };

    for (let index = 0; index < weeks; index++) {
      const weekDate = addDays(monday, index * 7);
      progress(`Načítám ${index + 1}/${weeks}: týden od ${isoLocalDate(weekDate)}…`);
      const snapshot = await loadWeek(weekDate);

      const result = await api('/api/isport-sync', {
        method: 'POST',
        body: JSON.stringify({
          weekStart: isoLocalDate(weekDate),
          dates: snapshot.dates,
          lanes: snapshot.lanes,
          slots: snapshot.slots
        })
      });

      totals.weeks += 1;
      totals.slots += Number(result.slots || 0);
      totals.ours += Number(result.ourReservations || 0);
      totals.activated += Number(result.activated || 0);
      totals.skippedExisting += Number(result.skippedExisting || 0);
      totals.skippedCancelled += Number(result.skippedCancelled || 0);

      // Malá pauza, ať zbytečně neposíláme mnoho requestů naráz.
      await new Promise(resolve => setTimeout(resolve, 180));
    }

    return totals;
  }

  function ensureOverlay() {
    let overlay = document.getElementById(OVERLAY_ID);
    if (overlay) return overlay;

    overlay = document.createElement('div');
    overlay.id = OVERLAY_ID;
    overlay.style.cssText = [
      'position:fixed', 'inset:0', 'z-index:2147483646', 'display:none',
      'background:rgba(0,0,0,.58)', 'padding:20px', 'box-sizing:border-box', 'overflow:auto'
    ].join(';');

    overlay.innerHTML = `
      <div style="max-width:560px;margin:30px auto;background:#fff;color:#111;border-radius:16px;padding:18px;box-shadow:0 20px 60px rgba(0,0,0,.35);font:14px/1.45 system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;">
          <div>
            <div style="font-size:12px;font-weight:800;color:#667085;text-transform:uppercase;letter-spacing:.08em;">CB Butchers</div>
            <h2 style="margin:3px 0 0;font-size:22px;">Synchronizace iSport</h2>
          </div>
          <button id="cb-sync-close" type="button" style="border:0;background:#eef2f6;border-radius:999px;width:40px;height:40px;font-size:24px;cursor:pointer;">×</button>
        </div>

        <p style="color:#475467;">Načte obsazenost z tvé přihlášené členské stránky. Jména rezervujících se do našeho API neposílají.</p>

        <div style="display:grid;gap:12px;margin-top:14px;">
          <label style="display:grid;gap:5px;font-weight:700;">
            Adamův PIN do CB kalendáře
            <input id="cb-sync-pin" type="password" inputmode="numeric" autocomplete="off" style="padding:10px;border:1px solid #cfd7e3;border-radius:9px;font:inherit;">
          </label>
          <label style="display:grid;gap:5px;font-weight:700;">
            Kolik týdnů dopředu
            <input id="cb-sync-weeks" type="number" min="1" max="20" value="${DEFAULT_WEEKS}" style="padding:10px;border:1px solid #cfd7e3;border-radius:9px;font:inherit;">
          </label>
          <button id="cb-sync-run" type="button" style="padding:11px 14px;border:0;border-radius:9px;background:#194a8d;color:#fff;font:inherit;font-weight:800;cursor:pointer;">Synchronizovat</button>
        </div>

        <p id="cb-sync-status" style="margin:14px 0 0;color:#475467;white-space:pre-line;"></p>
      </div>
    `;

    document.body.appendChild(overlay);
    overlay.querySelector('#cb-sync-close').onclick = () => { overlay.style.display = 'none'; };
    overlay.addEventListener('click', event => {
      if (event.target === overlay) overlay.style.display = 'none';
    });

    overlay.querySelector('#cb-sync-run').onclick = async () => {
      const runButton = overlay.querySelector('#cb-sync-run');
      const pinInput = overlay.querySelector('#cb-sync-pin');
      const weeksInput = overlay.querySelector('#cb-sync-weeks');
      const status = overlay.querySelector('#cb-sync-status');
      const pin = pinInput.value.trim();
      const weeks = Math.max(1, Math.min(20, Number(weeksInput.value || DEFAULT_WEEKS)));

      if (!/^\d{4,12}$/.test(pin)) {
        status.textContent = 'Zadej Adamův PIN (4–12 číslic).';
        return;
      }

      runButton.disabled = true;
      pinInput.disabled = true;
      weeksInput.disabled = true;
      apiToken = '';

      try {
        status.textContent = 'Přihlašuji Adama do CB API…';
        await loginAdam(pin);
        pinInput.value = '';

        const totals = await syncWeeks(weeks, text => { status.textContent = text; });
        status.textContent = [
          'Hotovo.',
          `Týdnů: ${totals.weeks}`,
          `Obsazených bloků: ${totals.slots}`,
          `Našich rezervací: ${totals.ours}`,
          `Nově/aktivně iSport tréninků: ${totals.activated}`,
          `Přeskočeno – už bylo v kalendáři: ${totals.skippedExisting}`,
          `Přeskočeno – ručně zrušené: ${totals.skippedCancelled}`
        ].join('\n');
      } catch (error) {
        status.textContent = `Chyba: ${error?.message || error}`;
      } finally {
        apiToken = '';
        runButton.disabled = false;
        pinInput.disabled = false;
        weeksInput.disabled = false;
      }
    };

    return overlay;
  }

  function addButton() {
    if (document.getElementById(BUTTON_ID)) return;
    const button = document.createElement('button');
    button.id = BUTTON_ID;
    button.type = 'button';
    button.textContent = '🥌 CB synchronizace';
    button.style.cssText = [
      'position:fixed', 'right:16px', 'bottom:16px', 'z-index:2147483645',
      'padding:11px 14px', 'border:0', 'border-radius:999px',
      'background:#194a8d', 'color:#fff',
      'font:700 14px system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
      'box-shadow:0 8px 24px rgba(0,0,0,.25)', 'cursor:pointer'
    ].join(';');
    button.onclick = () => { ensureOverlay().style.display = 'block'; };
    document.body.appendChild(button);
  }

  addButton();
})();

// ==UserScript==
// @name         CB BUTchers – iSport test rezervací
// @namespace    cb-butchers
// @version      0.3.0
// @description  Test čtení rezervací Curling Brno. Jména porovnává jen lokálně a do výstupu je nedává.
// @match        https://curlingbrno.isportsystem.cz/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(() => {
  'use strict';

  const SPORT_ID = '18';
  const ENDPOINT = '/ajax/ajax.schema.php';
  const BUTTON_ID = 'cb-butchers-isport-test-btn';
  const OVERLAY_ID = 'cb-butchers-isport-test-overlay';

  // Pouze lokální porovnání v prohlížeči. Do JSONu se žádné jméno nedává.
  const TEAM_ALIASES = [
    'jurcik',
    'ulrich',
    'sovadina',
    'sima',
    'prokes',
    'hegr'
  ];

  function isoLocalDate(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function htmlText(value) {
    const box = document.createElement('div');
    box.innerHTML = String(value || '');
    return box.textContent || '';
  }

  function parseTimeRange(value) {
    const text = htmlText(value).replace(/\s+/g, ' ').trim();
    const match = text.match(/(\d{1,2}:\d{2})\s*[–—-]\s*(\d{1,2}:\d{2})/);
    if (!match) return null;
    return { start: match[1], end: match[2] };
  }

  function normalizeText(value) {
    return String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLocaleLowerCase('cs')
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function classifyOwner(titleHtml) {
    const box = document.createElement('div');
    box.innerHTML = String(titleHtml || '');

    const owner = box.querySelector('strong')?.textContent?.trim() || '';
    if (!owner) return { ownerVisible: false, ourTeam: false };

    const normalizedOwner = ` ${normalizeText(owner)} `;
    const ourTeam = TEAM_ALIASES.some(alias => {
      const normalizedAlias = normalizeText(alias);
      return normalizedAlias && normalizedOwner.includes(` ${normalizedAlias} `);
    });

    return { ownerVisible: true, ourTeam };
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
    const result = [];

    const containers = [...doc.querySelectorAll('.schemaFullContainer')];

    for (const container of containers) {
      const date = findDate(container);
      const table = container.querySelector('table.schema');

      if (!date || !table) continue;

      const laneRows = [...table.querySelectorAll('tr[class*="trSchemaLane_"]')];

      for (const row of laneRows) {
        const lane = row.querySelector('th')?.textContent?.replace(/\s+/g, ' ').trim() || 'Neznámá dráha';

        const bookedCells = [...row.querySelectorAll('td.booked')];

        for (const cell of bookedCells) {
          const title = cell.getAttribute('title') || '';
          const time = parseTimeRange(title);

          if (!time) continue;

          const owner = classifyOwner(title);

          result.push({
            date,
            lane,
            start: time.start,
            end: time.end,
            ownerVisible: owner.ownerVisible,
            ourTeam: owner.ourTeam,
            related: cell.classList.contains('bookedRelated'),
            span: Number(cell.getAttribute('colspan') || 1)
          });
        }
      }
    }

    return result;
  }

  async function loadWeek(startDate) {
    const [year, month, day] = startDate.split('-');

    const body = new URLSearchParams({
      id_sport: SPORT_ID,
      day: String(Number(day)),
      month: String(Number(month)),
      year,
      event: 'init',
      timetableWidth: String(Math.max(643, window.innerWidth || 643)),
      noticeCheckRequested: '0',
      noticeCheck: '0',
      idNoticeCheck: '0'
    });

    const response = await fetch(ENDPOINT, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest'
      },
      body
    });

    if (!response.ok) {
      throw new Error(`iSport vrátil HTTP ${response.status}.`);
    }

    const text = await response.text();

    if (!text.includes('schema') || !text.includes('ČLENOVÉ')) {
      throw new Error(
        'Odpověď nevypadá jako členský rozpis. Zkontroluj, že jsi v iSportu přihlášený.'
      );
    }

    return parseSchedule(text);
  }

  function safeReservationRows(items) {
    return items.map(item => ({
      datum: item.date,
      draha: item.lane,
      od: item.start,
      do: item.end,
      typ: item.ourTeam
        ? 'nas-tym'
        : (item.ownerVisible ? 'cizi-se-jmenem' : 'obsazeno'),
      navazujiciBunka: item.related
    }));
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function ensureOverlay() {
    let overlay = document.getElementById(OVERLAY_ID);
    if (overlay) return overlay;

    overlay = document.createElement('div');
    overlay.id = OVERLAY_ID;
    overlay.style.cssText = [
      'position:fixed',
      'inset:0',
      'z-index:2147483646',
      'display:none',
      'background:rgba(0,0,0,.58)',
      'padding:20px',
      'box-sizing:border-box',
      'overflow:auto'
    ].join(';');

    overlay.innerHTML = `
      <div style="
        max-width:900px;
        margin:20px auto;
        background:#fff;
        color:#111;
        border-radius:16px;
        padding:18px;
        box-shadow:0 20px 60px rgba(0,0,0,.35);
        font:14px/1.45 system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
      ">
        <div style="display:flex;align-items:center;gap:12px;justify-content:space-between;">
          <div>
            <div style="font-size:12px;font-weight:800;color:#667085;text-transform:uppercase;letter-spacing:.08em;">CB BUTchers</div>
            <h2 style="margin:3px 0 0;font-size:22px;">Test iSport rezervací</h2>
          </div>
          <button id="cb-isport-close" type="button" style="
            border:0;background:#eef2f6;border-radius:999px;width:40px;height:40px;
            font-size:24px;cursor:pointer;
          ">×</button>
        </div>

        <div style="display:flex;gap:10px;align-items:end;flex-wrap:wrap;margin-top:18px;">
          <label style="display:grid;gap:5px;font-weight:700;">
            Začátek týdne
            <input id="cb-isport-date" type="date" style="
              padding:9px 10px;border:1px solid #cfd7e3;border-radius:9px;font:inherit;
            ">
          </label>
          <button id="cb-isport-load" type="button" style="
            padding:10px 14px;border:0;border-radius:9px;background:#194a8d;color:#fff;
            font:inherit;font-weight:800;cursor:pointer;
          ">Načíst týden</button>
        </div>

        <p id="cb-isport-status" style="margin:14px 0;color:#475467;"></p>

        <div id="cb-isport-summary"></div>

        <details style="margin-top:14px;">
          <summary style="cursor:pointer;font-weight:800;">Bezpečný technický JSON</summary>
          <p style="color:#667085;">
            Neobsahuje jména, telefony, e-maily ani cookies. Jméno se jen lokálně porovná se seznamem členů týmu a ven jde pouze typ nas-tym / cizi-se-jmenem / obsazeno.
          </p>
          <textarea id="cb-isport-json" readonly style="
            width:100%;height:280px;box-sizing:border-box;padding:10px;border:1px solid #cfd7e3;
            border-radius:10px;font:12px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace;
          "></textarea>
          <button id="cb-isport-copy" type="button" style="
            margin-top:8px;padding:9px 12px;border:1px solid #cfd7e3;border-radius:9px;
            background:#fff;font:inherit;font-weight:750;cursor:pointer;
          ">Kopírovat JSON</button>
        </details>
      </div>
    `;

    document.body.appendChild(overlay);

    overlay.querySelector('#cb-isport-close').onclick = () => {
      overlay.style.display = 'none';
    };

    overlay.addEventListener('click', event => {
      if (event.target === overlay) overlay.style.display = 'none';
    });

    overlay.querySelector('#cb-isport-date').value = isoLocalDate();

    overlay.querySelector('#cb-isport-copy').onclick = async () => {
      const textarea = overlay.querySelector('#cb-isport-json');
      try {
        await navigator.clipboard.writeText(textarea.value);
        overlay.querySelector('#cb-isport-status').textContent = 'JSON zkopírován do schránky.';
      } catch (_) {
        textarea.focus();
        textarea.select();
        document.execCommand('copy');
      }
    };

    overlay.querySelector('#cb-isport-load').onclick = async () => {
      const status = overlay.querySelector('#cb-isport-status');
      const summary = overlay.querySelector('#cb-isport-summary');
      const textarea = overlay.querySelector('#cb-isport-json');
      const startDate = overlay.querySelector('#cb-isport-date').value;

      status.textContent = 'Načítám iSport…';
      summary.innerHTML = '';
      textarea.value = '';

      try {
        const raw = await loadWeek(startDate);
        const safe = safeReservationRows(raw);

        const ours = safe.filter(item => item.typ === 'nas-tym').length;
        const otherNamed = safe.filter(item => item.typ === 'cizi-se-jmenem').length;
        const anonymous = safe.filter(item => item.typ === 'obsazeno').length;
        const dates = [...new Set(safe.map(item => item.datum))].sort();
        const lanes = [...new Set(safe.map(item => item.draha))].sort();

        status.textContent = `Hotovo: ${safe.length} obsazených bloků.`;

        summary.innerHTML = `
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(135px,1fr));gap:10px;">
            <div style="background:#f6f8fb;border-radius:10px;padding:12px;">
              <strong style="font-size:22px;">${safe.length}</strong><br>obsazených buněk/bloků
            </div>
            <div style="background:#f6f8fb;border-radius:10px;padding:12px;">
              <strong style="font-size:22px;">${ours}</strong><br>našich rezervací
            </div>
            <div style="background:#f6f8fb;border-radius:10px;padding:12px;">
              <strong style="font-size:22px;">${otherNamed}</strong><br>cizích rezervací se jménem
            </div>
            <div style="background:#f6f8fb;border-radius:10px;padding:12px;">
              <strong style="font-size:22px;">${anonymous}</strong><br>anonymních „Obsazeno“
            </div>
            <div style="background:#f6f8fb;border-radius:10px;padding:12px;">
              <strong style="font-size:22px;">${dates.length}</strong><br>dnů v odpovědi
            </div>
          </div>

          <p style="margin:14px 0 6px;"><strong>Dny:</strong> ${escapeHtml(dates.join(', ') || '—')}</p>
          <p style="margin:6px 0;"><strong>Dráhy:</strong> ${escapeHtml(lanes.join(', ') || '—')}</p>
        `;

        textarea.value = JSON.stringify({
          test: 'CB BUTchers iSport parser',
          startDate,
          count: safe.length,
          ourTeamCount: ours,
          otherNamedCount: otherNamed,
          anonymousCount: anonymous,
          dates,
          lanes,
          slots: safe
        }, null, 2);
      } catch (error) {
        status.textContent = `Chyba: ${error?.message || error}`;
      }
    };

    return overlay;
  }

  function addButton() {
    if (document.getElementById(BUTTON_ID)) return;

    const button = document.createElement('button');
    button.id = BUTTON_ID;
    button.type = 'button';
    button.textContent = '🥌 CB test rezervací';
    button.style.cssText = [
      'position:fixed',
      'right:16px',
      'bottom:16px',
      'z-index:2147483645',
      'padding:11px 14px',
      'border:0',
      'border-radius:999px',
      'background:#194a8d',
      'color:#fff',
      'font:700 14px system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
      'box-shadow:0 8px 24px rgba(0,0,0,.25)',
      'cursor:pointer'
    ].join(';');

    button.onclick = () => {
      const overlay = ensureOverlay();
      overlay.style.display = 'block';
    };

    document.body.appendChild(button);
  }

  addButton();
})();

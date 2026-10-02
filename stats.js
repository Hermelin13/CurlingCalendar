const $ = (s) => document.querySelector(s);

async function loadJson(url) {
  const res = await fetch(`${url}${url.includes('?') ? '&' : '?'}t=${Date.now()}`, { cache:'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function escapeHtml(value='') {
  return String(value).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#039;','"':'&quot;'}[c]));
}

function formatDateCZ(dateStr) {
  const d = new Date(`${dateStr}T12:00:00`);
  return new Intl.DateTimeFormat('cs-CZ', { day:'numeric', month:'numeric', year:'numeric' }).format(d);
}

function outcomeLabel(outcome) {
  return outcome === 'win' ? 'V' : outcome === 'loss' ? 'P' : 'R';
}

function outcomeText(outcome) {
  return outcome === 'win' ? 'Výhra' : outcome === 'loss' ? 'Prohra' : 'Remíza';
}

function render(data) {
  const s = data.summary || {};
  const cards = [
    ['Zápasy', s.played ?? 0],
    ['Výhry', s.wins ?? 0],
    ['Prohry', s.losses ?? 0],
    ['Remízy', s.draws ?? 0],
    ['Úspěšnost', `${s.winPct ?? 0} %`],
    ['Skóre', `${s.pointsFor ?? 0}:${s.pointsAgainst ?? 0}`],
    ['Rozdíl', `${(s.difference ?? 0) > 0 ? '+' : ''}${s.difference ?? 0}`],
  ];
  $('#summary-cards').innerHTML = cards.map(([label,value]) =>
    `<article class="stat-card"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></article>`
  ).join('');

  $('#form-strip').innerHTML = (data.form || []).length
    ? data.form.map(o => `<span class="form-dot form-${o}" title="${outcomeText(o)}">${outcomeLabel(o)}</span>`).join('')
    : '<span class="small-muted">Zatím bez výsledků</span>';

  $('#competition-body').innerHTML = (data.competitions || []).map(c => `
    <tr>
      <td data-label="Soutěž"><strong>${escapeHtml(c.competition)}</strong></td>
      <td data-label="Zápasy">${c.played}</td>
      <td data-label="Výhry">${c.wins}</td>
      <td data-label="Remízy">${c.draws}</td>
      <td data-label="Prohry">${c.losses}</td>
      <td data-label="Skóre">${c.pointsFor}:${c.pointsAgainst}</td>
      <td data-label="+/-">${c.difference > 0 ? '+' : ''}${c.difference}</td>
      <td data-label="Úspěšnost">${c.winPct} %</td>
    </tr>`).join('') || '<tr><td colspan="8" class="empty">Zatím nejsou zadané žádné výsledky.</td></tr>';

  $('#matches-body').innerHTML = (data.matches || []).map(m => `
    <tr class="match-row">
      <td data-label="Datum">${escapeHtml(formatDateCZ(m.date))}</td>
      <td data-label="Soupeř"><strong>${escapeHtml(m.opponent)}</strong></td>
      <td data-label="Soutěž">${escapeHtml(m.competition)}</td>
      <td data-label="Výsledek"><span class="match-result result-${m.outcome}">${m.ourScore}:${m.opponentScore}</span></td>
      <td data-label="Místo">${escapeHtml(m.location || '—')}</td>
    </tr>`).join('') || '<tr><td colspan="5" class="empty">Zatím nejsou zadané žádné výsledky.</td></tr>';
}

async function boot() {
  try {
    const config = await loadJson('config/config.json');
    const base = String(config.apiBase || '').replace(/\/$/, '');
    if (!base) throw new Error('Chybí apiBase v config/config.json.');
    const res = await fetch(`${base}/api/stats`, { cache:'no-store' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `API ${res.status}`);
    render(body);
  } catch (err) {
    $('#stats-error').textContent = `Statistiky se nepodařilo načíst: ${err.message}`;
  }
}

boot();

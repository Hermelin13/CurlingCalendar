const encoder = new TextEncoder();
const importedSources = new Set(['excel', 'pdf', 'ical']);

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      const origin = request.headers.get('Origin');
      const cors = corsHeaders(origin, env);
      if (!cors.allowed) return json({ error: 'Origin není povolen.' }, 403, cors.headers);
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors.headers });

      if (url.pathname === '/api/health' && request.method === 'GET') {
        return json({ ok: true }, 200, cors.headers);
      }
      if (url.pathname === '/api/users' && request.method === 'GET') {
        return listUsers(env, cors.headers);
      }
      if (url.pathname === '/api/login' && request.method === 'POST') {
        return login(request, env, cors.headers);
      }
      if (url.pathname === '/api/me' && request.method === 'GET') {
        const auth = await requireUser(request, env);
        if (auth.error) return json({ error: auth.error }, auth.status, cors.headers);
        return json({ user: publicUser(auth.user) }, 200, cors.headers);
      }
      if (url.pathname === '/api/change-pin' && request.method === 'POST') {
        const auth = await requireUser(request, env);
        if (auth.error) return json({ error: auth.error }, auth.status, cors.headers);
        return changePin(request, env, auth.user, cors.headers);
      }
      if (url.pathname === '/api/events' && request.method === 'GET') {
        return listEvents(env, cors.headers);
      }
      if (url.pathname === '/api/results' && request.method === 'PUT') {
        const auth = await requireUser(request, env);
        if (auth.error) return json({ error: auth.error }, auth.status, cors.headers);
        return saveResult(request, env, auth.user, cors.headers);
      }
      if (url.pathname === '/api/results' && request.method === 'DELETE') {
        const auth = await requireUser(request, env);
        if (auth.error) return json({ error: auth.error }, auth.status, cors.headers);
        return deleteResult(url, env, cors.headers);
      }
      if (url.pathname === '/api/stats' && request.method === 'GET') {
        return getStats(env, cors.headers);
      }
      if (url.pathname === '/api/attendance' && request.method === 'GET') {
        return getAttendance(url, env, cors.headers);
      }
      if (url.pathname === '/api/attendance-summary' && request.method === 'GET') {
        return getAttendanceSummary(env, cors.headers);
      }
      if (url.pathname === '/api/attendance' && request.method === 'PUT') {
        const auth = await requireUser(request, env);
        if (auth.error) return json({ error: auth.error }, auth.status, cors.headers);
        return saveAttendance(request, env, auth.user, cors.headers);
      }
      if (url.pathname === '/api/trainings' && request.method === 'POST') {
        const auth = await requireUser(request, env);
        if (auth.error) return json({ error: auth.error }, auth.status, cors.headers);
        if (!auth.user.can_manage_trainings) return json({ error: 'Nemáš oprávnění přidávat tréninky.' }, 403, cors.headers);
        return addTraining(request, env, auth.user, cors.headers);
      }
      if (url.pathname.startsWith('/api/trainings/') && request.method === 'DELETE') {
        const auth = await requireUser(request, env);
        if (auth.error) return json({ error: auth.error }, auth.status, cors.headers);
        if (!auth.user.can_manage_trainings) return json({ error: 'Nemáš oprávnění mazat tréninky.' }, 403, cors.headers);
        const id = decodeURIComponent(url.pathname.slice('/api/trainings/'.length));
        return deleteTraining(id, env, cors.headers);
      }
      if (url.pathname === '/api/import' && request.method === 'POST') {
        if (!secretBearerMatches(request, env.IMPORT_TOKEN)) return json({ error: 'Neplatný import token.' }, 401, cors.headers);
        return importEvents(request, env, cors.headers);
      }
      if (url.pathname === '/api/admin/users' && request.method === 'POST') {
        if (!secretBearerMatches(request, env.ADMIN_TOKEN)) return json({ error: 'Neplatný admin token.' }, 401, cors.headers);
        return upsertUsers(request, env, cors.headers);
      }
      return json({ error: 'Nenalezeno.' }, 404, cors.headers);
    } catch (err) {
      console.error(err);
      return json({ error: 'Interní chyba API.' }, 500);
    }
  }
};

function corsHeaders(origin, env) {
  const allowed = String(env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const ok = !origin || allowed.includes('*') || allowed.includes(origin);
  const headers = {
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
  if (origin && ok) headers['Access-Control-Allow-Origin'] = origin;
  return { allowed: ok, headers };
}

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra }
  });
}

function publicUser(u) {
  return { id: u.id, name: u.name, canManageTrainings: Boolean(u.can_manage_trainings) };
}

function db(env) {
  const database = env.DB || env.cb_butchers_calendar;
  if (!database) throw new Error('Chybí D1 binding (DB / cb_butchers_calendar).');
  return database;
}

async function listUsers(env, headers) {
  const { results } = await db(env).prepare('SELECT id, name, can_manage_trainings FROM users WHERE active=1 ORDER BY name').all();
  return json({ users: results.map(publicUser) }, 200, headers);
}

async function login(request, env, headers) {
  const body = await readJson(request);
  const userId = String(body.userId || '').trim();
  const pin = String(body.pin || '');
  if (!userId || !/^\d{4,12}$/.test(pin)) return json({ error: 'Vyber uživatele a zadej PIN.' }, 400, headers);
  const user = await db(env).prepare('SELECT * FROM users WHERE id=? AND active=1').bind(userId).first();
  if (!user) return json({ error: 'Neplatné jméno nebo PIN.' }, 401, headers);
  const hash = await hashPin(pin, user.pin_salt, env.PIN_PEPPER);
  if (!timingSafeEqual(hash, user.pin_hash)) return json({ error: 'Neplatné jméno nebo PIN.' }, 401, headers);
  const token = await signSession({ sub: user.id, exp: Math.floor(Date.now()/1000) + 60*60*24*14 }, env.SESSION_SECRET);
  return json({ token, user: publicUser(user) }, 200, headers);
}

async function changePin(request, env, authUser, headers) {
  const body = await readJson(request);
  const currentPin = String(body.currentPin || '');
  const newPin = String(body.newPin || '');
  if (!/^\d{4,12}$/.test(currentPin) || !/^\d{4,12}$/.test(newPin)) {
    return json({ error: 'PIN musí mít 4 až 12 číslic.' }, 400, headers);
  }
  if (currentPin === newPin) return json({ error: 'Nový PIN musí být jiný než současný.' }, 400, headers);
  const user = await db(env).prepare('SELECT id, pin_salt, pin_hash FROM users WHERE id=? AND active=1').bind(authUser.id).first();
  if (!user) return json({ error: 'Uživatel neexistuje.' }, 404, headers);
  const currentHash = await hashPin(currentPin, user.pin_salt, env.PIN_PEPPER);
  if (!timingSafeEqual(currentHash, user.pin_hash)) return json({ error: 'Současný PIN není správný.' }, 401, headers);
  const salt = crypto.randomUUID();
  const hash = await hashPin(newPin, salt, env.PIN_PEPPER);
  await db(env).prepare('UPDATE users SET pin_salt=?, pin_hash=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').bind(salt, hash, authUser.id).run();
  return json({ ok: true }, 200, headers);
}

async function requireUser(request, env) {
  const token = bearerToken(request);
  if (!token) return { error: 'Nejdřív se přihlas.', status: 401 };
  const payload = await verifySession(token, env.SESSION_SECRET);
  if (!payload?.sub) return { error: 'Přihlášení vypršelo. Přihlas se znovu.', status: 401 };
  const user = await db(env).prepare('SELECT id, name, can_manage_trainings, active FROM users WHERE id=?').bind(payload.sub).first();
  if (!user || !user.active) return { error: 'Uživatel není aktivní.', status: 401 };
  return { user };
}

async function listEvents(env, headers) {
  const { results } = await db(env).prepare(`
    SELECT e.payload_json, r.our_score, r.opponent_score, r.note, r.updated_at AS result_updated_at
    FROM events e
           LEFT JOIN match_results r ON r.event_id=e.id
    ORDER BY e.date, COALESCE(e.start_time, ''), e.id
  `).all();

  const events = results.map(row => {
    const event = JSON.parse(row.payload_json);
    if (row.our_score !== null && row.our_score !== undefined &&
        row.opponent_score !== null && row.opponent_score !== undefined) {
      event.result = {
        ourScore: Number(row.our_score),
        opponentScore: Number(row.opponent_score),
        note: row.note || null,
        updatedAt: row.result_updated_at || null
      };
    }
    return event;
  });

  return json({ events }, 200, headers);
}


async function saveResult(request, env, user, headers) {
  const body = await readJson(request);
  const eventId = String(body.eventId || '').trim();
  const ourScore = Number(body.ourScore);
  const opponentScore = Number(body.opponentScore);
  const note = clean(body.note, 500);

  if (!eventId || !Number.isInteger(ourScore) || !Number.isInteger(opponentScore) ||
      ourScore < 0 || ourScore > 99 || opponentScore < 0 || opponentScore > 99) {
    return json({ error: 'Zadej platný výsledek 0–99 pro oba týmy.' }, 400, headers);
  }

  const row = await db(env).prepare('SELECT payload_json FROM events WHERE id=?').bind(eventId).first();
  if (!row) return json({ error: 'Zápas neexistuje.' }, 404, headers);

  let event;
  try { event = JSON.parse(row.payload_json); }
  catch { return json({ error: 'Událost má neplatná data.' }, 500, headers); }

  if (event.type !== 'match' && !event.opponent) {
    return json({ error: 'Výsledek lze zadat jen k zápasu.' }, 400, headers);
  }

  await db(env).prepare(`
    INSERT INTO match_results(event_id,our_score,opponent_score,note,updated_by,updated_at)
    VALUES(?,?,?,?,?,CURRENT_TIMESTAMP)
      ON CONFLICT(event_id) DO UPDATE SET
      our_score=excluded.our_score,
                                 opponent_score=excluded.opponent_score,
                                 note=excluded.note,
                                 updated_by=excluded.updated_by,
                                 updated_at=CURRENT_TIMESTAMP
  `).bind(eventId, ourScore, opponentScore, note, user.id).run();

  return json({
    ok: true,
    result: { ourScore, opponentScore, note }
  }, 200, headers);
}

async function deleteResult(url, env, headers) {
  const eventId = String(url.searchParams.get('eventId') || '').trim();
  if (!eventId) return json({ error: 'Chybí eventId.' }, 400, headers);
  await db(env).prepare('DELETE FROM match_results WHERE event_id=?').bind(eventId).run();
  return json({ ok: true }, 200, headers);
}

async function getStats(env, headers) {
  const { results } = await db(env).prepare(`
    SELECT e.id, e.date, e.start_time, e.payload_json,
           r.our_score, r.opponent_score, r.note, r.updated_at
    FROM events e
           JOIN match_results r ON r.event_id=e.id
    ORDER BY e.date DESC, COALESCE(e.start_time, '') DESC, e.id DESC
  `).all();

  const matches = [];
  const competitions = {};

  let wins = 0, losses = 0, draws = 0, pointsFor = 0, pointsAgainst = 0;

  for (const row of results) {
    let event;
    try { event = JSON.parse(row.payload_json); }
    catch { continue; }

    const ourScore = Number(row.our_score);
    const opponentScore = Number(row.opponent_score);
    const outcome = ourScore > opponentScore ? 'win' : ourScore < opponentScore ? 'loss' : 'draw';

    if (outcome === 'win') wins++;
    else if (outcome === 'loss') losses++;
    else draws++;

    pointsFor += ourScore;
    pointsAgainst += opponentScore;

    const competition = event.competition || sourceStatsLabel(event?.source?.type);
    if (!competitions[competition]) {
      competitions[competition] = {
        competition,
        played: 0, wins: 0, losses: 0, draws: 0,
        pointsFor: 0, pointsAgainst: 0
      };
    }
    const c = competitions[competition];
    c.played++;
    c[outcome === 'win' ? 'wins' : outcome === 'loss' ? 'losses' : 'draws']++;
    c.pointsFor += ourScore;
    c.pointsAgainst += opponentScore;

    matches.push({
      id: event.id,
      date: event.date,
      startTime: event.startTime || null,
      opponent: event.opponent || '—',
      competition,
      location: event.location || null,
      ourScore,
      opponentScore,
      outcome,
      note: row.note || null
    });
  }

  const played = matches.length;
  const competitionRows = Object.values(competitions)
      .map(c => ({
        ...c,
        difference: c.pointsFor - c.pointsAgainst,
        winPct: c.played ? Math.round((c.wins / c.played) * 1000) / 10 : 0
      }))
      .sort((a,b) => b.played - a.played || a.competition.localeCompare(b.competition, 'cs'));

  return json({
    summary: {
      played,
      wins,
      losses,
      draws,
      pointsFor,
      pointsAgainst,
      difference: pointsFor - pointsAgainst,
      winPct: played ? Math.round((wins / played) * 1000) / 10 : 0
    },
    form: matches.slice(0, 5).map(m => m.outcome),
    competitions: competitionRows,
    matches
  }, 200, headers);
}

function sourceStatsLabel(type) {
  return ({ excel: 'Brněnský pohár', pdf: 'MČR / divize', ical: 'iCal', manual: 'Ruční' })[type] || 'Ostatní';
}

async function getAttendance(url, env, headers) {
  const eventId = url.searchParams.get('eventId');
  if (!eventId) return json({ error: 'Chybí eventId.' }, 400, headers);
  const event = await db(env).prepare('SELECT attendance_enabled FROM events WHERE id=?').bind(eventId).first();
  if (!event) return json({ error: 'Událost neexistuje.' }, 404, headers);
  const { results } = await db(env).prepare(`
    SELECT u.id, u.name, a.status, a.updated_at
    FROM users u
           LEFT JOIN attendance a ON a.user_id=u.id AND a.event_id=?
    WHERE u.active=1
    ORDER BY u.name
  `).bind(eventId).all();
  return json({ attendance: results }, 200, headers);
}

async function getAttendanceSummary(env, headers) {
  const { results } = await db(env).prepare(`
    SELECT e.id AS event_id, u.id AS user_id, u.name, a.status
    FROM events e
           CROSS JOIN users u
           LEFT JOIN attendance a ON a.event_id=e.id AND a.user_id=u.id
    WHERE e.attendance_enabled=1 AND u.active=1
    ORDER BY e.date, e.start_time, u.name
  `).all();
  const events = {};
  for (const row of results) {
    if (!events[row.event_id]) events[row.event_id] = [];
    events[row.event_id].push({ id: row.user_id, name: row.name, status: row.status || null });
  }
  return json({ events }, 200, headers);
}

async function saveAttendance(request, env, user, headers) {
  const body = await readJson(request);
  const eventId = String(body.eventId || '').trim();
  const status = String(body.status || '').trim();
  if (!eventId || !['yes','maybe','no'].includes(status)) return json({ error: 'Neplatná odpověď.' }, 400, headers);
  const event = await db(env).prepare('SELECT attendance_enabled FROM events WHERE id=?').bind(eventId).first();
  if (!event || !event.attendance_enabled) return json({ error: 'U této události není docházka povolena.' }, 400, headers);
  await db(env).prepare(`
    INSERT INTO attendance(event_id,user_id,status,updated_at) VALUES(?,?,?,CURRENT_TIMESTAMP)
      ON CONFLICT(event_id,user_id) DO UPDATE SET status=excluded.status, updated_at=CURRENT_TIMESTAMP
  `).bind(eventId, user.id, status).run();
  return json({ ok: true, status }, 200, headers);
}

async function addTraining(request, env, user, headers) {
  const body = await readJson(request);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(body.date || '')) || !/^\d{2}:\d{2}$/.test(String(body.startTime || ''))) {
    return json({ error: 'Datum a začátek jsou povinné.' }, 400, headers);
  }
  const id = `manual-${body.date}-${String(body.startTime).replace(':','')}-${crypto.randomUUID().slice(0,8)}`;
  const event = {
    id,
    type: 'training',
    title: String(body.title || 'Trénink').slice(0,120),
    team: env.TEAM_NAME || 'CB BUTchers',
    opponent: null,
    date: body.date,
    startTime: body.startTime,
    endTime: body.endTime || null,
    allDay: false,
    location: clean(body.location, 160),
    rink: clean(body.rink, 30),
    competition: null,
    description: clean(body.description, 1000),
    source: { type: 'manual', name: 'Web', url: null },
    editable: true,
    attendanceEnabled: true,
    createdBy: user.id
  };
  await storeEvent(env, event);
  return json({ event }, 201, headers);
}

async function deleteTraining(id, env, headers) {
  const row = await db(env).prepare('SELECT source_type FROM events WHERE id=?').bind(id).first();
  if (!row) return json({ error: 'Trénink neexistuje.' }, 404, headers);
  if (row.source_type !== 'manual') return json({ error: 'Mazat lze jen ručně přidané tréninky.' }, 400, headers);
  await db(env).batch([
    db(env).prepare('DELETE FROM attendance WHERE event_id=?').bind(id),
    db(env).prepare('DELETE FROM events WHERE id=?').bind(id)
  ]);
  return json({ ok: true }, 200, headers);
}

async function importEvents(request, env, headers) {
  const body = await readJson(request);
  const events = Array.isArray(body) ? body : body.events;
  if (!Array.isArray(events)) return json({ error: 'Očekávám pole events.' }, 400, headers);

  const cleanEvents = events.filter(
      e => importedSources.has(e?.source?.type) && e.id && e.date
  );

  const database = db(env);

  // DŮLEŽITÉ:
  // Události už před importem nemažeme. attendance.event_id má ON DELETE CASCADE,
  // takže původní DELETE mazal spolu s událostmi i veškerou docházku.
  // Nejdřív provedeme UPSERT stávajících událostí, čímž jejich řádky i docházka zůstanou.
  const { results: existingRows } = await database.prepare(
      "SELECT id FROM events WHERE source_type IN ('excel','pdf','ical')"
  ).all();

  for (let i = 0; i < cleanEvents.length; i += 50) {
    await database.batch(
        cleanEvents.slice(i, i + 50).map(e => eventStatement(env, e))
    );
  }

  // Odstraníme pouze události, které už opravdu ve zdrojích nejsou.
  // U těch je smazání docházky očekávané.
  const incomingIds = new Set(cleanEvents.map(e => String(e.id)));
  const staleIds = (existingRows || [])
      .map(row => String(row.id))
      .filter(id => !incomingIds.has(id));

  for (let i = 0; i < staleIds.length; i += 50) {
    const chunk = staleIds.slice(i, i + 50);
    await database.batch(
        chunk.map(id => database.prepare('DELETE FROM events WHERE id=?').bind(id))
    );
  }

  return json({
    ok: true,
    imported: cleanEvents.length,
    removed: staleIds.length
  }, 200, headers);
}

async function upsertUsers(request, env, headers) {
  const body = await readJson(request);
  const users = Array.isArray(body) ? body : body.users;
  if (!Array.isArray(users) || users.length < 1 || users.length > 20) return json({ error: 'Očekávám pole users.' }, 400, headers);
  const statements = [];
  for (const u of users) {
    const id = String(u.id || '').trim().toLowerCase();
    const name = String(u.name || '').trim();
    const pin = String(u.pin || '');
    if (!/^[a-z0-9_-]{2,40}$/.test(id) || !name || !/^\d{4,12}$/.test(pin)) return json({ error: `Neplatný uživatel: ${name || id}` }, 400, headers);
    const salt = crypto.randomUUID();
    const hash = await hashPin(pin, salt, env.PIN_PEPPER);
    statements.push(db(env).prepare(`
      INSERT INTO users(id,name,pin_salt,pin_hash,can_manage_trainings,active,updated_at)
      VALUES(?,?,?,?,?,1,CURRENT_TIMESTAMP)
        ON CONFLICT(id) DO UPDATE SET name=excluded.name,pin_salt=excluded.pin_salt,pin_hash=excluded.pin_hash,
                             can_manage_trainings=excluded.can_manage_trainings,active=1,updated_at=CURRENT_TIMESTAMP
    `).bind(id, name, salt, hash, u.canManageTrainings ? 1 : 0));
  }
  await db(env).batch(statements);
  return json({ ok: true, users: users.length }, 200, headers);
}

async function storeEvent(env, event) {
  await eventStatement(env, event).run();
}

function eventStatement(env, e) {
  return db(env).prepare(`
    INSERT INTO events(id,source_type,date,start_time,payload_json,editable,attendance_enabled,updated_at)
    VALUES(?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO UPDATE SET source_type=excluded.source_type,date=excluded.date,start_time=excluded.start_time,
                           payload_json=excluded.payload_json,editable=excluded.editable,attendance_enabled=excluded.attendance_enabled,updated_at=CURRENT_TIMESTAMP
  `).bind(
      String(e.id), String(e?.source?.type || 'manual'), String(e.date), e.startTime || null,
      JSON.stringify(e), e.editable ? 1 : 0, e.attendanceEnabled ? 1 : 0
  );
}

async function readJson(request) {
  try { return await request.json(); }
  catch { throw new Error('Neplatné JSON tělo.'); }
}

function clean(value, max) {
  const v = String(value || '').trim();
  return v ? v.slice(0, max) : null;
}

function bearerToken(request) {
  const h = request.headers.get('Authorization') || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
}

function secretBearerMatches(request, secret) {
  const token = bearerToken(request);
  return Boolean(secret && token && timingSafeEqual(token, String(secret)));
}

async function hashPin(pin, salt, pepper) {
  const bytes = await crypto.subtle.digest('SHA-256', encoder.encode(`${salt}:${pin}:${pepper || ''}`));
  return bytesToHex(new Uint8Array(bytes));
}

function timingSafeEqual(a, b) {
  a = String(a || ''); b = String(b || '');
  if (a.length !== b.length) return false;
  let x = 0;
  for (let i=0; i<a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return x === 0;
}

function bytesToHex(bytes) { return [...bytes].map(b => b.toString(16).padStart(2,'0')).join(''); }
function base64urlEncode(bytes) {
  let s = ''; for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
function base64urlDecode(s) {
  s = s.replace(/-/g,'+').replace(/_/g,'/'); while (s.length % 4) s += '=';
  const bin = atob(s); return Uint8Array.from(bin, c => c.charCodeAt(0));
}
async function hmac(data, secret) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret || ''), { name:'HMAC', hash:'SHA-256' }, false, ['sign','verify']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(data)));
}
async function signSession(payload, secret) {
  const body = base64urlEncode(encoder.encode(JSON.stringify(payload)));
  const sig = base64urlEncode(await hmac(body, secret));
  return `${body}.${sig}`;
}
async function verifySession(token, secret) {
  const [body, sig] = String(token).split('.');
  if (!body || !sig) return null;
  const expected = base64urlEncode(await hmac(body, secret));
  if (!timingSafeEqual(sig, expected)) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(base64urlDecode(body)));
    if (!payload.exp || payload.exp < Math.floor(Date.now()/1000)) return null;
    return payload;
  } catch { return null; }
}

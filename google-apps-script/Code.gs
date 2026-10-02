const SPREADSHEET_ID = '17rInHjZsT-sP6QSTcK4YhjQqo44TUzMCG7FjMASHjrY';
const SCHEDULE_GID = 116203339;
const RESULTS_SHEET_NAME = 'CB BUTchers výsledky';

function doGet(e) {
  try {
    requireSecret_(e && e.parameter ? e.parameter.secret : '');

    const action = String((e && e.parameter && e.parameter.action) || 'health');

    if (action === 'health') {
      return json_({ ok: true });
    }

    if (action === 'schedule') {
      const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
      const sheet = sheetByGid_(ss, SCHEDULE_GID);
      if (!sheet) throw new Error('Nenalezen list s gid=' + SCHEDULE_GID);

      const rows = sheet.getDataRange().getDisplayValues();
      return json_({
        ok: true,
        sheetName: sheet.getName(),
        rows: rows
      });
    }

    return json_({ ok: false, error: 'Neznámá akce.' });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

function doPost(e) {
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    requireSecret_(body.secret);

    const action = String(body.action || '');

    if (action === 'setResult') {
      return setResult_(body);
    }

    if (action === 'deleteResult') {
      return deleteResult_(body);
    }

    return json_({ ok: false, error: 'Neznámá akce.' });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

function setResult_(body) {
  const eventId = String(body.eventId || '').trim();
  if (!eventId) throw new Error('Chybí eventId.');

  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ensureResultsSheet_(ss);

  const row = findResultRow_(sheet, eventId);
  const values = [[
    eventId,
    body.date || '',
    body.startTime || '',
    body.rink || '',
    body.team || 'CB BUTchers',
    body.opponent || '',
    Number(body.ourScore),
    Number(body.opponentScore),
    body.competition || '',
    body.note || '',
    body.updatedBy || '',
    new Date()
  ]];

  if (row) {
    sheet.getRange(row, 1, 1, values[0].length).setValues(values);
  } else {
    sheet.getRange(sheet.getLastRow() + 1, 1, 1, values[0].length).setValues(values);
  }

  return json_({ ok: true });
}

function deleteResult_(body) {
  const eventId = String(body.eventId || '').trim();
  if (!eventId) throw new Error('Chybí eventId.');

  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName(RESULTS_SHEET_NAME);
  if (!sheet) return json_({ ok: true });

  const row = findResultRow_(sheet, eventId);
  if (row) sheet.deleteRow(row);

  return json_({ ok: true });
}

function ensureResultsSheet_(ss) {
  let sheet = ss.getSheetByName(RESULTS_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(RESULTS_SHEET_NAME);
  }

  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, 12).setValues([[
      'Event ID',
      'Datum',
      'Čas',
      'Dráha',
      'Tým',
      'Soupeř',
      'CB BUTchers',
      'Soupeř skóre',
      'Soutěž',
      'Poznámka',
      'Upravil',
      'Aktualizováno'
    ]]);
    sheet.setFrozenRows(1);
  }

  return sheet;
}

function findResultRow_(sheet, eventId) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return 0;

  const ids = sheet.getRange(2, 1, lastRow - 1, 1).getDisplayValues();
  for (let i = 0; i < ids.length; i++) {
    if (String(ids[i][0]).trim() === eventId) {
      return i + 2;
    }
  }
  return 0;
}

function sheetByGid_(ss, gid) {
  const sheets = ss.getSheets();
  for (let i = 0; i < sheets.length; i++) {
    if (sheets[i].getSheetId() === Number(gid)) return sheets[i];
  }
  return null;
}

function requireSecret_(candidate) {
  const expected = PropertiesService.getScriptProperties().getProperty('SYNC_SECRET');
  if (!expected) throw new Error('V Apps Scriptu není nastaven Script Property SYNC_SECRET.');
  if (String(candidate || '') !== String(expected)) throw new Error('Neplatný sync secret.');
}

function json_(value) {
  return ContentService
    .createTextOutput(JSON.stringify(value))
    .setMimeType(ContentService.MimeType.JSON);
}

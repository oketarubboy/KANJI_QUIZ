const SHEET_NAME = 'rankings';
const DEFAULT_LIMIT = 20;

function doGet(e) {
  const params = (e && e.parameter) || {};
  const callback = params.callback || '';
  let result;
  try {
    if (params.action === 'submit') {
      result = submitScore_(params);
    } else {
      result = listRanking_(params);
    }
  } catch (err) {
    result = { ok: false, error: String(err && err.message ? err.message : err) };
  }
  return output_(result, callback);
}

function doPost(e) {
  let params = {};
  try {
    params = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    params = (e && e.parameter) || {};
  }
  let result;
  try {
    result = submitScore_(params);
  } catch (err) {
    result = { ok: false, error: String(err && err.message ? err.message : err) };
  }
  return output_(result, '');
}

function setupRankingSheet() {
  const sheet = getSheet_();
  ensureHeader_(sheet);
  sheet.setFrozenRows(1);
  sheet.autoResizeColumns(1, 10);
}

function submitScore_(params) {
  const name = sanitizeText_(params.name || '名無し', 20);
  const genre = sanitizeText_(params.genre || '未指定', 40);
  const score = toNumber_(params.score);
  const correct = toNumber_(params.correct);
  const total = toNumber_(params.total || 10);
  const avgTime = toNumber_(params.avgTime);
  const totalTime = toNumber_(params.totalTime);
  const version = sanitizeText_(params.version || '', 20);

  if (!score || score < 0) throw new Error('score が不正です');
  if (correct < 0 || correct > total) throw new Error('correct が不正です');

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = getSheet_();
    ensureHeader_(sheet);
    sheet.appendRow([
      new Date(), name, genre, score, correct, total, avgTime, totalTime, version,
      sanitizeText_((params.userAgent || ''), 120)
    ]);
  } finally {
    lock.releaseLock();
  }

  const rank = getRank_(genre, score, correct, avgTime);
  return { ok: true, rank: rank };
}

function listRanking_(params) {
  const genre = sanitizeText_(params.genre || '', 40);
  const limit = Math.min(Math.max(toNumber_(params.limit || DEFAULT_LIMIT), 1), 100);
  const sheet = getSheet_();
  ensureHeader_(sheet);
  const values = sheet.getDataRange().getValues();
  const rows = values.slice(1)
    .filter(row => !genre || String(row[2]) === genre)
    .map(row => ({
      timestamp: row[0] instanceof Date ? row[0].toISOString() : String(row[0] || ''),
      name: String(row[1] || '名無し'),
      genre: String(row[2] || ''),
      score: Number(row[3] || 0),
      correct: Number(row[4] || 0),
      total: Number(row[5] || 10),
      avgTime: Number(row[6] || 0),
      totalTime: Number(row[7] || 0),
      version: String(row[8] || '')
    }))
    .sort(compareScore_)
    .slice(0, limit)
    .map((row, index) => Object.assign({ rank: index + 1 }, row));
  return { ok: true, items: rows };
}

function getRank_(genre, score, correct, avgTime) {
  const sheet = getSheet_();
  const values = sheet.getDataRange().getValues();
  const rows = values.slice(1)
    .filter(row => String(row[2]) === genre)
    .map(row => ({ score: Number(row[3] || 0), correct: Number(row[4] || 0), avgTime: Number(row[6] || 0), timestamp: row[0] }));
  rows.sort(compareScore_);
  const index = rows.findIndex(row => row.score === Number(score) && row.correct === Number(correct) && Number(row.avgTime) === Number(avgTime));
  return index >= 0 ? index + 1 : '';
}

function compareScore_(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  if (b.correct !== a.correct) return b.correct - a.correct;
  if (a.avgTime !== b.avgTime) return a.avgTime - b.avgTime;
  return String(a.timestamp || '').localeCompare(String(b.timestamp || ''));
}

function getSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('スプレッドシートに紐づいたApps Scriptとして作成してください');
  return ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME);
}

function ensureHeader_(sheet) {
  const header = ['timestamp', 'name', 'genre', 'score', 'correct', 'total', 'avgTime', 'totalTime', 'version', 'userAgent'];
  const current = sheet.getRange(1, 1, 1, header.length).getValues()[0];
  if (current.join('') !== header.join('')) {
    sheet.getRange(1, 1, 1, header.length).setValues([header]);
  }
}

function output_(obj, callback) {
  const json = JSON.stringify(obj);
  if (callback) {
    return ContentService
      .createTextOutput(String(callback).replace(/[^a-zA-Z0-9_.$]/g, '') + '(' + json + ');')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}

function sanitizeText_(value, maxLen) {
  return String(value || '').replace(/[\r\n\t]/g, ' ').trim().slice(0, maxLen);
}

function toNumber_(value) {
  const n = Number(value);
  return isFinite(n) ? n : 0;
}

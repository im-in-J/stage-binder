/**
 * 스테이지 바인더 — 서버 (Google Apps Script 웹 앱)
 *
 * 하는 일
 *  1) 출결 저장·공유            {회차id: {멤버id: "y"|"l"|"n"}}  (y=출석, l=지각, n=결석)
 *  2) 사이트 데이터 저장         동선표·가사·일정 등 data.json 전체 (관리자만 쓰기)
 *  3) 관리자 비밀번호 확인       처음 로그인할 때 정한 비밀번호가 그대로 관리자 비밀번호가 됨
 *
 * 설치 순서는 같은 폴더의 README.md 를 보세요.
 * 모든 데이터는 이 스크립트의 속성(Script Properties)에 저장됩니다. 외부 파일·시트 없음.
 */

var PIN_KEY = 'ADMIN_PIN';
var ATT_KEY = 'attendance';
var SITE_COUNT_KEY = 'site_n';
var SITE_CHUNK_PREFIX = 'site_';
var CHUNK_SIZE = 8000;          // Script Properties 값 하나당 9KB 제한 → 잘라서 저장
var MAX_SITE_BYTES = 400000;    // 전체 한도 500KB 중 사이트 데이터 상한
var VALID_STATUS = {y: true, l: true, n: true};
var ID_RE = /^[A-Za-z0-9_-]{1,32}$/;
var MAX_SESSIONS = 200;
var MAX_MEMBERS = 100;

function doGet() {
  return json({ok: true, site: readSite(), att: readAtt(), hasPin: !!getPin()});
}

function doPost(e) {
  var body;
  try {
    body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json({ok: false, error: 'bad_json'});
  }
  if (!body || typeof body !== 'object') return json({ok: false, error: 'bad_json'});

  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
  } catch (err) {
    return json({ok: false, error: 'busy'});
  }
  try {
    switch (String(body.action || '')) {
      case 'att':       return handleAtt(body);
      case 'login':     return handleLogin(body);
      case 'changePin': return handleChangePin(body);
      case 'saveSite':  return handleSaveSite(body);
      case 'resetSite': return handleResetSite(body);
      default:          return json({ok: false, error: 'bad_action'});
    }
  } finally {
    lock.releaseLock();
  }
}

/* ── 출결 ─────────────────────────── */
function handleAtt(body) {
  var sid = String(body.sessionId || '');
  var mid = String(body.memberId || '');
  var status = String(body.status || '');
  if (!ID_RE.test(sid) || !ID_RE.test(mid)) return json({ok: false, error: 'bad_id'});
  if (status && !VALID_STATUS[status]) return json({ok: false, error: 'bad_status'});

  var data = readAtt();
  if (!data[sid]) {
    if (Object.keys(data).length >= MAX_SESSIONS) return json({ok: false, error: 'too_many_sessions'});
    data[sid] = {};
  }
  if (status) {
    if (!data[sid][mid] && Object.keys(data[sid]).length >= MAX_MEMBERS) {
      return json({ok: false, error: 'too_many_members'});
    }
    data[sid][mid] = status;
  } else {
    delete data[sid][mid];
  }
  props().setProperty(ATT_KEY, JSON.stringify(data));
  return json({ok: true, att: data});
}

function readAtt() {
  var v = parseJson(props().getProperty(ATT_KEY));
  return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
}

/* ── 관리자 비밀번호 ─────────────────── */
function getPin() { return props().getProperty(PIN_KEY) || ''; }

function validPinShape(p) { return typeof p === 'string' && p.length >= 4 && p.length <= 64; }

function checkPin(body) {
  var given = String(body.pin || '');
  var saved = getPin();
  return !!saved && given === saved;
}

function handleLogin(body) {
  var given = String(body.pin || '');
  if (!validPinShape(given)) return json({ok: false, error: 'bad_pin_shape'});
  var saved = getPin();
  if (!saved) {
    props().setProperty(PIN_KEY, given);     // 첫 로그인 → 이 비밀번호가 관리자 비밀번호
    return json({ok: true, created: true});
  }
  if (given !== saved) return json({ok: false, error: 'bad_pin'});
  return json({ok: true});
}

function handleChangePin(body) {
  if (!checkPin(body)) return json({ok: false, error: 'bad_pin'});
  var next = String(body.newPin || '');
  if (!validPinShape(next)) return json({ok: false, error: 'bad_pin_shape'});
  props().setProperty(PIN_KEY, next);
  return json({ok: true});
}

/* ── 사이트 데이터 (data.json 전체) ───── */
function handleSaveSite(body) {
  if (!checkPin(body)) return json({ok: false, error: 'bad_pin'});
  var site = body.site;
  if (!site || typeof site !== 'object' || Array.isArray(site)) return json({ok: false, error: 'bad_site'});
  if (!Array.isArray(site.members) || !Array.isArray(site.songs) || !Array.isArray(site.scenes)) {
    return json({ok: false, error: 'bad_site'});
  }
  var text = JSON.stringify(site);
  if (text.length > MAX_SITE_BYTES) return json({ok: false, error: 'too_big'});
  writeSite(text);
  return json({ok: true});
}

function handleResetSite(body) {
  if (!checkPin(body)) return json({ok: false, error: 'bad_pin'});
  clearSite();
  return json({ok: true});
}

function readSite() {
  var p = props();
  var n = parseInt(p.getProperty(SITE_COUNT_KEY) || '0', 10);
  if (!n) return null;
  var parts = [];
  for (var i = 0; i < n; i++) {
    var c = p.getProperty(SITE_CHUNK_PREFIX + i);
    if (c === null) return null;                 // 조각이 빠졌으면 없는 것으로
    parts.push(c);
  }
  var v = parseJson(parts.join(''));
  return (v && typeof v === 'object') ? v : null;
}

function writeSite(text) {
  var p = props();
  var oldN = parseInt(p.getProperty(SITE_COUNT_KEY) || '0', 10);
  var chunks = {};
  var n = 0;
  for (var i = 0; i < text.length; i += CHUNK_SIZE) {
    chunks[SITE_CHUNK_PREFIX + n] = text.substring(i, i + CHUNK_SIZE);
    n++;
  }
  chunks[SITE_COUNT_KEY] = String(n);
  p.setProperties(chunks, false);
  for (var j = n; j < oldN; j++) p.deleteProperty(SITE_CHUNK_PREFIX + j);
}

function clearSite() {
  var p = props();
  var n = parseInt(p.getProperty(SITE_COUNT_KEY) || '0', 10);
  for (var i = 0; i < n; i++) p.deleteProperty(SITE_CHUNK_PREFIX + i);
  p.deleteProperty(SITE_COUNT_KEY);
}

/* ── 공통 ─────────────────────────── */
function props() { return PropertiesService.getScriptProperties(); }

function parseJson(s) {
  if (!s) return null;
  try { return JSON.parse(s); } catch (err) { return null; }
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/** 편집기에서 직접 실행: 비밀번호를 잊었을 때 초기화 (다음 로그인 때 새로 정해짐) */
function resetPin() { props().deleteProperty(PIN_KEY); }

/** 편집기에서 직접 실행: 출결 전체 삭제 */
function resetAttendance() { props().deleteProperty(ATT_KEY); }

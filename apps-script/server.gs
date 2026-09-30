/**
 * 스테이지 바인더 — 서버 (Google Apps Script 웹 앱)
 *
 * 하는 일
 *  1) 출결 저장·공유            {회차id: {멤버id: "y"|"l"|"n"}}  (y=출석, l=지각, n=결석)
 *  2) 사이트 데이터 저장         동선표·가사·일정 등 data.json 전체 (관리자만 쓰기)
 *  3) 관리자 비밀번호 확인       처음 로그인할 때 정한 비밀번호가 그대로 관리자 비밀번호가 됨
 *
 *  4) 이전 버전 보관                 사이트 데이터를 저장할 때마다 직전 버전을 최근 5개까지 보관, 복원 가능
 *
 * 설치 순서는 같은 폴더의 README.md 를 보세요.
 * 모든 데이터는 이 스크립트의 속성(Script Properties)에 저장됩니다. 외부 파일·시트 없음.
 */

var PIN_KEY = 'ADMIN_PIN';
var ATT_KEY = 'attendance';
var CHUNK_SIZE = 8000;          // Script Properties 값 하나당 9KB 제한 → 잘라서 저장
var MAX_SITE_BYTES = 120000;    // 사이트 데이터 한 벌 상한 (전체 한도 500KB 안에서 이전 버전 5개까지 보관)
var HIST_INDEX_KEY = 'hist_index';   // [{key, at, bytes, note}] 최근 것이 앞
var HIST_MAX = 5;
var HIST_BUDGET = 330000;       // 이전 버전 보관에 쓸 총 바이트
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
      case 'history':   return handleHistory(body);
      case 'restoreSite': return handleRestoreSite(body);
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
  archiveCurrent('저장 전');
  writeSite(text);
  return json({ok: true});
}

function handleResetSite(body) {
  if (!checkPin(body)) return json({ok: false, error: 'bad_pin'});
  archiveCurrent('기본값 되돌리기 전');
  clearSite();
  return json({ok: true});
}

/* ── 이전 버전 보관 ───────────────── */
function handleHistory(body) {
  if (!checkPin(body)) return json({ok: false, error: 'bad_pin'});
  return json({ok: true, history: readHistIndex(), max: HIST_MAX});
}

function handleRestoreSite(body) {
  if (!checkPin(body)) return json({ok: false, error: 'bad_pin'});
  var key = String(body.key || '');
  var entry = readHistIndex().filter(function (h) { return h.key === key; })[0];
  if (!entry) return json({ok: false, error: 'no_such_version'});
  var text = readChunks(key);
  if (text === null) return json({ok: false, error: 'version_broken'});
  archiveCurrent('복원 전');
  writeSite(text);
  return json({ok: true});
}

function readHistIndex() {
  var v = parseJson(props().getProperty(HIST_INDEX_KEY));
  return Array.isArray(v) ? v : [];
}

/** 지금 저장돼 있는 사이트 데이터를 이전 버전 목록 맨 앞에 넣는다 (같은 내용이면 건너뜀) */
function archiveCurrent(note) {
  var cur = readChunks('site');
  if (cur === null || !cur.length) return;
  var hist = readHistIndex();
  if (hist.length) {
    var last = readChunks(hist[0].key);
    if (last === cur) return;
  }
  var key = 'h' + Date.now().toString(36);
  writeChunks(key, cur);
  hist.unshift({key: key, at: new Date().toISOString(), bytes: cur.length, note: note || ''});
  // 개수·용량 초과분은 오래된 것부터 삭제
  var total = 0, keep = [];
  for (var i = 0; i < hist.length; i++) {
    total += hist[i].bytes || 0;
    if (i < HIST_MAX && total <= HIST_BUDGET) keep.push(hist[i]);
    else deleteChunks(hist[i].key);
  }
  props().setProperty(HIST_INDEX_KEY, JSON.stringify(keep));
}

function readSite() {
  var v = parseJson(readChunks('site'));
  return (v && typeof v === 'object') ? v : null;
}
function writeSite(text) { writeChunks('site', text); }
function clearSite() { deleteChunks('site'); }

/* 큰 문자열을 <key>_n(개수) + <key>_0.. 으로 나눠 저장 (값 하나 9KB 제한 대응) */
function readChunks(key) {
  var p = props();
  var n = parseInt(p.getProperty(key + '_n') || '0', 10);
  if (!n) return null;
  var parts = [];
  for (var i = 0; i < n; i++) {
    var c = p.getProperty(key + '_' + i);
    if (c === null) return null;                 // 조각이 빠졌으면 없는 것으로
    parts.push(c);
  }
  return parts.join('');
}
function writeChunks(key, text) {
  var p = props();
  var oldN = parseInt(p.getProperty(key + '_n') || '0', 10);
  var chunks = {}, n = 0;
  for (var i = 0; i < text.length; i += CHUNK_SIZE) {
    chunks[key + '_' + n] = text.substring(i, i + CHUNK_SIZE);
    n++;
  }
  chunks[key + '_n'] = String(n);
  p.setProperties(chunks, false);
  for (var j = n; j < oldN; j++) p.deleteProperty(key + '_' + j);
}
function deleteChunks(key) {
  var p = props();
  var n = parseInt(p.getProperty(key + '_n') || '0', 10);
  for (var i = 0; i < n; i++) p.deleteProperty(key + '_' + i);
  p.deleteProperty(key + '_n');
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

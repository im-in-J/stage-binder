/**
 * 스테이지 바인더 — 출결 저장 백엔드 (Google Apps Script)
 *
 * 설치 순서는 같은 폴더의 README.md 를 보세요.
 * 저장 위치: 이 스크립트의 속성(Script Properties) 한 칸.
 * 저장 형태: {"회차id": {"멤버id": "y"|"l"|"n"}}   (y=출석, l=지각, n=결석)
 */

var STORE_KEY = 'attendance';
var VALID_STATUS = {y: true, l: true, n: true};
var ID_RE = /^[A-Za-z0-9_-]{1,32}$/;
var MAX_SESSIONS = 200;
var MAX_MEMBERS = 100;

function doGet() {
  return json({ok: true, data: readAll()});
}

function doPost(e) {
  var body;
  try {
    body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json({ok: false, error: 'bad_json'});
  }

  var sid = String(body.sessionId || '');
  var mid = String(body.memberId || '');
  var status = String(body.status || '');

  if (!ID_RE.test(sid) || !ID_RE.test(mid)) return json({ok: false, error: 'bad_id'});
  if (status && !VALID_STATUS[status]) return json({ok: false, error: 'bad_status'});

  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
  } catch (err) {
    return json({ok: false, error: 'busy'});
  }

  try {
    var data = readAll();
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
    PropertiesService.getScriptProperties().setProperty(STORE_KEY, JSON.stringify(data));
    return json({ok: true, data: data});
  } finally {
    lock.releaseLock();
  }
}

function readAll() {
  var raw = PropertiesService.getScriptProperties().getProperty(STORE_KEY);
  if (!raw) return {};
  try {
    var v = JSON.parse(raw);
    return (v && typeof v === 'object') ? v : {};
  } catch (err) {
    return {};
  }
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/** 전체 초기화가 필요할 때 편집기에서 직접 실행 */
function resetAll() {
  PropertiesService.getScriptProperties().deleteProperty(STORE_KEY);
}

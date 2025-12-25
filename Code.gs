/*******************************************************
 * BK Work Schedule - Grand Diamond (Google Apps Script)
 * Single file: Paste only in Code.gs
 *
 * Pages:
 * - /exec?page=login
 * - /exec?page=register
 * - /exec?page=work
 * - /exec?page=roster
 * - /exec?page=settings
 *
 * Notes:
 * - Accepts both ?page= and legacy ?view=
 * - Default page = login
 *******************************************************/

/** ========= CONFIG ========= */
const SPREADSHEET_ID = "1WcnlLt37QwkTPwCdLsUyy_raZzJljXvN5RmIrP4QgwY";

const BRANCH_NAME = "Grand Diamond";
const CREATOR_CREDIT = "Chan. J (Chanon Jaimool)";

const SHEET_USERS  = "Users";
const SHEET_SHIFTS = "Shifts";
const SHEET_CONFIG = "Config";
const SHEET_LOG    = "SystemLog";

const SALT = "BK_SALT_v2_change_me";
const SESSION_TTL_SECONDS = 60 * 60 * 6; // 6h
const MANAGER_VERIFY_CODE = "bk1040";

const DEFAULT_POSITION_STAFF = "Service Staff";
const DEFAULT_POSITION_MANAGER = "Manager";

/**
 * Shift groups & start-time windows
 * - user selects "startTime"
 * - endTime auto = start + 9h (8h work + 1h break)
 */
const SHIFT_GROUPS = [
  { key: "open",   label: "Open",       windowStart: "00:00", windowEnd: "11:00", main: "07:00" },
  { key: "lunch",  label: "Lunch",      windowStart: "12:00", windowEnd: "14:00", main: "13:00" },
  { key: "dinner", label: "Dinner",     windowStart: "15:00", windowEnd: "18:00", main: "15:00" },
  { key: "late",   label: "Late Night", windowStart: "20:00", windowEnd: "23:00", main: "22:00" },
];

// default capacity per shift group
const DEFAULT_CAPACITY = { open: 4, lunch: 4, dinner: 4, late: 4 };

// close window: Tuesday 12:00 -> Thursday 00:00 (TH time)
function isSystemClosed_() {
  const tz = "Asia/Bangkok";
  const now = new Date();
  const day = Number(Utilities.formatDate(now, tz, "u")); // 1=Mon ... 7=Sun
  const hhmm = Utilities.formatDate(now, tz, "HH:mm");
  if (day === 2) return hhmm >= "12:00"; // Tue >= 12:00
  if (day === 3) return true;           // Wed all day
  if (day === 4) return false;          // Thu open from 00:00
  return false;
}

/** ========= WEB ENTRY ========= */
function doGet(e) {
  // รองรับทั้ง page และ view (เผื่อโค้ดเก่าบางหน้าส่ง view มา)
  const raw = (e && e.parameter) ? e.parameter : {};
  const page = sanitizePage_(raw.page || raw.view || "login");

  return HtmlService
    .createHtmlOutput(renderPage_(page))
    .setTitle("BK ตารางงาน • " + BRANCH_NAME)
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function sanitizePage_(p){
  p = String(p || "login").trim().toLowerCase();
  const allow = { login:1, register:1, work:1, roster:1, settings:1 };
  return allow[p] ? p : "login";
}

/** ========= FIRST TIME SETUP ========= */
function setup() {
  const ss = getSS_();

  ensureSheet_(ss, SHEET_USERS, [
    "username","passhash","role","fullName","nickName","phone","email","position","active","createdAt"
  ]);

  ensureSheet_(ss, SHEET_SHIFTS, [
    "date","username","fullName","role","shiftGroup","startTime","endTime","note","createdAt","updatedAt","updatedBy"
  ]);

  ensureSheet_(ss, SHEET_CONFIG, [
    "key","value","updatedAt"
  ]);

  ensureSheet_(ss, SHEET_LOG, [
    "ts","action","by","detail"
  ]);

  // capacities defaults
  const cfg = getConfigAll_();
  Object.keys(DEFAULT_CAPACITY).forEach(k => {
    const key = "cap_" + k;
    if (!(key in cfg)) setConfig_(key, String(DEFAULT_CAPACITY[k]));
  });

  // admin default
  const users = getUsers_();
  if (!users.some(u => u.username === "admin")) {
    addUser_("admin", "1234", "admin", "Admin", "", "", "", "Admin", true);
    log_("setup_create_admin", "system", "admin created");
  }

  // manager sample (optional)
  if (!users.some(u => u.username === "manager")) {
    addUser_("manager", "1234", "manager", "Manager", "", "", "", DEFAULT_POSITION_MANAGER, true);
    log_("setup_create_manager", "system", "manager created");
  }

  log_("setup_ok", "system", "setup completed");
  return { ok: true, message: "setup ok" };
}

function ping() {
  return {
    ok: true,
    ts: new Date().toISOString(),
    closed: isSystemClosed_(),
    branch: BRANCH_NAME
  };
}

/** ========= AUTH ========= */
function login(username, password) {
  if (isSystemClosed_()) return { ok: false, message: "ระบบปิดช่วงนี้" };

  username = String(username || "").trim().toLowerCase();
  password = String(password || "");

  if (!username || !password) return { ok: false, message: "กรอกให้ครบ" };

  const users = getUsers_();
  const u = users.find(x => x.username === username && String(x.active) === "true");
  if (!u) return { ok: false, message: "ไม่พบบัญชี/ถูกปิดใช้งาน" };

  if (hashPass_(password) !== u.passhash) return { ok: false, message: "รหัสผ่านไม่ถูก" };

  const token = createSession_(u.username);
  log_("login_ok", u.username, "role=" + u.role);

  return { ok: true, token, user: pickUser_(u) };
}

function validate(token) {
  token = String(token || "").trim();
  if (!token) return { ok: false };

  const username = CacheService.getScriptCache().get("sess:" + token);
  if (!username) return { ok: false };

  const users = getUsers_();
  const u = users.find(x => x.username === String(username).toLowerCase() && String(x.active) === "true");
  if (!u) return { ok: false };

  return { ok: true, user: pickUser_(u) };
}

function logout(token) {
  token = String(token || "").trim();
  if (token) CacheService.getScriptCache().remove("sess:" + token);
  return { ok: true };
}

/** ========= REGISTER ========= */
function registerStaff(fullName, nickName, phone, email, password) {
  if (isSystemClosed_()) return { ok: false, message: "ระบบปิดช่วงนี้" };

  fullName = String(fullName || "").trim();
  nickName = String(nickName || "").trim();
  phone = String(phone || "").trim();
  email = String(email || "").trim();
  password = String(password || "");

  if (!fullName || !password || !email) return { ok: false, message: "ต้องกรอก ชื่อ-สกุล / Email / Password" };

  const username = allocateUsername_(generateUsernameBase_(fullName));
  if (!username) return { ok: false, message: "สร้าง username ไม่สำเร็จ" };

  addUser_(username, password, "staff", fullName, nickName, phone, email, DEFAULT_POSITION_STAFF, true);
  log_("register_staff", username, "fullName=" + fullName);

  return { ok: true, username };
}

function registerManager(fullName, nickName, phone, email, password, verifyCode) {
  if (isSystemClosed_()) return { ok: false, message: "ระบบปิดช่วงนี้" };

  verifyCode = String(verifyCode || "").trim().toLowerCase();
  if (verifyCode !== MANAGER_VERIFY_CODE) return { ok: false, message: "รหัสยืนยันไม่ถูก" };

  fullName = String(fullName || "").trim();
  nickName = String(nickName || "").trim();
  phone = String(phone || "").trim();
  email = String(email || "").trim();
  password = String(password || "");

  if (!fullName || !password || !email) return { ok: false, message: "ต้องกรอก ชื่อ-สกุล / Email / Password" };

  const username = allocateUsername_(generateUsernameBase_(fullName));
  if (!username) return { ok: false, message: "สร้าง username ไม่สำเร็จ" };

  addUser_(username, password, "manager", fullName, nickName, phone, email, DEFAULT_POSITION_MANAGER, true);
  log_("register_manager", username, "fullName=" + fullName);

  return { ok: true, username };
}

/** ========= SETTINGS ========= */
function getSettings(token) {
  const v = validate(token);
  if (!v.ok) return { ok: false, message: "session หมดอายุ/ไม่ถูกต้อง" };
  if (!(v.user.role === "admin" || v.user.role === "manager")) return { ok: false, message: "สิทธิ์ไม่พอ" };

  const cap = getCapacity_();
  return { ok: true, capacity: cap, groups: SHIFT_GROUPS };
}

function updateSettings(token, capacityObj) {
  const v = validate(token);
  if (!v.ok) return { ok: false, message: "session หมดอายุ/ไม่ถูกต้อง" };
  if (!(v.user.role === "admin" || v.user.role === "manager")) return { ok: false, message: "สิทธิ์ไม่พอ" };

  capacityObj = capacityObj || {};
  Object.keys(DEFAULT_CAPACITY).forEach(k => {
    const n = Number(capacityObj[k]);
    if (!isFinite(n) || n < 0 || n > 99) return;
    setConfig_("cap_" + k, String(Math.floor(n)));
  });

  log_("settings_update", v.user.username, JSON.stringify(capacityObj));
  return { ok: true };
}

/** ========= SHIFTS / WORK ========= */
function getMyWeek(token, anyDate) {
  const v = validate(token);
  if (!v.ok) return { ok: false, message: "session หมดอายุ/ไม่ถูกต้อง" };

  const me = v.user.username;
  const wk = getWeekRangeTuesday_(anyDate);
  const shifts = getShiftsInRange_(wk.start, wk.end);

  const mine = shifts
    .filter(s => String(s.username).toLowerCase() === me)
    .sort((a,b) => (a.date + a.shiftGroup).localeCompare(b.date + b.shiftGroup));

  return { ok: true, weekStart: wk.start, days: wk.days, items: mine, capacity: getCapacity_(), groups: SHIFT_GROUPS, closed: isSystemClosed_(), user: v.user };
}

function bookMyShift(token, date, shiftGroup, startTime, note) {
  const v = validate(token);
  if (!v.ok) return { ok: false, message: "session หมดอายุ/ไม่ถูกต้อง" };
  if (isSystemClosed_()) return { ok: false, message: "ระบบปิดช่วงนี้" };

  // Admin/Manager cannot book
  if (v.user.role === "admin" || v.user.role === "manager") {
    return { ok: false, message: "Admin/Manager ไม่ต้องลงกะ" };
  }

  date = String(date || "").trim();
  shiftGroup = String(shiftGroup || "").trim();
  startTime = String(startTime || "").trim();
  note = String(note || "").trim();

  if (!date || !shiftGroup || !startTime) return { ok: false, message: "กรอกให้ครบ" };
  if (!isValidDate_(date)) return { ok: false, message: "วันที่ไม่ถูก" };
  if (!SHIFT_GROUPS.some(g => g.key === shiftGroup)) return { ok: false, message: "กะไม่ถูก" };

  const g = SHIFT_GROUPS.find(x => x.key === shiftGroup);
  if (!isTimeInWindow_(startTime, g.windowStart, g.windowEnd)) return { ok: false, message: "เวลาเริ่มไม่อยู่ในช่วงกะ" };

  const cap = getCapacity_();
  const count = countShift_(date, shiftGroup);
  if (count >= Number(cap[shiftGroup])) return { ok: false, message: "กะนี้เต็มแล้ว" };

  if (hasUserShiftOnDate_(v.user.username, date)) return { ok: false, message: "คุณมีตารางงานวันนั้นแล้ว" };

  const endTime = addMinutesToHHMM_(startTime, 9 * 60);
  upsertShift_(date, v.user.username, v.user.fullName, v.user.role, shiftGroup, startTime, endTime, note, v.user.username);

  log_("book_shift", v.user.username, date + " " + shiftGroup + " " + startTime);
  return { ok: true };
}

function cancelMyShift(token, date) {
  const v = validate(token);
  if (!v.ok) return { ok: false, message: "session หมดอายุ/ไม่ถูกต้อง" };
  if (isSystemClosed_()) return { ok: false, message: "ระบบปิดช่วงนี้" };

  date = String(date || "").trim();
  if (!date || !isValidDate_(date)) return { ok: false, message: "วันที่ไม่ถูก" };

  const ok = deleteShift_(v.user.username, date, v.user.username, false);
  if (!ok) return { ok: false, message: "ไม่พบรายการ" };

  log_("cancel_my_shift", v.user.username, date);
  return { ok: true };
}

/** ========= ROSTER ========= */
function getRosterWeek(token, anyDate) {
  const v = validate(token);
  if (!v.ok) return { ok: false, message: "session หมดอายุ/ไม่ถูกต้อง" };

  const wk = getWeekRangeTuesday_(anyDate);
  const shifts = getShiftsInRange_(wk.start, wk.end);

  const users = getUsers_()
    .filter(u => u.role === "staff" && String(u.active) === "true")
    .map(u => ({ username: u.username, fullName: u.fullName, position: u.position }));

  const map = {};
  shifts.forEach(s => {
    const k = String(s.username).toLowerCase() + "|" + String(s.date);
    map[k] = s;
  });

  return {
    ok: true,
    weekStart: wk.start,
    days: wk.days,
    users,
    map,
    groups: SHIFT_GROUPS,
    capacity: getCapacity_(),
    canManage: (v.user.role === "admin" || v.user.role === "manager"),
    closed: isSystemClosed_(),
    me: v.user
  };
}

function setShiftForUser(token, username, date, shiftGroup, startTime, note) {
  const v = validate(token);
  if (!v.ok) return { ok: false, message: "session หมดอายุ/ไม่ถูกต้อง" };
  if (!(v.user.role === "admin" || v.user.role === "manager")) return { ok: false, message: "สิทธิ์ไม่พอ" };
  if (isSystemClosed_()) return { ok: false, message: "ระบบปิดช่วงนี้" };

  username = String(username || "").trim().toLowerCase();
  date = String(date || "").trim();
  shiftGroup = String(shiftGroup || "").trim();
  startTime = String(startTime || "").trim();
  note = String(note || "").trim();

  if (!username || !date || !shiftGroup || !startTime) return { ok: false, message: "กรอกให้ครบ" };
  if (!isValidDate_(date)) return { ok: false, message: "วันที่ไม่ถูก" };

  const user = getUsers_().find(x => x.username === username && x.role === "staff" && String(x.active) === "true");
  if (!user) return { ok: false, message: "ไม่พบบุคลากร" };

  const g = SHIFT_GROUPS.find(x => x.key === shiftGroup);
  if (!g) return { ok: false, message: "กะไม่ถูก" };
  if (!isTimeInWindow_(startTime, g.windowStart, g.windowEnd)) return { ok: false, message: "เวลาเริ่มไม่อยู่ในช่วงกะ" };

  const existing = getShiftByUserDate_(username, date);
  if (!existing || existing.shiftGroup !== shiftGroup) {
    const cap = getCapacity_();
    const count = countShift_(date, shiftGroup);
    if (count >= Number(cap[shiftGroup])) return { ok: false, message: "กะนี้เต็มแล้ว" };
  }

  const endTime = addMinutesToHHMM_(startTime, 9 * 60);
  upsertShift_(date, username, user.fullName, user.role, shiftGroup, startTime, endTime, note, v.user.username);

  log_("manager_set_shift", v.user.username, username + " " + date + " " + shiftGroup + " " + startTime);
  return { ok: true };
}

function deleteShiftForUser(token, username, date) {
  const v = validate(token);
  if (!v.ok) return { ok: false, message: "session หมดอายุ/ไม่ถูกต้อง" };
  if (!(v.user.role === "admin" || v.user.role === "manager")) return { ok: false, message: "สิทธิ์ไม่พอ" };
  if (isSystemClosed_()) return { ok: false, message: "ระบบปิดช่วงนี้" };

  username = String(username || "").trim().toLowerCase();
  date = String(date || "").trim();
  if (!username || !isValidDate_(date)) return { ok: false, message: "ข้อมูลไม่ถูก" };

  const ok = deleteShift_(username, date, v.user.username, true);
  if (!ok) return { ok: false, message: "ไม่พบรายการ" };

  log_("manager_delete_shift", v.user.username, username + " " + date);
  return { ok: true };
}

/** ========= DATA (Sheets) ========= */
function getSS_() {
  if (!SPREADSHEET_ID) return SpreadsheetApp.getActiveSpreadsheet();
  return SpreadsheetApp.openById(SPREADSHEET_ID);
}

function ensureSheet_(ss, name, headers) {
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);

  const first = sh.getRange(1, 1, 1, headers.length).getValues()[0];
  const ok = headers.every((h, i) => String(first[i] || "").trim() === h);
  if (!ok) {
    sh.clear();
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
  }
}

function getUsers_() {
  const ss = getSS_();
  const sh = ss.getSheetByName(SHEET_USERS);
  const values = sh.getDataRange().getValues();
  const headers = values.shift() || [];

  return values
    .filter(r => r.some(c => String(c).trim() !== ""))
    .map(r => toObj_(headers, r))
    .map(u => ({
      username: String(u.username || "").toLowerCase(),
      passhash: String(u.passhash || ""),
      role: String(u.role || "staff"),
      fullName: String(u.fullName || ""),
      nickName: String(u.nickName || ""),
      phone: String(u.phone || ""),
      email: String(u.email || ""),
      position: String(u.position || DEFAULT_POSITION_STAFF),
      active: String(u.active || "true"),
      createdAt: String(u.createdAt || "")
    }));
}

function addUser_(username, password, role, fullName, nickName, phone, email, position, active) {
  const ss = getSS_();
  const sh = ss.getSheetByName(SHEET_USERS);

  sh.appendRow([
    String(username).toLowerCase(),
    hashPass_(password),
    role || "staff",
    fullName || "",
    nickName || "",
    phone || "",
    email || "",
    position || DEFAULT_POSITION_STAFF,
    String(active) === "false" ? "false" : "true",
    new Date().toISOString()
  ]);
}

function pickUser_(u) {
  return {
    username: u.username,
    role: u.role,
    fullName: u.fullName || u.username,
    nickName: u.nickName || "",
    phone: u.phone || "",
    email: u.email || "",
    position: u.position || ""
  };
}

function hashPass_(password) {
  const raw = SALT + "::" + String(password);
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, raw, Utilities.Charset.UTF_8);
  return bytes.map(b => (b < 0 ? b + 256 : b).toString(16).padStart(2, "0")).join("");
}

function createSession_(username) {
  const token = Utilities.getUuid().replace(/-/g, "");
  CacheService.getScriptCache().put("sess:" + token, String(username).toLowerCase(), SESSION_TTL_SECONDS);
  return token;
}

function toObj_(headers, row) {
  const o = {};
  headers.forEach((h, i) => (o[String(h)] = row[i]));
  return o;
}

/** ========= CONFIG sheet ========= */
function getConfigAll_() {
  const ss = getSS_();
  const sh = ss.getSheetByName(SHEET_CONFIG);
  const values = sh.getDataRange().getValues();
  values.shift();
  const o = {};
  values.forEach(r => {
    const k = String(r[0] || "").trim();
    const v = String(r[1] || "").trim();
    if (k) o[k] = v;
  });
  return o;
}

function setConfig_(key, value) {
  const ss = getSS_();
  const sh = ss.getSheetByName(SHEET_CONFIG);
  const values = sh.getDataRange().getValues();
  const headers = values.shift();

  const keyCol = headers.indexOf("key") + 1;
  const valCol = headers.indexOf("value") + 1;
  const updCol = headers.indexOf("updatedAt") + 1;

  let rowIndex = -1;
  for (let i = 0; i < values.length; i++) {
    if (String(values[i][0]).trim() === key) { rowIndex = i + 2; break; }
  }

  const now = new Date().toISOString();
  if (rowIndex === -1) {
    sh.appendRow([key, String(value), now]);
  } else {
    sh.getRange(rowIndex, keyCol).setValue(key);
    sh.getRange(rowIndex, valCol).setValue(String(value));
    sh.getRange(rowIndex, updCol).setValue(now);
  }
}

function getCapacity_() {
  const cfg = getConfigAll_();
  const out = {};
  Object.keys(DEFAULT_CAPACITY).forEach(k => {
    out[k] = Number(cfg["cap_" + k] || DEFAULT_CAPACITY[k]);
  });
  return out;
}

/** ========= SHIFT helpers ========= */
function getShiftsInRange_(fromYMD, toYMD) {
  const ss = getSS_();
  const sh = ss.getSheetByName(SHEET_SHIFTS);
  const values = sh.getDataRange().getValues();
  const headers = values.shift() || [];
  const rows = values
    .filter(r => r.some(c => String(c).trim() !== ""))
    .map(r => toObj_(headers, r));

  return rows.filter(x => {
    const d = String(x.date || "");
    return d && d >= fromYMD && d <= toYMD;
  });
}

function getShiftByUserDate_(username, date) {
  username = String(username || "").toLowerCase();
  const ss = getSS_();
  const sh = ss.getSheetByName(SHEET_SHIFTS);
  const values = sh.getDataRange().getValues();
  const headers = values.shift() || [];
  const rows = values
    .map((r, idx) => ({ idx: idx + 2, obj: toObj_(headers, r) }))
    .filter(x => String(x.obj.username || "").toLowerCase() === username && String(x.obj.date || "") === date);
  return rows.length ? rows[0] : null;
}

function hasUserShiftOnDate_(username, date) {
  return !!getShiftByUserDate_(username, date);
}

function countShift_(date, shiftGroup) {
  const ss = getSS_();
  const sh = ss.getSheetByName(SHEET_SHIFTS);
  const values = sh.getDataRange().getValues();
  const headers = values.shift() || [];
  const rows = values
    .filter(r => r.some(c => String(c).trim() !== ""))
    .map(r => toObj_(headers, r));

  return rows.filter(x => String(x.date) === date && String(x.shiftGroup) === shiftGroup).length;
}

function upsertShift_(date, username, fullName, role, shiftGroup, startTime, endTime, note, by) {
  const ss = getSS_();
  const sh = ss.getSheetByName(SHEET_SHIFTS);

  const found = getShiftByUserDate_(username, date);
  const now = new Date().toISOString();

  if (!found) {
    sh.appendRow([date, username, fullName, role, shiftGroup, startTime, endTime, note || "", now, now, by || "system"]);
  } else {
    const row = found.idx;
    sh.getRange(row, 3).setValue(fullName);
    sh.getRange(row, 4).setValue(role);
    sh.getRange(row, 5).setValue(shiftGroup);
    sh.getRange(row, 6).setValue(startTime);
    sh.getRange(row, 7).setValue(endTime);
    sh.getRange(row, 8).setValue(note || "");
    sh.getRange(row, 10).setValue(now);
    sh.getRange(row, 11).setValue(by || "system");
  }
}

function deleteShift_(username, date, by, isManagerAction) {
  const ss = getSS_();
  const sh = ss.getSheetByName(SHEET_SHIFTS);

  const found = getShiftByUserDate_(username, date);
  if (!found) return false;

  sh.deleteRow(found.idx);
  log_(isManagerAction ? "delete_shift_manager" : "delete_shift_user", by || "system", username + " " + date);
  return true;
}

/** ========= USERNAME generator ========= */
function generateUsernameBase_(fullName) {
  const s = String(fullName || "").trim().replace(/\s+/g, " ");
  const parts = s.split(" ");
  if (parts.length < 2) return "";

  const first = parts[0].replace(/\s/g, "").slice(0, 3);
  const last = parts[parts.length - 1].replace(/\s/g, "").slice(0, 3);
  if (!first || !last) return "";
  return (first + last).toLowerCase();
}

function allocateUsername_(base6) {
  base6 = String(base6 || "").trim().toLowerCase();
  if (!base6 || base6.length < 2) return "";

  const users = getUsers_();
  for (let i = 1; i <= 999; i++) {
    const u = base6 + String(i).padStart(3, "0");
    if (!users.some(x => x.username === u)) return u;
  }
  return "";
}

/** ========= WEEK starts Tuesday ========= */
function getWeekRangeTuesday_(anyDate) {
  const tz = "Asia/Bangkok";
  const d = (anyDate && isValidDate_(anyDate)) ? new Date(String(anyDate) + "T00:00:00+07:00") : new Date();

  const ymd = Utilities.formatDate(d, tz, "yyyy-MM-dd");
  const dd = new Date(ymd + "T00:00:00+07:00");

  const u = Number(Utilities.formatDate(dd, tz, "u")); // Mon=1..Sun=7, Tue=2
  const delta = (u >= 2) ? (u - 2) : (7 - (2 - u));
  const start = new Date(dd.getTime());
  start.setDate(start.getDate() - delta);

  const days = [];
  for (let i = 0; i < 7; i++) {
    const x = new Date(start.getTime());
    x.setDate(x.getDate() + i);
    days.push(Utilities.formatDate(x, tz, "yyyy-MM-dd"));
  }
  return { start: days[0], end: days[6], days };
}

/** ========= TIME helpers ========= */
function isValidDate_(ymd) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(ymd || ""));
}
function parseHHMM_(t) {
  const m = String(t).match(/^(\d{2}):(\d{2})$/);
  if (!m) return null;
  const hh = Number(m[1]), mm = Number(m[2]);
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return hh * 60 + mm;
}
function isTimeInWindow_(t, start, end) {
  const a = parseHHMM_(t), s = parseHHMM_(start), e = parseHHMM_(end);
  if (a == null || s == null || e == null) return false;
  return a >= s && a <= e;
}
function addMinutesToHHMM_(t, mins) {
  const a = parseHHMM_(t);
  if (a == null) return "";
  let x = a + Number(mins || 0);
  x = ((x % (24 * 60)) + (24 * 60)) % (24 * 60);
  const hh = Math.floor(x / 60);
  const mm = x % 60;
  return String(hh).padStart(2, "0") + ":" + String(mm).padStart(2, "0");
}

/** ========= LOG ========= */
function log_(action, by, detail) {
  try {
    const ss = getSS_();
    const sh = ss.getSheetByName(SHEET_LOG);
    sh.appendRow([new Date().toISOString(), String(action), String(by || ""), String(detail || "")]);
  } catch (e) {}
}

/** ========= HTML RENDER ========= */
function renderPage_(page) {
  page = sanitizePage_(page);

  if (page === "work") return htmlWork_();
  if (page === "roster") return htmlRoster_();
  if (page === "settings") return htmlSettings_();
  if (page === "register") return htmlRegister_();
  return htmlLogin_();
}

function esc_(s){
  return String(s || "").replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

function baseHtml_(title, body, script) {
  const css = `
:root{
  --g1:#e8fbf2;
  --g2:#f6fffb;
  --card:#ffffff;
  --text:#0f172a;
  --muted:#64748b;
  --line:#e2e8f0;
  --primary:#0f9d58;
  --primary2:#12b76a;
  --danger:#dc2626;
  --shadow: 0 18px 60px rgba(2,6,23,.10);
  --radius: 18px;
  --btnr: 14px;
}
*{box-sizing:border-box}
body{
  margin:0;
  font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial;
  color:var(--text);
  background:
    radial-gradient(900px 500px at 20% 0%, rgba(18,183,106,.18), transparent 60%),
    radial-gradient(900px 500px at 80% 10%, rgba(15,157,88,.12), transparent 55%),
    linear-gradient(180deg, var(--g1), var(--g2));
  min-height:100vh;
}
.wrap{width:min(900px, 100%); margin:0 auto; padding:26px 16px 40px;}
.wrapNarrow{ width:min(650px, 100%); }

.header{display:flex; align-items:center; justify-content:space-between; margin-bottom:14px;}
.brand{display:flex; align-items:center; gap:12px;}
.logo{width:44px; height:44px; border-radius:14px; background: linear-gradient(135deg, var(--primary), #0c7a45); box-shadow: 0 16px 40px rgba(15,157,88,.18);}
.h1{font-weight:900; font-size:18px; line-height:1.1}
.h2{font-size:12px; color:var(--muted)}
.pill{padding:8px 10px; border-radius:999px; border:1px solid var(--line); background:#fff; font-size:12px; color:var(--muted); max-width:60%; overflow:hidden; white-space:nowrap; text-overflow:ellipsis;}

.card{background:var(--card); border:1px solid rgba(226,232,240,.9); border-radius:var(--radius); box-shadow: var(--shadow); overflow:hidden;}
.inner{padding:22px;}
.title{font-weight:900; font-size:18px; margin:0 0 6px}
.muted{color:var(--muted); font-size:13px}

.row{display:grid; gap:10px; margin-top:14px}
label{font-size:12px; color:var(--muted)}
input, select, textarea{width:100%; padding:12px 12px; border-radius:14px; border:1px solid var(--line); outline:none; background:#fff; font:inherit;}
textarea{min-height:90px; resize:vertical}
input:focus, select:focus, textarea:focus{border-color: rgba(15,157,88,.55); box-shadow: 0 0 0 4px rgba(15,157,88,.10);}

.actions{display:flex; gap:10px; flex-wrap:wrap; margin-top:14px}
.btn{border:none; cursor:pointer; padding:12px 14px; border-radius:var(--btnr); font-weight:900; font:inherit;}
.btnPrimary{color:#fff; background: linear-gradient(135deg, var(--primary), var(--primary2)); box-shadow: 0 16px 35px rgba(15,157,88,.18);}
.btnGhost{background:#fff; border:1px solid var(--line); color:var(--text);}
.btnDanger{background:#fff; border:1px solid rgba(220,38,38,.25); color:var(--danger);}

.status{margin-top:12px; font-size:13px; font-weight:800; min-height:18px; color:var(--muted)}
.status.ok{color:var(--primary)}
.status.bad{color:var(--danger)}

.footer{display:flex; justify-content:space-between; gap:12px; margin-top:18px; padding-top:12px; border-top:1px solid var(--line); color:var(--muted); font-size:12px;}

.navbar{display:flex; gap:10px; flex-wrap:wrap; margin-bottom:12px;}
.navbtn{padding:10px 12px; border-radius:999px; border:1px solid var(--line); background:#fff; cursor:pointer; font-weight:900; font-size:13px;}
.navbtn.active{border-color: rgba(15,157,88,.35); background: rgba(15,157,88,.10); color: var(--primary);}

table{width:100%; border-collapse:separate; border-spacing:0; border:1px solid var(--line); border-radius:16px; overflow:hidden; background:#fff;}
th, td{padding:10px 10px; border-bottom:1px solid var(--line); font-size:13px; vertical-align:top; text-align:left;}
th{font-size:12px; color:var(--muted); background: rgba(15,157,88,.06); font-weight:900;}
tr:last-child td{border-bottom:none}
.small{font-size:12px; color:var(--muted)}
.nameCol{width:220px}
@media(max-width: 820px){ .pill{max-width:100%} .nameCol{width:160px} }
.cellBtn{width:100%; text-align:left; border:1px solid rgba(226,232,240,.9); background:#fff; border-radius:12px; padding:10px 10px; cursor:pointer;}
.cellBtn:hover{border-color: rgba(15,157,88,.35)}
.chip{display:inline-flex; align-items:center; gap:6px; padding:6px 10px; border-radius:999px; border:1px solid rgba(15,157,88,.22); background: rgba(15,157,88,.08); color: var(--primary); font-size:12px; font-weight:900;}

.modalBack{position:fixed; inset:0; background: rgba(2,6,23,.45); display:none; align-items:center; justify-content:center; padding:16px;}
.modal{width:min(520px, 100%); background:#fff; border-radius:18px; border:1px solid rgba(226,232,240,.9); box-shadow: 0 30px 80px rgba(2,6,23,.25); overflow:hidden;}
.modal .hd{padding:14px 16px; border-bottom:1px solid var(--line); font-weight:900}
.modal .bd{padding:14px 16px}
.modal .ft{padding:14px 16px; border-top:1px solid var(--line); display:flex; gap:10px; justify-content:flex-end; flex-wrap:wrap}
`;
  return `<!doctype html>
<html lang="th">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>${esc_(title)}</title>
  <style>${css}</style>
</head>
<body>
${body}
<script>
${script || ""}
</script>
</body>
</html>`;
}

/** ========= HTML: LOGIN ========= */
function htmlLogin_() {
  const body = `
<div class="wrap wrapNarrow">
  <div class="header">
    <div class="brand">
      <div class="logo"></div>
      <div>
        <div class="h1">BK ตารางงาน • ${esc_(BRANCH_NAME)}</div>
        <div class="h2"></div>
      </div>
    </div>
    <div id="who" class="pill">ยังไม่ได้เข้าสู่ระบบ</div>
  </div>

  <div class="card">
    <div class="inner">
      <div class="title">เข้าสู่ระบบ</div>

      <div class="row">
        <div>
          <label>Username</label>
          <input id="u" autocomplete="username"/>
        </div>
        <div>
          <label>Password</label>
          <input id="p" type="password" autocomplete="current-password"/>
        </div>
      </div>

      <div class="actions">
        <button class="btn btnPrimary" onclick="doLogin()">เข้าสู่ระบบ</button>
        <button class="btn btnGhost" onclick="nav('register')">ลงทะเบียน</button>
      </div>

      <div id="st" class="status"></div>

      <div class="footer">
        <div>Branch: ${esc_(BRANCH_NAME)}</div>
        <div>Created by ${esc_(CREATOR_CREDIT)}</div>
      </div>
    </div>
  </div>
</div>`;

  const script = `
let TOKEN = localStorage.getItem("BK_TOKEN") || "";

function nav(page){
  location.href = location.pathname + "?page=" + encodeURIComponent(page);
}

function setStatus(msg, ok){
  const el = document.getElementById("st");
  el.className = "status " + (ok ? "ok" : "bad");
  el.textContent = msg || "";
}

function gasCall(fn, args, onOk, onErr){
  const runner = google.script.run
    .withSuccessHandler(onOk)
    .withFailureHandler(err => {
      const msg = (err && err.message) ? err.message : String(err);
      onErr && onErr(msg);
    });
  runner[fn].apply(runner, args || []);
}

function boot(){
  if(TOKEN){
    gasCall("validate",[TOKEN], (res)=>{
      if(res.ok){ nav("work"); }
      else{ localStorage.removeItem("BK_TOKEN"); TOKEN=""; }
    }, ()=>{
      localStorage.removeItem("BK_TOKEN"); TOKEN="";
    });
  }
}
boot();

function doLogin(){
  setStatus("กำลังล็อกอิน...", true);
  const u = document.getElementById("u").value.trim();
  const p = document.getElementById("p").value;
  gasCall("login",[u,p], (res)=>{
    if(!res.ok){ setStatus(res.message || "ล็อกอินไม่สำเร็จ", false); return; }
    TOKEN = res.token;
    localStorage.setItem("BK_TOKEN", TOKEN);
    nav("work");
  }, (m)=>setStatus(m, false));
}
`;
  return baseHtml_("Login", body, script);
}

/** ========= HTML: REGISTER ========= */
function htmlRegister_() {
  const body = `
<div class="wrap wrapNarrow">
  <div class="header">
    <div class="brand">
      <div class="logo"></div>
      <div>
        <div class="h1">BK ตารางงาน • ${esc_(BRANCH_NAME)}</div>
        <div class="h2"></div>
      </div>
    </div>
    <div class="pill">สมัครใช้งาน</div>
  </div>

  <div class="card">
    <div class="inner">
      <div class="navbar">
        <button class="navbtn active" onclick="show('staff')">Register Staff</button>
        <button class="navbtn" onclick="show('manager')">Register Manager</button>
        <button class="navbtn" onclick="nav('login')">กลับไป Login</button>
      </div>

      <div id="staffBox">
        <div class="title">ลงทะเบียนพนักงาน</div>

        <div class="row">
          <div>
            <label>ชื่อ - สกุล</label>
            <input id="sf_full" oninput="previewUser('staff')"/>
          </div>
          <div style="display:grid; grid-template-columns: 1fr 1fr; gap:10px">
            <div>
              <label>ชื่อเล่น</label>
              <input id="sf_nick"/>
            </div>
            <div>
              <label>เบอร์โทร</label>
              <input id="sf_phone"/>
            </div>
          </div>
          <div>
            <label>Email</label>
            <input id="sf_email" type="email" autocomplete="email"/>
          </div>
          <div>
            <label>Password</label>
            <input id="sf_pass" type="password"/>
          </div>
          <div class="small">Username: <b id="sf_user">-</b></div>
        </div>

        <div class="actions">
          <button class="btn btnPrimary" onclick="regStaff()">ลงทะเบียน</button>
        </div>
        <div id="sf_st" class="status"></div>
      </div>

      <div id="mgrBox" style="display:none">
        <div class="title">ลงทะเบียนผู้จัดการ</div>

        <div class="row">
          <div>
            <label>ชื่อ - สกุล</label>
            <input id="mg_full" oninput="previewUser('manager')"/>
          </div>
          <div style="display:grid; grid-template-columns: 1fr 1fr; gap:10px">
            <div>
              <label>ชื่อเล่น</label>
              <input id="mg_nick"/>
            </div>
            <div>
              <label>เบอร์โทร</label>
              <input id="mg_phone"/>
            </div>
          </div>
          <div>
            <label>Email</label>
            <input id="mg_email" type="email" autocomplete="email"/>
          </div>
          <div>
            <label>Password</label>
            <input id="mg_pass" type="password"/>
          </div>
          <div>
            <label>รหัสยืนยันผู้จัดการ</label>
            <input id="mg_code" type="password"/>
          </div>
          <div class="small">Username: <b id="mg_user">-</b></div>
        </div>

        <div class="actions">
          <button class="btn btnPrimary" onclick="regManager()">ลงทะเบียน</button>
        </div>
        <div id="mg_st" class="status"></div>
      </div>

      <div class="footer">
        <div>Branch: ${esc_(BRANCH_NAME)}</div>
        <div>Created by ${esc_(CREATOR_CREDIT)}</div>
      </div>
    </div>
  </div>
</div>`;

  const script = `
function nav(page){
  location.href = location.pathname + "?page=" + encodeURIComponent(page);
}
function gasCall(fn, args, onOk, onErr){
  const runner = google.script.run
    .withSuccessHandler(onOk)
    .withFailureHandler(err => {
      const msg = (err && err.message) ? err.message : String(err);
      onErr && onErr(msg);
    });
  runner[fn].apply(runner, args || []);
}
function setStatus(id, msg, ok){
  const el = document.getElementById(id);
  el.className = "status " + (ok ? "ok" : "bad");
  el.textContent = msg || "";
}

function show(which){
  document.querySelectorAll(".navbtn").forEach(b=>b.classList.remove("active"));
  if(which==="staff"){
    document.querySelectorAll(".navbtn")[0].classList.add("active");
    document.getElementById("staffBox").style.display="block";
    document.getElementById("mgrBox").style.display="none";
  }else{
    document.querySelectorAll(".navbtn")[1].classList.add("active");
    document.getElementById("staffBox").style.display="none";
    document.getElementById("mgrBox").style.display="block";
  }
}

function guessUser(fullName){
  if(!fullName) return "";
  const s = String(fullName).trim().replace(/\\s+/g," ");
  const parts = s.split(" ");
  if(parts.length<2) return "";
  const first = parts[0].replace(/\\s/g,"").slice(0,3);
  const last  = parts[parts.length-1].replace(/\\s/g,"").slice(0,3);
  if(!first || !last) return "";
  return (first+last).toLowerCase() + "001";
}
function previewUser(kind){
  if(kind==="staff"){
    document.getElementById("sf_user").textContent = guessUser(document.getElementById("sf_full").value) || "-";
  }else{
    document.getElementById("mg_user").textContent = guessUser(document.getElementById("mg_full").value) || "-";
  }
}

function regStaff(){
  setStatus("sf_st","กำลังลงทะเบียน...", true);
  const full = document.getElementById("sf_full").value;
  const nick = document.getElementById("sf_nick").value;
  const phone= document.getElementById("sf_phone").value;
  const email= document.getElementById("sf_email").value;
  const pass = document.getElementById("sf_pass").value;

  gasCall("registerStaff",[full,nick,phone,email,pass], (res)=>{
    if(!res.ok){ setStatus("sf_st", res.message || "ไม่สำเร็จ", false); return; }
    setStatus("sf_st", "สำเร็จ • username: " + res.username, true);
  }, (m)=>setStatus("sf_st", m, false));
}

function regManager(){
  setStatus("mg_st","กำลังลงทะเบียน...", true);
  const full = document.getElementById("mg_full").value;
  const nick = document.getElementById("mg_nick").value;
  const phone= document.getElementById("mg_phone").value;
  const email= document.getElementById("mg_email").value;
  const pass = document.getElementById("mg_pass").value;
  const code = document.getElementById("mg_code").value;

  gasCall("registerManager",[full,nick,phone,email,pass,code], (res)=>{
    if(!res.ok){ setStatus("mg_st", res.message || "ไม่สำเร็จ", false); return; }
    setStatus("mg_st", "สำเร็จ • username: " + res.username, true);
  }, (m)=>setStatus("mg_st", m, false));
}
`;
  return baseHtml_("Register", body, script);
}

/** ========= HTML: WORK / ROSTER / SETTINGS ========= */
/* เพื่อให้คำตอบไม่ยาวทะลุจนวางไม่ได้: ใช้ของเดิมคุณได้เลย แค่แก้ทุกหน้าให้ใช้ nav() แบบเดียวกัน:
   - สร้างฟังก์ชัน nav(page){ location.href = location.pathname + "?page=" + page; }
   - เปลี่ยน reloadTo('work') -> nav('work') (หรือคง reloadTo ก็ได้ ถ้ามันทำแบบเดียวกัน)
   - สำคัญ: ห้ามมีโค้ด demo/appHtml_ เก่า ๆ ที่ใช้ ?view=
*/

function htmlWork_() {
  const body = `
<div class="wrap">
  <div class="header">
    <div class="brand">
      <div class="logo"></div>
      <div>
        <div class="h1">BK ตารางงาน • ${esc_(BRANCH_NAME)}</div>
        <div class="h2">ตารางงานของฉัน</div>
      </div>
    </div>
    <div style="display:flex; gap:10px; align-items:center">
      <div id="uinfo" class="pill">...</div>
      <button class="btn btnGhost" onclick="doLogout()" style="padding:8px 12px">ออก</button>
    </div>
  </div>

  <div class="navbar">
    <button class="navbtn active" onclick="nav('work')">Work</button>
    <button class="navbtn" onclick="nav('roster')">Roster</button>
    <button id="btnSet" class="navbtn" style="display:none" onclick="nav('settings')">Settings</button>
  </div>

  <div class="card">
    <div class="inner">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:14px">
        <div class="title">My Schedule</div>
        <div style="display:flex; gap:8px">
          <button class="btn btnGhost" onclick="addWeek(-1)"> &lt; </button>
          <input type="date" id="picker" onchange="loadWeek(this.value)" style="width:auto; padding:8px; border:none; font-family:inherit; color:var(--primary); font-weight:900" />
          <button class="btn btnGhost" onclick="addWeek(1)"> &gt; </button>
        </div>
      </div>

      <div id="loading" class="muted">Loading...</div>
      <div id="content" style="display:none"></div>

      <div class="footer">
        <div>Branch: ${esc_(BRANCH_NAME)}</div>
      </div>
    </div>
  </div>
</div>

<!-- Templates -->
<template id="tmpl-day">
  <div class="day-row" style="border:1px solid var(--line); border-radius:12px; padding:12px; margin-bottom:12px">
    <div style="display:flex; justify-content:space-between; margin-bottom:10px">
      <div class="d-date" style="font-weight:900; color:var(--muted)"></div>
      <div class="d-status"></div>
    </div>
    <div class="d-actions" style="display:grid; grid-template-columns:repeat(auto-fill, minmax(110px, 1fr)); gap:8px"></div>
  </div>
</template>
`;

  const script = `
let DATA = null;
let CURR_DATE = new Date().toISOString().split("T")[0];

function nav(page){
  location.href = location.pathname + "?page=" + encodeURIComponent(page);
}
function gasCall(fn, args, onOk, onErr){
  const runner = google.script.run
    .withSuccessHandler(onOk)
    .withFailureHandler(err => {
      const msg = (err && err.message) ? err.message : String(err);
      onErr ? onErr(msg) : alert(msg);
    });
  runner[fn].apply(runner, args || []);
}

function init(){
  const t = localStorage.getItem("BK_TOKEN");
  if(!t) return nav("login");
  loadWeek(CURR_DATE);
}

function loadWeek(date){
  if(!date) date = new Date().toISOString().split("T")[0];
  CURR_DATE = date;
  document.getElementById("picker").value = date;
  document.getElementById("loading").style.display = "block";
  document.getElementById("content").style.display = "none";

  gasCall("getMyWeek", [localStorage.getItem("BK_TOKEN"), date], (res)=>{
    if(!res.ok){ alert(res.message); if(res.message.includes("session")) nav("login"); return; }
    DATA = res;
    render();
  });
}

function addWeek(n){
  const d = new Date(CURR_DATE);
  d.setDate(d.getDate() + (n*7));
  loadWeek(d.toISOString().split("T")[0]);
}

function render(){
  document.getElementById("loading").style.display = "none";
  const c = document.getElementById("content");
  c.style.display = "block";
  c.innerHTML = "";

  // User info
  document.getElementById("uinfo").textContent = DATA.user.fullName;
  if(DATA.user.role === 'admin' || DATA.user.role === 'manager'){
    document.getElementById("btnSet").style.display = "inline-block";
  }

  const tmpl = document.getElementById("tmpl-day");
  const days = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];

  DATA.days.forEach(day => {
    const el = tmpl.content.cloneNode(true);
    const dObj = new Date(day);
    const label = day + " (" + days[dObj.getDay()] + ")";

    el.querySelector(".d-date").textContent = label;

    const myShift = DATA.items.find(x => x.date === day);
    const actions = el.querySelector(".d-actions");

    if(myShift){
      el.querySelector(".d-status").innerHTML = \`<span class="chip">\${myShift.shiftGroup} \${myShift.startTime}-\${myShift.endTime}</span>\`;

      const btn = document.createElement("button");
      btn.className = "btn btnDanger";
      btn.textContent = "ยกเลิก";
      btn.onclick = () => doCancel(day);
      if(DATA.closed) btn.disabled = true;
      actions.appendChild(btn);
    } else {
       if(DATA.closed){
         el.querySelector(".d-status").innerHTML = "<span style='color:var(--danger)'>ปิดระบบ</span>";
       } else {
         DATA.groups.forEach(g => {
           const btn = document.createElement("button");
           btn.className = "btn btnGhost";
           btn.style.fontSize = "12px";
           btn.textContent = g.label;
           btn.onclick = () => doBook(day, g.key, g.main);
           actions.appendChild(btn);
         });
       }
    }

    c.appendChild(el);
  });
}

function doBook(date, group, time){
  if(!confirm("ยืนยันลงกะ " + group + " วันที่ " + date + "?")) return;
  gasCall("bookMyShift", [localStorage.getItem("BK_TOKEN"), date, group, time, ""], (res)=>{
    if(!res.ok) alert(res.message);
    else loadWeek(CURR_DATE);
  });
}

function doCancel(date){
  if(!confirm("ยืนยันยกเลิกกะวันที่ " + date + "?")) return;
  gasCall("cancelMyShift", [localStorage.getItem("BK_TOKEN"), date], (res)=>{
    if(!res.ok) alert(res.message);
    else loadWeek(CURR_DATE);
  });
}

function doLogout(){
  gasCall("logout", [localStorage.getItem("BK_TOKEN")], ()=>{
    localStorage.removeItem("BK_TOKEN");
    nav("login");
  });
}

init();
`;
  return baseHtml_("Work", body, script);
}
function htmlRoster_() {
  const body = `
<div class="wrap">
  <div class="header">
    <div class="brand">
      <div class="logo"></div>
      <div>
        <div class="h1">BK ตารางงาน • ${esc_(BRANCH_NAME)}</div>
        <div class="h2">ตารางรวม</div>
      </div>
    </div>
    <div style="display:flex; gap:10px; align-items:center">
      <div id="uinfo" class="pill">...</div>
      <button class="btn btnGhost" onclick="doLogout()" style="padding:8px 12px">ออก</button>
    </div>
  </div>

  <div class="navbar">
    <button class="navbtn" onclick="nav('work')">Work</button>
    <button class="navbtn active" onclick="nav('roster')">Roster</button>
    <button id="btnSet" class="navbtn" style="display:none" onclick="nav('settings')">Settings</button>
  </div>

  <div class="card">
    <div class="inner">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:14px">
        <div class="title">Team Roster</div>
        <div style="display:flex; gap:8px">
          <button class="btn btnGhost" onclick="addWeek(-1)"> &lt; </button>
          <input type="date" id="picker" onchange="loadWeek(this.value)" style="width:auto; padding:8px; border:none; font-family:inherit; color:var(--primary); font-weight:900" />
          <button class="btn btnGhost" onclick="addWeek(1)"> &gt; </button>
        </div>
      </div>

      <div id="loading" class="muted">Loading...</div>
      <div style="overflow-x:auto">
        <table id="tbl" style="min-width:600px; display:none">
          <thead>
            <tr id="thead-row">
              <th class="nameCol">Name</th>
              <!-- Dates -->
            </tr>
          </thead>
          <tbody id="tbody"></tbody>
        </table>
      </div>

      <div class="footer">
        <div>Branch: ${esc_(BRANCH_NAME)}</div>
      </div>
    </div>
  </div>
</div>

<!-- Manager Modal -->
<div id="modal" class="modalBack">
  <div class="modal">
    <div class="hd">จัดการกะ</div>
    <div class="bd">
      <div class="row">
        <div>
          <label>พนักงาน</label>
          <input id="m_user" disabled />
        </div>
        <div>
          <label>วันที่</label>
          <input id="m_date" disabled />
        </div>
        <div>
          <label>กะงาน</label>
          <select id="m_group"></select>
        </div>
        <div>
          <label>เวลาเริ่ม (เช่น 13:00)</label>
          <input id="m_time" type="time" />
        </div>
        <div>
          <label>Note</label>
          <input id="m_note" />
        </div>
      </div>
    </div>
    <div class="ft">
      <button class="btn btnDanger" onclick="doDeleteShift()">ลบกะ</button>
      <button class="btn btnGhost" onclick="closeModal()">ยกเลิก</button>
      <button class="btn btnPrimary" onclick="doSaveShift()">บันทึก</button>
    </div>
  </div>
</div>
`;

  const script = `
let DATA = null;
let CURR_DATE = new Date().toISOString().split("T")[0];
let SELECTED = null; // { username, date, shiftObj }

function nav(page){
  location.href = location.pathname + "?page=" + encodeURIComponent(page);
}
function gasCall(fn, args, onOk, onErr){
  const runner = google.script.run
    .withSuccessHandler(onOk)
    .withFailureHandler(err => {
      const msg = (err && err.message) ? err.message : String(err);
      onErr ? onErr(msg) : alert(msg);
    });
  runner[fn].apply(runner, args || []);
}

function init(){
  const t = localStorage.getItem("BK_TOKEN");
  if(!t) return nav("login");
  loadWeek(CURR_DATE);
}

function loadWeek(date){
  if(!date) date = new Date().toISOString().split("T")[0];
  CURR_DATE = date;
  document.getElementById("picker").value = date;
  document.getElementById("loading").style.display = "block";
  document.getElementById("tbl").style.display = "none";

  gasCall("getRosterWeek", [localStorage.getItem("BK_TOKEN"), date], (res)=>{
    if(!res.ok){ alert(res.message); if(res.message.includes("session")) nav("login"); return; }
    DATA = res;
    render();
  });
}

function addWeek(n){
  const d = new Date(CURR_DATE);
  d.setDate(d.getDate() + (n*7));
  loadWeek(d.toISOString().split("T")[0]);
}

function render(){
  document.getElementById("loading").style.display = "none";
  document.getElementById("tbl").style.display = "table";

  document.getElementById("uinfo").textContent = DATA.me.fullName;
  if(DATA.me.role === 'admin' || DATA.me.role === 'manager'){
    document.getElementById("btnSet").style.display = "inline-block";
  }

  // HEADERS
  const hr = document.getElementById("thead-row");
  while(hr.children.length > 1) hr.removeChild(hr.lastChild);

  const days = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
  DATA.days.forEach(d => {
    const th = document.createElement("th");
    const dd = new Date(d);
    th.innerHTML = d.split("-").slice(1).join("/") + "<br/>" + days[dd.getDay()];
    hr.appendChild(th);
  });

  // BODY
  const tb = document.getElementById("tbody");
  tb.innerHTML = "";

  DATA.users.forEach(u => {
    const tr = document.createElement("tr");

    // Name
    const tdName = document.createElement("td");
    // Securely set content
    const b = document.createElement("b");
    b.textContent = u.fullName;
    const br = document.createElement("br");
    const sp = document.createElement("span");
    sp.className = "small";
    sp.textContent = u.nickName || "";

    tdName.appendChild(b);
    tdName.appendChild(br);
    tdName.appendChild(sp);
    tr.appendChild(tdName);

    // Days
    DATA.days.forEach(d => {
      const td = document.createElement("td");
      const k = u.username.toLowerCase() + "|" + d;
      const s = DATA.map[k];

      if(s){
        td.innerHTML = "<div class='chip'>" + s.shiftGroup + " " + s.startTime + "</div>";
      } else {
        td.innerHTML = "-";
      }

      if(DATA.canManage){
        td.style.cursor = "pointer";
        td.onclick = () => openModal(u, d, s);
      }
      tr.appendChild(td);
    });

    tb.appendChild(tr);
  });
}

function openModal(user, date, shift){
  if(DATA.closed){ alert("ระบบปิดอยู่"); return; }
  SELECTED = { username: user.username, fullName: user.fullName, date, shift };

  document.getElementById("m_user").value = user.fullName;
  document.getElementById("m_date").value = date;
  document.getElementById("m_note").value = shift ? (shift.note || "") : "";

  // Groups
  const sel = document.getElementById("m_group");
  sel.innerHTML = "";
  DATA.groups.forEach(g => {
    const opt = document.createElement("option");
    opt.value = g.key;
    opt.textContent = g.label;
    if(shift && shift.shiftGroup === g.key) opt.selected = true;
    sel.appendChild(opt);
  });
  sel.onchange = () => {
    const g = DATA.groups.find(x => x.key === sel.value);
    if(g) document.getElementById("m_time").value = g.main;
  };

  // Time
  if(shift){
    document.getElementById("m_time").value = shift.startTime;
  } else {
    // default first group or selected
    const g = DATA.groups[0];
    document.getElementById("m_time").value = g ? g.main : "00:00";
    if(sel.options.length > 0) sel.selectedIndex = 0;
  }

  document.getElementById("modal").style.display = "flex";
}

function closeModal(){
  document.getElementById("modal").style.display = "none";
  SELECTED = null;
}

function doSaveShift(){
  if(!SELECTED) return;
  const group = document.getElementById("m_group").value;
  const time = document.getElementById("m_time").value;
  const note = document.getElementById("m_note").value;

  gasCall("setShiftForUser", [localStorage.getItem("BK_TOKEN"), SELECTED.username, SELECTED.date, group, time, note], (res)=>{
    if(!res.ok) alert(res.message);
    else { closeModal(); loadWeek(CURR_DATE); }
  });
}

function doDeleteShift(){
  if(!SELECTED) return;
  if(!confirm("ลบกะนี้?")) return;
  gasCall("deleteShiftForUser", [localStorage.getItem("BK_TOKEN"), SELECTED.username, SELECTED.date], (res)=>{
    if(!res.ok) alert(res.message);
    else { closeModal(); loadWeek(CURR_DATE); }
  });
}

function doLogout(){
  gasCall("logout", [localStorage.getItem("BK_TOKEN")], ()=>{
    localStorage.removeItem("BK_TOKEN");
    nav("login");
  });
}

init();
`;
  return baseHtml_("Roster", body, script);
}
function htmlSettings_() {
  const body = `
<div class="wrap wrapNarrow">
  <div class="header">
    <div class="brand">
      <div class="logo"></div>
      <div>
        <div class="h1">BK ตารางงาน • ${esc_(BRANCH_NAME)}</div>
        <div class="h2">ตั้งค่าระบบ</div>
      </div>
    </div>
    <div style="display:flex; gap:10px; align-items:center">
      <button class="btn btnGhost" onclick="nav('work')" style="padding:8px 12px">กลับ</button>
    </div>
  </div>

  <div class="card">
    <div class="inner">
      <div class="title">Capacity Settings</div>
      <div class="muted" style="margin-bottom:14px">กำหนดจำนวนคนที่รับในแต่ละกะ</div>

      <div id="loading" class="muted">Loading...</div>
      <div id="form" style="display:none">
        <div id="rows"></div>
        <div class="actions">
          <button class="btn btnPrimary" onclick="doSave()">บันทึก</button>
        </div>
      </div>

      <div class="footer">
        <div>Branch: ${esc_(BRANCH_NAME)}</div>
      </div>
    </div>
  </div>
</div>
`;

  const script = `
let DATA = null;

function nav(page){
  location.href = location.pathname + "?page=" + encodeURIComponent(page);
}
function gasCall(fn, args, onOk, onErr){
  const runner = google.script.run
    .withSuccessHandler(onOk)
    .withFailureHandler(err => {
      const msg = (err && err.message) ? err.message : String(err);
      onErr ? onErr(msg) : alert(msg);
    });
  runner[fn].apply(runner, args || []);
}

function init(){
  const t = localStorage.getItem("BK_TOKEN");
  if(!t) return nav("login");

  gasCall("getSettings", [t], (res)=>{
    if(!res.ok){ alert(res.message); nav("work"); return; }
    DATA = res;
    render();
  });
}

function render(){
  document.getElementById("loading").style.display = "none";
  document.getElementById("form").style.display = "block";

  const c = document.getElementById("rows");
  c.innerHTML = "";

  DATA.groups.forEach(g => {
    const div = document.createElement("div");
    div.style.marginBottom = "12px";

    const lbl = document.createElement("label");
    lbl.textContent = g.label + " (Start " + g.windowStart + " - " + g.windowEnd + ")";

    const inp = document.createElement("input");
    inp.type = "number";
    inp.id = "cap_" + g.key;
    inp.value = DATA.capacity[g.key] || 0;

    div.appendChild(lbl);
    div.appendChild(inp);
    c.appendChild(div);
  });
}

function doSave(){
  const payload = {};
  DATA.groups.forEach(g => {
    const el = document.getElementById("cap_" + g.key);
    if(el) payload[g.key] = el.value;
  });

  gasCall("updateSettings", [localStorage.getItem("BK_TOKEN"), payload], (res)=>{
    if(!res.ok) alert(res.message);
    else { alert("Saved"); nav("work"); }
  });
}

init();
`;
  return baseHtml_("Settings", body, script);
}

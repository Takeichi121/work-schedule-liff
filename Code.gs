/*******************************************************
 * BK Work Schedule - Grand Diamond (Google Apps Script)
 * Single file: Paste only in Code.gs
 *
 * Pages (full reload):
 * - /exec?page=login        (Login only)
 * - /exec?page=register     (Register only)
 * - /exec?page=work         (Main after login)
 * - /exec?page=roster       (Roster Tue-start)
 * - /exec?page=settings     (Manager settings)
 *
 * Rules:
 * - No LINE login
 * - Admin/Manager NOT shown in roster staff list
 * - Admin/Manager cannot book shifts (only manage)
 * - Week starts Tuesday always (Tue -> Mon)
 * - Green calm theme
 * - Register includes Email, no example placeholder text
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

// generate start time options every 30 minutes inside each window
const START_STEP_MIN = 30;

// close window: Tuesday 12:00 -> Thursday 00:00 (TH time)
function isSystemClosed_() {
  const tz = "Asia/Bangkok";
  const now = new Date();
  const day = Number(Utilities.formatDate(now, tz, "u")); // 1=Mon ... 7=Sun
  const hhmm = Utilities.formatDate(now, tz, "HH:mm");
  // Tue=2: after 12:00 closed
  if (day === 2) return hhmm >= "12:00";
  // Wed=3 closed all day
  if (day === 3) return true;
  // Thu=4 open from 00:00 => NOT closed
  return false;
}

/** ========= WEB ENTRY ========= */
function doGet(e) {
  // รองรับทั้ง ?page= และ ?view= (กันของเก่าที่เคยใช้ view)
  const raw = (e && e.parameter) ? (e.parameter.page || e.parameter.view) : "";
  const page = sanitizePage_(raw || "login");

  return HtmlService
    .createHtmlOutput(renderPage_(page))
    .setTitle("BK ตารางงาน • " + BRANCH_NAME)
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function sanitizePage_(p) {
  p = String(p || "").trim().toLowerCase();
  const allowed = { login:1, register:1, work:1, roster:1, settings:1 };
  return allowed[p] ? p : "login";
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
  ensureInitialized_();
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
  ensureInitialized_();
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
  ensureInitialized_();
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
  ensureInitialized_();
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
  ensureInitialized_();
  const v = validate(token);
  if (!v.ok) return { ok: false, message: "session หมดอายุ/ไม่ถูกต้อง" };
  if (!(v.user.role === "admin" || v.user.role === "manager")) return { ok: false, message: "สิทธิ์ไม่พอ" };

  return { ok: true, capacity: getCapacity_(), groups: SHIFT_GROUPS };
}

function updateSettings(token, capacityObj) {
  ensureInitialized_();
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
  ensureInitialized_();
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
  ensureInitialized_();
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

  // validate start time in window
  const g = SHIFT_GROUPS.find(x => x.key === shiftGroup);
  if (!isTimeInWindow_(startTime, g.windowStart, g.windowEnd)) return { ok: false, message: "เวลาเริ่มไม่อยู่ในช่วงกะ" };

  // capacity
  const cap = getCapacity_();
  const count = countShift_(date, shiftGroup);
  if (count >= Number(cap[shiftGroup])) return { ok: false, message: "กะนี้เต็มแล้ว" };

  // no duplicate for same user/date
  if (hasUserShiftOnDate_(v.user.username, date)) return { ok: false, message: "คุณมีตารางงานวันนั้นแล้ว" };

  const endTime = addMinutesToHHMM_(startTime, 9 * 60);
  upsertShift_(date, v.user.username, v.user.fullName, v.user.role, shiftGroup, startTime, endTime, note, v.user.username);

  log_("book_shift", v.user.username, date + " " + shiftGroup + " " + startTime);
  return { ok: true };
}

function cancelMyShift(token, date) {
  ensureInitialized_();
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
  ensureInitialized_();
  const v = validate(token);
  if (!v.ok) return { ok: false, message: "session หมดอายุ/ไม่ถูกต้อง" };

  const wk = getWeekRangeTuesday_(anyDate);
  const shifts = getShiftsInRange_(wk.start, wk.end);

  // roster users = staff only (exclude admin/manager)
  const users = getUsers_()
    .filter(u => u.role === "staff" && String(u.active) === "true")
    .map(u => ({ username: u.username, fullName: u.fullName, position: u.position }));

  // map: username|date => shift
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

// Manager set shift for staff
function setShiftForUser(token, username, date, shiftGroup, startTime, note) {
  ensureInitialized_();
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

  // capacity check (if creating new for that date/group)
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
  ensureInitialized_();
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

function ensureInitialized_() {
  // กันเคสยังไม่ได้รัน setup แล้วมีคนเปิดใช้งานทันที
  const ss = getSS_();
  const need = [SHEET_USERS, SHEET_SHIFTS, SHEET_CONFIG, SHEET_LOG];
  const ok = need.every(n => !!ss.getSheetByName(n));
  if (!ok) setup();
}

function ensureSheet_(ss, name, headers) {
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);

  const lastRow = sh.getLastRow();
  const lastCol = sh.getLastColumn();
  if (lastRow === 0 || lastCol === 0) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    return;
  }

  const first = sh.getRange(1, 1, 1, headers.length).getValues()[0];
  const matches = headers.every((h, i) => String(first[i] || "").trim() === h);

  if (!matches) {
    // backup ก่อนล้าง (กันข้อมูลหาย)
    const tz = "Asia/Bangkok";
    const stamp = Utilities.formatDate(new Date(), tz, "yyyyMMdd_HHmmss");
    try {
      const cp = sh.copyTo(ss);
      cp.setName(name + "_backup_" + stamp);
    } catch (e) {}

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
  const headers = values.shift() || ["key","value","updatedAt"];

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
  return rows.length ? rows[0] : null; // first match
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
    // columns: date,username,fullName,role,shiftGroup,startTime,endTime,note,createdAt,updatedAt,updatedBy
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
  return (first + last).toLowerCase(); // 6 chars
}

function allocateUsername_(base6) {
  base6 = String(base6 || "").trim().toLowerCase();
  if (!base6 || base6.length < 2) return "";

  const users = getUsers_();
  // try 001..999
  for (let i = 1; i <= 999; i++) {
    const u = base6 + String(i).padStart(3, "0");
    if (!users.some(x => x.username === u)) return u;
  }
  return "";
}

/** ========= WEEK starts Tuesday ========= */
function getWeekRangeTuesday_(anyDate) {
  const tz = "Asia/Bangkok";
  const d = anyDate ? new Date(String(anyDate)) : new Date();
  // normalize to date-only in Bangkok
  const ymd = Utilities.formatDate(d, tz, "yyyy-MM-dd");
  const dd = new Date(ymd + "T00:00:00+07:00");

  // find Tuesday (u: Mon=1..Sun=7). Tue=2
  const u = Number(Utilities.formatDate(dd, tz, "u"));
  const delta = (u >= 2) ? (u - 2) : (7 - (2 - u)); // how many days since Tue
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
  --warn:#f59e0b;
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
.wrap{width:min(1100px, 100%); margin:0 auto; padding:26px 16px 40px;}
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
.btn{border:none; cursor:pointer; padding:12px 14px; border-radius:var(--btnr); font-weight:900; font:inherit; transition: transform .05s ease, box-shadow .15s ease, opacity .15s ease;}
.btn:active{transform:scale(.98)}
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
        <button class="btn btnGhost" onclick="goRegister()">ลงทะเบียน</button>
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
function goRegister(){ location.href = "?page=register"; }
function goWork(){ location.href = "?page=work"; }

function boot(){
  if(TOKEN){
    gasCall("validate",[TOKEN], (res)=>{
      if(res.ok){ goWork(); }
      else{ localStorage.removeItem("BK_TOKEN"); }
    }, ()=>{ localStorage.removeItem("BK_TOKEN"); });
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
    goWork();
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
        <button class="navbtn" onclick="goLogin()">กลับไป Login</button>
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
function goLogin(){ location.href = "?page=login"; }

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

/** ========= HTML: WORK (MAIN) ========= */
function htmlWork_() {
  const body = `
<div class="wrap">
  <div class="header">
    <div class="brand">
      <div class="logo"></div>
      <div>
        <div class="h1">BK ตารางงาน • ${esc_(BRANCH_NAME)}</div>
        <div class="h2"></div>
      </div>
    </div>
    <div id="who" class="pill"></div>
  </div>

  <div class="card">
    <div class="inner">
      <div class="navbar">
        <button class="navbtn active" onclick="reloadTo('work')">ทำงาน</button>
        <button class="navbtn" onclick="reloadTo('roster')">Roster</button>
        <button class="navbtn" id="btnSettings" style="display:none" onclick="reloadTo('settings')">ตั้งค่า</button>
        <button class="navbtn" onclick="doLogout()">ออกจากระบบ</button>
      </div>

      <div class="title">หน้าหลัก</div>
      <div class="muted">จองกะ (พนักงานเท่านั้น) • ยกเลิกได้เฉพาะของตัวเอง</div>

      <div class="row">
        <div style="display:grid; grid-template-columns: 1fr 1fr; gap:10px">
          <div>
            <label>สัปดาห์ (เริ่มอังคารอัตโนมัติ)</label>
            <input id="pickDate" type="date"/>
          </div>
          <div class="actions" style="align-items:end">
            <button class="btn btnGhost" onclick="thisWeek()">สัปดาห์นี้</button>
            <button class="btn btnPrimary" onclick="load()">โหลด</button>
          </div>
        </div>

        <div style="border-top:1px solid var(--line); padding-top:12px">
          <div class="title" style="font-size:16px; margin-bottom:6px">จองกะ</div>

          <div style="display:grid; grid-template-columns: 1fr 1fr; gap:10px">
            <div>
              <label>วันที่</label>
              <input id="bk_date" type="date"/>
            </div>
            <div>
              <label>กะ</label>
              <select id="bk_group"></select>
            </div>
          </div>

          <div style="display:grid; grid-template-columns: 1fr 1fr; gap:10px; margin-top:10px">
            <div>
              <label>เวลาเริ่ม</label>
              <select id="bk_start"></select>
            </div>
            <div>
              <label>เวลาเลิก (อัตโนมัติ +9ชม.)</label>
              <input id="bk_end" disabled/>
            </div>
          </div>

          <div style="margin-top:10px">
            <label>หมายเหตุ</label>
            <textarea id="bk_note"></textarea>
          </div>

          <div class="actions">
            <button class="btn btnPrimary" onclick="book()">จอง</button>
            <button class="btn btnDanger" onclick="cancel()">ยกเลิกของฉัน (ตามวันที่เลือก)</button>
          </div>

          <div id="st" class="status"></div>
        </div>

        <div style="border-top:1px solid var(--line); padding-top:12px">
          <div class="title" style="font-size:16px; margin-bottom:6px">ตารางของฉัน (สัปดาห์นี้)</div>
          <div id="myWrap"></div>
        </div>
      </div>

      <div class="footer">
        <div>Branch: ${esc_(BRANCH_NAME)}</div>
        <div>Created by ${esc_(CREATOR_CREDIT)}</div>
      </div>
    </div>
  </div>
</div>`;

  const script = `
let TOKEN = localStorage.getItem("BK_TOKEN") || "";
let ME = null;
let GROUPS = [];
let CAP = {};

function reloadTo(p){ location.href = "?page=" + p; }
function redirectLogin(){ location.href = "?page=login"; }

function gasCall(fn, args, onOk, onErr){
  const runner = google.script.run
    .withSuccessHandler(onOk)
    .withFailureHandler(err => {
      const msg = (err && err.message) ? err.message : String(err);
      onErr && onErr(msg);
    });
  runner[fn].apply(runner, args || []);
}
function setStatus(msg, ok){
  const el = document.getElementById("st");
  el.className = "status " + (ok ? "ok" : "bad");
  el.textContent = msg || "";
}
function setWho(){
  const el = document.getElementById("who");
  if(!ME){ el.textContent = ""; return; }
  el.textContent = ME.fullName + " • " + ME.username + " • " + ME.role;
  document.getElementById("btnSettings").style.display = (ME.role==="admin"||ME.role==="manager") ? "inline-block" : "none";
}
function doLogout(){
  const t = TOKEN;
  TOKEN = "";
  localStorage.removeItem("BK_TOKEN");
  if(t) gasCall("logout",[t], ()=>redirectLogin(), ()=>redirectLogin());
  else redirectLogin();
}
function thisWeek(){
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth()+1).padStart(2,"0");
  const dd = String(d.getDate()).padStart(2,"0");
  document.getElementById("pickDate").value = yyyy+"-"+mm+"-"+dd;
}
function fillGroups(){
  const sel = document.getElementById("bk_group");
  sel.innerHTML = GROUPS.map(g=>'<option value="'+g.key+'">'+g.label+' ('+g.windowStart+'-'+g.windowEnd+' • main '+g.main+')</option>').join("");
  sel.onchange = fillStart;
  fillStart();
}
function fillStart(){
  const group = document.getElementById("bk_group").value;
  const g = GROUPS.find(x=>x.key===group);
  const opts = [];
  function toMin(t){ const [h,m]=t.split(":").map(Number); return h*60+m; }
  function toHHMM(min){ min=((min%(24*60))+(24*60))%(24*60); const h=Math.floor(min/60), m=min%60; return String(h).padStart(2,"0")+":"+String(m).padStart(2,"0"); }
  const s = toMin(g.windowStart), e = toMin(g.windowEnd);
  for(let m=s; m<=e; m+=30) opts.push(toHHMM(m));
  if(!opts.includes(g.main)) opts.push(g.main);
  opts.sort();
  const sel = document.getElementById("bk_start");
  sel.innerHTML = opts.map(t=>'<option value="'+t+'">'+t+'</option>').join("");
  sel.onchange = calcEnd;
  calcEnd();
}
function calcEnd(){
  const t = document.getElementById("bk_start").value;
  function toMin(t){ const [h,m]=t.split(":").map(Number); return h*60+m; }
  function toHHMM(min){ min=((min%(24*60))+(24*60))%(24*60); const h=Math.floor(min/60), m=min%60; return String(h).padStart(2,"0")+":"+String(m).padStart(2,"0"); }
  document.getElementById("bk_end").value = toHHMM(toMin(t) + 540); // +9h
}
function load(){
  if(!TOKEN) return redirectLogin();
  setStatus("กำลังโหลด...", true);
  const anyDate = document.getElementById("pickDate").value || "";
  gasCall("getMyWeek",[TOKEN, anyDate], (res)=>{
    if(!res.ok){ setStatus(res.message || "โหลดไม่สำเร็จ", false); return; }
    ME = res.user;
    GROUPS = res.groups || [];
    CAP = res.capacity || {};
    setWho();
    fillGroups();

    if(!document.getElementById("pickDate").value){
      document.getElementById("pickDate").value = res.weekStart;
    }
    if(!document.getElementById("bk_date").value){
      const d = new Date();
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth()+1).padStart(2,"0");
      const dd = String(d.getDate()).padStart(2,"0");
      document.getElementById("bk_date").value = yyyy+"-"+mm+"-"+dd;
    }

    renderMy(res.items || []);
    setStatus(res.closed ? "ระบบปิดช่วงนี้" : "พร้อมใช้งาน", !res.closed);
  }, (m)=>setStatus(m, false));
}
function escapeHtml(s){
  return String(s||"").replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function renderMy(items){
  if(!items.length){
    document.getElementById("myWrap").innerHTML = '<div class="muted">ยังไม่มี</div>';
    return;
  }
  const mapLabel = {open:"Open", lunch:"Lunch", dinner:"Dinner", late:"Late Night"};
  const html = '<table><thead><tr><th style="width:120px">วันที่</th><th style="width:120px">กะ</th><th style="width:120px">เวลา</th><th>หมายเหตุ</th></tr></thead><tbody>'
    + items.map(x=>{
      return '<tr>'
        + '<td>'+x.date+'</td>'
        + '<td><span class="chip">'+(mapLabel[x.shiftGroup]||x.shiftGroup)+'</span></td>'
        + '<td>'+x.startTime+'-'+x.endTime+'</td>'
        + '<td>'+ escapeHtml(x.note||"") +'</td>'
      + '</tr>';
    }).join("")
    + '</tbody></table>';
  document.getElementById("myWrap").innerHTML = html;
}
function book(){
  if(!TOKEN) return redirectLogin();
  const date = document.getElementById("bk_date").value;
  const group = document.getElementById("bk_group").value;
  const start = document.getElementById("bk_start").value;
  const note = document.getElementById("bk_note").value;

  setStatus("กำลังจอง...", true);
  gasCall("bookMyShift",[TOKEN, date, group, start, note], (res)=>{
    if(!res.ok){ setStatus(res.message || "จองไม่สำเร็จ", false); return; }
    setStatus("จองสำเร็จ", true);
    load();
  }, (m)=>setStatus(m, false));
}
function cancel(){
  if(!TOKEN) return redirectLogin();
  const date = document.getElementById("bk_date").value;
  if(!date){ setStatus("เลือกวันที่ก่อน", false); return; }
  setStatus("กำลังยกเลิก...", true);
  gasCall("cancelMyShift",[TOKEN, date], (res)=>{
    if(!res.ok){ setStatus(res.message || "ยกเลิกไม่สำเร็จ", false); return; }
    setStatus("ยกเลิกแล้ว", true);
    load();
  }, (m)=>setStatus(m, false));
}
function boot(){
  if(!TOKEN) return redirectLogin();
  gasCall("validate",[TOKEN], (res)=>{
    if(!res.ok){ localStorage.removeItem("BK_TOKEN"); return redirectLogin(); }
    ME = res.user;
    setWho();
    thisWeek();
    load();
  }, ()=>{ localStorage.removeItem("BK_TOKEN"); redirectLogin(); });
}
boot();
`;
  return baseHtml_("Work", body, script);
}

/** ========= HTML: ROSTER ========= */
function htmlRoster_() {
  const body = `
<div class="wrap">
  <div class="header">
    <div class="brand">
      <div class="logo"></div>
      <div>
        <div class="h1">BK ตารางงาน • ${esc_(BRANCH_NAME)}</div>
        <div class="h2"></div>
      </div>
    </div>
    <div id="who" class="pill"></div>
  </div>

  <div class="card">
    <div class="inner">
      <div class="navbar">
        <button class="navbtn" onclick="reloadTo('work')">ทำงาน</button>
        <button class="navbtn active" onclick="reloadTo('roster')">Roster</button>
        <button class="navbtn" id="btnSettings" style="display:none" onclick="reloadTo('settings')">ตั้งค่า</button>
        <button class="navbtn" onclick="doLogout()">ออกจากระบบ</button>
      </div>

      <div class="title">Roster (รายชื่อเป็นแถว)</div>
      <div class="muted">เริ่มสัปดาห์วันอังคารเสมอ • Admin/Manager ไม่แสดง</div>

      <div class="row">
        <div style="display:grid; grid-template-columns: 1fr 1fr; gap:10px">
          <div>
            <label>สัปดาห์</label>
            <input id="pickDate" type="date"/>
          </div>
          <div class="actions" style="align-items:end">
            <button class="btn btnGhost" onclick="thisWeek()">สัปดาห์นี้</button>
            <button class="btn btnPrimary" onclick="load()">โหลด Roster</button>
          </div>
        </div>

        <div id="st" class="status"></div>
        <div id="tableWrap"></div>
      </div>

      <div class="footer">
        <div>Branch: ${esc_(BRANCH_NAME)}</div>
        <div>Created by ${esc_(CREATOR_CREDIT)}</div>
      </div>
    </div>
  </div>
</div>

<div id="mb" class="modalBack">
  <div class="modal">
    <div class="hd" id="mh"></div>
    <div class="bd">
      <div class="row" style="margin-top:0">
        <div>
          <label>กะ</label>
          <select id="m_group"></select>
        </div>
        <div>
          <label>เวลาเริ่ม</label>
          <select id="m_start"></select>
        </div>
        <div>
          <label>หมายเหตุ</label>
          <textarea id="m_note"></textarea>
        </div>
      </div>
      <div id="m_st" class="status"></div>
    </div>
    <div class="ft">
      <button class="btn btnGhost" onclick="closeModal()">ปิด</button>
      <button class="btn btnDanger" id="btnDel" style="display:none" onclick="delShift()">ลบ</button>
      <button class="btn btnPrimary" id="btnSave" style="display:none" onclick="saveShift()">บันทึก</button>
    </div>
  </div>
</div>
`;

  const script = `
let TOKEN = localStorage.getItem("BK_TOKEN") || "";
let ME = null;
let CAN_MANAGE = false;
let GROUPS = [];
let SHIFT_MAP = {};
let CUR = { username:"", date:"" };

function reloadTo(p){ location.href = "?page=" + p; }
function redirectLogin(){ location.href = "?page=login"; }

function gasCall(fn, args, onOk, onErr){
  const runner = google.script.run
    .withSuccessHandler(onOk)
    .withFailureHandler(err => {
      const msg = (err && err.message) ? err.message : String(err);
      onErr && onErr(msg);
    });
  runner[fn].apply(runner, args || []);
}
function setStatus(msg, ok){
  const el = document.getElementById("st");
  el.className = "status " + (ok ? "ok" : "bad");
  el.textContent = msg || "";
}
function setWho(){
  const el = document.getElementById("who");
  el.textContent = ME ? (ME.fullName + " • " + ME.username + " • " + ME.role) : "";
  document.getElementById("btnSettings").style.display = (ME && (ME.role==="admin"||ME.role==="manager")) ? "inline-block" : "none";
}
function doLogout(){
  const t = TOKEN;
  TOKEN = "";
  localStorage.removeItem("BK_TOKEN");
  if(t) gasCall("logout",[t], ()=>redirectLogin(), ()=>redirectLogin());
  else redirectLogin();
}
function thisWeek(){
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth()+1).padStart(2,"0");
  const dd = String(d.getDate()).padStart(2,"0");
  document.getElementById("pickDate").value = yyyy+"-"+mm+"-"+dd;
}
function mapLabel(k){
  return ({open:"Open", lunch:"Lunch", dinner:"Dinner", late:"Late Night"})[k] || k;
}
function load(){
  if(!TOKEN) return redirectLogin();
  setStatus("กำลังโหลด...", true);
  const anyDate = document.getElementById("pickDate").value || "";

  gasCall("getRosterWeek",[TOKEN, anyDate], (res)=>{
    if(!res.ok){ setStatus(res.message || "โหลดไม่สำเร็จ", false); return; }

    ME = res.me;
    CAN_MANAGE = !!res.canManage;
    GROUPS = res.groups || [];
    setWho();

    if(!document.getElementById("pickDate").value) document.getElementById("pickDate").value = res.weekStart;

    render(res);
    setStatus(res.closed ? "ระบบปิดช่วงนี้" : "โหลดแล้ว", !res.closed);
  }, (m)=>setStatus(m, false));
}
function render(res){
  const days = res.days || [];
  const users = res.users || [];
  const map = res.map || {};
  SHIFT_MAP = map;

  const thDays = ["อังคาร","พุธ","พฤหัส","ศุกร์","เสาร์","อาทิตย์","จันทร์"];

  let thead = '<thead><tr><th class="nameCol">Name</th>' +
    days.map((d,i)=>'<th>'+thDays[i]+'<div class="small">'+d+'</div></th>').join("") +
  '</tr></thead>';

  let tbody = '<tbody>' + users.map(u=>{
    const name = '<div style="font-weight:900">'+escapeHtml(u.fullName||u.username)+'</div><div class="small">'+escapeHtml(u.username)+'</div>';
    const cols = days.map(d=>{
      const k = u.username.toLowerCase() + "|" + d;
      const s = map[k];
      const text = s ? (mapLabel(s.shiftGroup) + " • " + s.startTime + "-" + s.endTime) : "-";
      const btn = '<button class="cellBtn" onclick="cellClick(\\''+escapeJs(u.username)+'\\',\\''+d+'\\')">'+escapeHtml(text)+'</button>';
      return '<td>'+btn+'</td>';
    }).join("");
    return '<tr><td>'+name+'</td>'+cols+'</tr>';
  }).join("") + '</tbody>';

  document.getElementById("tableWrap").innerHTML = '<table>'+thead+tbody+'</table>';
}
function escapeHtml(s){
  return String(s||"").replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function escapeJs(s){
  return String(s||"").replace(/\\\\/g,"\\\\\\\\").replace(/'/g,"\\\\'");
}
function cellClick(username, date){
  CUR = { username, date };
  openModal();
}
function openModal(){
  document.getElementById("mb").style.display = "flex";
  document.getElementById("mh").textContent = CUR.username + " • " + CUR.date;

  const mg = document.getElementById("m_group");
  mg.innerHTML = GROUPS.map(g=>'<option value="'+g.key+'">'+g.label+' ('+g.windowStart+'-'+g.windowEnd+')</option>').join("");
  mg.onchange = fillStart;

  const key = CUR.username.toLowerCase() + "|" + CUR.date;
  const shift = SHIFT_MAP[key];

  if(shift){
    mg.value = shift.shiftGroup;
    fillStart();
    document.getElementById("m_start").value = shift.startTime;
    document.getElementById("m_note").value = shift.note || "";
  }else{
    mg.value = GROUPS[0].key;
    fillStart();
    document.getElementById("m_note").value = "";
  }

  document.getElementById("btnSave").style.display = CAN_MANAGE ? "inline-block" : "none";
  document.getElementById("btnDel").style.display  = CAN_MANAGE ? "inline-block" : "none";

  document.getElementById("m_st").textContent = CAN_MANAGE ? "" : "ดูอย่างเดียว (ต้องเป็นผู้จัดการ)";
  document.getElementById("m_st").className = "status " + (CAN_MANAGE ? "" : "bad");
}
function closeModal(){
  document.getElementById("mb").style.display = "none";
}
function fillStart(){
  const group = document.getElementById("m_group").value;
  const g = GROUPS.find(x=>x.key===group);
  function toMin(t){ const [h,m]=t.split(":").map(Number); return h*60+m; }
  function toHHMM(min){ min=((min%(24*60))+(24*60))%(24*60); const h=Math.floor(min/60), m=min%60; return String(h).padStart(2,"0")+":"+String(m).padStart(2,"0"); }
  const s = toMin(g.windowStart), e = toMin(g.windowEnd);
  const opts = [];
  for(let m=s; m<=e; m+=30) opts.push(toHHMM(m));
  if(!opts.includes(g.main)) opts.push(g.main);
  opts.sort();
  const ms = document.getElementById("m_start");
  ms.innerHTML = opts.map(t=>'<option value="'+t+'">'+t+'</option>').join("");
}
function modalStatus(msg, ok){
  const el = document.getElementById("m_st");
  el.className = "status " + (ok ? "ok" : "bad");
  el.textContent = msg || "";
}
function saveShift(){
  if(!CAN_MANAGE) return;
  modalStatus("กำลังบันทึก...", true);
  const group = document.getElementById("m_group").value;
  const start = document.getElementById("m_start").value;
  const note  = document.getElementById("m_note").value;

  gasCall("setShiftForUser",[TOKEN, CUR.username, CUR.date, group, start, note], (res)=>{
    if(!res.ok){ modalStatus(res.message || "ไม่สำเร็จ", false); return; }
    modalStatus("บันทึกแล้ว", true);
    setTimeout(()=>{ closeModal(); load(); }, 250);
  }, (m)=>modalStatus(m, false));
}
function delShift(){
  if(!CAN_MANAGE) return;
  modalStatus("กำลังลบ...", true);
  gasCall("deleteShiftForUser",[TOKEN, CUR.username, CUR.date], (res)=>{
    if(!res.ok){ modalStatus(res.message || "ลบไม่สำเร็จ", false); return; }
    modalStatus("ลบแล้ว", true);
    setTimeout(()=>{ closeModal(); load(); }, 250);
  }, (m)=>modalStatus(m, false));
}
function boot(){
  if(!TOKEN) return redirectLogin();
  gasCall("validate",[TOKEN], (res)=>{
    if(!res.ok){ localStorage.removeItem("BK_TOKEN"); return redirectLogin(); }
    ME = res.user; setWho();
    thisWeek();
    load();
  }, ()=>{ localStorage.removeItem("BK_TOKEN"); redirectLogin(); });
}
boot();
`;
  return baseHtml_("Roster", body, script);
}

/** ========= HTML: SETTINGS ========= */
function htmlSettings_() {
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
    <div id="who" class="pill"></div>
  </div>

  <div class="card">
    <div class="inner">
      <div class="navbar">
        <button class="navbtn" onclick="reloadTo('work')">ทำงาน</button>
        <button class="navbtn" onclick="reloadTo('roster')">Roster</button>
        <button class="navbtn active" onclick="reloadTo('settings')">ตั้งค่า</button>
        <button class="navbtn" onclick="doLogout()">ออกจากระบบ</button>
      </div>

      <div class="title">ตั้งค่า Capacity</div>
      <div class="muted">เฉพาะ Admin/Manager</div>

      <div class="row">
        <div id="formWrap"></div>
        <div class="actions">
          <button class="btn btnPrimary" onclick="save()">บันทึก</button>
        </div>
        <div id="st" class="status"></div>
      </div>

      <div class="footer">
        <div>Branch: ${esc_(BRANCH_NAME)}</div>
        <div>Created by ${esc_(CREATOR_CREDIT)}</div>
      </div>
    </div>
  </div>
</div>
`;
  const script = `
let TOKEN = localStorage.getItem("BK_TOKEN") || "";
let ME = null;
let GROUPS = [];
let CAP = {};

function reloadTo(p){ location.href = "?page=" + p; }
function redirectLogin(){ location.href = "?page=login"; }

function gasCall(fn, args, onOk, onErr){
  const runner = google.script.run
    .withSuccessHandler(onOk)
    .withFailureHandler(err => {
      const msg = (err && err.message) ? err.message : String(err);
      onErr && onErr(msg);
    });
  runner[fn].apply(runner, args || []);
}
function setWho(){
  document.getElementById("who").textContent = ME ? (ME.fullName + " • " + ME.username + " • " + ME.role) : "";
}
function setStatus(msg, ok){
  const el = document.getElementById("st");
  el.className = "status " + (ok ? "ok" : "bad");
  el.textContent = msg || "";
}
function doLogout(){
  const t = TOKEN;
  TOKEN = "";
  localStorage.removeItem("BK_TOKEN");
  if(t) gasCall("logout",[t], ()=>redirectLogin(), ()=>redirectLogin());
  else redirectLogin();
}
function load(){
  if(!TOKEN) return redirectLogin();
  setStatus("กำลังโหลด...", true);
  gasCall("getSettings",[TOKEN], (res)=>{
    if(!res.ok){ setStatus(res.message || "โหลดไม่สำเร็จ", false); return; }
    CAP = res.capacity || {};
    GROUPS = res.groups || [];
    render();
    setStatus("โหลดแล้ว", true);
  }, (m)=>setStatus(m, false));
}
function render(){
  const html = GROUPS.map(g=>{
    const v = (CAP[g.key] ?? "");
    return '<div style="display:grid; grid-template-columns: 1fr 160px; gap:10px; align-items:end; margin-top:10px">'
      + '<div><div style="font-weight:900">'+g.label+' ('+g.windowStart+'-'+g.windowEnd+')</div><div class="small">key: '+g.key+'</div></div>'
      + '<div><label>Capacity</label><input id="cap_'+g.key+'" type="number" min="0" max="99" value="'+v+'"/></div>'
      + '</div>';
  }).join("");
  document.getElementById("formWrap").innerHTML = html;
}
function save(){
  const obj = {};
  GROUPS.forEach(g=>{
    obj[g.key] = Number(document.getElementById("cap_"+g.key).value || 0);
  });
  setStatus("กำลังบันทึก...", true);
  gasCall("updateSettings",[TOKEN, obj], (res)=>{
    if(!res.ok){ setStatus(res.message || "ไม่สำเร็จ", false); return; }
    setStatus("บันทึกแล้ว", true);
    load();
  }, (m)=>setStatus(m, false));
}
function boot(){
  if(!TOKEN) return redirectLogin();
  gasCall("validate",[TOKEN], (res)=>{
    if(!res.ok){ localStorage.removeItem("BK_TOKEN"); return redirectLogin(); }
    ME = res.user;
    if(!(ME.role==="admin"||ME.role==="manager")){
      location.href = "?page=work";
      return;
    }
    setWho();
    load();
  }, ()=>{ localStorage.removeItem("BK_TOKEN"); redirectLogin(); });
}
boot();
`;
  return baseHtml_("Settings", body, script);
}

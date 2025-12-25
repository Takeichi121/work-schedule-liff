
const BRANCH_NAME = "Grand Diamond";
const CREATOR_CREDIT = "Chan. J (Chanon Jaimool)";

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

console.log(htmlLogin_());

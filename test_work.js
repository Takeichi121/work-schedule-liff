
const BRANCH_NAME = "Grand Diamond";

function esc_(s){
  return String(s || "").replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

function baseHtml_(title, body, script) {
  // ... (same as before)
  const css = `...`;
  return `<!doctype html>
<html lang="th">
<head>
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

function htmlWork_() {
  const body = `<div>Work Page</div>`;
  const script = `
    const myShift = { shiftGroup: 'A', startTime: '09:00', endTime: '18:00' };
    const el = document.createElement('div');
    el.innerHTML = \`<span class="chip">\${myShift.shiftGroup} \${myShift.startTime}-\${myShift.endTime}</span>\`;
    console.log(el.innerHTML);
  `;
  return baseHtml_("Work", body, script);
}

console.log(htmlWork_());

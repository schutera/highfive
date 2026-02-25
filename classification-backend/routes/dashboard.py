from flask import Blueprint

dashboard_route = Blueprint("dashboard", __name__, url_prefix="/debug")


@dashboard_route.get("/dashboard")
def dashboard():
    return """<!doctype html>
<meta charset="utf-8">
<title>HiveHive — Live Dashboard</title>
<style>
  :root{--bg:#0f1113;--card:#121416;--muted:#9aa3ad;--accent:#1ea7fd}
  body{margin:0;background:var(--bg);color:#e6eef3;font-family:Inter, system-ui, -apple-system, 'Segoe UI', Roboto, Arial;}
  .container{max-width:1200px;margin:24px auto;padding:16px;display:grid;grid-template-columns:1fr 420px;gap:18px}
  .card{background:linear-gradient(180deg, rgba(255,255,255,0.02), rgba(255,255,255,0.01));
        padding:12px;border-radius:10px;border:1px solid rgba(255,255,255,0.03)}
  h1{font-size:18px;margin:0 0 8px 0}
  .stream-wrap{background:#000;border-radius:8px;overflow:hidden;border:1px solid #222}
  #streamImg{display:block;width:100%;height:auto}
  table{width:100%;border-collapse:collapse;font-size:13px;margin-top:8px}
  th,td{padding:8px;border-bottom:1px solid rgba(255,255,255,0.05)}
  th{color:var(--muted)}
  .filled{color:#58c98d;font-weight:600}
  .unfilled{color:#ff5050;font-weight:600}
  .meta{font-size:12px;color:var(--muted)}
</style>

<div class="container">
  <div class="card">
    <h1>Live Stream</h1>
    <div class="stream-wrap">
      <img id="streamImg" src="/debug/stream" alt="Live stream"/>
    </div>
  </div>

  <div class="card">
    <h1>Bee Classification</h1>
    <div id="jsonWrap">Lade…</div>
    <div class="meta">Auto refresh</div>
  </div>
</div>

<script>
async function fetchResult(){
  try{
    const res = await fetch('/debug/result', {cache:'no-store'});
    if(!res.ok) throw new Error('Network');

    const data = await res.json();
    const json = data.classification || data;

    render(json);

  }catch(e){
    document.getElementById('jsonWrap').innerHTML = 'Fehler beim Laden';
    console.error(e);
  }
}

function render(json){
  if(!json){
    document.getElementById('jsonWrap').innerHTML = 'Keine Daten';
    return;
  }

  let html = '';

  for(const bee in json){
    html += `<h3>${bee}</h3>`;
    html += `<table><thead><tr><th>Hole</th><th>Status</th></tr></thead><tbody>`;

    const holes = json[bee];
    for(const idx in holes){
      const status = holes[idx];
      const cls = status === 'filled' ? 'filled' : 'unfilled';
      html += `<tr><td>${idx}</td><td class="${cls}">${status}</td></tr>`;
    }

    html += '</tbody></table>';
  }

  document.getElementById('jsonWrap').innerHTML = html;
}

setInterval(fetchResult, 800);
fetchResult();
</script>
"""
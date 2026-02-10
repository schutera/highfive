from flask import Blueprint

dashboard_route = Blueprint("dashboard", __name__, url_prefix="/debug")


@dashboard_route.get("/dashboard")
def dashboard():
    return """<!doctype html>
<meta charset="utf-8">
<title>HiveHive — Live Dashboard</title>
<style>
  :root{--bg:#0f1113;--card:#121416;--muted:#9aa3ad;--accent:#1ea7fd}
  body{margin:0;background:var(--bg);color:#e6eef3;font-family:Inter, system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial;}
  .container{max-width:1200px;margin:24px auto;padding:16px;display:grid;grid-template-columns:1fr 420px;gap:18px;align-items:start}
  .card{background:linear-gradient(180deg, rgba(255,255,255,0.02), rgba(255,255,255,0.01));padding:12px;border-radius:10px;border:1px solid rgba(255,255,255,0.03);box-shadow:0 6px 18px rgba(2,6,23,0.6)}
  h1{font-size:18px;margin:0 0 8px 0;color:#fff}
  .stream-wrap{position:relative;background:#000;border-radius:8px;overflow:hidden;border:1px solid #222}
  #streamImg{display:block;width:100%;height:auto;object-fit:contain;background:#000}
  #overlay{position:absolute;left:0;top:0;pointer-events:none}
  .meta{font-size:13px;color:var(--muted);margin-top:8px}
  table{width:100%;border-collapse:collapse;font-size:13px;margin-top:8px}
  th,td{padding:8px 6px;border-bottom:1px dashed rgba(255,255,255,0.03);text-align:left}
  th{color:var(--muted);font-weight:600;font-size:12px}
  tr:hover td{background:rgba(30,167,253,0.03)}
  .empty{color:var(--muted);padding:10px;text-align:center}
  .controls{display:flex;gap:8px;align-items:center;margin-top:10px}
  .btn{background:transparent;border:1px solid rgba(255,255,255,0.06);color:#cfe8ff;padding:6px 8px;border-radius:6px;cursor:pointer;font-size:13px}
  .btn.toggle{background:linear-gradient(90deg, rgba(30,167,253,0.12), rgba(30,167,253,0.06));border-color:rgba(30,167,253,0.18)}
  @media (max-width:900px){.container{grid-template-columns:1fr;padding:10px}}
</style>
<div class="container">
  <div class="card">
    <h1>Live Stream</h1>
    <div class="stream-wrap" id="streamWrap">
      <img id="streamImg" src="/debug/stream" alt="Live stream" crossorigin="anonymous"/>
      <canvas id="overlay"></canvas>
    </div>
    <div class="meta">Stream: automatische Aktualisierung — Ergebnisse werden rechts aktualisiert.</div>
    <div class="controls">
      <button id="toggleOverlay" class="btn toggle">Overlay an/aus</button>
      <button id="snapshot" class="btn">Snapshot</button>
      <div style="flex:1"></div>
      <div style="font-size:12px;color:var(--muted)">Letzte Aktualisierung: <span id="lastUpdate">—</span></div>
    </div>
  </div>
  <div class="card" style="min-height:240px">
    <h1>Erkannte Kreise</h1>
    <div class="meta">Die Tabelle zeigt die zuletzt erkannten Kreise (x, y, radius, status). Sie wird automatisch aktualisiert.</div>
    <div id="tableWrap">
      <div class="empty">Lade Ergebnisse…</div>
    </div>
  </div>
</div>
<script>
(function(){
  const img = document.getElementById('streamImg');
  const canvas = document.getElementById('overlay');
  const tableWrap = document.getElementById('tableWrap');
  const lastUpdateEl = document.getElementById('lastUpdate');
  const toggleBtn = document.getElementById('toggleOverlay');
  const snapshotBtn = document.getElementById('snapshot');

  let showOverlay = true;
  let circles = [];
  let intrinsicW = 640, intrinsicH = 360;

  function safeParseCircles(raw){
    if(!raw) return [];
    try{
      // handle common wrapping styles:
      // - []                      -> no circles
      // - [[ [x,y,r], ... ]]      -> nested wrapper
      // - [ [x,y,r], ... ]        -> direct array
      // - [ {x:.., y:.., radius:.., status:..}, ... ] -> objects
      if(Array.isArray(raw) && raw.length===1 && Array.isArray(raw[0])) return raw[0];
      if(Array.isArray(raw)) return raw;
      return [];
    }catch(e){
      return [];
    }
  }

  function resizeCanvas(){
    const cssWidth = img.clientWidth || 640;
    const cssHeight = img.clientHeight || (cssWidth * 9 / 16);
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    canvas.style.width = cssWidth + 'px';
    canvas.style.height = cssHeight + 'px';
    canvas.width = Math.round(cssWidth * dpr);
    canvas.height = Math.round(cssHeight * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(1,0,0,1,0,0);
    ctx.scale(dpr, dpr);
  }

  function statusColor(status){
    if(!status) return 'rgba(30,167,253,0.95)'; // default accent
    const s = String(status).toLowerCase();
    if(s === 'filled' || s === 'fill' || s === 'ok' || s === 'valid') return 'rgba(88,201,141,0.95)'; // green
    if(s === 'unfilled' || s === 'empty' || s === 'invalid') return 'rgba(255,80,80,0.95)'; // red
    return 'rgba(30,167,253,0.95)';
  }

  function draw(){
    requestAnimationFrame(draw);
    if(!showOverlay){
      const ctx = canvas.getContext('2d'); ctx.clearRect(0,0,canvas.width,canvas.height);
      return;
    }
    const ctx = canvas.getContext('2d');
    const cssW = parseFloat(canvas.style.width) || img.clientWidth || 640;
    const cssH = parseFloat(canvas.style.height) || img.clientHeight || (cssW * 9 / 16);

    ctx.clearRect(0,0, cssW, cssH);

    try{ ctx.drawImage(img, 0, 0, cssW, cssH); }catch(e){}

    const intrinsicWidth = img.naturalWidth || intrinsicW;
    const intrinsicHeight = img.naturalHeight || intrinsicH;
    const scaleX = cssW / intrinsicWidth;
    const scaleY = cssH / intrinsicHeight;

    ctx.lineWidth = 2;
    ctx.font = '12px system-ui, Arial';

    for(let i=0;i<circles.length;i++){
      const c = circles[i];
      // robust extraction of coordinates, radius and status
      let x = 0, y = 0, r = 0, status = '';
      if(Array.isArray(c) || c.length !== undefined){
        x = Number(c[0]||0); y = Number(c[1]||0); r = Number(c[2]||0);
        // optional: status could be at index 3
        status = c[3] !== undefined ? String(c[3]) : '';
      } else if(typeof c === 'object'){
        x = Number(c.x || c[0] || 0);
        y = Number(c.y || c[1] || 0);
        // radius may be named 'r' or 'radius'
        r = Number(c.r || c.radius || c[2] || 0);
        status = c.status || c.state || '';
      }

      const cx = x * scaleX; const cy = y * scaleY;
      // scale radius proportional with display; if r missing use 0
      const cr = (Number.isFinite(r) && r > 0) ? r * Math.max(scaleX, scaleY) : 0;

      const color = statusColor(status);
      ctx.strokeStyle = color;
      ctx.fillStyle = color.replace('0.95', '0.12') || 'rgba(30,167,253,0.12)';

      if(cr > 0){
        ctx.beginPath(); ctx.arc(cx, cy, cr, 0, Math.PI*2); ctx.fill(); ctx.stroke();
      } else {
        // if radius missing draw a small marker instead
        ctx.beginPath(); ctx.arc(cx, cy, 6, 0, Math.PI*2); ctx.fill(); ctx.stroke();
      }

      // index label
      ctx.fillStyle = 'rgba(255,255,255,0.95)';
      ctx.fillText(String(i+1), cx + Math.min(6, (cr||6)/2), cy - 6);
    }
  }

  async function fetchResult(){
    try{
      const res = await fetch('/debug/result', {cache:'no-store'});
      if(!res.ok) throw new Error('Network');
      const data = await res.json();
      const raw = data.circles;
      const parsed = safeParseCircles(raw);
      circles = parsed || [];
      renderTable(circles);
      lastUpdateEl.textContent = new Date().toLocaleTimeString();
    }catch(e){
      tableWrap.innerHTML = '<div class="empty">Fehler beim Laden der Ergebnisse</div>';
      console.error(e);
    }
  }

  function renderTable(circles){
    if(!circles || circles.length===0){ tableWrap.innerHTML = '<div class="empty">Keine Kreise erkannt</div>'; return; }
    let rows = '';
    for(let i=0;i<circles.length;i++){
      const c = circles[i];
      let x='-', y='-', radius='-', status='-';
      if(Array.isArray(c) || c.length !== undefined){
        x = Number(c[0]||0).toFixed(1);
        y = Number(c[1]||0).toFixed(1);
        radius = (c[2] !== undefined && c[2] !== null) ? Number(c[2]).toFixed(1) : '-';
        status = c[3] !== undefined ? String(c[3]) : '-';
      } else if(typeof c === 'object'){
        x = c.x !== undefined ? Number(c.x).toFixed(1) : (c[0]!==undefined?Number(c[0]).toFixed(1):'-');
        y = c.y !== undefined ? Number(c.y).toFixed(1) : (c[1]!==undefined?Number(c[1]).toFixed(1):'-');
        radius = c.radius !== undefined ? Number(c.radius).toFixed(1) : (c.r!==undefined?Number(c.r).toFixed(1):'-');
        status = c.status !== undefined ? String(c.status) : (c.state!==undefined?String(c.state): '-');
      }
      rows += `<tr><td>${i+1}</td><td>${x}</td><td>${y}</td><td>${radius}</td><td>${status}</td></tr>`;
    }
    tableWrap.innerHTML = `<table><thead><tr><th>#</th><th>X</th><th>Y</th><th>Radius</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  toggleBtn.addEventListener('click', ()=>{
    showOverlay = !showOverlay;
    toggleBtn.textContent = showOverlay ? 'Overlay an/aus' : 'Overlay an/aus';
  });

  snapshotBtn.addEventListener('click', ()=>{
    try{
      const data = canvas.toDataURL('image/png');
      const a = document.createElement('a'); a.href = data; a.download = 'snapshot.png'; a.click();
    }catch(e){ console.error('Snapshot failed', e); }
  });

  const ro = new ResizeObserver(resizeCanvas);
  ro.observe(img);
  window.addEventListener('resize', resizeCanvas);

  resizeCanvas();
  draw();
  setInterval(fetchResult, 800);
  fetchResult();

})();
</script>
"""
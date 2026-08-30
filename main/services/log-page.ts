// log-page.ts — the self-contained /log viewer.
//
// No framework and no build step, served as one string, so it still works when
// the renderer bundle is missing or half-deployed — which is exactly the state
// you are in when you need it. It lived inside remote-server.ts; it is here so
// the route that serves it and the logic it runs can both be tested.
//
// The one piece with real logic — day boundaries and backwards time jumps — is
// NOT written in this template. It is decorateLogLines from log-rows.ts, inlined
// verbatim by toString(), so the browser runs the function the tests run.

import { decorateLogLines } from "./log-rows.js";

/** JSON-encode for embedding in a <script>. `</script>` inside a string literal
 *  ends the block, and `<!--` opens an HTML comment inside it; both are escaped
 *  so a value can never break out of the script into markup. */
function inlineJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
}

/**
 * Render the viewer.
 *
 * @param timeZone the APP time zone (app-timezone.ts). Every timestamp on the
 *   page is drawn in it and the header says which it is. The page used to render
 *   in the VIEWER's browser zone — a fix for having printed raw UTC, but it
 *   traded one unlabelled zone for another: an operator reading the log from
 *   somewhere else, or a laptop that never got the building's zone, compares
 *   timestamps against a service that happened in the building.
 */
export function renderLogPage(timeZone: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Stage Utility — Server log</title>
<style>
:root{color-scheme:dark;--bg:#0b0c0e;--panel:#121418;--line:#23262c;--fg:#d6d9de;--dim:#8b919b;--faint:#6b7280;--ok:#5bc98a;--warn:#f5c451;--down:#f2777a;--idle:#7aa7d8}
*{box-sizing:border-box}
body{margin:0;font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--bg);color:var(--fg)}
header{position:sticky;top:0;z-index:2;background:var(--panel);border-bottom:1px solid var(--line)}
.bar{display:flex;gap:.6rem;align-items:center;flex-wrap:wrap;padding:.55rem .8rem}
.bar+.bar{border-top:1px solid var(--line)}
h1{font:600 14px/1.4 system-ui,sans-serif;margin:0;color:#e8ebef;white-space:nowrap}
.sp{flex:1 1 auto}
input,button,select{font:inherit;background:#1a1d22;color:var(--fg);border:1px solid #2a2e35;border-radius:6px;padding:.3rem .5rem}
button{cursor:pointer}button:hover{background:#22262d}
label{color:var(--dim);white-space:nowrap;display:inline-flex;align-items:center;gap:.3rem}
#meta{color:var(--faint);font:12px/1.4 system-ui,sans-serif;white-space:nowrap}
#checks{display:flex;gap:.4rem;flex-wrap:wrap;align-items:center}
.chip{display:inline-flex;align-items:center;gap:.35rem;border:1px solid var(--line);border-radius:999px;padding:.12rem .55rem;font:12px/1.6 system-ui,sans-serif;color:var(--dim)}
.chip b{font-weight:600;color:var(--fg)}
.dot{width:7px;height:7px;border-radius:50%;background:var(--faint);flex:none}
.s-ok .dot{background:var(--ok)}.s-warn .dot{background:var(--warn)}.s-down .dot{background:var(--down)}.s-idle .dot{background:var(--idle)}.s-off .dot{background:#3a3f47}
.s-down{border-color:#5a2c2e}.s-warn{border-color:#5a4a1e}
#log{padding:.4rem .8rem 3rem;white-space:pre-wrap;word-break:break-word}
.ln{padding:.5px 0}
.t{color:var(--faint)}
.warn{color:var(--warn)}.error{color:var(--down)}
.day{margin:.9rem 0 .3rem;padding:.15rem .5rem;border-left:2px solid #2a2e35;color:var(--dim);font:600 12px/1.6 system-ui,sans-serif;background:#101215}
.jump{margin:.6rem 0 .2rem;padding:.15rem .5rem;border-left:2px solid var(--warn);color:var(--warn);font:12px/1.6 system-ui,sans-serif;background:#181509}
#note{color:var(--faint);padding:.4rem .8rem 0;font:12px/1.5 system-ui,sans-serif}
#err{display:none;color:var(--down);padding:.4rem .8rem;font:12px/1.5 system-ui,sans-serif}
</style></head><body>
<header>
  <div class="bar">
    <h1>Server log</h1>
    <span id="meta"></span>
    <span class="sp"></span>
    <input id="filter" placeholder="filter text…" autocomplete="off" size="18" aria-label="Filter lines by text" title="Filter lines by text">
    <select id="level" aria-label="Level" title="Show only warnings, or only errors"><option value="">all levels</option><option value="warn">warnings + errors</option><option value="error">errors only</option></select>
    <select id="tag" aria-label="Source" title="Show only one subsystem"><option value="">all sources</option></select>
    <label title="Refresh every 2 seconds and follow the newest lines"><input type="checkbox" id="auto" checked> auto</label>
    <button id="refresh" type="button">refresh</button>
    <button id="copy" type="button" title="Copy the matching lines">copy</button>
    <button id="download" type="button" title="Download the matching lines">download</button>
  </div>
  <div class="bar" id="checks"></div>
</header>
<div id="err"></div>
<div id="note"></div>
<div id="log"></div>
<script>
(function(){
"use strict";
var TZ = ${inlineJson(timeZone)};
${decorateLogLines.toString()}

var token = new URLSearchParams(location.search).get('token');
var q = token ? ('&token=' + encodeURIComponent(token)) : '';
var logEl = document.getElementById('log');
var noteEl = document.getElementById('note');
var errEl = document.getElementById('err');
var metaEl = document.getElementById('meta');
var checksEl = document.getElementById('checks');
var filterEl = document.getElementById('filter');
var levelEl = document.getElementById('level');
var tagEl = document.getElementById('tag');
var autoEl = document.getElementById('auto');

/* Raw lines, oldest first, and the highest seq the server has handed us.
   The poll asks for what is NEWER than that, so a steady-state tick moves a few
   hundred bytes instead of the whole buffer. */
var lines = [];
var since = null;
var rows = [];
/* What the current filters match, in full — copy and download hand this over, so
   filtering to errors and pressing copy gives the errors rather than all 10,000
   lines. Not the same as what is DRAWN, which is capped. */
var shownRows = [];
var knownTags = [];
/* Rendering every row into innerHTML is the expensive half, and nobody reads
   10,000 lines at once. Filtering still runs over all of them. */
var MAX_DRAWN = 2000;
/* Matches the server's ring buffer, so a long-lived tab cannot outgrow it. */
var MAX_HELD = 10000;

/* Quotes as well as angle brackets. Not everything here lands in a text node:
   an integration's message goes into a title="…" and a source tag into a
   value="…", and both are built from log lines, which are full of outside data
   by definition. Escaping only &<> leaves a quote free to close the attribute. */
function esc(s){ return String(s).replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }

function uptime(sec){
  var d = Math.floor(sec/86400), h = Math.floor(sec%86400/3600), m = Math.floor(sec%3600/60);
  if (d) return d + 'd ' + h + 'h';
  if (h) return h + 'h ' + m + 'm';
  return m + 'm';
}

function drawChecks(c){
  if (!c) return;
  metaEl.textContent = 'v' + c.version + ' · up ' + uptime(c.uptimeSec) + ' · times in ' + c.timeZone + (c.followingHost ? ' (host)' : '');
  var html = '';
  if (c.errors || c.warnings) {
    html += '<span class="chip ' + (c.errors ? 's-down' : 's-warn') + '"><span class="dot"></span>'
         +  '<b>' + c.errors + '</b> errors · <b>' + c.warnings + '</b> warnings</span>';
  } else {
    html += '<span class="chip s-ok"><span class="dot"></span>no errors or warnings held</span>';
  }
  for (var i = 0; i < c.integrations.length; i++) {
    var it = c.integrations[i];
    html += '<span class="chip s-' + esc(it.state) + '" title="' + esc(it.detail || '') + '">'
         +  '<span class="dot"></span><b>' + esc(it.label) + '</b> ' + esc(it.state === 'ok' ? 'connected' : it.state) + '</span>';
  }
  checksEl.innerHTML = html;
}

function refreshTagOptions(){
  var seen = {};
  for (var i = 0; i < rows.length; i++) if (rows[i].tag) seen[rows[i].tag] = 1;
  var tags = Object.keys(seen).sort();
  if (tags.join('\\u0000') === knownTags.join('\\u0000')) return;
  knownTags = tags;
  var keep = tagEl.value;
  var html = '<option value="">all sources</option>';
  for (var j = 0; j < tags.length; j++) html += '<option value="' + esc(tags[j]) + '">' + esc(tags[j]) + '</option>';
  tagEl.innerHTML = html;
  tagEl.value = keep;
  /* A source that has scrolled out of the buffer must not leave the page
     filtered to nothing with no way back. */
  if (tagEl.value !== keep) tagEl.value = '';
}

function render(){
  var f = filterEl.value.toLowerCase();
  var lvl = levelEl.value;
  var tag = tagEl.value;
  var atBottom = (window.innerHeight + window.scrollY) >= (document.body.scrollHeight - 40);
  var shown = [];
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (lvl === 'error' && r.level !== 'error') continue;
    if (lvl === 'warn' && r.level !== 'error' && r.level !== 'warn') continue;
    if (tag && r.tag !== tag) continue;
    if (f && r.msg.toLowerCase().indexOf(f) < 0) continue;
    shown.push(r);
  }
  shownRows = shown;
  var drawn = shown.length > MAX_DRAWN ? shown.slice(shown.length - MAX_DRAWN) : shown;
  noteEl.textContent = shown.length + ' of ' + rows.length + ' lines match'
    + (drawn.length < shown.length ? ' — drawing the newest ' + drawn.length : '');
  var out = [];
  var lastDay = null;
  for (var k = 0; k < drawn.length; k++) {
    var row = drawn[k];
    /* Compare against what was actually DRAWN above, not row.newDay: filtering
       can drop the row that opened a day, and a date heading that never appears
       is how a page of timestamps stops meaning anything. */
    if (row.day && row.day !== lastDay) {
      out.push('<div class="day">' + esc(row.day) + '</div>');
      lastDay = row.day;
    }
    /* Independent of the date heading, not an else: a jump that also crosses a
       date shows a heading with an EARLIER date on it, which is the one case
       most likely to be read as the page being broken. */
    if (row.backwards) {
      out.push('<div class="jump">\\u2191 earlier than the line above — replayed from before a restart</div>');
    }
    out.push('<div class="ln ' + esc(row.level) + '"><span class="t">' + esc(row.time) + '</span> ' + esc(row.msg) + '</div>');
  }
  logEl.innerHTML = out.join('');
  if (autoEl.checked && atBottom) window.scrollTo(0, document.body.scrollHeight);
}

function apply(d){
  var incoming = d.lines || [];
  if (d.reset) lines = incoming;
  else if (incoming.length) lines = lines.concat(incoming);
  else { drawChecks(d.checks); return; }
  if (lines.length > MAX_HELD) lines = lines.slice(lines.length - MAX_HELD);
  since = d.latestSeq;
  rows = decorateLogLines(lines, TZ);
  refreshTagOptions();
  drawChecks(d.checks);
  render();
}

function load(){
  fetch('/api/log?since=' + (since === null ? '' : since) + q)
    .then(function(r){
      if (!r.ok) throw new Error('HTTP ' + r.status + (r.status === 401 ? ' — this server wants ?token=…' : ''));
      return r.json();
    })
    .then(function(d){ errEl.style.display = 'none'; apply(d); })
    .catch(function(e){
      /* Shown, not swallowed: a viewer that quietly stops updating is worse than
         no viewer, because it looks like a server that has gone silent. */
      errEl.textContent = 'could not load the log: ' + e.message;
      errEl.style.display = 'block';
    });
}

function plainText(){
  var out = [];
  /* Full ISO-style date on every line, not just at the headings: pasted into a
     ticket the headings are gone, and a bare HH:MM:SS is the thing that makes a
     replayed block look like a clock fault. */
  for (var i = 0; i < shownRows.length; i++) {
    out.push(shownRows[i].day + ' ' + shownRows[i].time + '  ' + shownRows[i].level + '  ' + shownRows[i].msg);
  }
  return out.join('\\n');
}

function copyText(text){
  /* navigator.clipboard is secure-context only and this app is served over plain
     HTTP on the LAN, so it is undefined exactly where it is needed. Fall back to
     a selection, and say so when even that is refused. */
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(function(){ flash('copied'); }, function(){ selectFallback(text); });
    return;
  }
  selectFallback(text);
}
function selectFallback(text){
  var ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  var ok = false;
  try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
  document.body.removeChild(ta);
  flash(ok ? 'copied' : 'copy blocked — use download');
}
function flash(msg){
  noteEl.textContent = msg;
  /* Restore by re-rendering, not by putting back the text that was there: a poll
     can land in the meantime and the saved string would be a stale count. */
  setTimeout(function(){ if (noteEl.textContent === msg) render(); }, 1500);
}

filterEl.oninput = render;
levelEl.onchange = render;
tagEl.onchange = render;
document.getElementById('refresh').onclick = load;
document.getElementById('copy').onclick = function(){ copyText(plainText()); };
document.getElementById('download').onclick = function(){
  var url = URL.createObjectURL(new Blob([plainText()], { type: 'text/plain' }));
  var a = document.createElement('a');
  a.href = url;
  a.download = 'stage-utility-log.txt';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(function(){ URL.revokeObjectURL(url); }, 5000);
};
load();
setInterval(function(){ if (autoEl.checked) load(); }, 2000);
})();
</script></body></html>`;
}

const $content = document.getElementById('content');
const $status  = document.getElementById('status');
const $now     = document.getElementById('now');

let CFG, TARGETS, ANNC;
let ticker = null;
let slideTimer = null;

init();

async function init() {
  try {
    // Load configs, but don't crash if one is missing.
    const [cfg, targets, annc] = await Promise.all([
      fetchJSON('config.json').catch(e => ({ timezone: 'America/Los_Angeles', refresh_seconds: 60 })),
      fetchJSON('targets.json').catch(e => ({ defaults: {} , byDate: {} })),
      fetchJSON('announcements.json').catch(e => ({ rotation: [], timeRemaining: [] }))
    ]);
    CFG = cfg; TARGETS = targets; ANNC = annc;

    loop();
    setInterval(loop, (CFG.refresh_seconds || 60) * 1000);
  } catch (e) {
    fail(e);
  }
}


async function loop() {
  try {
    clearTimers();
    const now = localNow(CFG.timezone || 'America/Los_Angeles');
    $now.textContent = formatNow(now, CFG.timezone);

    // 1) Determine current thread (period) from ICS or fallback
    const threadInfo = await currentThread(now);

    // 2) Time-remaining override? (clean-up, etc.)
    const minutesLeft = threadInfo.end ? Math.ceil((threadInfo.end - now) / 60000) : null;
    const tr = pickTimeRemaining(minutesLeft);
    if (tr) {
      renderItem(tr);
      $status.textContent = `Time-remaining (${minutesLeft}m)`;
      return;
    }

    // 3) If in-class: show targets for this thread; else show rotation
    if (threadInfo.thread) {
      const item = pickTargets(now, threadInfo.thread);
      if (item) {
        renderItem(item);
        $status.textContent = `In-class • ${threadInfo.thread.toUpperCase()}`;
        return;
      }
    }

    const rot = pickRotation(now);
    if (rot) {
      renderItem(rot);
      $status.textContent = `Rotation`;
      return;
    }

    // Nothing matched → friendly idle
    $content.textContent = 'No content scheduled.';
    $status.textContent = `Idle`;
  } catch (e) {
    fail(e);
  }
}

/* ---------- Content selection ---------- */

function pickTargets(now, thread) {
  const ymd = toYMD(now);
  const day = (TARGETS.byDate && TARGETS.byDate[ymd]) || {};
  return day[thread] || (TARGETS.defaults && TARGETS.defaults[thread]) || null;
}

function pickRotation(now) {
  if (!ANNC.rotation) return null;
  const t = hhmm(now);
  const todays = ANNC.rotation.filter(r => inWindow(t, r.window));
  return todays.length ? wrapPlaylist(todays[0]) : null;
}

function pickTimeRemaining(minutesLeft) {
  if (!ANNC.timeRemaining || minutesLeft == null) return null;
  const match = ANNC.timeRemaining.find(x => minutesLeft <= x.minutesLeft);
  return match ? wrapPlaylist(match) : null;
}

/* ---------- Rendering ---------- */

function renderItem(item) {
  clearTimers();
  if (item.type === 'text') {
    $content.innerHTML = escapeHTML(item.content).replace(/\n/g, '<br/>');
  } else if (item.type === 'slides') {
    $content.innerHTML = `<iframe class="slides-embed" src="${item.url}" allowfullscreen></iframe>`;
  } else if (item.type === 'images') {
    renderImages(item);
  } else {
    $content.textContent = 'Unsupported item type.';
  }
}

function renderImages(item) {
  let i = 0;
  const show = () => {
    const it = item.items[i % item.items.length];
    $content.innerHTML = `<img src="${it.src}" alt="image"/>${it.caption ? `<div class="caption">${escapeHTML(it.caption)}</div>` : ''}`;
    i++;
  };
  show();
  slideTimer = setInterval(show, (item.durationSec || 10) * 1000);
}

function wrapPlaylist(obj) {
  // shallow clone to avoid mutating originals
  return JSON.parse(JSON.stringify(obj));
}

/* ---------- Calendar handling ---------- */

async function currentThread(now) {
  // Try ICS first (via proxy), then fallback schedule
  const icsUrl = CFG.ics_proxy_url || CFG.ics_url;
  let ev = null;
  if (icsUrl) {
    try {
      const icsText = await fetchText(icsUrlWithCacheBust(icsUrl));
      ev = pickCurrentICSEvent(icsText, now, CFG.timezone);
    } catch (_) { /* ignore */ }
  }

  if (!ev) {
    const fb = await fetchJSON('fallback-schedule.json').catch(()=>null);
    if (fb) {
      const dayKey = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][now.getDay()];
      const blocks = fb[dayKey] || [];
      for (const b of blocks) {
        const {start, end} = blockToDates(now, b.start, b.end);
        if (now >= start && now < end) {
          return { thread: b.thread, start, end };
        }
      }
      return { thread: null, start: null, end: null };
    }
  }

  if (!ev) return { thread: null, start: null, end: null };

  const title = (ev.summary || '').toLowerCase();

// Try to extract a period number from the title (e.g., "1st period", "period 2", "p3")
  const numMatch = title.match(/\b(?:period\s*)?([1-9])\b/);
  let thread = null;

  if (numMatch) {
    thread = 'p' + numMatch[1];  // e.g., "p1"
  } else {
    // Fall back to old event_map matching if no number found
    const matchKey = Object.keys(CFG.event_map).find(k => title.includes(k.toLowerCase()));
    thread = matchKey ? CFG.event_map[matchKey] : CFG.default_thread;
  }

  return { thread, start: ev.dtstart, end: ev.dtend, summary: ev.summary };

}

/* ---------- ICS parsing (minimal) ---------- */

function pickCurrentICSEvent(icsText, now, tz) {
  // Very light ICS parsing sufficient for standard Google public ICS
  // Assumes DTSTART/DTEND in UTC or TZID; we interpret with local TZ if floating.
  const events = [];
  const lines = icsText.split(/\r?\n/);
  let cur = null;
  for (let raw of lines) {
    const line = raw.replace(/\s+$/,'');
    if (line === 'BEGIN:VEVENT') cur = {};
    else if (line === 'END:VEVENT') { if (cur) { if (cur.DTSTART && cur.DTEND) events.push(cur); } cur = null; }
    else if (cur) {
      if (line.startsWith('SUMMARY:')) cur.summary = line.slice(8);
      else if (line.startsWith('DTSTART')) cur.DTSTART = parseICSDate(line);
      else if (line.startsWith('DTEND'))   cur.DTEND   = parseICSDate(line);
    }
  }
  // Find event containing "now"
  for (const e of events) {
    const {start, end} = normalizeICSTimes(e, tz);
    if (now >= start && now < end) {
      return { summary: e.summary, dtstart: start, dtend: end };
    }
  }
  return null;
}

function parseICSDate(line) {
  // e.g., "DTSTART:20250903T160000Z" or "DTSTART;TZID=America/Los_Angeles:20250903T090000"
  const [, val] = line.split(':');
  // Return raw string; interpret later
  return val;
}

function normalizeICSTimes(e, tz) {
  const start = icsToDate(e.DTSTART, tz);
  const end   = icsToDate(e.DTEND, tz);
  return { start, end };
}

function icsToDate(s, tz) {
  // Zulu → UTC; floating or TZID → construct in that TZ via toLocaleString hack
  if (s.endsWith('Z')) return new Date(s);
  // "YYYYMMDDTHHMMSS" floating in calendar TZ: treat as given TZ
  const y = +s.slice(0,4), m = +s.slice(4,6)-1, d = +s.slice(6,8), H = +s.slice(9,11), M = +s.slice(11,13), S = +s.slice(13,15);
  const fake = new Date(Date.UTC(y, m, d, H, M, S || 0));
  const asTZ = new Date(new Date(fake).toLocaleString('en-US', { timeZone: tz || 'America/Los_Angeles' }));
  return asTZ;
}

/* ---------- Utils ---------- */

function localNow(tz) { return new Date(new Date().toLocaleString('en-US', { timeZone: tz })); }
function toYMD(d) { return d.toISOString().slice(0,10); }
function hhmm(d) { return d.toTimeString().slice(0,5); }
function inWindow(hhmmNow, win) {
  if (!win) return true;
  return hhmmNow >= win.start && hhmmNow < win.end;
}
function blockToDates(base, startHHMM, endHHMM) {
  const start = new Date(base), end = new Date(base);
  start.setHours(+startHHMM.slice(0,2), +startHHMM.slice(3), 0, 0);
  end.setHours(+endHHMM.slice(0,2), +endHHMM.slice(3), 0, 0);
  return { start, end };
}

async function fetchJSON(url){ const r=await fetch(url,{cache:'no-store'}); if(!r.ok) throw new Error(`${url} ${r.status}`); return r.json(); }
async function fetchText(url){ const r=await fetch(url,{cache:'no-store'}); if(!r.ok) throw new Error(`${url} ${r.status}`); return r.text(); }
function icsUrlWithCacheBust(url){ const u=new URL(url); u.searchParams.set('t', Date.now()); return u.toString(); }
function formatNow(d, tz){ return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})} ${tz ? '('+tz+')' : ''}`; }
function escapeHTML(s){ return s.replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }
function clearTimers(){ if (ticker) { clearInterval(ticker); ticker=null; } if (slideTimer){ clearInterval(slideTimer); slideTimer=null; } }
function fail(e){ $content.textContent='Error loading display.'; $status.textContent = (e && e.message) ? e.message : 'Unknown error'; }

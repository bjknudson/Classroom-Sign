// ===== MOBILE-FRIENDLY ERROR TRAP =====
(function () {
  function showFatal(msg, stack) {
    const box = document.createElement('div');
    box.id = 'fatal';
    box.style.cssText = 'position:fixed;inset:auto 8px 8px 8px;background:#220;'+
      'color:#f99;font:12px/1.4 ui-monospace,monospace;padding:10px;border:1px solid #844;'+
      'border-radius:8px;z-index:99999;max-height:45vh;overflow:auto;white-space:pre-wrap;';
    box.innerText = `⚠️ Script error\n${msg || '(no message)'}${stack ? '\n\n'+stack : ''}`;
    document.body.appendChild(box);
  }
  window.addEventListener('error', (e)=> showFatal(e.message, e.error && e.error.stack));
  window.addEventListener('unhandledrejection', (e)=> {
    const why = (e && e.reason) ? (e.reason.stack || e.reason.message || String(e.reason)) : 'Promise rejection';
    showFatal(why);
  });
})();


// Replace the old lines:
//// const $content = document.getElementById('content');
//// const $status  = document.getElementById('status');
//// const $now     = document.getElementById('now');

let $content, $status, $now;

// Kick off only after DOM is parsed
document.addEventListener('DOMContentLoaded', () => {
  $content = document.getElementById('content');
  $status  = document.getElementById('status');
  $now     = document.getElementById('now');

  // Guard: if the elements are missing, show a loud message
  if (!$content || !$status || !$now) {
    const missing = [
      !$content && '#content',
      !$status  && '#status',
      !$now     && '#now'
    ].filter(Boolean).join(', ');
    alert(`Display page is missing required elements: ${missing}`);
    return;
  }

  init();  // <-- move init() here
});


let CFG, TARGETS, ANNC;
let ticker = null;
let slideTimer = null;

// Periodic hard reload to keep kiosk healthy
(function setupHardReload(){
  let armed = false;
  window.addEventListener('load', () => {
    if (!CFG || !CFG.hard_reload_minutes) return;
    const jitter = Math.floor(Math.random()*60); // avoid all screens reloading at the same second
    const intervalMs = (CFG.hard_reload_minutes*60 + jitter) * 1000;
    setInterval(() => {
      // Only reload if page is visible and online
      if (document.visibilityState === 'visible' && navigator.onLine) {
        location.reload();
      }
    }, intervalMs);
  });
})();

// Reload when network returns (helps after Wi-Fi blips)
window.addEventListener('online', () => setTimeout(()=>location.reload(), 3000));
//window.addEventListener('resize', () => fitContentToStage());

// If the tab ever gets hidden and comes back (e.g., HDMI sync), refresh content
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    // trigger an immediate loop pass
    if (typeof loop === 'function') loop();
  }
});

// Remove the old top-level call:
// init();


async function init() {
    // TEMP TEST: render something no matter what (remove after debugging)
  if (new URL(location.href).searchParams.get('safe') === '1') {
    document.getElementById('content').innerHTML = '✅ Safe mode — basic render works.';
    document.getElementById('status').textContent = 'Safe mode (skipping config/ICS)';
    return; // skip the rest of init()
  }
  try {
    // Load configs, but don't crash if one is missing.
    const [cfg, targets, annc] = await Promise.all([
      fetchJSON('config.json').catch(e => ({ timezone: 'America/Los_Angeles', refresh_seconds: 60 })),
      fetchJSON('targets.json').catch(e => ({ defaults: {} , byDate: {} })),
      fetchJSON('announcements.json').catch(e => ({ rotation: [], timeRemaining: [] }))
    ]);
    CFG = cfg; TARGETS = targets; ANNC = annc;

    loop();
    // If nothing rendered in 6s, hint what to check
    setTimeout(() => {
      const html = document.getElementById('content')?.innerHTML || '';
      if (/Loading/i.test(html)) {
        document.getElementById('status').textContent = 'Still loading… check config/targets URLs.';
      }
    }, 6000);

    setInterval(loop, (CFG.refresh_seconds || 60) * 1000);
  } catch (e) {
    fail(e);
  }
}


async function loop() {
  try {
    clearTimers();
    const tz = CFG.timezone || 'America/Los_Angeles';
    const now = localNow(tz);
    $now.textContent = formatNowNoTZ(now);      //edited to prevent displaying timezone

    const query = new URL(location.href).searchParams;
    if (query.get('inspect') === '1') {
      await inspectICS(now);
      return;
    }


    const threadInfo = await currentThread(now); // {thread,start,end,summary}
    const minutesLeft = threadInfo.end ? Math.ceil((threadInfo.end - now) / 60000) : null;

    let picked = null;
    let pickedReason = '';

    if (threadInfo.thread) {
      picked = pickTargets(now, threadInfo.thread);
      pickedReason = picked ? `targets[${threadInfo.thread}]` : 'no targets for thread';
    }
    if (!picked) {
      const tr = pickTimeRemaining(minutesLeft);
      if (tr) { picked = tr; pickedReason = `timeRemaining (≤ ${minutesLeft}m)`; }
    }
    if (!picked) {
      const rot = pickRotation(now);
      if (rot) { picked = rot; pickedReason = 'rotation'; }
    }

    if (picked) {
      renderItem(picked);
      $status.textContent = pickedReason.includes('targets')
        ? `In-class • ${threadInfo.thread?.toUpperCase()}`
        : pickedReason;
    } else {
      $content.textContent = 'No content scheduled.';
      $status.textContent = 'Idle';
    }

    showDebug({
    now: formatNowNoTZ(now),
    eventSummary: threadInfo.summary || '(none)',
    mappedThread: threadInfo.thread || '(none)',
    start: threadInfo.start ? threadInfo.start.toString() : null,
    end: threadInfo.end ? threadInfo.end.toString() : null,
    reason: threadInfo.debug?.reason || '(n/a)',
    lookedAt: threadInfo.debug?.lookedAt || [],
    nextEvent: threadInfo.debug?.nextEvent || null
    });

  } catch (e) {
    fail(e);
    showDebug({ error: e?.message || String(e) });
  }
}

function showDebug(obj) {
  if (!new URL(location.href).searchParams.get('debug')) return;
  let el = document.getElementById('debug');
  if (!el) { el = document.createElement('div'); el.id = 'debug'; document.body.appendChild(el); }
  const lines = Object.entries(obj).map(([k,v]) => `<b>${k}:</b> ${typeof v === 'object' ? JSON.stringify(v) : v}`);
  el.innerHTML = lines.join('\n');
}


/* ---------- Content selection ---------- */

function pickTargets(now, thread) {
  if (!thread) return null;

  const ymd = toYMD(now);
  const dayMap = CLASS_MAP[ymd] || CLASS_MAP.defaults || {};
  
  // 1. Get the class key(s) from the period thread. Default to empty array.
  // Ensure we get an array, even if the value is a single string (for flexibility).
  let classKeys = dayMap[thread];
  if (!classKeys) return null; // No mapping found for this period
  if (!Array.isArray(classKeys)) {
      classKeys = [classKeys]; // Convert single string to array
  }

  const playlistItems = [];
  const dayTargets = (TARGETS.byDate && TARGETS.byDate[ymd]) || {};

  // 2. Iterate through all class keys for this period and collect their content
  for (const classKey of classKeys) {
    // Check daily overrides first, then the default targets
    let content = dayTargets[classKey] || (TARGETS.defaults && TARGETS.defaults[classKey]) || null;
    
    if (content) {
        // If content is an existing playlist (e.g., 'images' or 'slides'), 
        // we should embed it as-is. Otherwise, wrap the single item.
        const item = wrapPlaylist(content); 
        item.sourceClass = classKey; // For debugging/status display
        playlistItems.push(item);
    }
  }

  if (playlistItems.length === 0) {
      return null; // No content found for any of the mapped classes
  }
  
  if (playlistItems.length === 1) {
      // If only one item, return it directly to avoid unnecessary playlist overhead
      return playlistItems[0];
  }

  // 3. Return a combined 'playlist' object for rotation
  return {
    type: 'playlist',
    items: playlistItems,
    durationSec: CFG.playlist_duration_sec || 10 // Use a global default for rotation speed
  };
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
    // Try iframe first
    const iframe = document.createElement('iframe');
    iframe.className = 'slides-embed';
    iframe.src = item.url;
    iframe.allow = "fullscreen";
    iframe.loading = "lazy";

    let loaded = false;
    iframe.onload = () => { loaded = true; };
    $content.innerHTML = '';
    $content.appendChild(iframe);

    // Fallback to images: scrape published deck for slide IDs
    setTimeout(async () => {
      if (!loaded) {
        try {
          const res = await fetch(item.url, { cache: 'no-store' });
          const html = await res.text();

          // Find all "slide=id.gXXXX" occurrences
          const matches = [...html.matchAll(/slide=id\.(g[a-zA-Z0-9]+)/g)];
          const uniqueIds = [...new Set(matches.map(m => m[1]))];

          if (uniqueIds.length) {
            let i = 0;
            const show = () => {
              const src = `${item.url.replace(/\/pub.*/, '')}/pub?slide=id.${uniqueIds[i % uniqueIds.length]}`;
              $content.innerHTML = `<img src="${src}" alt="slide image" style="max-width:100%;height:auto;">`;
              i++;
            };
            show();
            slideTimer = setInterval(show, (item.durationSec || 10) * 1000);
          } else {
            $content.textContent = "No slides found in deck.";
          }
        } catch (err) {
          $content.textContent = "Error loading slides fallback.";
          console.error("Slides fallback error", err);
        }
      }
    }, 5000);

  } else if (item.type === 'images') {
    renderImages(item);

  } else {
    $content.textContent = 'Unsupported item type.';
  }
  //fitContentToStage(0.78); // fills ~78% of stage height
}


async function renderImages(item) {
  clearTimers();

  // Case A: explicit list of image objects in targets.json
  if (Array.isArray(item.items) && item.items.length > 0) {
    const urls = item.items.map(it => (typeof it === 'string' ? it : it.src)).filter(Boolean);
    if (urls.length === 0) {
      $content.textContent = 'No image URLs in items.'; 
      return;
    }
    cycleImages(urls, item.durationSec);
    return;
  }

  // Case B: a folder with a manifest.json (auto-generated)
  if (typeof item.folder === 'string' && item.folder.trim() !== '') {
    try {
      const res = await fetch(`${item.folder}/manifest.json`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`manifest.json not found at ${item.folder}/manifest.json`);
      const list = await res.json();
      if (!Array.isArray(list) || list.length === 0) {
        throw new Error(`manifest.json is empty or invalid in ${item.folder}`);
      }
      const urls = list.map(name => `${item.folder}/${name}`);
      cycleImages(urls, item.durationSec);
      return;
    } catch (err) {
      $content.textContent = `Error loading images: ${err.message}`;
      console.error(err);
      return;
    }
  }

  // Case C: nothing provided
  $content.textContent = 'No images configured (need "items" or "folder").';
}


function cycleImages(urls, durationSec) {
  let i = 0;
  const show = () => {
    const src = urls[i % urls.length];
    $content.innerHTML = `<img src="${src}" alt="image" style="max-width:100%;height:auto;">`;
    i++;
  };
  show();
  //fitContentToStage();
  slideTimer = setInterval(show, (durationSec || 10) * 1000);
}


function wrapPlaylist(obj) {
  // shallow clone to avoid mutating originals
  return JSON.parse(JSON.stringify(obj));
}

/* ---------- Calendar handling ---------- */

async function currentThread(now) {
  const tz = CFG.timezone || 'America/Los_Angeles';

  // URL override for testing: ?force=p1
  const q = new URL(location.href).searchParams;
  const force = q.get('force');
  if (force) return { thread: force, start: null, end: null, summary: '(forced)', debug: { reason: 'forced' } };

  // TEST OVERRIDE: ?ics=https://...workers.dev/ics
  const icsOverride = q.get('ics');
  const icsUrlList = icsOverride
    ? [icsOverride]
    : (Array.isArray(CFG.ics_urls)
        ? CFG.ics_urls
        : (CFG.ics_proxy_url || CFG.ics_url ? [CFG.ics_proxy_url || CFG.ics_url] : []));

  if (!icsUrlList.length) {
    return { thread: null, start: null, end: null, summary: '', debug: { reason: 'no-ics-config', lookedAt: [] } };
  }

  let debugInfo = { reason: '', lookedAt: [], nextEvent: null };
  let found = null;

  for (const url of icsUrlList) {
    try {
      const icsText = await fetchText(icsUrlWithCacheBust(url));
      const events = parseICSEvents(icsText);
      const parsed = expandEventsNearNow(events, now, tz, 7, 7);  // ← expand RRULEs near now

      // sort by start time
      parsed.sort((a,b) => a.start - b.start);

      // find current containing now
      const current = parsed.find(e => now >= e.start && now < e.end);

      // grace window: if none, take event starting within next 2 minutes
      const GRACE_MS = 10 * 60 * 1000;  //10 mins
      const soon = parsed.find(e => e.start >= now && (e.start - now) <= GRACE_MS);

      debugInfo.lookedAt.push({ url, count: parsed.length, first: parsed[0]?.start?.toString() || null, last: parsed.at(-1)?.end?.toString() || null });

      if (current || soon) {
        const hit = current || soon;
        const title = (hit.summary || '').toLowerCase();

        // Extract period number/letter if present (handles "1st period", "period 2", "p3", "Period A", "p10")
        const thread = mapSummaryToThread(    //NEW AFTER MOVING MAP TO UTILS
          hit.summary,
          CFG.event_map || {},
          CFG.default_thread
        );


        found = { thread, start: hit.start, end: hit.end, summary: hit.summary, debug: { reason: current ? 'current' : 'grace', url } };
        break;
      }

      // keep the next upcoming event for debug
      const upcoming = parsed.find(e => e.start >= now);
      if (!debugInfo.nextEvent && upcoming) {
        debugInfo.nextEvent = {
          summary: upcoming.summary,
          start: upcoming.start?.toString(),
          end: upcoming.end?.toString()
        };
      }
    } catch (err) {
      debugInfo.lookedAt.push({ url, error: err.message || String(err) });
      continue;
    }
  }

  if (found) return found;

  // fallback-schedule as last resort
  try {
    const fb = await fetchJSON('fallback-schedule.json');
    const dayKey = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][now.getDay()];
    const blocks = fb[dayKey] || [];
    for (const b of blocks) {
      const {start, end} = blockToDates(now, b.start, b.end);
      if (now >= start && now < end) {
        return { thread: b.thread, start, end, summary: '(fallback schedule)', debug: { reason: 'fallback' } };
      }
    }
  } catch {/* ignore */}

  return { thread: null, start: null, end: null, summary: '', debug: { reason: 'none', ...debugInfo } };
}


/* ---------- ICS parsing (robust) ---------- */

function unfoldICS(text) {
  const raw = text.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    const line = raw[i];
    if (line.startsWith(' ') && out.length) {
      out[out.length - 1] += line.slice(1);
    } else {
      out.push(line);
    }
  }
  return out;
}

function parseICSParamsAndValue(line) {
  const idx = line.indexOf(':');
  if (idx === -1) return { name: line, params: {}, value: '' };
  const left = line.slice(0, idx);
  const value = line.slice(idx + 1);
  const parts = left.split(';');
  const name = parts[0];
  const params = {};
  for (let i = 1; i < parts.length; i++) {
    const [k, v] = parts[i].split('=');
    params[(k || '').toUpperCase()] = v;
  }
  return { name, params, value };
}

function parseICSEvents(icsText) {
  const lines = unfoldICS(icsText);
  const events = [];
  let cur = null;

  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') {
      cur = {};
    } else if (line === 'END:VEVENT') {
      if (cur && (cur.DTSTART || cur.DTEND)) events.push(cur);
      cur = null;
    } else if (cur) {
      // Use the generic parser so we don't miss parameterized props
      const { name, params, value } = parseICSParamsAndValue(line);
      switch ((name || '').toUpperCase()) {
        case 'SUMMARY':
          cur.SUMMARY = value;         // handles SUMMARY and SUMMARY;LANGUAGE=...
          break;
        case 'STATUS':
          cur.STATUS = value;          // <-- needed to ignore cancelled events
          break;
        case 'DTSTART':
          cur.DTSTART = value;
          cur.DTSTART_TZID = params.TZID || null;
          cur.DTSTART_VALUE = params.VALUE || null; // e.g., DATE
          break;
        case 'DTEND':
          cur.DTEND = value;
          cur.DTEND_TZID = params.TZID || null;
          cur.DTEND_VALUE = params.VALUE || null;
          break;
        case 'RRULE':
          cur.RRULE = value;       // e.g., "FREQ=WEEKLY;BYDAY=MO,TH,FR;UNTIL=20260606T065959Z"
          break;
        default:
          // ignore other lines
          break;
      }
    }
  }
  return events;
}

function parseICSDateValue(val, tzid, displayTZ) {
  if (!val) return null;

  // All-day VALUE=DATE: "YYYYMMDD"
  if (/^\d{8}$/.test(val)) {
    const y = +val.slice(0,4), m = +val.slice(4,6)-1, d = +val.slice(6,8);
    const local = new Date(
      new Date(Date.UTC(y, m, d, 0, 0, 0))
      .toLocaleString('en-US', { timeZone: displayTZ || 'America/Los_Angeles' }));
    return validDateOrNull(local);
  }

  // UTC instant
  if (val.endsWith('Z')) return validDateOrNull(new Date(val));

  // Floating or TZID local
  const y = +val.slice(0,4), m = +val.slice(4,6)-1, d = +val.slice(6,8),
        H = +val.slice(9,11) || 0, M = +val.slice(11,13) || 0, S = +val.slice(13,15) || 0;
  const base = new Date(Date.UTC(y, m, d, H, M, S));
  const tz = tzid || displayTZ || 'America/Los_Angeles';
  const local = new Date(new Date(base).toLocaleString('en-US', { timeZone: tz }));
  return validDateOrNull(local);
}

function pickCurrentICSEvent(icsText, now, displayTZ) {
  const events = parseICSEvents(icsText);
  for (const e of events) {
    const start = parseICSDateValue(e.DTSTART, e.DTSTART_TZID, displayTZ);
    let end = parseICSDateValue(e.DTEND, e.DTEND_TZID, displayTZ);

    // If all-day DTSTART with no DTEND, treat as end of day
    if (e.DTSTART_VALUE === 'DATE' && (!e.DTEND || e.DTEND_VALUE === 'DATE')) {
      const endOfDay = new Date(start);
      endOfDay.setHours(23, 59, 59, 999);
      end = end || endOfDay;
    }

    if (start && end && now >= start && now < end) {
      return { summary: e.SUMMARY || '', dtstart: start, dtend: end };
    }
  }
  return null;
}

async function inspectICS(now) {
  const tz = CFG.timezone || 'America/Los_Angeles';
  const icsList = Array.isArray(CFG.ics_urls)
    ? CFG.ics_urls
    : (CFG.ics_proxy_url || CFG.ics_url ? [CFG.ics_proxy_url || CFG.ics_url] : []);

  const wrap = el('div');
  wrap.appendChild(el('h2', {text: 'ICS Inspector'}));

  if (!icsList.length) {
    wrap.appendChild(el('p', {text: 'No ICS URL configured (ics_proxy_url or ics_urls).'}));
  }

  for (const url of icsList) {
    const section = el('div', {class: 'ics-section'}, [
      el('h3', {text: `Feed: ${url}`})
    ]);
    try {
      const icsText = await fetchText(icsUrlWithCacheBust(url));
      const eventsRaw = parseICSEvents(icsText);
     
      // Expand recurring events ±7 days around "now"
      const events = expandEventsNearNow(eventsRaw, now, tz, 7, 7);
      
      section.appendChild(el('p', {
        text: `Expanded events in ±7-day window: ${events.length}`
      }));

      section.appendChild(el('p', {text: `Parsed events: ${events.length}`}));

      const table = el('table', {class: 'ics-table'});
      const thread = mapSummaryToThread(ev.summary, CFG.event_map || {}, CFG.default_thread) || '(n/a)';   //NEW WHEN ADDED MAPPING TO UTILS
      table.appendChild(thead);
      const tbody = el('tbody');

      const LIMIT = 40;
      let count = 0;
      for (const ev of events) {
        if (count++ >= LIMIT) break;
        const contains = (now >= ev.start && now < ev.end);
        const title = (ev.summary || '').toLowerCase();
        const m = title.match(/\b(?:p(?:eriod)?\s*)?([0-9]{1,2}|[a-z])\b/);
        let thread = '(n/a)';
        if (m) {
          const token = m[1];
          thread = isNaN(token) ? ('p' + token) : ('p' + parseInt(token,10));
        } else if (CFG.event_map) {
          const key = Object.keys(CFG.event_map).find(k => title.includes(k.toLowerCase()));
          if (key) thread = CFG.event_map[key];
        }

        const row = el('tr', {class: contains ? 'now' : ''}, [
          el('td', {text: contains ? 'YES' : ''}),
          el('td', {text: ev.start.toString()}),
          el('td', {text: ev.end.toString()}),
          el('td', {text: ev.summary}),
          el('td', {text: thread})
        ]);
        tbody.appendChild(row);
      }
      table.appendChild(tbody);
      section.appendChild(table);
    } catch (err) {
      section.appendChild(el('p', {text: `Error: ${err.message}`}));
    }
    wrap.appendChild(section);
  }

  // Render into page
  $content.innerHTML = '';
  $content.appendChild(wrap);
  $status.textContent = 'Inspector';
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

function el(tag, attrs = {}, children = []) {
  const n = document.createElement(tag);
  for (const [k,v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v; else if (k === 'text') n.textContent = v; else n.setAttribute(k, v);
  }
  for (const c of [].concat(children)) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  return n;
}
// --- RRULE expansion (minimal: DAILY/WEEKLY with BYDAY/UNTIL/INTERVAL)

const BYDAY_MAP = { SU:0, MO:1, TU:2, WE:3, TH:4, FR:5, SA:6 };

function parseRRule(rrule) {
  // rrule like: "FREQ=WEEKLY;WKST=SU;UNTIL=20260606T065959Z;BYDAY=MO,TH,FR"
  const out = {};
  for (const part of (rrule || '').split(';')) {
    if (!part) continue;
    const [k,v] = part.split('=');
    if (!k) continue;
    out[k.toUpperCase()] = v || '';
  }
  // normalize
  if (out.FREQ) out.FREQ = out.FREQ.toUpperCase();
  if (out.BYDAY) out.BYDAY = out.BYDAY.split(',').map(s=>s.trim().toUpperCase()).filter(Boolean);
  if (out.INTERVAL) out.INTERVAL = Math.max(1, parseInt(out.INTERVAL, 10) || 1);
  else out.INTERVAL = 1;
  return out;
}

function sameDay(d1, d2) {
  return d1.getFullYear()===d2.getFullYear() && d1.getMonth()===d2.getMonth() && d1.getDate()===d2.getDate();
}

function withDateKeepTime(template, dateLike) {
  // clone template date but replace Y-M-D with dateLike's Y-M-D (keeps the time portion)
  const d = new Date(template);
  d.setFullYear(dateLike.getFullYear(), dateLike.getMonth(), dateLike.getDate());
  return d;
}

/**
 * Expand events with RRULE into concrete instances within [winStart, winEnd]
 * Returns array of {summary, start, end, cancelled}
 */
function expandEventsNearNow(events, now, tz, windowDaysBefore = 7, windowDaysAfter = 7) {
  const winStart = new Date(now); winStart.setDate(winStart.getDate() - windowDaysBefore);
  const winEnd   = new Date(now); winEnd.setDate(winEnd.getDate() + windowDaysAfter);

  const out = [];

  for (const e of events) {
    // Parse base start/end
    const baseStart = validDateOrNull(parseICSDateValue(e.DTSTART, e.DTSTART_TZID, tz));
    const baseEnd   = validDateOrNull(parseICSDateValue(e.DTEND,   e.DTEND_TZID,   tz));
    const cancelled = (e.STATUS || '').toUpperCase() === 'CANCELLED';
    const summary = e.SUMMARY || '';

    if (!baseStart || !baseEnd || cancelled) continue;

    if (!e.RRULE) {
      // Single instance
      if (baseEnd >= winStart && baseStart <= winEnd) {
        out.push({ summary, start: baseStart, end: baseEnd, cancelled: false });
      }
      continue;
    }

    // Recurring: expand minimally (DAILY/WEEKLY)
    const rule = parseRRule(e.RRULE);
    const durMs = baseEnd - baseStart;
    const until = e.DTEND_VALUE === 'DATE' || e.DTSTART_VALUE === 'DATE'
      ? null  // all-day UNTIL handling skipped for simplicity
      : (rule.UNTIL ? validDateOrNull(parseICSDateValue(rule.UNTIL, null, tz)) : null);

    if (rule.FREQ === 'DAILY') {
      // walk days by INTERVAL
      // Start from the first day in window aligned to INTERVAL from baseStart
      let cursor = new Date(baseStart);
      // move cursor to winStart or later
      while (cursor < winStart) cursor.setDate(cursor.getDate() + rule.INTERVAL);
      for (; cursor <= winEnd; cursor.setDate(cursor.getDate() + rule.INTERVAL)) {
        if (until && cursor > until) break;
        const s = withDateKeepTime(baseStart, cursor);
        const eend = new Date(s.getTime() + durMs);
        out.push({ summary, start: s, end: eend, cancelled: false });
      }
    } else if (rule.FREQ === 'WEEKLY') {
      // BYDAY required for school schedules
      const by = (rule.BYDAY && rule.BYDAY.length) ? rule.BYDAY : [ 'MO','TU','WE','TH','FR' ];
      // find the Monday of the week containing winStart (or WKST if you care)
      const startWeek = new Date(winStart);
      startWeek.setHours(0,0,0,0);
      startWeek.setDate(startWeek.getDate() - startWeek.getDay()); // to Sunday

      // step weeks by INTERVAL
      for (let w = new Date(startWeek); w <= winEnd; w.setDate(w.getDate() + 7*rule.INTERVAL)) {
        for (const code of by) {
          const dow = BYDAY_MAP[code]; if (dow == null) continue;
          const occDate = new Date(w); // Sunday of this block
          occDate.setDate(occDate.getDate() + dow);
          // skip if before baseStart's calendar date (recurrences don't occur before the first instance's date)
          if (occDate < new Date(baseStart.getFullYear(), baseStart.getMonth(), baseStart.getDate())) continue;
          if (until && occDate > until) continue;
          // place the base time onto this occurrence date
          const s = withDateKeepTime(baseStart, occDate);
          const eend = new Date(s.getTime() + durMs);
          if (eend >= winStart && s <= winEnd) {
            out.push({ summary, start: s, end: eend, cancelled: false });
          }
        }
      }
    } else {
      // other FREQ types not implemented — keep the base only (better than nothing)
      if (baseEnd >= winStart && baseStart <= winEnd) {
        out.push({ summary, start: baseStart, end: baseEnd, cancelled: false });
      }
    }
  }

  // sort chronologically
  out.sort((a,b)=> a.start - b.start);
  return out;
}

function mapSummaryToThread(title, eventMap, defaultThread) {
  const t = (title || '').toLowerCase();

  // Pattern A: "period 2", "p2", "p 2", "period a"
  let m = t.match(/\b(?:p(?:eriod)?\s*)([0-9]{1,2}|[a-z])\b/i);
  if (m) {
    const tok = m[1];
    return isNaN(tok) ? ('p' + tok) : ('p' + parseInt(tok, 10));
  }

  // Pattern B: number-first ordinals "2nd period", "1st", "7th block"
  m = t.match(/\b([0-9]{1,2})(?:st|nd|rd|th)?\b/);
  if (m) {
    // Ensure it's not a year or time; 1–12 are safe for periods
    const n = parseInt(m[1], 10);
    if (n >= 1 && n <= 12) return 'p' + n;
  }

  // Pattern C: letter periods like "Period A"
  m = t.match(/\b([a-z])\b(?:\s*(?:period|block))?/i);
  if (m && m[1].length === 1) return 'p' + m[1].toLowerCase();

  // Pattern D: fall back to explicit event_map keywords
  if (eventMap) {
    const key = Object.keys(eventMap).find(k => t.includes(k.toLowerCase()));
    if (key) return eventMap[key];
  }

  return defaultThread || null;
}

/* --------- adapt to display ---------*/

function fitContentToStage(targetFill = 0.95) {
  const stage = document.getElementById('stage');
  const content = document.getElementById('content');
  if (!stage || !content) return;

  // reset before measuring
  document.documentElement.style.setProperty('--auto', '1');

  // measure after render
  requestAnimationFrame(() => {
    const stageH = stage.clientHeight || 1;
    const contentH = content.scrollHeight || 1;
    const fill = contentH / stageH;

    // If content is small (< target), scale up; if too big, cap at current size.
    if (fill < targetFill) {
      const factor = Math.min(3, targetFill / Math.max(fill, 0.01)); // cap x3 to avoid extremes
      document.documentElement.style.setProperty('--auto', String(factor));
    }
  });
}

function validDateOrNull(d) {return (d instanceof Date && !isNaN(d.getTime())) ? d : null;}
async function fetchJSON(url){ const r=await fetch(url,{cache:'no-store'}); if(!r.ok) throw new Error(`${url} ${r.status}`); return r.json(); }
async function fetchText(url){ const r=await fetch(url,{cache:'no-store'}); if(!r.ok) throw new Error(`${url} ${r.status}`); return r.text(); }
function icsUrlWithCacheBust(url){ const u=new URL(url); u.searchParams.set('t', Date.now()); return u.toString(); }
function formatNow(d, tz){ return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})} ${tz ? '('+tz+')' : ''}`; }
function formatNowNoTZ(d) { return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], {hour: '2-digit',minute: '2-digit'})}`;}
function escapeHTML(s){ return s.replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }
function clearTimers(){ if (ticker) { clearInterval(ticker); ticker=null; } if (slideTimer){ clearInterval(slideTimer); slideTimer=null; } }
function fail(e){ $content.textContent='Error loading display.'; $status.textContent = (e && e.message) ? e.message : 'Unknown error'; }

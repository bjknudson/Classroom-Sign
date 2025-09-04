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
    const tz = CFG.timezone || 'America/Los_Angeles';
    const now = localNow(tz);
    $now.textContent = formatNow(now, tz);

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
    now: formatNow(now, tz),
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
  const tz = CFG.timezone || 'America/Los_Angeles';

  // URL override for testing: ?force=p1
  const q = new URL(location.href).searchParams;
  const force = q.get('force');
  if (force) return { thread: force, start: null, end: null, summary: '(forced)', debug: { reason: 'forced' } };

  const icsUrlList = Array.isArray(CFG.ics_urls)
    ? CFG.ics_urls
    : (CFG.ics_proxy_url || CFG.ics_url ? [CFG.ics_proxy_url || CFG.ics_url] : []);

  let debugInfo = { reason: '', lookedAt: [], nextEvent: null };
  let found = null;

  for (const url of icsUrlList) {
    try {
      const icsText = await fetchText(icsUrlWithCacheBust(url));
      const events = parseICSEvents(icsText);
      const parsed = events.map(e => {
        const start = parseICSDateValue(e.DTSTART, e.DTSTART_TZID, tz);
        const end   = parseICSDateValue(e.DTEND,   e.DTEND_TZID,   tz);
        return { summary: e.SUMMARY || '', start, end, allDay: e.DTSTART_VALUE === 'DATE' || e.DTEND_VALUE === 'DATE' };
      }).filter(e => e.start && e.end);

      // sort by start time
      parsed.sort((a,b) => a.start - b.start);

      // find current containing now
      const current = parsed.find(e => now >= e.start && now < e.end);

      // grace window: if none, take event starting within next 2 minutes
      const GRACE_MS = 2 * 60 * 1000;
      const soon = parsed.find(e => e.start >= now && (e.start - now) <= GRACE_MS);

      debugInfo.lookedAt.push({ url, count: parsed.length, first: parsed[0]?.start?.toString() || null, last: parsed.at(-1)?.end?.toString() || null });

      if (current || soon) {
        const hit = current || soon;
        const title = (hit.summary || '').toLowerCase();

        // Extract period number/letter if present (handles "1st period", "period 2", "p3", "Period A", "p10")
        const numMatch = title.match(/\b(?:p(?:eriod)?\s*)?([0-9]{1,2}|[a-z])\b/);
        let thread = null;
        if (numMatch) {
          const token = numMatch[1];
          thread = isNaN(token) ? ('p' + token) : ('p' + parseInt(token, 10));
        } else {
          // fallback to event_map
          const key = Object.keys(CFG.event_map || {}).find(k => title.includes(k.toLowerCase()));
          thread = key ? CFG.event_map[key] : CFG.default_thread;
        }

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
      if (line.startsWith('SUMMARY:')) cur.SUMMARY = line.slice(8);
      else if (line.startsWith('DTSTART')) {
        const { params, value } = parseICSParamsAndValue(line);
        cur.DTSTART = value;
        cur.DTSTART_TZID = params.TZID || null;
        cur.DTSTART_VALUE = params.VALUE || null; // e.g., DATE
      } else if (line.startsWith('DTEND')) {
        const { params, value } = parseICSParamsAndValue(line);
        cur.DTEND = value;
        cur.DTEND_TZID = params.TZID || null;
        cur.DTEND_VALUE = params.VALUE || null;
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
    const asTZ = new Date(new Date(Date.UTC(y, m, d, 0, 0, 0))
      .toLocaleString('en-US', { timeZone: displayTZ || 'America/Los_Angeles' }));
    return asTZ;
  }

  // UTC instant
  if (val.endsWith('Z')) return new Date(val);

  // Floating or TZID local: "YYYYMMDDTHHMMSS"
  const y = +val.slice(0,4), m = +val.slice(4,6)-1, d = +val.slice(6,8),
        H = +val.slice(9,11) || 0, M = +val.slice(11,13) || 0, S = +val.slice(13,15) || 0;
  const base = new Date(Date.UTC(y, m, d, H, M, S));
  const tz = tzid || displayTZ || 'America/Los_Angeles';
  const asTZ = new Date(new Date(base).toLocaleString('en-US', { timeZone: tz }));
  return asTZ;
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
      const events = eventsRaw.map(e => {
        const start = parseICSDateValue(e.DTSTART, e.DTSTART_TZID, tz);
        const end   = parseICSDateValue(e.DTEND,   e.DTEND_TZID,   tz);
        return { summary: e.SUMMARY || '', start, end };
      }).filter(e => e.start && e.end)
        .sort((a,b) => a.start - b.start);

      section.appendChild(el('p', {text: `Parsed events: ${events.length}`}));

      const table = el('table', {class: 'ics-table'});
      const thead = el('thead', {}, [ el('tr', {}, [
        el('th', {text: 'Contains Now?'}), el('th', {text: 'Start'}), el('th', {text: 'End'}), el('th', {text: 'Summary'}), el('th', {text: 'Thread?'}),
      ])]);
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


async function fetchJSON(url){ const r=await fetch(url,{cache:'no-store'}); if(!r.ok) throw new Error(`${url} ${r.status}`); return r.json(); }
async function fetchText(url){ const r=await fetch(url,{cache:'no-store'}); if(!r.ok) throw new Error(`${url} ${r.status}`); return r.text(); }
function icsUrlWithCacheBust(url){ const u=new URL(url); u.searchParams.set('t', Date.now()); return u.toString(); }
function formatNow(d, tz){ return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})} ${tz ? '('+tz+')' : ''}`; }
function escapeHTML(s){ return s.replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }
function clearTimers(){ if (ticker) { clearInterval(ticker); ticker=null; } if (slideTimer){ clearInterval(slideTimer); slideTimer=null; } }
function fail(e){ $content.textContent='Error loading display.'; $status.textContent = (e && e.message) ? e.message : 'Unknown error'; }

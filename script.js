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


let CFG, TARGETS, ANNC, CLASS_MAP;
let ticker = null;
let slideTimer = null;
let playlistTimer = null;
let renderTokenCounter = 0;
let currentRenderToken = 0;

const calendarHealth = {
  lastAttempt: null,
  lastAttemptUrl: null,
  lastSuccess: null,
  lastSuccessUrl: null,
  lastCount: 0,
  lastError: null
};

function newRenderToken() {
  renderTokenCounter += 1;
  return renderTokenCounter;
}

function setCurrentRenderToken(token) {
  currentRenderToken = token;
}

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
    const cfg = await fetchJSON('config.json').catch(() => ({
      timezone: 'America/Los_Angeles',
      refresh_seconds: 60,
      playlist_duration_sec: 10
    }));

    CFG = cfg;
    if (typeof CFG.playlist_duration_sec !== 'number' || Number.isNaN(CFG.playlist_duration_sec)) {
      CFG.playlist_duration_sec = 10;
    }

    const targetsCsvPromise = cfg.targets_csv_url
      ? fetchText(cfg.targets_csv_url).catch(e => {
          console.error('Targets CSV Failed:', e);
          return '';
        })
      : Promise.resolve('');

    const [targetsJson, targetsCsv, annc, classMap] = await Promise.all([
      fetchJSON('targets.json').catch(() => ({ defaults: {}, byDate: {} })),
      targetsCsvPromise,
      fetchJSON('announcements.json').catch(() => ({ rotation: [], timeRemaining: [] })),
      fetchJSON('period_to_class_map.json').catch(() => ({ defaults: {}, byDate: {} }))
    ]);

    TARGETS = mergeTargets(targetsJson, parseSimpleTargetsCSV(targetsCsv, CFG));
    ANNC = annc;
    CLASS_MAP = normalizeClassMap(classMap);

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
    const lookedAt = threadInfo.debug?.lookedAt || [];
    const hasSuccessProbe = lookedAt.some(entry => entry && typeof entry.count === 'number');
    const hasErrorProbe = lookedAt.some(entry => entry && entry.error);
    const calendarError = threadInfo.debug?.reason === 'calendar-fetch-error'
      || (!hasSuccessProbe && hasErrorProbe);

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
      let statusText = pickedReason.includes('targets')
        ? `In-class • ${threadInfo.thread?.toUpperCase()}`
        : pickedReason;
      if (calendarError) {
        statusText += ' • Calendar fetch error';
      }
      $status.textContent = statusText;
    } else {
      if (calendarError) {
        if (!$content.textContent) {
          $content.textContent = 'Calendar unavailable.';
        }
        $status.textContent = 'Calendar fetch error';
      } else {
        $content.textContent = 'No content scheduled.';
        $status.textContent = 'Idle';
      }
    }

    showDebug({
      now: formatNowNoTZ(now),
      eventSummary: threadInfo.summary || '(none)',
      mappedThread: threadInfo.thread || '(none)',
      start: threadInfo.start ? threadInfo.start.toString() : null,
      end: threadInfo.end ? threadInfo.end.toString() : null,
      reason: threadInfo.debug?.reason || '(n/a)',
      lookedAt: threadInfo.debug?.lookedAt || [],
      nextEvent: threadInfo.debug?.nextEvent || null,
      calendarHealth
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
  const classEntries = classEntriesForThread(now, thread);
  const items = [];

  for (const entry of classEntries) {
    const item = lookupTargetForKey(ymd, entry.key);
    if (!item) continue;
    if (entry.label && !item.displayName) item.displayName = entry.label;
    items.push(item);
  }

  if (!items.length) {
    return lookupTargetForKey(ymd, thread);
  }

  if (items.length === 1) {
    return items[0];
  }

  const duration = CFG?.playlist_duration_sec;

  return {
    type: 'playlist',
    items,
    durationSec: typeof duration === 'number' ? duration : undefined
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

function classEntriesForThread(now, thread) {
  const ymd = toYMD(now);
  const dayMap = CLASS_MAP?.byDate?.[ymd] || {};
  const fromDate = normalizeClassEntries(dayMap?.[thread]);
  const fromDefaults = normalizeClassEntries(CLASS_MAP?.defaults?.[thread]);

  const merged = [];
  const seenKeys = new Set();

  const appendEntry = (entry) => {
    if (!entry?.key) return;
    const key = entry.key;
    if (seenKeys.has(key)) return;
    seenKeys.add(key);
    merged.push(entry);
  };

  for (const entry of fromDate) appendEntry(entry);
  if (fromDate.length) {
    for (const entry of fromDefaults) {
      if (!entry?.key || seenKeys.has(entry.key)) continue;
      appendEntry(entry);
    }
  } else {
    for (const entry of fromDefaults) appendEntry(entry);
  }

  const labeled = merged.map(entry => {
    if (entry.label || !TARGETS?.displayNames) return entry;
    const label = TARGETS.displayNames[entry.key];
    return label ? { ...entry, label } : entry;
  });

  if (labeled.length) return labeled;
  const fallbackLabel = TARGETS?.displayNames?.[thread] || null;
  return [{ key: thread, label: fallbackLabel }];
}

function normalizeClassEntries(value) {
  if (!value) return [];
  const list = Array.isArray(value) ? value : [value];
  const out = [];
  for (const entry of list) {
    if (!entry) continue;
    if (typeof entry === 'string') {
      out.push({ key: entry, label: null });
    } else if (typeof entry === 'object') {
      const key = entry.key || entry.id || entry.thread;
      if (!key) continue;
      out.push({ key, label: entry.label || entry.name || entry.displayName || null });
    }
  }
  return out;
}

function lookupTargetForKey(ymd, key) {
  if (!TARGETS) return null;
  const day = TARGETS.byDate?.[ymd];
  const fromDay = day?.[key] ? cloneItem(day[key]) : null;
  if (fromDay) {
    if (!fromDay.displayName) {
      const label = TARGETS.displayNames?.[key];
      if (label) fromDay.displayName = label;
    }
    return fromDay;
  }
  const fromDefaults = TARGETS.defaults?.[key] ? cloneItem(TARGETS.defaults[key]) : null;
  if (fromDefaults && !fromDefaults.displayName) {
    const label = TARGETS.displayNames?.[key];
    if (label) fromDefaults.displayName = label;
  }
  if (fromDefaults) return fromDefaults;
  return null;
}

/* ---------- Rendering ---------- */

function renderItem(item) {
  clearTimers();

  if (!item || typeof item !== 'object') {
    $content.textContent = 'Unsupported item type.';
    return;
  }

  const token = newRenderToken();
  setCurrentRenderToken(token);

  if (item.type === 'playlist') {
    renderPlaylist(item, token);
    return;
  }

  renderSingleItem(item, token);
  //fitContentToStage(0.78); // fills ~78% of stage height
}

function renderSingleItem(item, token) {
  if (!item || typeof item !== 'object') {
    $content.textContent = 'Unsupported item type.';
    return;
  }

  if (item.type === 'text') {
    const header = item.displayName ? `<div class="playlist-title">${escapeHTML(item.displayName)}</div>` : '';
    const body = escapeHTML(item.content || '').replace(/\n/g, '<br/>');
    $content.innerHTML = header + body;
    return;
  }

  if (item.type === 'slides') {
    // Try iframe first
    const iframe = document.createElement('iframe');
    iframe.className = 'slides-embed';
    iframe.src = item.url;
    iframe.allow = "fullscreen";
    iframe.loading = "lazy";

    let loaded = false;
    iframe.onload = () => { loaded = true; };
    $content.innerHTML = '';
    if (item.displayName) {
      const title = document.createElement('div');
      title.className = 'playlist-title';
      title.textContent = item.displayName;
      $content.appendChild(title);
    }
    $content.appendChild(iframe);

    // Fallback to images: scrape published deck for slide IDs
    setTimeout(async () => {
      if (token !== currentRenderToken) return;
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
              if (token !== currentRenderToken) return;
              const src = `${item.url.replace(/\/pub.*/, '')}/pub?slide=id.${uniqueIds[i % uniqueIds.length]}`;
              $content.innerHTML = `${item.displayName ? `<div class="playlist-title">${escapeHTML(item.displayName)}</div>` : ''}` +
                `<img src="${src}" alt="slide image" style="max-width:100%;height:auto;">`;
              i++;
            };
            show();
            slideTimer = setInterval(() => {
              if (token !== currentRenderToken) {
                clearInterval(slideTimer);
                slideTimer = null;
                return;
              }
              show();
            }, (item.durationSec || 10) * 1000);
          } else {
            $content.textContent = "No slides found in deck.";
          }
        } catch (err) {
          $content.textContent = "Error loading slides fallback.";
          console.error("Slides fallback error", err);
        }
      }
    }, 5000);
    return;
  }

  if (item.type === 'images') {
    if (item.displayName) {
      const title = document.createElement('div');
      title.className = 'playlist-title';
      title.textContent = item.displayName;
      $content.innerHTML = '';
      $content.appendChild(title);
      const wrapper = document.createElement('div');
      const wrapperId = `playlist-image-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      wrapper.id = wrapperId;
      $content.appendChild(wrapper);
      renderImages({ ...item, mountId: wrapperId }, token);
    } else {
      renderImages(item, token);
    }
    return;
  }

  $content.textContent = 'Unsupported item type.';
}


function renderPlaylist(item, initialToken) {
  if (!Array.isArray(item.items) || item.items.length === 0) {
    $content.textContent = 'No playlist items configured.';
    return;
  }

  const flattened = [];
  for (const raw of item.items) {
    if (raw && typeof raw === 'object' && raw.type === 'playlist' && Array.isArray(raw.items)) {
      for (const nested of raw.items) {
        if (nested && typeof nested === 'object') {
          flattened.push(cloneItem(nested));
        }
      }
    } else if (raw && typeof raw === 'object') {
      flattened.push(cloneItem(raw));
    }
  }

  if (!flattened.length) {
    $content.textContent = 'Unsupported playlist items.';
    return;
  }

  let index = 0;
  let nextToken = initialToken ?? newRenderToken();

  const advance = () => {
    playlistTimer = null;
    clearTimers({ keepPlaylist: true });

    const next = flattened[index % flattened.length];
    index += 1;
    const token = nextToken;
    nextToken = newRenderToken();
    setCurrentRenderToken(token);

    if (!next || !next.type) {
      $content.textContent = 'Unsupported playlist item.';
    } else {
      renderSingleItem(next, token);
    }

    const waitSec = resolvePlaylistDuration(next, item);
    playlistTimer = setTimeout(advance, waitSec * 1000);
  };

  advance();
}

function resolvePlaylistDuration(item, playlist) {
  if (item && typeof item.durationSec === 'number' && !isNaN(item.durationSec)) {
    return Math.max(1, item.durationSec);
  }
  if (playlist && typeof playlist.durationSec === 'number' && !isNaN(playlist.durationSec)) {
    return Math.max(1, playlist.durationSec);
  }
  if (typeof CFG?.playlist_duration_sec === 'number' && !isNaN(CFG.playlist_duration_sec)) {
    return Math.max(1, CFG.playlist_duration_sec);
  }
  return 10;
}


async function renderImages(item, token) {
  const mountId = item.mountId || item.containerId;
  const mount = mountId ? document.getElementById(mountId) : $content;
  if (!mount) return;

  const showError = (msg) => {
    if (token != null && token !== currentRenderToken) return;
    mount.textContent = msg;
  };

  // Case A: explicit list of image objects in targets.json
  if (Array.isArray(item.items) && item.items.length > 0) {
    const urls = item.items.map(it => (typeof it === 'string' ? it : it.src)).filter(Boolean);
    if (urls.length === 0) {
      showError('No image URLs in items.');
      return;
    }
    try {
      const validUrls = await filterValidImageUrls(urls, token);
      if (token != null && token !== currentRenderToken) return;
      if (validUrls.length === 0) {
        showError('No valid images found.');
        return;
      }
      cycleImages(validUrls, item.durationSec, mount, token);
    } catch (err) {
      showError(`Error loading images: ${err.message}`);
      console.error(err);
    }
    return;
  }

  // Case B: a folder with a manifest.json (auto-generated)
  if (typeof item.folder === 'string' && item.folder.trim() !== '') {
    try {
      const res = await fetch(`${item.folder}/manifest.json`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`manifest.json not found at ${item.folder}/manifest.json`);
      if (token != null && token !== currentRenderToken) return;
      const list = await res.json();
      if (token != null && token !== currentRenderToken) return;
      if (!Array.isArray(list) || list.length === 0) {
        throw new Error(`manifest.json is empty or invalid in ${item.folder}`);
      }
      const urls = list.map(name => `${item.folder}/${name}`);
      const validUrls = await filterValidImageUrls(urls, token);
      if (token != null && token !== currentRenderToken) return;
      if (validUrls.length === 0) {
        showError('No valid images found.');
        return;
      }
      cycleImages(validUrls, item.durationSec, mount, token);
      return;
    } catch (err) {
      showError(`Error loading images: ${err.message}`);
      console.error(err);
      return;
    }
  }

  // Case C: nothing provided
  showError('No images configured (need "items" or "folder").');
}


function cycleImages(urls, durationSec, mount = $content, token) {
  let i = 0;
  const show = () => {
    const src = urls[i % urls.length];
    if (token != null && token !== currentRenderToken) return;
    mount.innerHTML = `<img src="${src}" alt="image" style="max-width:100%;height:auto;">`;
    i++;
  };
  show();
  //fitContentToStage();
  slideTimer = setInterval(() => {
    if (token != null && token !== currentRenderToken) {
      clearInterval(slideTimer);
      slideTimer = null;
      return;
    }
    show();
  }, (durationSec || 10) * 1000);
}

async function filterValidImageUrls(urls, token) {
  const valid = [];
  for (const url of urls) {
    if (token != null && token !== currentRenderToken) {
      return [];
    }
    const ok = await checkImage(url);
    if (token != null && token !== currentRenderToken) {
      return [];
    }
    if (ok) {
      valid.push(url);
    }
  }
  return valid;
}

function checkImage(url) {
  return new Promise(resolve => {
    const img = new Image();
    let settled = false;
    const cleanup = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      img.onload = null;
      img.onerror = null;
      resolve(result);
    };
    const timer = setTimeout(() => cleanup(false), 5000);
    img.onload = () => cleanup(true);
    img.onerror = () => cleanup(false);
    img.src = url;
  });
}


function cloneItem(obj) {
  return obj ? JSON.parse(JSON.stringify(obj)) : null;
}

function wrapPlaylist(obj) {
  return cloneItem(obj);
}

function mergeTargets(jsonTargets, csvTargets) {
  const base = cloneItem(jsonTargets) || {};
  const merged = {
    ...base,
    defaults: { ...(base.defaults || {}) },
    byDate: {}
  };

  const baseByDate = base.byDate || {};
  for (const [dateKey, entries] of Object.entries(baseByDate)) {
    merged.byDate[dateKey] = { ...entries };
  }

  if (csvTargets?.defaults) {
    merged.defaults = { ...merged.defaults, ...csvTargets.defaults };
  }

  if (csvTargets?.byDate) {
    for (const [dateKey, entries] of Object.entries(csvTargets.byDate)) {
      merged.byDate[dateKey] = { ...(merged.byDate[dateKey] || {}), ...entries };
    }
  }

  const displayNames = { ...(base.displayNames || {}) };
  if (csvTargets?.displayNames) {
    Object.assign(displayNames, csvTargets.displayNames);
  }
  if (Object.keys(displayNames).length) {
    merged.displayNames = displayNames;
  } else {
    delete merged.displayNames;
  }

  if (!Object.keys(merged.byDate).length) {
    delete merged.byDate;
  }

  return merged;
}

function parseSimpleTargetsCSV(csvText, cfg = {}) {
  const sanitized = (csvText || '').replace(/\ufeff/g, '');
  if (!sanitized.trim()) return { defaults: {}, byDate: {} };

  const lines = sanitized.split(/\r?\n/).filter(line => line.trim().length > 0);
  if (lines.length < 2) return { defaults: {}, byDate: {} };

  const delimiter = detectDelimiter(lines[0]);
  const headerCellsRaw = parseCSVLine(lines[0], delimiter).map(h => h.trim());
  const headerCells = headerCellsRaw.map(h => h.toLowerCase());

  if (headerCells[0] === 'date') {
    return parseClassScheduleCSV(lines, delimiter, headerCellsRaw, cfg);
  }

  return parseLegacyTargetsCSV(lines, delimiter, headerCellsRaw, headerCells, cfg);
}

function parseClassScheduleCSV(lines, delimiter, headersRaw, cfg) {
  const classKeys = headersRaw.slice(1).map(h => h.trim()).filter(Boolean);
  const defaultDuration = typeof cfg.playlist_duration_sec === 'number' ? cfg.playlist_duration_sec : 10;
  const displayNames = {};
  const result = { defaults: {}, byDate: {}, displayNames: {} };

  const interpretCell = (raw) => {
    const trimmed = (raw || '').trim();
    if (!trimmed) return null;

    const baseItem = {
      type: 'text',
      content: trimmed,
      durationSec: defaultDuration
    };

    const colonIdx = trimmed.indexOf(':');
    if (colonIdx <= 0) {
      return baseItem;
    }

    const left = trimmed.slice(0, colonIdx).trim();
    const right = trimmed.slice(colonIdx + 1).trim();
    if (!left) {
      return baseItem;
    }

    const segments = left.split('|').map(s => s.trim()).filter(Boolean);
    if (!segments.length) {
      return baseItem;
    }

    const type = segments.shift().toLowerCase();
    if (!['text', 'slides', 'images', 'playlist'].includes(type)) {
      return baseItem;
    }

    const opts = {};
    for (const segment of segments) {
      const eqIdx = segment.indexOf('=');
      if (eqIdx === -1) continue;
      const key = segment.slice(0, eqIdx).trim().toLowerCase();
      const value = segment.slice(eqIdx + 1).trim();
      if (!key || !value) continue;
      opts[key] = value;
    }

    const item = { type };

    const durationOpt = opts.duration || opts.d || opts.sec || opts.seconds;
    if (durationOpt) {
      const parsed = parseInt(durationOpt, 10);
      if (!Number.isNaN(parsed) && parsed > 0) {
        item.durationSec = parsed;
      }
    }

    if (!item.durationSec) {
      item.durationSec = defaultDuration;
    }

    const labelOpt = opts.label || opts.name || opts.displayname;
    if (labelOpt) {
      item.displayName = labelOpt;
    }

    if (type === 'text') {
      item.content = right || trimmed;
      return item.content ? item : null;
    }

    if (type === 'slides') {
      item.url = right;
      return item.url ? item : null;
    }

    if (type === 'images') {
      if (opts.folder) {
        item.folder = opts.folder;
      }

      const payload = right;
      if (payload) {
        if (payload.startsWith('[')) {
          try {
            const parsed = JSON.parse(payload);
            if (Array.isArray(parsed) && parsed.length) {
              item.items = parsed;
            }
          } catch (err) {
            console.warn('Unable to parse images JSON from compact CSV cell', err);
          }
        }
        if (!item.items?.length) {
          const parts = payload.split(/[\n;,]+/).map(s => s.trim()).filter(Boolean);
          if (parts.length > 1) {
            item.items = parts.map(src => ({ src }));
          } else if (parts.length === 1) {
            const single = parts[0];
            if (!item.folder) {
              // Treat a single entry as a folder by default for parity with legacy CSV parsing.
              item.folder = single;
            } else {
              // Folder already provided via opts; interpret the single value as a direct image.
              item.items = [{ src: single }];
            }
          }
        }
      }

      if (opts.items && !item.items?.length) {
        try {
          const parsed = JSON.parse(opts.items);
          if (Array.isArray(parsed) && parsed.length) {
            item.items = parsed;
          }
        } catch (err) {
          console.warn('Unable to parse images items JSON from compact CSV options', err);
        }
      }

      if (!item.folder && !item.items?.length) {
        return null;
      }
      return item;
    }

    if (type === 'playlist') {
      const payload = right;
      if (!payload) return null;
      try {
        const parsed = JSON.parse(payload);
        if (Array.isArray(parsed) && parsed.length) {
          item.items = parsed;
          return item;
        }
      } catch (err) {
        console.warn('Unable to parse playlist JSON from compact CSV cell', err);
      }
      return null;
    }

    return baseItem;
  };

  const upsertItems = (dest, values) => {
    for (let i = 1; i < headersRaw.length; i++) {
      const key = classKeys[i - 1];
      if (!key) continue;
      const cell = values[i];
      const item = interpretCell(cell);
      if (!item) continue;
      if (!item.durationSec || Number.isNaN(item.durationSec)) {
        item.durationSec = defaultDuration;
      }
      if (!item.displayName && displayNames[key]) {
        item.displayName = displayNames[key];
      }
      dest[key] = item;
    }
  };

  for (let i = 1; i < lines.length; i++) {
    const values = parseCSVLine(lines[i], delimiter);
    if (!values.length) continue;
    while (values.length < headersRaw.length) values.push('');

    const first = (values[0] || '').trim();
    const firstLower = first.toLowerCase();

    if (!first || firstLower === 'display name' || firstLower === 'display names') {
      for (let j = 1; j < headersRaw.length; j++) {
        const key = classKeys[j - 1];
        if (!key) continue;
        const label = (values[j] || '').trim();
        if (label) {
          displayNames[key] = label;
        }
      }
      continue;
    }

    if (firstLower === 'default' || firstLower === 'defaults') {
      upsertItems(result.defaults, values);
      continue;
    }

    const dateKey = normalizeDateKey(first);
    if (!dateKey) continue;
    if (!result.byDate[dateKey]) result.byDate[dateKey] = {};
    upsertItems(result.byDate[dateKey], values);
  }

  if (Object.keys(displayNames).length) {
    const applyLabels = dest => {
      if (!dest) return;
      for (const [key, item] of Object.entries(dest)) {
        if (item && typeof item === 'object' && !item.displayName && displayNames[key]) {
          item.displayName = displayNames[key];
        }
      }
    };
    applyLabels(result.defaults);
    for (const dateKey of Object.keys(result.byDate || {})) {
      applyLabels(result.byDate[dateKey]);
    }
  }

  if (Object.keys(displayNames).length) {
    result.displayNames = displayNames;
  } else {
    delete result.displayNames;
  }

  if (!Object.keys(result.defaults).length) delete result.defaults;
  if (!Object.keys(result.byDate).length) delete result.byDate;

  return result;
}

function parseLegacyTargetsCSV(lines, delimiter, headersRaw, headersLower, cfg) {
  const indexOf = (...names) => {
    for (const name of names) {
      const idx = headersLower.indexOf(name.toLowerCase());
      if (idx !== -1) return idx;
    }
    return -1;
  };

  const idxKey = indexOf('classkey', 'key', 'thread');
  const idxDisplay = indexOf('displayname', 'display name', 'name');
  const idxType = indexOf('contenttype', 'type');
  const idxUrl = indexOf('contenturl', 'url');
  const idxText = indexOf('contenttext', 'text', 'content');
  const idxDuration = indexOf('durationsec', 'duration');
  const idxDate = indexOf('date', 'day', 'effective', 'ymd');

  const result = { defaults: {}, byDate: {} };

  for (let i = 1; i < lines.length; i++) {
    const values = parseCSVLine(lines[i], delimiter);
    if (idxKey === -1 || idxType === -1 || !values.length) continue;

    const key = (values[idxKey] || '').trim();
    if (!key) continue;

    const type = (values[idxType] || '').trim().toLowerCase();
    if (!type) continue;

    const displayName = idxDisplay !== -1 ? (values[idxDisplay] || '').trim() : '';
    const duration = idxDuration !== -1 ? parseInt((values[idxDuration] || '').trim(), 10) : NaN;
    const resolvedDuration = !isNaN(duration)
      ? duration
      : (typeof cfg.playlist_duration_sec === 'number' ? cfg.playlist_duration_sec : 10);

    const item = { type, durationSec: resolvedDuration };
    if (displayName) item.displayName = displayName;

    const textValue = idxText !== -1 ? (values[idxText] || '').trim() : '';
    const urlValue = idxUrl !== -1 ? (values[idxUrl] || '').trim() : '';

    if (type === 'text') {
      item.content = textValue || urlValue;
    } else if (type === 'slides') {
      item.url = urlValue || textValue;
    } else if (type === 'images') {
      if (urlValue.startsWith('[')) {
        try {
          const parsed = JSON.parse(urlValue);
          if (Array.isArray(parsed)) item.items = parsed;
        } catch (err) {
          console.warn('Unable to parse images JSON for', key, err);
        }
      }
      if (!item.items?.length) {
        const parts = urlValue.split(/[,\n;]+/).map(s => s.trim()).filter(Boolean);
        if (parts.length > 1) {
          item.items = parts.map(src => ({ src }));
        } else if (parts.length === 1) {
          item.folder = parts[0];
        } else if (textValue) {
          item.folder = textValue;
        }
      }
    } else if (type === 'playlist') {
      const raw = textValue || urlValue;
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) item.items = parsed;
        } catch (err) {
          console.warn('Unable to parse playlist JSON for', key, err);
        }
      }
    } else {
      continue;
    }

    if (type === 'text' && !item.content) continue;
    if ((type === 'slides' || type === 'images') && !item.url && !item.folder && !item.items) continue;

    const dateValue = idxDate !== -1 ? normalizeDateKey(values[idxDate]) : null;
    if (dateValue) {
      if (!result.byDate[dateValue]) result.byDate[dateValue] = {};
      result.byDate[dateValue][key] = item;
    } else {
      result.defaults[key] = item;
    }
  }

  if (!Object.keys(result.byDate).length) delete result.byDate;

  return result;
}

function parseCSVLine(line, delimiter = ',') {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function detectDelimiter(line) {
  const commaCount = (line.match(/,/g) || []).length;
  const tabCount = (line.match(/\t/g) || []).length;
  return tabCount > commaCount ? '\t' : ',';
}

function normalizeClassMap(raw) {
  if (!raw || typeof raw !== 'object') {
    return { defaults: {}, byDate: {} };
  }

  const result = { defaults: {}, byDate: {} };

  if (raw.defaults && typeof raw.defaults === 'object') {
    for (const [thread, value] of Object.entries(raw.defaults)) {
      result.defaults[thread] = cloneItem(value);
    }
  }

  if (raw.byDate && typeof raw.byDate === 'object') {
    for (const [dateKey, value] of Object.entries(raw.byDate)) {
      const normalizedKey = normalizeDateKey(dateKey);
      if (!normalizedKey) continue;
      result.byDate[normalizedKey] = cloneItem(value);
    }
  }

  for (const [key, value] of Object.entries(raw)) {
    if (key === 'defaults' || key === 'byDate') continue;
    const normalizedKey = normalizeDateKey(key);
    if (!normalizedKey) continue;
    result.byDate[normalizedKey] = cloneItem(value);
  }

  if (!Object.keys(result.defaults).length) delete result.defaults;
  if (!Object.keys(result.byDate).length) delete result.byDate;

  return result;
}

function normalizeDateKey(value) {
  if (!value) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return null;
  const y = parsed.getFullYear();
  const m = String(parsed.getMonth() + 1).padStart(2, '0');
  const d = String(parsed.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/* ---------- Calendar handling ---------- */

function resolveICSUrlList(cfg, override) {
  if (override) return [override];
  const urls = [];
  if (Array.isArray(cfg?.ics_urls)) {
    for (const entry of cfg.ics_urls) urls.push(entry);
  }
  if (cfg?.ics_proxy_url) urls.push(cfg.ics_proxy_url);
  if (cfg?.ics_url) urls.push(cfg.ics_url);
  return Array.from(new Set(urls.filter(Boolean)));
}

function noteCalendarAttempt(url) {
  calendarHealth.lastAttempt = new Date().toISOString();
  calendarHealth.lastAttemptUrl = url || null;
}

function noteCalendarSuccess(url, count) {
  calendarHealth.lastSuccess = new Date().toISOString();
  calendarHealth.lastSuccessUrl = url;
  calendarHealth.lastCount = count;
  calendarHealth.lastError = null;
}

function noteCalendarFailure(url, err) {
  calendarHealth.lastError = {
    url,
    message: describeFetchError(err),
    time: new Date().toISOString()
  };
}

function describeFetchError(err) {
  if (!err) return 'Unknown error';
  const msg = err.message || String(err);
  if (err instanceof TypeError && /Failed to fetch/i.test(msg)) {
    return 'Failed to fetch (network or CORS issue)';
  }
  return msg;
}

async function currentThread(now) {
  const tz = CFG.timezone || 'America/Los_Angeles';

  // URL override for testing: ?force=p1
  const q = new URL(location.href).searchParams;
  const force = q.get('force');
  if (force) return { thread: force, start: null, end: null, summary: '(forced)', debug: { reason: 'forced' } };

  // TEST OVERRIDE: ?ics=https://...workers.dev/ics
  const icsOverride = q.get('ics');
  const icsUrlList = resolveICSUrlList(CFG, icsOverride);

  if (!icsUrlList.length) {
    return { thread: null, start: null, end: null, summary: '', debug: { reason: 'no-ics-config', lookedAt: [] } };
  }

  let debugInfo = { reason: '', lookedAt: [], nextEvent: null };
  let found = null;

  for (const url of icsUrlList) {
    try {
      noteCalendarAttempt(url);
      const icsText = await fetchText(icsUrlWithCacheBust(url));
      const events = parseICSEvents(icsText);
      const parsed = expandEventsNearNow(events, now, tz, 7, 7);  // ← expand RRULEs near now

      noteCalendarSuccess(url, parsed.length);

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
        const thread = mapSummaryToThread(
          hit.summary,
          CFG.event_map || {},
          CFG.default_thread
        );


        found = {
          thread,
          start: hit.start,
          end: hit.end,
          summary: hit.summary,
          debug: { ...debugInfo, reason: current ? 'current' : 'grace', url }
        };
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
      debugInfo.lookedAt.push({ url, error: describeFetchError(err) });
      noteCalendarFailure(url, err);
      if (!debugInfo.reason) debugInfo.reason = 'calendar-fetch-error';
      continue;
    }
  }

  if (found) return found;

  if (!debugInfo.reason && debugInfo.lookedAt.some(entry => entry.error)) {
    debugInfo.reason = 'calendar-fetch-error';
  }

  // fallback-schedule as last resort
  try {
    const fb = await fetchJSON('fallback-schedule.json');
    const dayKey = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][now.getDay()];
    const blocks = fb[dayKey] || [];
    for (const b of blocks) {
      const {start, end} = blockToDates(now, b.start, b.end);
      if (now >= start && now < end) {
        return {
          thread: b.thread,
          start,
          end,
          summary: '(fallback schedule)',
          debug: { ...debugInfo, reason: 'fallback' }
        };
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
  const icsList = resolveICSUrlList(CFG);

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
      noteCalendarAttempt(url);
      const icsText = await fetchText(icsUrlWithCacheBust(url));
      const eventsRaw = parseICSEvents(icsText);

      // Expand recurring events ±7 days around "now"
      const events = expandEventsNearNow(eventsRaw, now, tz, 7, 7);

      noteCalendarSuccess(url, events.length);
      
      section.appendChild(el('p', {
        text: `Expanded events in ±7-day window: ${events.length}`
      }));

      section.appendChild(el('p', {text: `Parsed events: ${events.length}`}));

      const table = el('table', {class: 'ics-table'});
      const thead = el('thead');
      thead.appendChild(el('tr', {}, [
        el('th', {text: 'Now?'}),
        el('th', {text: 'Start'}),
        el('th', {text: 'End'}),
        el('th', {text: 'Summary'}),
        el('th', {text: 'Thread'})
      ]));
      table.appendChild(thead);
      const tbody = el('tbody');

      const LIMIT = 40;
      let count = 0;
      for (const ev of events) {
        if (count++ >= LIMIT) break;
        const contains = (now >= ev.start && now < ev.end);
        const title = (ev.summary || '').toLowerCase();
        const thread = mapSummaryToThread(ev.summary, CFG.event_map || {}, CFG.default_thread) || '(n/a)';

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
      noteCalendarFailure(url, err);
      section.appendChild(el('p', {text: `Error: ${describeFetchError(err)}`}));
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
async function fetchJSON(url) {
  try {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) {
      throw new Error(`HTTP ${r.status}${r.statusText ? ' ' + r.statusText : ''}`.trim());
    }
    return await r.json();
  } catch (err) {
    const message = describeFetchError(err instanceof Error ? err : new Error(String(err)));
    throw new Error(`Fetch failed for ${url}: ${message}`);
  }
}

async function fetchText(url) {
  try {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) {
      throw new Error(`HTTP ${r.status}${r.statusText ? ' ' + r.statusText : ''}`.trim());
    }
    return await r.text();
  } catch (err) {
    const message = describeFetchError(err instanceof Error ? err : new Error(String(err)));
    throw new Error(`Fetch failed for ${url}: ${message}`);
  }
}
function icsUrlWithCacheBust(url){ const u=new URL(url); u.searchParams.set('t', Date.now()); return u.toString(); }
function formatNow(d, tz){ return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})} ${tz ? '('+tz+')' : ''}`; }
function formatNowNoTZ(d) { return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], {hour: '2-digit',minute: '2-digit'})}`;}
function escapeHTML(s){ return s.replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }
function clearTimers(options = {}) {
  const { keepPlaylist = false } = options;
  if (ticker) { clearInterval(ticker); ticker = null; }
  if (slideTimer) { clearInterval(slideTimer); slideTimer = null; }
  if (!keepPlaylist && playlistTimer) { clearTimeout(playlistTimer); playlistTimer = null; }
}
function fail(e){ $content.textContent='Error loading display.'; $status.textContent = (e && e.message) ? e.message : 'Unknown error'; }

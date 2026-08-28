// Schedule selection override: show the upcoming class x minutes before it starts.
// Loaded after script.js and before DOMContentLoaded, so loop() uses this version.

currentThread = async function currentThreadWithLead(now) {
  const tz = CFG.timezone || 'America/Los_Angeles';
  const LEAD_MS = 2 * 60 * 1000; // 2 minutes

  const q = new URL(location.href).searchParams;
  const force = q.get('force');
  if (force) {
    return {
      thread: force,
      start: null,
      end: null,
      summary: '(forced)',
      debug: { reason: 'forced' }
    };
  }

  const icsOverride = q.get('ics');
  const icsUrlList = resolveICSUrlList(CFG, icsOverride);
  const debugInfo = { reason: '', lookedAt: [], nextEvent: null };

  let bestSoon = null;
  let bestCurrent = null;

  for (const url of icsUrlList) {
    try {
      noteCalendarAttempt(url);
      const icsText = await fetchText(icsUrlWithCacheBust(url));
      const events = parseICSEvents(icsText);
      const parsed = expandEventsNearNow(events, now, tz, 7, 7);
      parsed.sort((a, b) => a.start - b.start);

      noteCalendarSuccess(url, parsed.length);
      debugInfo.lookedAt.push({
        url,
        count: parsed.length,
        first: parsed[0]?.start?.toString() || null,
        last: parsed.at(-1)?.end?.toString() || null
      });

      const soon = parsed.find(e => e.start > now && (e.start - now) <= LEAD_MS);
      if (soon && (!bestSoon || soon.start < bestSoon.event.start)) {
        bestSoon = { event: soon, url };
      }

      const current = parsed.find(e => now >= e.start && now < e.end);
      if (current && (!bestCurrent || current.start > bestCurrent.event.start)) {
        bestCurrent = { event: current, url };
      }

      const upcoming = parsed.find(e => e.start > now);
      if (upcoming) {
        const existingStart = debugInfo.nextEvent?.start
          ? new Date(debugInfo.nextEvent.start)
          : null;
        if (!existingStart || upcoming.start < existingStart) {
          debugInfo.nextEvent = {
            summary: upcoming.summary,
            start: upcoming.start?.toString(),
            end: upcoming.end?.toString()
          };
        }
      }
    } catch (err) {
      debugInfo.lookedAt.push({ url, error: describeFetchError(err) });
      noteCalendarFailure(url, err);
      if (!debugInfo.reason) debugInfo.reason = 'calendar-fetch-error';
    }
  }

  // During the final minute before the next event, upcoming classroom content
  // intentionally takes priority over an event that is still technically active.
  const calendarHit = bestSoon || bestCurrent;
  if (calendarHit) {
    const hit = calendarHit.event;
    const isLead = calendarHit === bestSoon;
    const thread = mapSummaryToThread(
      hit.summary,
      CFG.event_map || {},
      CFG.default_thread
    );

    return {
      thread,
      start: hit.start,
      end: hit.end,
      summary: hit.summary,
      debug: {
        ...debugInfo,
        reason: isLead ? 'lead-1m' : 'current',
        url: calendarHit.url
      }
    };
  }

  if (!debugInfo.reason && debugInfo.lookedAt.some(entry => entry.error)) {
    debugInfo.reason = 'calendar-fetch-error';
  }

  // Fallback schedule uses the same one-minute lead behavior.
  try {
    const fb = await fetchJSON('fallback-schedule.json');
    const dayKey = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][now.getDay()];
    const blocks = fb[dayKey] || [];
    const datedBlocks = blocks.map(block => ({
      block,
      ...blockToDates(now, block.start, block.end)
    }));

    const soon = datedBlocks.find(({ start }) => start > now && (start - now) <= LEAD_MS);
    const current = datedBlocks.find(({ start, end }) => now >= start && now < end);
    const hit = soon || current;

    if (hit) {
      return {
        thread: hit.block.thread,
        start: hit.start,
        end: hit.end,
        summary: '(fallback schedule)',
        debug: {
          ...debugInfo,
          reason: soon ? 'fallback-lead-1m' : 'fallback'
        }
      };
    }
  } catch (err) {
    console.warn('Fallback schedule unavailable:', err);
  }

  return {
    thread: null,
    start: null,
    end: null,
    summary: '',
    debug: { reason: debugInfo.reason || 'none', ...debugInfo }
  };
};

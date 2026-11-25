/**
 * @OnlyCurrentDoc
 *
 * Iron Sharpens Iron: lifegroup sheet -> website
 *
 * Runs inside the lifegroup Google Sheet (Extensions > Apps Script) and sends
 * the sheet's upcoming nights, the Events tab and the Families tab to the
 * website, the same way the app's sheet sync does. Google runs it every hour;
 * it uses no Claude.
 *
 * Settings live in Project Settings > Script properties, never in this file:
 *   SUPABASE_URL       https://<project>.supabase.co
 *   SUPABASE_ANON_KEY  the project's public (anon / publishable) key
 *   SYNC_KEY           the sync key from docs/calendar-sync.md step 1
 *
 * Setup steps are in docs/sheet-sync.md. Run setUpSync once; after that it
 * runs on its own. Nothing from the sheet is written to the log, only counts.
 *
 * "@OnlyCurrentDoc" above limits the script to this one spreadsheet.
 */

var TIME_ZONE = 'America/Chicago';
var DEFAULT_TIME = '6:30pm';

/** Run once: turns on the hourly sync and runs it right away. */
function setUpSync() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'syncLifegroupSheet') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('syncLifegroupSheet').timeBased().everyHours(1).create();
  syncLifegroupSheet();
}

/** Run once to stop the hourly sync. */
function stopSync() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'syncLifegroupSheet') ScriptApp.deleteTrigger(t);
  });
  Logger.log('The hourly sync is off.');
}

/** The hourly sync. */
function syncLifegroupSheet() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    Logger.log('Another sync is still running, so this one was skipped.');
    return;
  }
  try {
    syncOnce_();
  } finally {
    lock.releaseLock();
  }
}

function syncOnce_() {
  var settings = readSettings_();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var today = Utilities.formatDate(new Date(), TIME_ZONE, 'yyyy-MM-dd');
  var names = ss.getSheets().map(function (s) { return s.getName(); });
  var data = buildSync(names, function (name) {
    return ss.getSheetByName(name).getDataRange().getDisplayValues();
  }, today);

  if (data.events.length) {
    var body = { p_source: 'sheet', p_events: data.events, p_key: settings.key };
    // Nights taken off the sheet are removed, but only when this quarter's tab
    // (or a later one) is there to compare against.
    if (data.replace) body.p_replace_from = today;
    var n = callSite_(settings, 'sync_events', body);
    Logger.log('Calendar: ' + n + ' upcoming events synced.');
    if (!data.replace) {
      Logger.log('No tab for this quarter yet (like "' + data.currentQuarter + '"), so nights were only added or updated, not removed.');
    }
  } else {
    // The site refuses an empty list rather than clear the calendar.
    Logger.log('Calendar: no upcoming events in the sheet, so the calendar was left as it is.');
  }
  var f = callSite_(settings, 'sync_families', { p_families: data.families, p_key: settings.key });
  Logger.log('Families: ' + f + ' synced.');
}

// ---------------------------------------------------------------------------
// Reading the sheet (no Google services below this line except in callSite_)
// ---------------------------------------------------------------------------

/**
 * Turns the sheet's tabs into what the site needs.
 * tabNames: every tab's name. readTab(name): that tab's cells as text rows.
 * today: YYYY-MM-DD in Chicago time. Rows before today are left out.
 */
function buildSync(tabNames, readTab, today) {
  var quarters = quarterTabs(tabNames);
  var current = quarterName(today);
  if (!quarters.length) throw new Error('No quarter tab (like "2026 Q4") was found, so nothing was sent.');
  if (tabNames.indexOf('Events') < 0) throw new Error('No "Events" tab was found, so nothing was sent.');
  if (tabNames.indexOf('Families') < 0) throw new Error('No "Families" tab was found, so nothing was sent.');

  var events = [];
  quarters.forEach(function (tab) {
    var rows = readTab(tab);
    var h = findHeader(rows, ['Date', 'Host']);
    if (!h) throw new Error('Tab "' + tab + '" has no header row with Date and Host, so nothing was sent.');
    var cDate = col(h.cells, 'Date'), cHost = col(h.cells, 'Host');
    var cAddr = col(h.cells, 'Address', true), cTime = col(h.cells, 'Time');
    var body = rows.slice(h.index + 1);
    checkDates(body, cDate, 'Tab "' + tab + '"');
    body.forEach(function (r) {
      var date = parseDate(cell(r, cDate));
      if (!date || date < today) return;
      var host = cell(r, cHost);
      var ev = { id: 'sheet-' + date, date: date, time: cTime >= 0 && cell(r, cTime) ? formatTime(cell(r, cTime)) : DEFAULT_TIME,
                 location: '', address: cell(r, cAddr), notes: '' };
      if (!host) {
        ev.title = 'Bible study \u00b7 host needed';
        ev.kind = 'open';
        ev.address = '';
      } else if (/ at /i.test(host)) {
        ev.title = host;
      } else {
        ev.title = 'Bible study at ' + possessive(host);
      }
      events.push(ev);
    });
  });

  var er = readTab('Events');
  var eh = findHeader(er, ['Date', 'Event']);
  if (!eh) throw new Error('The Events tab has no header row with Date and Event, so nothing was sent.');
  var e = { date: col(eh.cells, 'Date'), time: col(eh.cells, 'Time'), title: col(eh.cells, 'Event'),
            location: col(eh.cells, 'Location'), address: col(eh.cells, 'Address', true), notes: col(eh.cells, 'Notes') };
  checkDates(er.slice(eh.index + 1), e.date, 'The Events tab');
  er.slice(eh.index + 1).forEach(function (r) {
    var date = parseDate(cell(r, e.date)), title = cell(r, e.title);
    if (!date || !title || date < today) return;
    events.push({ id: 'sheet-' + date + '-' + slug(title), title: title, date: date,
                  time: cell(r, e.time) ? formatTime(cell(r, e.time)) : '',
                  location: cell(r, e.location), address: cell(r, e.address), notes: cell(r, e.notes) });
  });

  var fr = readTab('Families');
  var fh = findHeader(fr, ['Family', 'Husband', 'Wife']);
  if (!fh) throw new Error('The Families tab has no header row with Family, Husband and Wife, so nothing was sent.');
  var f = { name: col(fh.cells, 'Family'), husband: col(fh.cells, 'Husband'), wife: col(fh.cells, 'Wife'),
            prayFor: col(fh.cells, 'Pray for', true) };
  if (f.prayFor < 0) throw new Error('The Families tab has no "Pray for" column, so nothing was sent.');
  var families = [];
  fr.slice(fh.index + 1).forEach(function (r) {
    var name = cell(r, f.name).replace(/^the\s+/i, '').trim();
    if (!name) return;
    families.push({ name: name, husband: cell(r, f.husband), wife: cell(r, f.wife), pray_for: cell(r, f.prayFor) });
  });
  if (!families.length) throw new Error('The Families tab has no families, so nothing was sent.');

  return { events: events, families: families, replace: quarterKey(quarters[0]) >= quarterKey(current),
           currentQuarter: current };
}

/** "2026-11-25" -> "2026 Q4". */
function quarterName(day) {
  return day.slice(0, 4) + ' Q' + Math.ceil(+day.slice(5, 7) / 3);
}

function quarterKey(name) {
  var m = /^\s*(\d{4})\s*Q([1-4])\s*$/i.exec(name);
  return m ? +m[1] * 10 + +m[2] : 0;
}

/** Stops when a tab has dates but none of them can be read (say the date format changed). */
function checkDates(rows, c, what) {
  var filled = 0, read = 0;
  rows.forEach(function (r) {
    if (!cell(r, c)) return;
    filled++;
    if (parseDate(cell(r, c))) read++;
  });
  if (filled && !read) {
    throw new Error(what + "'s dates can't be read (they should look like 11/3/26), so nothing was sent.");
  }
}

/** The two most recent quarter tabs, like "2026 Q4" and "2026 Q3". */
function quarterTabs(names) {
  return names
    .map(function (n) { var k = quarterKey(n); return k ? { name: n, key: k } : null; })
    .filter(Boolean)
    .sort(function (a, b) { return b.key - a.key; })
    .slice(0, 2)
    .map(function (q) { return q.name; });
}

/** The first row that has every one of the given headers. */
function findHeader(rows, needed) {
  for (var i = 0; i < rows.length; i++) {
    var cells = rows[i].map(function (c) { return String(c).trim().toLowerCase(); });
    if (needed.every(function (n) { return cells.indexOf(n.toLowerCase()) >= 0; })) return { index: i, cells: cells };
  }
  return null;
}

/** Column of a header (or of the first header starting with it), or -1. */
function col(cells, name, startsWith) {
  name = name.toLowerCase();
  for (var i = 0; i < cells.length; i++) {
    if (startsWith ? cells[i].indexOf(name) === 0 : cells[i] === name) return i;
  }
  return -1;
}

function cell(row, i) {
  return i >= 0 && i < row.length ? String(row[i]).trim() : '';
}

/** "10/27/26", "11/17/2026" or "Tue 11/3/26" -> "2026-11-03"; anything else -> "". */
function parseDate(text) {
  var m = /(?:^|\D)(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})(?!\d)/.exec(String(text));
  var y, mo, d;
  if (m) {
    mo = +m[1]; d = +m[2]; y = +m[3]; if (y < 100) y += 2000;
  } else {
    m = /^\s*(\d{4})-(\d{1,2})-(\d{1,2})(?!\d)/.exec(String(text));
    if (!m) return '';
    y = +m[1]; mo = +m[2]; d = +m[3];
  }
  var dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return '';
  return y + '-' + pad2(mo) + '-' + pad2(d);
}

/** "6:30 PM", "6 pm", "18:30" or "18:30:00" -> "6:30pm" / "6pm"; other text is kept. */
function formatTime(text) {
  var t = String(text).trim();
  var m = /^(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m\.?$/i.exec(t);
  if (m) return +m[1] + (m[2] ? ':' + m[2] : '') + m[3].toLowerCase() + 'm';
  m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(t);
  if (m && +m[1] < 24) {
    var h = +m[1], ap = h >= 12 ? 'pm' : 'am';
    h = h % 12 || 12;
    return h + ':' + m[2] + ap;
  }
  return t.slice(0, 40);
}

/** "Oelkers" -> "the Oelkers'", "Farag's" -> "the Farags'", "The Weeks" -> "the Weeks'". */
function possessive(host) {
  var name = String(host).trim().replace(/^the\s+/i, '');
  if (/['\u2019]s$/i.test(name)) name = name.slice(0, -2) + 's';
  else if (/s['\u2019]$/i.test(name)) name = name.slice(0, -1);
  if (!/s$/i.test(name)) name += 's';
  return 'the ' + name + "'";
}

/** "Fall Fest 2026!" -> "fall-fest-2026"; accents are dropped. */
function slug(text) {
  return String(text).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '') || 'event';
}

function pad2(n) { return (n < 10 ? '0' : '') + n; }

// ---------------------------------------------------------------------------
// Talking to the site
// ---------------------------------------------------------------------------

function readSettings_() {
  var p = PropertiesService.getScriptProperties();
  var url = String(p.getProperty('SUPABASE_URL') || '').trim().replace(/\/+$/, '');
  var anon = String(p.getProperty('SUPABASE_ANON_KEY') || '').trim();
  var key = String(p.getProperty('SYNC_KEY') || '').trim();
  if (!url || !anon || !key) {
    throw new Error('Add SUPABASE_URL, SUPABASE_ANON_KEY and SYNC_KEY in Project Settings > Script properties.');
  }
  // Only a Supabase project address, so a typo can't send the key elsewhere.
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(url)) {
    throw new Error('SUPABASE_URL should look like https://abcd1234.supabase.co, with nothing after it.');
  }
  return { url: url, anon: anon, key: key };
}

/** Calls one of the site's sync functions. The key goes in the body, over HTTPS. */
function callSite_(settings, fn, body) {
  var res = UrlFetchApp.fetch(settings.url + '/rest/v1/rpc/' + fn, {
    method: 'post',
    contentType: 'application/json',
    headers: { apikey: settings.anon },
    payload: JSON.stringify(body),
    muteHttpExceptions: true,
    followRedirects: false
  });
  var code = res.getResponseCode(), text = res.getContentText();
  if (code !== 200) {
    var msg = text;
    try { msg = JSON.parse(text).message || text; } catch (e) { /* keep the text */ }
    throw new Error('The site refused ' + fn + ' (' + code + '): ' + String(msg).slice(0, 300));
  }
  return JSON.parse(text);
}

// Lets the tests load this file in Node. Apps Script ignores it.
if (typeof module !== 'undefined') {
  module.exports = { buildSync: buildSync, quarterTabs: quarterTabs, findHeader: findHeader, parseDate: parseDate,
                     formatTime: formatTime, possessive: possessive, slug: slug, quarterName: quarterName,
                     syncLifegroupSheet: syncLifegroupSheet, setUpSync: setUpSync, stopSync: stopSync };
}

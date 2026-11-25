// Pure helpers for the prayer lists. No database or page code here, so these
// are easy to test.

export const DAY = 86400000;

export function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

export function ymd(d) {
  const x = new Date(d);
  return x.getFullYear() + "-" + String(x.getMonth() + 1).padStart(2, "0") + "-" + String(x.getDate()).padStart(2, "0");
}

// The prayer week runs Sunday to Saturday, matching the Sunday prayer sheet.
export function prayerWeekStart(now = new Date()) {
  const d = startOfDay(now);
  d.setDate(d.getDate() - d.getDay());
  return d;
}

export function inThisWeek(iso, now = new Date()) {
  return !!iso && new Date(iso) >= prayerWeekStart(now);
}

export const isActive = (r) => r.status !== "answered";

// The day a request belongs to: its prayer sheet's date, or the day it was added.
export function entryDay(r) {
  return r.sheet_date || (r.created_at ? ymd(r.created_at) : "");
}

export function normalize(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// "The Smiths:" and "smiths" are the same family.
export function cleanFamilyName(s) {
  return String(s || "")
    .trim()
    .replace(/\s*[:\-–—]+$/, "")
    .replace(/^the\s+/i, "")
    .replace(/\s+/g, " ");
}

// Each family's newest sheet day. A family's newest request is its current one.
export function latestByFamily(requests) {
  const m = new Map();
  for (const r of requests) {
    if (r.list !== "lifegroup" || !isActive(r)) continue;
    const d = entryDay(r);
    if (!m.has(r.family_id) || d > m.get(r.family_id)) m.set(r.family_id, d);
  }
  return m;
}

export function isCurrent(r, latest) {
  if (!isActive(r)) return false;
  if (r.list === "brothers") return true;
  return entryDay(r) === latest.get(r.family_id);
}

// Index prayers by request id, newest first.
export function prayersByRequest(prayers) {
  const m = new Map();
  for (const p of prayers) {
    if (!m.has(p.request_id)) m.set(p.request_id, []);
    m.get(p.request_id).push(p);
  }
  for (const list of m.values()) list.sort((a, b) => String(b.prayed_at).localeCompare(String(a.prayed_at)));
  return m;
}

export function prayersThisWeek(list = [], now = new Date()) {
  return list.filter((p) => inThisWeek(p.prayed_at, now));
}

export function iPrayedThisWeek(list = [], myId, now = new Date()) {
  return !!myId && list.some((p) => p.member_id === myId && inThisWeek(p.prayed_at, now));
}

// A current request nobody has prayed for since Sunday.
export function needsPrayer(r, list, latest, now = new Date()) {
  return isCurrent(r, latest) && prayersThisWeek(list, now).length === 0;
}

// This week: the newest prayer sheet (if it is under two weeks old, else the
// last seven days), plus every open Brothers request.
export function weekFrom(requests, now = new Date()) {
  const today = startOfDay(now).getTime();
  const todayYmd = ymd(new Date(today));
  // A sheet date typed in the future is ignored, so it can't hide this week.
  const sheets = requests.filter((r) => r.list === "lifegroup" && r.sheet_date && r.sheet_date <= todayYmd).map((r) => r.sheet_date).sort();
  const newest = sheets.pop();
  const twoWeeksAgo = ymd(new Date(today - 13 * DAY));
  const sevenAgo = ymd(new Date(today - 7 * DAY));
  return newest && newest >= twoWeeksAgo ? newest : sevenAgo;
}

// True when weekFrom() is the date of a real prayer sheet.
export function weekIsSheet(requests, from) {
  return requests.some((r) => r.list === "lifegroup" && r.sheet_date === from);
}

export function thisWeek(requests, labelOf, now = new Date()) {
  const from = weekFrom(requests, now);
  const byLabel = (a, b) => normalize(labelOf(a)).localeCompare(normalize(labelOf(b)));
  const lifegroup = requests.filter((r) => r.list === "lifegroup" && isActive(r) && entryDay(r) >= from).sort(byLabel);
  const brothers = requests.filter((r) => r.list === "brothers" && isActive(r)).sort(byLabel);
  return { from, lifegroup, brothers };
}

// Group requests under a heading (a family or a man), headings A to Z,
// newest request first inside each.
export function groupBy(requests, keyOf, labelOf) {
  const m = new Map();
  for (const r of requests) {
    const k = keyOf(r);
    if (!m.has(k)) m.set(k, { key: k, label: labelOf(r), items: [] });
    m.get(k).items.push(r);
  }
  const groups = [...m.values()].sort((a, b) => normalize(a.label).localeCompare(normalize(b.label)));
  for (const g of groups) g.items.sort((a, b) => entryDay(b).localeCompare(entryDay(a)) || String(b.created_at).localeCompare(String(a.created_at)));
  return groups;
}

export function matchesSearch(r, query, labelOf, updatesFor = () => []) {
  const words = normalize(query).split(" ").filter(Boolean);
  if (!words.length) return true;
  const hay = normalize([labelOf(r), r.body, r.answered_note, ...updatesFor(r).map((u) => u.body)].join(" "));
  return words.every((w) => hay.includes(w));
}

export function friendlyDay(s) {
  const [y, m, d] = String(s || "").split("-").map(Number);
  if (!y || !m || !d) return "";
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function ago(iso, now = new Date()) {
  if (!iso) return "never";
  const n = Math.floor((startOfDay(now) - startOfDay(iso)) / DAY);
  if (n <= 0) return "today";
  if (n === 1) return "yesterday";
  if (n < 7) return n + " days ago";
  if (n < 14) return "1 week ago";
  if (n < 60) return Math.floor(n / 7) + " weeks ago";
  return Math.floor(n / 30) + " months ago";
}

export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

export const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || "").trim());

// ---------- encouragement after "I prayed" (same verses as the app) ----------

export const ENCOURAGE = [
  "The prayer of a righteous person has great power. James 5:16",
  "Pray without ceasing. 1 Thessalonians 5:17",
  "Bear one another’s burdens. Galatians 6:2",
  "Cast all your anxieties on him, because he cares for you. 1 Peter 5:7",
  "The Lord is near to all who call on him. Psalm 145:18",
  "Continue steadfastly in prayer, being watchful in it with thanksgiving. Colossians 4:2",
  "Rejoice in hope, be patient in tribulation, be constant in prayer. Romans 12:12",
  "Ask, and it will be given to you; seek, and you will find. Matthew 7:7",
  "In everything by prayer and supplication with thanksgiving let your requests be made known to God. Philippians 4:6",
  "Where two or three are gathered in my name, there am I among them. Matthew 18:20",
];

// Hands out the verses in turn, starting at a random one.
export function encourager(start = Math.floor(Math.random() * ENCOURAGE.length)) {
  let i = start;
  return () => ENCOURAGE[((i++ % ENCOURAGE.length) + ENCOURAGE.length) % ENCOURAGE.length];
}

// ---------- updates bring a prayer back ----------

const time = (iso) => (iso ? new Date(iso).getTime() : 0);

export function myLastPrayer(list = [], myId) {
  return list.filter((p) => p.member_id === myId).map((p) => p.prayed_at).sort((a, b) => time(b) - time(a))[0] || null;
}

export function latestUpdate(ups = []) {
  return ups.slice().sort((a, b) => time(b.created_at) - time(a.created_at))[0] || null;
}

// Someone else shared news on an open prayer after I last prayed for it
// (in the last two weeks), so it comes back to me as "Pray again".
export function updatedForMe(r, list = [], ups = [], myId, now = new Date()) {
  if (!myId || !isActive(r)) return false;
  const mine = myLastPrayer(list, myId);
  const u = latestUpdate(ups);
  return !!(mine && u && u.created_by !== myId && time(u.created_at) > time(mine) && time(now) - time(u.created_at) < 14 * DAY);
}

// "Prayed this week" only counts when nothing new was shared since.
export function prayedCurrent(r, list, ups, myId, now = new Date()) {
  return iPrayedThisWeek(list, myId, now) && !updatedForMe(r, list, ups, myId, now);
}

// Undoing "I prayed" takes back only the prayers made after the newest
// update, so a "Pray again" goes back to "Pray again". Otherwise it takes
// back this week's.
export function undoIds(list = [], ups = [], myId, now = new Date()) {
  const week = list.filter((p) => p.member_id === myId && inThisWeek(p.prayed_at, now));
  const u = latestUpdate(ups);
  const after = u && u.created_by !== myId ? week.filter((p) => time(p.prayed_at) > time(u.created_at)) : [];
  return (after.length && after.length < week.length ? after : week).map((p) => p.id);
}

// ---------- similar prayers ----------

// Who a request is for: a family, a member, or a name.
export function ownerKey(r) {
  if (r.list === "lifegroup") return "f:" + r.family_id;
  return r.for_member ? "m:" + r.for_member : "n:" + normalize(r.for_name);
}

const STOP = new Set(("about after again also always answer away been being both bring continue continued could each even every from give have help into just keep know like lord made make many more most much need needs next please pray prayed prayer prayers praying praise really some still such than thank thanks that their them then there these they this those through very want week weeks well were what when where which while will with would your god jesus christ family families").split(" "));

export function stems(text) {
  return new Set(normalize(text).split(" ").filter((w) => w.length >= 4 && !STOP.has(w)).map((w) => w.slice(0, 5)));
}

// Other open prayers from the same family or person that share a key word.
export function similarOpen(r, requests) {
  const s = stems(r.body);
  if (!s.size) return [];
  const k = ownerKey(r);
  return requests
    .filter((x) => x.id !== r.id && isActive(x) && ownerKey(x) === k && [...stems(x.body)].some((w) => s.has(w)))
    .sort((a, b) => entryDay(b).localeCompare(entryDay(a)));
}

// ---------- this week's numbers ----------

// How many of this week's requests someone prayed for, and how many prayers
// from how many people since Sunday.
export function weekPulse(all, requests, by, now = new Date()) {
  const covered = all.filter((r) => prayersThisWeek(by.get(r.id), now).length > 0).length;
  const week = requests.flatMap((r) => prayersThisWeek(by.get(r.id), now));
  return { total: all.length, covered, lifted: week.length, people: new Set(week.map((p) => p.member_id)).size };
}

// Updates and answers from the last 7 days, newest first.
export function weekNews(requests, updatesFor, now = new Date()) {
  const recent = (iso) => !!iso && Math.floor((startOfDay(now) - startOfDay(iso)) / DAY) < 7;
  const news = [];
  for (const r of requests) {
    if (!isActive(r) && recent(r.answered_at)) news.push({ r, at: r.answered_at, by: r.answered_by, kind: "answer", words: r.answered_note });
    const u = isActive(r) ? latestUpdate(updatesFor(r)) : null;
    if (u && recent(u.created_at)) news.push({ r, at: u.created_at, by: u.created_by, kind: "update", words: u.body });
  }
  return news.sort((a, b) => time(b.at) - time(a.at));
}

// ---------- dates ----------

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// "Nov", or "Nov ’25" for another year.
export function monthLabel(ym, now = new Date()) {
  const [y, m] = String(ym).split("-").map(Number);
  return MONTHS[m - 1] + (y !== now.getFullYear() ? " ’" + String(y).slice(2) : "");
}

export function longMonth(iso) {
  return new Date(iso).toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

// ---------- calendar ----------

// An event's last day (the start day for one-day events).
export const eventEnd = (e) => (e.ends_on && e.ends_on >= e.starts_on ? e.ends_on : e.starts_on);

const dayKey = (e) => String(e.starts_on) + " " + String(e.time_text || "");

// Events that haven't ended yet and start within the next `days` days, soonest first.
export function upcomingEvents(events, days, now = new Date()) {
  const today = ymd(now);
  const end = ymd(new Date(startOfDay(now).getTime() + days * DAY));
  return events.filter((e) => !e.hidden && e.starts_on && eventEnd(e) >= today && e.starts_on <= end)
    .sort((a, b) => dayKey(a).localeCompare(dayKey(b)));
}

// The Calendar tab's lists: "upcoming" (soonest first), "past" (newest first) or "hidden".
export function eventsFor(events, when, now = new Date()) {
  const today = ymd(now);
  return events.filter((e) => e.starts_on && (when === "hidden" ? e.hidden
    : !e.hidden && (when === "past" ? eventEnd(e) < today : eventEnd(e) >= today)))
    .sort((a, b) => (when === "upcoming" ? dayKey(a).localeCompare(dayKey(b)) : String(b.starts_on).localeCompare(String(a.starts_on))));
}

const parseDay = (s) => {
  const [y, m, d] = String(s || "").split("-").map(Number);
  return y && m && d ? new Date(y, m - 1, d) : null;
};

// "Sat, Nov 29", or "Nov 28–30" / "Nov 30 – Dec 2" for a few days.
export function dateRange(e) {
  const a = parseDay(e.starts_on);
  if (!a) return "";
  const b = e.ends_on && e.ends_on > e.starts_on ? parseDay(e.ends_on) : null;
  const f = (d) => d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  if (!b) return a.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  return a.getMonth() === b.getMonth() && a.getFullYear() === b.getFullYear() ? `${f(a)}–${b.getDate()}` : `${f(a)} – ${f(b)}`;
}

// The little date block: weekday and day of the month.
export function dateBlock(s) {
  const d = parseDay(s);
  return d ? { dow: d.toLocaleDateString(undefined, { weekday: "short" }), day: d.getDate() } : { dow: "", day: "?" };
}

// "November 2026" heading for the Calendar tab.
export function eventMonth(s) {
  const d = parseDay(s);
  return d ? d.toLocaleDateString(undefined, { month: "long", year: "numeric" }) : "No date";
}

// A link that opens Google Calendar with the event filled in (all-day).
export function calendarLink(e) {
  const a = parseDay(e.starts_on);
  if (!a) return "";
  const after = new Date(parseDay(eventEnd(e)) || a);
  after.setDate(after.getDate() + 1);
  const p = new URLSearchParams({
    action: "TEMPLATE",
    text: e.title || "Event",
    dates: ymd(a).replace(/-/g, "") + "/" + ymd(after).replace(/-/g, ""),
    details: [e.time_text ? "Time: " + e.time_text : "", e.notes || "", e.url || ""].filter(Boolean).join("\n"),
    location: e.address || e.location || "",
  });
  return "https://calendar.google.com/calendar/render?" + p.toString();
}

export const mapsLink = (address) => "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(address);

// Only send people to https pages.
export const safeUrl = (u) => (/^https:\/\//i.test(String(u || "")) ? String(u) : "");

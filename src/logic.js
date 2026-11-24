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

// "The Weeks:" and "weeks" are the same family.
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
  const sheets = requests.filter((r) => r.list === "lifegroup" && r.sheet_date).map((r) => r.sheet_date).sort();
  const newest = sheets.pop();
  const today = startOfDay(now).getTime();
  const twoWeeksAgo = ymd(new Date(today - 13 * DAY));
  const sevenAgo = ymd(new Date(today - 7 * DAY));
  return newest && newest >= twoWeeksAgo ? newest : sevenAgo;
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

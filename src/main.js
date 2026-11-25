import "./styles.css";
import { supabase, configured } from "./supabase.js";
import * as api from "./api.js";
import {
  esc, isActive, entryDay, friendlyDay, ago, cleanFamilyName, isEmail, ymd, normalize,
  latestByFamily, needsPrayer, prayersByRequest, prayersThisWeek, iPrayedThisWeek,
  thisWeek, matchesSearch, inThisWeek, weekIsSheet, DAY,
  encourager, latestUpdate, updatedForMe, prayedCurrent, undoIds, similarOpen, ownerKey,
  weekPulse, weekNews, monthLabel, longMonth,
  upcomingEvents, eventsFor, dateRange, dateBlock, eventMonth, calendarLink, mapsLink, safeUrl,
  familyLabel, weekOf, joinsNextWeek, partnerFamily, prayingFamilies, memberOfFamily, familyKey,
  familyPrayers, prayersForPerson, personUndoIds, myExtras,
} from "./logic.js";

const $ = (s) => document.querySelector(s);
const app = $("#app");

// Small per-browser memory (which sections are open, what news you've seen).
// It can fail in private windows, so every use is wrapped.
const stored = {
  get(k, fallback) { try { const v = localStorage.getItem(k); return v === null ? fallback : JSON.parse(v); } catch (_) { return fallback; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) { /* not saved, that's fine */ } },
};

const state = {
  session: null,
  member: null, // true / false once checked
  admin: false,
  data: null,
  invites: [],
  tab: "week",
  search: { lifegroup: "", brothers: "" },
  form: null, // { kind: "update" | "answer" | "add", id, ctx }
  confirm: null, // request id waiting for delete confirmation
  sent: null, // email a sign-in link was sent to
  loading: false,
  error: null, // message when loading failed
  open: new Set(), // family or brother groups the person has opened
  drops: new Set(stored.get("drops-open", [])), // This week sections the person keeps open
  family: "all", // Lifegroup chip: "all", "answered" or a family id
  man: "all", // Brothers chip: "all", "answered" or a person key
  famDate: {}, // date tab picked inside each family
  picked: new Set(), // search results picked to mark answered together
  bulkNote: "", // the note typed for them
  showAllAnswered: false,
  newsBaseline: undefined, // when news was last seen, frozen while the page is open
  prayNow: null, // { ids, i, prayed, skipped, verse }
  ready: false, // true once we know whether someone is signed in
  when: "upcoming", // Calendar: "upcoming", "past" or "hidden" (admins)
  openEvent: null, // the sheet event whose details are showing
  eventDraft: null, // what was typed in Add a group event, kept if saving fails
  picking: false, // true while changing your family
};

const nextVerse = encourager();

// ---------- small page helpers ----------

let toastTimer;
function toast(msg, ms = 3500) {
  const t = $("#toast");
  t.hidden = false;
  t.textContent = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

function friendlyError(e) {
  const msg = String((e && e.message) || e || "");
  if (/invite list|Database error saving new user|Signups not allowed/i.test(msg)) return "That email isn't on the invite list yet. Ask the group leader to add you.";
  if (/rate limit|too many/i.test(msg)) return "Too many sign-in emails just now. Wait a minute and try again.";
  if (/expired|invalid.*(otp|token)|token.*(expired|invalid)/i.test(msg)) return "That code didn't work. It may be old: use the newest email, or send a new code.";
  if (/row-level security|permission denied/i.test(msg)) return "You don't have access to do that.";
  if (/Failed to fetch|NetworkError/i.test(msg)) return "Couldn't reach the server. Check your connection and try again.";
  return msg || "Something went wrong. Try again.";
}

async function act(fn, okMsg, ms) {
  try {
    await fn();
    if (okMsg) toast(okMsg, ms);
    await refresh();
    return true;
  } catch (e) {
    toast(friendlyError(e));
    return false;
  }
}

// ---------- data ----------

async function refresh() {
  if (!state.session) return;
  state.loading = !state.data;
  state.error = null;
  render();
  try {
    state.member = await api.amIMember();
    if (state.member) {
      const [data, admin] = await Promise.all([api.loadAll(), api.amIAdmin()]);
      state.data = data;
      state.admin = admin;
      state.invites = admin ? await api.loadInvites() : [];
      if (!admin && state.tab === "group") state.tab = "week";
    }
  } catch (e) {
    if (state.data) toast(friendlyError(e));
    else state.error = friendlyError(e);
  }
  state.loading = false;
  render();
}

const myId = () => state.session?.user?.id;

// Lookups built once per render from the loaded data.
let D = { by: new Map(), ups: new Map(), latest: new Map() };
function derive() {
  const ups = new Map();
  for (const u of state.data.updates) {
    if (!ups.has(u.request_id)) ups.set(u.request_id, []);
    ups.get(u.request_id).push(u);
  }
  D = { by: prayersByRequest(state.data.prayers), ups, latest: latestByFamily(state.data.requests) };
  // Your family, and the family and brother you pray for this week.
  const d = state.data;
  const me = d.members.find((m) => m.id === myId()) || null;
  const fam = me?.family_id ? d.families.find((f) => f.id === me.family_id) || null : null;
  const partner = fam ? partnerFamily(d.families, fam.id) : null;
  const ex = myExtras(d.extras || [], myId());
  const brother = partner ? memberOfFamily(d.members, partner.id) : null;
  D.week = {
    me, fam, partner, brother,
    // Leave out an extra that's now your own family or this week's partner
    // (after a mid-week change of family).
    extraFams: ex.families.filter((x) => x.family_id !== fam?.id && x.family_id !== partner?.id && d.families.some((f) => f.id === x.family_id)),
    extraMen: ex.members.filter((x) => x.for_member !== brother?.id && x.for_member !== myId() && d.members.some((m) => m.id === x.for_member)),
  };
  // Who prays for each family this week, worked out once per redraw.
  D.prayingFor = new Map();
  for (const [fid, fams] of prayingFamilies(d.families)) {
    D.prayingFor.set(fid, fams.flatMap((f) => d.members.filter((m) => m.family_id === f.id)));
  }
}
// Who prayed for a person this week: for him, or for any of his requests.
const whoPrayedFor = (memberId) => prayersForPerson(memberId, state.data.personPrayers || [], state.data.requests, D.by);
const iPrayedFor = (memberId) => whoPrayedFor(memberId).includes(myId());
// The brothers whose family prays for this person's family this week.
const prayingFor = (m) => (m?.family_id && D.prayingFor.get(m.family_id)) || [];
const onMyList = (memberId) => D.week.brother?.id === memberId || D.week.extraMen.some((x) => x.for_member === memberId);
const prayersOf = (r) => D.by.get(r.id) || [];
const updatesFor = (r) => D.ups.get(r.id) || [];
const isUpdated = (r) => updatedForMe(r, prayersOf(r), updatesFor(r), myId());
const isMine = (r) => prayedCurrent(r, prayersOf(r), updatesFor(r), myId());
const weekCount = (r) => prayersThisWeek(prayersOf(r)).length;

function labelOf(r) {
  const d = state.data;
  if (r.list === "lifegroup") return d.families.find((f) => f.id === r.family_id)?.name || "Unknown family";
  return d.members.find((m) => m.id === r.for_member)?.display_name || r.for_name || "Unknown";
}

const nameOf = (id) => (id === myId() ? "You" : state.data.members.find((m) => m.id === id)?.display_name || "Someone");
const firstName = (s) => String(s || "").trim().split(/\s+/)[0] || "";
const canDelete = (r) => state.admin || r.created_by === myId();
const plural = (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`;
const shortDay = (iso) => (iso ? friendlyDay(ymd(iso)) : "");
const joinNames = (names) => names.length <= 2 ? names.join(" and ") : names.slice(0, -1).join(", ") + " and " + names.at(-1);

// ---------- views ----------

function render() {
  if (!configured) return renderSetup();
  if (!state.ready) { app.innerHTML = shell(`<div class="empty">Loading…</div>`); return; }
  if (!state.session) return renderSignIn();
  if (state.member === false) return renderNotInvited();
  if (state.error && !state.data) {
    app.innerHTML = shell(`<div class="card"><h2>Couldn't load the prayers</h2><p class="lede">${esc(state.error)}</p>
      <div class="actions"><button class="btn primary" type="button" data-act="retry">Try again</button></div></div>`);
    return;
  }
  if (state.loading || !state.data) {
    app.innerHTML = shell(`<div class="empty">Loading prayers…</div>`);
    return;
  }
  derive();
  const views = { week: viewWeek, lifegroup: viewLifegroup, brothers: viewBrothers, calendar: viewCalendar };
  if (state.admin) views.group = viewGroup;
  const view = (views[state.tab] || viewWeek)();
  const tabId = state.tab in views ? state.tab : "week";
  const foot = tabId === "week" ? "" : footer();
  // The invite list opens from the footer, so it has no tab of its own.
  const panel = tabId === "group" ? `aria-label="Invite list" tabindex="-1"` : `role="tabpanel" aria-labelledby="tab-${tabId}"`;
  app.innerHTML = shell(tabs() + `<section class="view" id="panel-${tabId}" ${panel}>${view}</section>${foot}`) + prayNowView();
  document.body.classList.toggle("noscroll", !!state.prayNow);
  if (state.prayNow && state.prayNow.focus !== state.prayNow.i) {
    state.prayNow.focus = state.prayNow.i;
    app.querySelector(".pn-card [data-autofocus]")?.focus();
  }
}

function shell(inner) {
  return `<header class="mast">
      <div>
        <h1>Iron Sharpens Iron</h1>
        <div class="verse">Proverbs 27:17 · one man sharpens another</div>
      </div>
      <span class="today mono">${esc(new Date().toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }))}</span>
    </header>${inner}`;
}

function whoAmI() {
  const me = state.data?.members.find((m) => m.id === myId());
  const fam = state.data?.weeklyReady && me?.family_id ? state.data.families.find((f) => f.id === me.family_id) : null;
  return `<div class="whoami"><span class="meta">You’re ${esc(me?.display_name || state.session?.user?.email || "")}${fam ? ` · ${esc(fam.name)} family` : ""}</span>
    <span class="actions">${fam && !state.picking ? `<button class="btn quiet small" type="button" data-act="change-family">Change family</button>` : ""}${state.admin ? `<button class="btn quiet small" type="button" data-act="tab" data-tab="group"${state.tab === "group" ? ` aria-current="page"` : ""}>Invite list</button>` : ""}<button class="btn quiet small" type="button" data-act="sign-out">Sign out</button></span></div>`;
}
const footer = () => `<footer class="foot">${whoAmI()}</footer>`;

function tabs() {
  const list = [["week", "This week"], ["lifegroup", "Lifegroup"], ["brothers", "Brothers"], ["calendar", "Calendar"]];
  const wk = thisWeek(state.data.requests, labelOf);
  const notYet = wk.lifegroup.concat(wk.brothers).filter((r) => !weekCount(r)).length;
  return `<nav class="tabs" role="tablist" aria-label="Sections">${list.map(([id, label]) => `
    <button class="tab" role="tab" type="button" id="tab-${id}" data-act="tab" data-tab="${id}" aria-selected="${state.tab === id}">
      ${esc(label)}${id === "week" && notYet ? ` <span class="count" title="${notYet} not prayed for yet this week"><span class="sr">, </span>${notYet}<span class="sr"> not prayed for yet</span></span>` : ""}
    </button>`).join("")}</nav>`;
}

function renderSetup() {
  app.innerHTML = shell(`<div class="card">
    <h2>Almost ready</h2>
    <p class="lede">This site isn't connected to its database yet. Add the <code>SUPABASE_URL</code> and <code>SUPABASE_ANON_KEY</code> secrets to the repo, then deploy again.</p>
  </div>`);
}

function renderSignIn() {
  if (state.sent) {
    app.innerHTML = shell(`<div class="card">
      <h2>Check your email</h2>
      <p class="lede">We sent a sign-in email to <strong>${esc(state.sent)}</strong>. Type the code from it here, or tap the link in it.</p>
      <form class="form-plain" data-form="code" autocomplete="on">
        <label class="field">Code from the email<input class="code-input" type="text" name="code" required inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]{6,12}" maxlength="12" placeholder="123456"></label>
        <div class="actions"><button class="btn primary" type="submit">Sign in</button></div>
      </form>
      <p class="meta">The code works in any browser, so it's handy when the email opens a link somewhere else, like inside your mail app.</p>
      <div class="actions"><button class="btn quiet small" type="button" data-act="resend">Send a new email</button><button class="btn quiet small" type="button" data-act="other-email">Use a different email</button></div>
    </div>`);
    return;
  }
  app.innerHTML = shell(`<div class="card">
    <h2>Sign in</h2>
    <p class="lede">Enter the email the group leader invited. We'll email you a code, no password needed.</p>
    <form class="form-plain" data-form="sign-in" autocomplete="on">
      <label class="field">Email<input type="email" name="email" required autocomplete="email" inputmode="email" placeholder="you@example.com"></label>
      <div class="actions"><button class="btn primary" type="submit">Email me a sign-in code</button></div>
    </form>
  </div>`);
}

function renderNotInvited() {
  app.innerHTML = shell(`<div class="card">
    <h2>Not on the invite list</h2>
    <p class="lede">You're signed in as ${esc(state.session.user.email)}, but that email isn't on the group's invite list. Ask the group leader to add you, then sign in again.</p>
    <div class="actions"><button class="btn small" type="button" data-act="sign-out">Sign out</button></div>
  </div>`);
}

// ----- one prayer request -----

function requestRow(r, ctx, opts = {}) {
  const list = prayersOf(r);
  const week = prayersThisWeek(list);
  const ups = updatesFor(r).slice().sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  const flag = needsPrayer(r, list, D.latest);
  const updated = isUpdated(r);
  const open = state.form && state.form.id === r.id && state.form.ctx === ctx ? state.form.kind : null;

  const pill = !isActive(r) ? `<span class="pill moss">Answered</span>`
    : updated ? `<span class="pill steel">Updated</span>`
    : flag ? `<span class="pill ember">${list.length ? "Not prayed for this week" : "Not prayed for yet"}</span>` : "";
  const when = [r.sheet_date ? `From ${friendlyDay(r.sheet_date)} sheet` : `Added ${shortDay(r.created_at)}`];
  if (!isActive(r)) when.push("answered " + ago(r.answered_at));
  const whoPrayed = [...new Set(list.map((p) => p.member_id))].map(nameOf);
  const prayLine = (week.length ? `<span class="pray-count">\u{1F64F} ${week.length} this week</span> · ` : "")
    + (whoPrayed.length ? `Prayed for by ${esc(joinNames(whoPrayed))}, last ${esc(ago(list[0].prayed_at))}` : "No prayers logged yet");

  let tail;
  if (open === "update") {
    const nm = "kind-" + esc(r.id);
    tail = `<form class="inline" data-form="update" data-id="${esc(r.id)}">
      <label class="field">Update<textarea name="body" required maxlength="2000" placeholder="Surgery went well, still recovering…"></textarea></label>
      <fieldset class="choices"><legend class="sub">What does this mean for the prayer?</legend>
        <label class="checkline"><input type="radio" name="kind" value="keep" checked><span>Keep praying for this <span class="meta">· everyone who prayed sees the update</span></span></label>
        <label class="checkline"><input type="radio" name="kind" value="answered"><span>God answered this <span class="meta">· the update becomes the answer</span></span></label>
        <label class="checkline"><input type="radio" name="kind" value="new"><span>This is a new prayer request <span class="meta">· added as its own prayer</span></span></label>
      </fieldset>
      <div class="new-opts" id="${nm}" hidden><label class="checkline"><input type="checkbox" name="orig_done"><span>The original prayer was answered too</span></label></div>
      <div class="actions"><button class="btn primary small" type="submit">Save</button><button class="btn quiet small" type="button" data-act="close">Cancel</button></div>
    </form>`;
  } else if (open === "answer") {
    const sim = similarOpen(r, state.data.requests);
    tail = `<form class="inline" data-form="answer" data-id="${esc(r.id)}">
      <label class="field">How did God answer?<textarea name="note" maxlength="2000" placeholder="Got the job, or didn't, and He gave peace about what's next."></textarea></label>
      ${sim.length ? `<fieldset class="similar"><legend class="sub">Similar open ${sim.length === 1 ? "prayer" : "prayers"} from ${esc(labelOf(r))}. Check any that were answered too.</legend>
        ${sim.map((x) => `<label class="checkline"><input type="checkbox" name="also" value="${esc(x.id)}"><span>${esc(x.body)} <span class="meta">· ${esc(x.sheet_date ? friendlyDay(x.sheet_date) + " sheet" : "added " + shortDay(x.created_at))}</span></span></label>`).join("")}
      </fieldset>` : ""}
      <div class="actions"><button class="btn primary small" type="submit">Save answer</button><button class="btn quiet small" type="button" data-act="close">Cancel</button></div>
    </form>`;
  } else if (state.confirm === r.id) {
    tail = `<div class="actions"><span class="meta">Delete this request for everyone?</span>
      <button class="btn danger small" type="button" data-act="delete" data-id="${esc(r.id)}">Delete</button>
      <button class="btn quiet small" type="button" data-act="close">Keep</button></div>`;
  } else if (!isActive(r)) {
    tail = `<div class="actions"><button class="btn quiet small" type="button" data-act="reopen" data-id="${esc(r.id)}">Not answered yet</button>
      ${!opts.compact && canDelete(r) ? `<button class="btn quiet small" type="button" data-act="confirm" data-id="${esc(r.id)}">Delete</button>` : ""}</div>`;
  } else {
    const mine = isMine(r);
    tail = `<div class="actions">
      <button class="btn small ${mine ? "prayed" : updated ? "primary" : ""}" type="button" data-act="prayed" data-id="${esc(r.id)}" aria-pressed="${mine}" title="${mine ? "Tap to undo" : "Mark that you prayed for this"}">${mine ? "Prayed this week ✓" : updated ? "\u{1F64F} Pray again" : "I prayed"}</button>
      <button class="btn small" type="button" data-act="open-update" data-id="${esc(r.id)}" data-ctx="${ctx}">Share an update</button>
      <button class="btn small" type="button" data-act="open-answer" data-id="${esc(r.id)}" data-ctx="${ctx}">God answered</button>
      ${!opts.compact && canDelete(r) ? `<button class="btn quiet small" type="button" data-act="confirm" data-id="${esc(r.id)}">Delete</button>` : ""}
    </div>`;
  }

  const shownUps = ups.slice(0, opts.compact ? 1 : 3);
  const said = [];
  if (!isActive(r) && r.answered_note) said.push(`<div><span class="mono">${esc(shortDay(r.answered_at))}</span> ${esc(r.answered_note)}</div>`);
  for (const u of shownUps) said.push(`<div><span class="mono">${esc(shortDay(u.created_at))}</span> ${esc(u.body)} <span class="meta">· ${esc(nameOf(u.created_by))}</span></div>`);

  return `<div class="row">
    <div class="row-top">
      <div class="row-main">
        ${opts.showWho ? `<span class="who">${esc(labelOf(r))}</span>` : ""}
        <span class="text">${esc(r.body)}</span>
      </div>
      ${pill}
    </div>
    ${said.length ? `<div class="updates">${said.join("")}</div>` : ""}
    <span class="meta">${esc(when.join(" · "))}</span>
    <span class="meta">${prayLine}</span>
    ${tail}
  </div>`;
}

const rows = (list, ctx, opts) => `<div class="list">${list.map((r) => requestRow(r, ctx, opts)).join("")}</div>`;

// A fold-out section on This week; each person's open ones are remembered.
function drop(key, title, meta, body) {
  return `<details class="drop" data-drop="${key}"${state.drops.has(key) ? " open" : ""}>
    <summary><span class="drop-title">${esc(title)}</span><span class="drop-meta">${meta}</span></summary>
    <div class="drop-body">${body}</div>
  </details>`;
}

// A story: who it's for, what was asked, then the news in its own callout.
function storyRow(r, label, words, at, kind, fresh) {
  const mine = prayersOf(r).some((p) => p.member_id === myId());
  return `<div class="story">${fresh ? `<span class="pill ember new-pill">New</span>` : ""}
    <span class="who">${esc(labelOf(r))} <span class="meta">· ${r.list === "lifegroup" ? "Lifegroup" : "Brothers"}</span></span>
    <span class="asked">${esc(r.body)}</span>
    <div class="callout ${kind}"><span class="sub">${esc(label)} · ${esc(ago(at))}${mine ? " · you prayed for this" : ""}</span>${words ? `<span class="said">${esc(words)}</span>` : ""}</div>
  </div>`;
}

// ----- This week -----

function viewWeek() {
  const wk = thisWeek(state.data.requests, labelOf);
  const all = wk.lifegroup.concat(wk.brothers);
  const p = weekPulse(all, state.data.requests, D.by);
  const pct = p.total ? Math.round((p.covered / p.total) * 100) : 0;
  const everyone = p.total && p.covered === p.total;

  const pulse = `<div class="pulse">${!p.total
    ? `<div class="pulse-foot">Prayers from this week’s sheet and the brothers’ requests show up here.</div>`
    : `<div class="pulse-top"><span class="pulse-head">${everyone ? "Every request was prayed for this week \u{1F64C}" : `<span class="pulse-num">${p.covered} of ${p.total}</span> requests prayed for this week`}</span>
        <button class="btn primary small pulse-btn" type="button" data-act="pn-open">Pray now</button></div>
      <div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="${p.total}" aria-valuenow="${p.covered}" aria-label="Requests prayed for this week"><span style="width:${pct}%"></span></div>
      <div class="pulse-foot">${p.lifted ? `\u{1F64F} ${plural(p.lifted, "prayer")} from ${plural(p.people, "brother")} since Sunday` : "No prayers logged yet this week. Be the first."}</div>`}
  </div>`;

  const dropMeta = (rs) => {
    if (!rs.length) return "none yet";
    const notYet = rs.filter((r) => !weekCount(r)).length;
    const upd = rs.filter(isUpdated).length;
    return esc(`${plural(rs.length, "request")}${upd ? ` · ${upd} updated` : ""}${notYet ? ` · ${notYet} not prayed for yet` : " · all prayed for ✓"}`);
  };
  const source = wk.lifegroup.length ? `<span class="eyebrow">${weekIsSheet(state.data.requests, wk.from) ? "From the " + esc(friendlyDay(wk.from)) + " sheet" : "Last 7 days"}</span>` : "";

  // News from the last 7 days. "New" means since you last opened this section.
  const news = weekNews(state.data.requests, updatesFor);
  const seen = stored.get("news-seen", null);
  const isNew = (n, since) => n.by !== myId() && (!since || String(n.at) > since);
  if (state.drops.has("news")) {
    // The section is open, so you're seeing the news now.
    if (state.newsBaseline === undefined) state.newsBaseline = seen;
    stored.set("news-seen", new Date().toISOString());
  }
  const fresh = state.drops.has("news") ? 0 : news.filter((n) => isNew(n, seen)).length;
  const mark = state.newsBaseline !== undefined ? state.newsBaseline : seen;
  const nAns = news.filter((n) => n.kind === "answer").length, nUp = news.length - nAns;
  const newsMeta = (fresh ? `<span class="pill ember">${fresh} new</span> ` : "")
    + esc(news.length ? [nUp ? plural(nUp, "update") : "", nAns ? `${nAns} answered` : ""].filter(Boolean).join(" · ") : "none this week");
  const newsBody = news.length
    ? news.map((n) => storyRow(n.r, n.kind === "answer" ? "God answered" : "Update", n.words, n.at, n.kind, isNew(n, mark))).join("")
    : `<div class="empty">When someone taps <b>Share an update</b> or <b>God answered</b> on a prayer, it shows up here for a week.</div>`;

  return pulse + myCard()
    + `<div class="drops">`
    + drop("lg", "Lifegroup prayers", dropMeta(wk.lifegroup), source + (wk.lifegroup.length ? weekList(wk.lifegroup) : `<div class="empty">No lifegroup requests this week yet. Add them on the <b>Lifegroup</b> tab.</div>`))
    + drop("peer", "Brothers prayers", dropMeta(wk.brothers), wk.brothers.length ? weekList(wk.brothers) : `<div class="empty">No requests yet. Add them on the <b>Brothers</b> tab.</div>`)
    + drop("news", "Updates and answered prayers", newsMeta, newsBody)
    + `</div>` + comingUp() + rememberWall();
}

// Your own view: prayers you prayed for this week drop below the rest and
// come back when the new week starts or someone shares news.
function weekList(all) {
  const todo = all.filter((r) => !isMine(r)).sort((a, b) => isUpdated(b) - isUpdated(a));
  const done = all.filter(isMine);
  return (todo.length ? rows(todo, "week", { showWho: true, compact: true }) : `<div class="empty">You've prayed for every request this week. Thank you.</div>`)
    + (done.length ? `<div class="prayed-head"><span class="sub">You prayed for these this week ✓</span><span class="meta">${done.length}</span></div>${rows(done, "week", { showWho: true, compact: true })}` : "");
}

// ----- your family and brother each week -----

// One family to pray for: its names and its prayers from the latest sheet.
function famBlock(f, extra = "") {
  const rs = familyPrayers(state.data.requests, f.id, D.latest);
  const couple = familyLabel(f);
  return `<div class="famblock">
    <div class="famblock-head"><span class="fam-name">${esc(f.name)}${couple ? ` <span class="meta">· ${esc(couple)}</span>` : ""}</span>${extra}</div>
    ${rs.length ? rows(rs, "fam", { compact: true })
      : `<p class="meta">No requests from the ${esc(f.name)} family on the sheet yet. Pray for them as a couple: their marriage, their home and their walk with the Lord.</p>`}
  </div>`;
}

// "I prayed for Mike": for the man himself, not only his requests.
function personPrayBtn(m) {
  if (!state.data.weeklyReady || !m?.id || m.id === myId()) return "";
  const first = firstName(m.display_name);
  const mine = iPrayedFor(m.id);
  return `<button class="btn small ${mine ? "prayed" : ""}" type="button" data-act="pray-person" data-id="${esc(m.id)}" aria-pressed="${mine}" title="${mine ? "Tap to undo" : `Mark that you prayed for ${esc(first)}`}">${mine ? `Prayed for ${esc(first)} ✓` : `\u{1F64F} I prayed for ${esc(first)}`}</button>`;
}

const openCount = (memberId) => state.data.requests.filter((r) => r.list === "brothers" && r.for_member === memberId && isActive(r)).length;

// A brother on your list: his name (opens his page), his requests, the button.
function brotherLine(m, label, extra = "") {
  const n = openCount(m.id);
  return `<div class="brother">
    <span class="brother-text"><span class="sub">${esc(label)}</span>
      <button class="linkish" type="button" data-man="m:${esc(m.id)}">${esc(m.display_name)}</button>
      <span class="meta">· ${n ? plural(n, "open request") : "no requests yet"}</span></span>
    <span class="actions">${personPrayBtn(m)}${extra}</span>
  </div>`;
}

const memberById = (id) => state.data.members.find((m) => m.id === id) || null;
const familyById = (id) => state.data.families.find((f) => f.id === id) || null;
const removeBtn = (x, name) => `<button class="btn quiet small" type="button" data-act="extra-remove" data-id="${esc(x.id)}" aria-label="Take ${esc(name)} off your list">Remove</button>`;

// Pick your family once, like the app's "Which family is yours?".
function familyPicker() {
  const W = D.week;
  const fams = state.data.families.slice().sort((a, b) => familyKey(a.name).localeCompare(familyKey(b.name)));
  return `<form class="weekfam" data-form="my-family" autocomplete="off">
    <div class="sec-head"><h2>Which family is yours?</h2></div>
    <p class="meta">Pick it once. Each Sunday you’ll get another family and a brother to pray for, and another family prays for yours.</p>
    <label class="field">Your family<select name="family" required>
      <option value="">Pick your family…</option>
      ${fams.map((f) => `<option value="${esc(f.id)}"${W.fam?.id === f.id ? " selected" : ""}>${esc(f.name)}</option>`).join("")}
      <option value="new">My family isn’t listed</option>
    </select></label>
    <label class="field new-family" hidden>Family name<input type="text" name="name" maxlength="80" placeholder="Smith" autocapitalize="words"></label>
    <label class="field">Your wife’s first name <span class="meta">(optional)</span><input type="text" name="wife" maxlength="80" autocapitalize="words"></label>
    <p class="meta">Her name is only used if the family list doesn’t have it yet.</p>
    <div class="actions"><button class="btn primary small" type="submit">This is my family</button>${state.picking ? `<button class="btn quiet small" type="button" data-act="pick-cancel">Cancel</button>` : ""}</div>
  </form>`;
}

// The top of the This week card.
function weekTop() {
  const d = state.data, W = D.week;
  if (!d.weeklyReady) {
    return state.admin ? `<div class="callout"><span class="sub">Weekly prayer partners</span><span class="said">One setup step turns on each person’s family and brother to pray for each week. They’re in the README, steps 8 and 9.</span></div>` : "";
  }
  if (!W.fam || state.picking) return familyPicker();
  if (joinsNextWeek(W.fam)) {
    return `<div class="weekfam"><div class="sub">Welcome</div><p class="meta">Your family joins the weekly prayer circle on Sunday. From then on, your family and brother to pray for show up here.</p></div>`;
  }
  if (!W.partner) {
    return `<div class="weekfam"><p class="meta">Once another family joins the prayer circle, you’ll get a family and a brother to pray for here each week.</p></div>`;
  }
  const extras = W.extraFams.map((x) => familyById(x.family_id)).map((f) => famBlock(f)).join("")
    + W.extraMen.map((x) => brotherLine(memberById(x.for_member), "Brother")).join("");
  return `<div class="weekfam">
    <div class="sec-head"><h2>Your family to pray for</h2><span class="eyebrow">changes each Sunday</span></div>
    ${famBlock(W.partner)}
    ${W.brother ? brotherLine(W.brother, "Your brother")
      : `<p class="meta">Nobody from the ${esc(W.partner.name)} family has signed in yet, so there’s no brother this week.</p>`}
    ${extras ? `<div class="sub also">Also praying for</div>${extras}` : ""}
  </div>`;
}

// Updates on prayers you prayed for, and who prayed for you.
function myCard() {
  const me = myId();
  const d = state.data, W = D.week;
  const updates = d.requests.filter(isUpdated)
    .sort((a, b) => String(latestUpdate(updatesFor(b)).created_at).localeCompare(String(latestUpdate(updatesFor(a)).created_at)));
  // Everyone who prayed for you, your requests or your family's this week.
  const ids = new Set(d.requests.filter((r) => r.for_member === me).flatMap((r) => prayersThisWeek(prayersOf(r)).map((p) => p.member_id)));
  if (d.weeklyReady) {
    whoPrayedFor(me).forEach((id) => ids.add(id));
    if (W.fam) d.requests.filter((r) => r.list === "lifegroup" && r.family_id === W.fam.id)
      .forEach((r) => prayersThisWeek(prayersOf(r)).forEach((p) => ids.add(p.member_id)));
  }
  ids.delete(me);
  const prayedForMe = [...ids];
  let html = `<div class="mecard">` + weekTop();
  if (updates.length) {
    html += `<div class="my-updates"><div class="sub">\u{1F4E3} ${updates.length === 1 ? "An update" : `${updates.length} updates`} on prayers you prayed for</div>
      ${rows(updates.slice(0, 3), "card", { showWho: true, compact: true })}
      ${updates.length > 3 ? `<span class="meta">${updates.length - 3} more in the prayer lists below.</span>` : ""}</div>`;
  }
  html += `<div class="prayed-for-me">${prayedForMe.length
    ? `\u{1F64F} ${esc(joinNames(prayedForMe.map(nameOf)))} prayed for you${W.fam && d.weeklyReady ? " and your family" : ""} this week.`
    : `<span class="meta">When someone prays for you or your requests this week, you’ll see it here.</span>`}</div>`;
  return html + whoAmI() + `</div>`;
}

// "Pray for another family (or brother) too", for this week only.
function extraForm(kind) {
  const W = D.week;
  const taken = kind === "family"
    ? new Set([W.fam?.id, W.partner?.id, ...W.extraFams.map((x) => x.family_id)])
    : new Set([myId(), W.brother?.id, ...W.extraMen.map((x) => x.for_member)]);
  const opts = kind === "family"
    ? state.data.families.filter((f) => !taken.has(f.id)).sort((a, b) => normalize(a.name).localeCompare(normalize(b.name))).map((f) => [f.id, f.name])
    : state.data.members.filter((m) => !taken.has(m.id)).map((m) => [m.id, m.display_name]);
  if (!opts.length) return "";
  const what = kind === "family" ? "family" : "brother";
  return `<details class="more addextra"><summary>+ Pray for another ${what} too</summary>
    <form class="form-plain" data-form="extra" data-kind="${kind}">
      <label class="field">${kind === "family" ? "Family" : "Brother"}<select name="pick" required><option value="">Pick one…</option>${opts.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join("")}</select></label>
      <p class="meta">Just for this week. Your list starts fresh on Sunday.</p>
      <div class="actions"><button class="btn small" type="submit">Add for this week</button></div>
    </form></details>`;
}

// Lifegroup tab: your family this week, at the top.
function lgWeekCard() {
  const W = D.week;
  if (!state.data.weeklyReady || !W.partner) return "";
  return `<div class="mecard">
    <div class="sec-head"><h2>Your family this week</h2><span class="eyebrow">changes each Sunday</span></div>
    ${famBlock(W.partner)}
    ${W.extraFams.map((x) => { const f = familyById(x.family_id); return famBlock(f, removeBtn(x, f.name)); }).join("")}
    ${extraForm("family")}
  </div>`;
}

// Brothers tab: your brother this week, at the top.
function broWeekCard() {
  const W = D.week;
  if (!state.data.weeklyReady || !W.partner) return "";
  const b = W.brother;
  let body;
  if (!b) body = `<p class="meta">Nobody from the ${esc(W.partner.name)} family has signed in yet, so there’s no brother this week.</p>`;
  else {
    const open = state.data.requests.filter((r) => r.list === "brothers" && r.for_member === b.id && isActive(r)).sort(newestFirst);
    const first = firstName(b.display_name);
    body = `<div class="famblock"><div class="famblock-head"><button class="linkish fam-name" type="button" data-man="m:${esc(b.id)}">${esc(b.display_name)}</button><span class="actions">${personPrayBtn(b)}</span></div>
      ${open.length ? rows(open, "bro", { compact: true }) : `<p class="meta">${esc(first)} hasn’t shared a prayer request yet. Pray for ${esc(first)} anyway, and ask how you can pray this week.</p>`}</div>`;
  }
  return `<div class="mecard">
    <div class="sec-head"><h2>Your brother this week</h2><span class="eyebrow">changes each Sunday</span></div>
    ${body}
    ${W.extraMen.map((x) => { const m = memberById(x.for_member); return brotherLine(m, "Also praying for", removeBtn(x, m.display_name)); }).join("")}
    ${extraForm("brother")}
  </div>`;
}

// On a brother's page: who's praying for him this week, and the buttons.
function personWeek(p) {
  if (!state.data.weeklyReady || !p.id) return "";
  const m = memberById(p.id);
  if (!m) return "";
  const self = m.id === myId();
  const first = firstName(m.display_name);
  const fam = m.family_id ? familyById(m.family_id) : null;
  const onList = !self && onMyList(m.id);
  const others = prayingFor(m).filter((x) => x.id !== myId() && x.id !== m.id).map((x) => x.display_name);
  const lines = [];
  if (fam) lines.push(`${self ? "Your" : esc(first) + "’s"} family: ${esc(fam.name)}`);
  if (onList) lines.push(`You’re praying for ${esc(first)} this week.`);
  if (others.length) lines.push(`${esc(joinNames(others))} ${others.length === 1 ? "is" : "are"} ${onList ? "too" : `praying for ${self ? "you" : esc(first)} this week`}.`);
  const who = whoPrayedFor(m.id).map(nameOf);
  lines.push(who.length ? `\u{1F64F} ${esc(joinNames(who))} prayed for ${self ? "you" : esc(first)} this week.` : `No one has prayed for ${self ? "you" : esc(first)} yet this week.`);
  const add = self ? ""
    : onList ? `<span class="meta">On your list this week ✓</span>`
    : `<button class="btn quiet small" type="button" data-act="extra-add-man" data-id="${esc(m.id)}">Pray for ${esc(first)} this week too</button>`;
  return `<div class="weekbox">${lines.map((l) => `<span class="meta">${l}</span>`).join("")}
    ${self ? "" : `<div class="actions">${personPrayBtn(m)}${add}</div>`}</div>`;
}


// Every answered prayer, newest first, by month. This week's are in the news above.
function rememberWall() {
  const answered = state.data.requests.filter((r) => !isActive(r) && r.answered_at)
    .sort((a, b) => String(b.answered_at).localeCompare(String(a.answered_at)));
  if (!answered.length) return "";
  const older = answered.filter((r) => Date.now() - new Date(r.answered_at) >= 7 * DAY);
  const shown = state.showAllAnswered ? older : older.slice(0, 5);
  let body = `<div class="remember-count"><span class="pulse-num">${answered.length}</span><span class="pulse-label">${answered.length === 1 ? "prayer" : "prayers"} answered since ${esc(longMonth(answered.at(-1).answered_at))}</span></div>`;
  if (!older.length) body += `<p class="meta">This week’s answers are under Updates above. Earlier answers collect here.</p>`;
  let month = "";
  for (const r of shown) {
    const m = longMonth(r.answered_at);
    if (m !== month) { body += `<div class="month">${esc(m)}</div>`; month = m; }
    body += storyRow(r, "God answered", r.answered_note, r.answered_at, "answer");
  }
  if (older.length > 5) body += `<div class="actions"><button class="btn quiet small" type="button" data-act="remember-toggle">${state.showAllAnswered ? "Show fewer" : `Show all ${older.length}`}</button></div>`;
  return drop("remember", "Remembering God’s faithfulness", esc(`${answered.length} answered`), body);
}

// ----- Pray now: a few prayers, one at a time -----

const PRAY_NOW_SIZE = 3;
function prayNowQueue(skip = []) {
  const wk = thisWeek(state.data.requests, labelOf);
  const extra = state.data.requests.filter((r) => isUpdated(r) && !wk.lifegroup.includes(r) && !wk.brothers.includes(r));
  // Like the app: news first, then your family and brother for the week,
  // then the others you added, then anything nobody has prayed for yet.
  const W = D.week;
  const xf = new Set(W.extraFams.map((x) => x.family_id)), xm = new Set(W.extraMen.map((x) => x.for_member));
  const rank = (r) => (isUpdated(r) ? 0
    : W.partner && r.family_id === W.partner.id ? 1
    : W.brother && r.for_member === W.brother.id ? 2
    : xf.has(r.family_id) || xm.has(r.for_member) ? 3
    : !weekCount(r) ? 4 : 5);
  return wk.lifegroup.concat(wk.brothers, extra)
    .filter((r) => !isMine(r) && !skip.includes(r.id))
    .sort((a, b) => rank(a) - rank(b))
    .map((r) => r.id);
}
function startPrayNow(prev) {
  const skipped = prev ? prev.skipped : [];
  const ids = prayNowQueue(skipped).slice(0, PRAY_NOW_SIZE);
  state.prayNow = { ids, i: 0, prayed: prev ? prev.prayed : 0, skipped, verse: nextVerse(), opener: prev ? prev.opener : document.activeElement };
}
function closePrayNow() {
  const opener = state.prayNow && state.prayNow.opener;
  state.prayNow = null;
  render();
  const back = opener && opener.dataset && app.querySelector(`[data-act="${opener.dataset.act}"]`);
  if (back) back.focus();
}

function prayNowView() {
  const pn = state.prayNow;
  if (!pn) return "";
  const close = `<button class="btn quiet small pn-close" type="button" data-act="pn-close">Close</button>`;
  let inner;
  if (pn.i >= pn.ids.length) {
    const more = prayNowQueue(pn.skipped).length;
    inner = `<div class="pn-done">${pn.prayed
      ? `<span class="pn-big" aria-hidden="true">\u{1F64F}</span><h2 id="pn-title">You prayed for ${plural(pn.prayed, "request")}.</h2><p class="pn-verse">${esc(pn.verse)}</p>`
      : pn.ids.length ? `<h2 id="pn-title">All done for now.</h2>`
      : `<span class="pn-big" aria-hidden="true">\u{1F64C}</span><h2 id="pn-title">You’ve prayed for every request this week.</h2><p>Thank you.</p>`}
      <div class="pn-actions center"><button class="btn primary" type="button" data-act="pn-close" data-autofocus>Done</button>${more ? `<button class="btn" type="button" data-act="pn-more">Pray for ${Math.min(PRAY_NOW_SIZE, more)} more</button>` : ""}</div></div>`;
  } else {
    const r = state.data.requests.find((x) => x.id === pn.ids[pn.i]);
    const u = r && latestUpdate(updatesFor(r));
    inner = !r ? `<h2 class="pn-who" id="pn-title">This prayer was removed.</h2><div class="pn-actions"><button class="btn primary" type="button" data-act="pn-skip" data-autofocus>Next</button></div>`
      : `<div class="pn-step">${pn.i + 1} of ${pn.ids.length}</div>
      <h2 class="pn-who" id="pn-title">${esc(labelOf(r))}${isUpdated(r) ? ` <span class="pill steel">Updated</span>` : ""}</h2>
      <div class="pn-text">${esc(r.body)}</div>
      ${u ? `<div class="callout update"><span class="sub">Latest update · ${esc(ago(u.created_at))}</span><span class="said">${esc(u.body)}</span></div>` : ""}
      <div class="pn-actions"><button class="btn primary" type="button" data-act="pn-pray" data-autofocus>\u{1F64F} I prayed</button><button class="btn quiet" type="button" data-act="pn-skip">Skip</button></div>`;
  }
  return `<div class="praynow" role="dialog" aria-modal="true" aria-labelledby="pn-title"><div class="pn-card">${close}${inner}</div></div>`;
}

// ----- search and pick (Lifegroup and Brothers) -----

function searchBox(which) {
  return `<input type="search" class="search" data-search="${which}" value="${esc(state.search[which])}" placeholder="Search prayers, like job or surgery" aria-label="Search prayers" autocomplete="off" enterkeyhint="search">`;
}

function searchResults(which) {
  const hits = state.data.requests.filter((r) => r.list === which && matchesSearch(r, state.search[which], labelOf, updatesFor))
    .sort((a, b) => (isActive(b) - isActive(a)) || entryDay(b).localeCompare(entryDay(a)));
  const open = hits.filter(isActive);
  for (const id of [...state.picked]) if (!open.some((r) => r.id === id)) state.picked.delete(id);
  const n = state.picked.size;
  if (!hits.length) return `<div class="empty">No prayers match “${esc(state.search[which].trim())}”.</div>`;
  return `<div class="search-results">
    <div class="toolbar"><span class="meta">${hits.length} ${hits.length === 1 ? "prayer matches" : "prayers match"} · ${open.length} open</span>
      ${open.length ? `<button class="btn quiet small" type="button" data-act="pick-all" data-list="${which}">${n === open.length ? "Clear selection" : "Select all open"}</button>` : ""}</div>
    ${n ? `<form class="bulk" data-form="bulk">
      <span class="sub">${n} selected</span>
      <input type="text" name="note" value="${esc(state.bulkNote)}" data-bulknote placeholder="How did God answer?" aria-label="How God answered" maxlength="2000">
      <div class="actions"><button class="btn primary small" type="submit">Mark ${n} answered</button><button class="btn quiet small" type="button" data-act="pick-clear">Clear</button></div>
    </form>` : ""}
    <div>${hits.map((r) => {
      const done = !isActive(r);
      return `<label class="pick ${done ? "done" : ""}">
        <input type="checkbox" data-pick="${esc(r.id)}" ${state.picked.has(r.id) ? "checked" : ""} ${done ? "disabled" : ""} aria-label="Select: ${esc(labelOf(r))}">
        <span class="row-main"><span class="who">${esc(labelOf(r))}</span><span class="text">${esc(r.body)}</span>
          <span class="meta">${esc(r.sheet_date ? "From " + friendlyDay(r.sheet_date) + " sheet" : "Added " + shortDay(r.created_at))}${done ? ` · <span class="pill moss">Answered</span>` : ""}</span></span>
      </label>`;
    }).join("")}</div>
  </div>`;
}

function chip(attr, value, selected, label, flag) {
  return `<button class="chip" type="button" ${attr}="${esc(value)}" aria-pressed="${selected}">${flag ? `<span class="dot-flag" title="Needs prayer"></span><span class="sr">Needs prayer: </span>` : ""}${esc(label)}</button>`;
}

// Every answered prayer for one list, all together, newest answer first, by month.
function answeredList(rs, which) {
  if (!rs.length) return `<div class="empty">No answered prayers yet. When God answers one, tap <b>God answered</b> on it and it will be remembered here.</div>`;
  const owners = new Set(rs.map(ownerKey)).size;
  const ownerWord = which === "brothers" ? (owners === 1 ? "brother" : "brothers") : owners === 1 ? "family" : "families";
  let html = `<div class="group"><div class="group-head"><h3>Answered prayers</h3><span class="meta">${plural(rs.length, "prayer")} · ${owners} ${ownerWord} · since ${esc(longMonth(rs.at(-1).answered_at))}</span></div>`;
  let month = "";
  for (const r of rs) {
    const m = longMonth(r.answered_at);
    if (m !== month) { html += `<div class="month">${esc(m)}</div>`; month = m; }
    const go = which === "lifegroup" ? `data-family="${esc(r.family_id)}"` : `data-man="${esc(manKey(r))}"`;
    html += `<div class="story">
      <span class="who"><button class="linkish" type="button" ${go}>${esc(labelOf(r))}</button> <span class="meta">· ${esc(r.sheet_date ? friendlyDay(r.sheet_date) + " sheet" : "added " + shortDay(r.created_at))}</span></span>
      <span class="asked">${esc(r.body)}</span>
      <div class="callout answer"><span class="sub">God answered · ${esc(shortDay(r.answered_at))}</span>${r.answered_note ? `<span class="said">${esc(r.answered_note)}</span>` : ""}</div>
    </div>`;
  }
  return html + `</div>`;
}

const byAnswered = (a, b) => String(b.answered_at || "").localeCompare(String(a.answered_at || ""));
const newestFirst = (a, b) => (isActive(b) - isActive(a)) || entryDay(b).localeCompare(entryDay(a)) || String(b.created_at).localeCompare(String(a.created_at));
const countsLine = (rs) => {
  const answered = rs.filter((r) => !isActive(r)).length;
  return rs.length ? `${plural(rs.length, "prayer request")}${answered ? ` · ${answered} answered` : ""}` : "No requests yet";
};

// ----- Lifegroup -----

// A family's prayers by sheet date, with tabs: Latest, each month, All dates.
function famBody(key, rs) {
  const days = [...new Set(rs.map(entryDay))].sort().reverse();
  const months = [...new Set(days.map((d) => d.slice(0, 7)))];
  const valid = ["latest", "all"].concat(months.length > 1 ? months : []);
  const sel = valid.includes(state.famDate[key]) ? state.famDate[key] : "latest";
  const done = (pred) => { const xs = rs.filter(pred); return xs.length && xs.every((r) => !isActive(r)); };
  const tab = (v, label, allAnswered) => `<button class="chip small-chip" type="button" data-famdate="${esc(key)}|${esc(v)}" aria-pressed="${sel === v}">${esc(label)}${allAnswered ? " ✓" : ""}</button>`;
  const tabsHtml = days.length > 1 ? `<div class="chips date-tabs" role="group" aria-label="Sheet dates">${
    tab("latest", "Latest", done((r) => entryDay(r) === days[0]))
    + (months.length > 1 ? months.map((m) => tab(m, monthLabel(m), done((r) => entryDay(r).startsWith(m)))).join("") : "")
    + tab("all", "All dates", false)}</div>` : "";
  const shown = sel === "latest" ? days.slice(0, 1) : sel === "all" ? days : days.filter((d) => d.startsWith(sel));
  const body = shown.map((d) => {
    const dayRs = rs.filter((r) => entryDay(r) === d).sort(newestFirst);
    const isSheet = dayRs.some((r) => r.sheet_date === d);
    return `<div class="date-group"><div class="sub">${esc(isSheet ? friendlyDay(d) + " sheet" : "Added " + friendlyDay(d))}</div>${rows(dayRs, "lifegroup")}</div>`;
  }).join("");
  return `<div class="fam-body">${tabsHtml}${body}</div>`;
}

function viewLifegroup() {
  const lg = state.data.requests.filter((r) => r.list === "lifegroup");
  const fams = state.data.families.filter((f) => lg.some((r) => r.family_id === f.id))
    .sort((a, b) => normalize(a.name).localeCompare(normalize(b.name)));
  if (!["all", "answered"].includes(state.family) && !fams.some((f) => f.id === state.family)) state.family = "all";
  const answered = lg.filter((r) => !isActive(r)).sort(byAnswered);
  const famFlag = (id) => lg.some((r) => r.family_id === id && needsPrayer(r, prayersOf(r), D.latest));
  const famRequests = (id) => lg.filter((r) => r.family_id === id).sort(newestFirst);
  const searching = !!state.search.lifegroup.trim();
  const allOpen = fams.length && fams.every((f) => state.open.has("lifegroup:" + f.id));

  let list;
  if (searching) list = searchResults("lifegroup");
  else if (!fams.length) list = `<div class="empty">No family requests yet. Add this week's prayer sheet above.</div>`;
  else if (state.family === "answered") list = answeredList(answered, "lifegroup");
  else if (state.family !== "all") {
    const f = fams.find((x) => x.id === state.family);
    const rs = famRequests(f.id);
    list = `<div class="group"><div class="group-head"><h3>${esc(f.name)}</h3><span class="meta">${esc(countsLine(rs))}</span></div>${famBody(f.id, rs)}</div>`;
  } else {
    list = `<div class="fams">${fams.map((f) => {
      const rs = famRequests(f.id);
      const days = [...new Set(rs.map(entryDay))].sort().reverse();
      const sub = [countsLine(rs), days.length ? "latest " + friendlyDay(days[0]) : ""].filter(Boolean).join(" · ");
      const key = "lifegroup:" + f.id;
      const busy = rs.some((r) => r.id === state.confirm || (state.form && state.form.id === r.id && state.form.ctx === "lifegroup"));
      return `<details class="person" data-group="${esc(key)}"${state.open.has(key) || busy ? " open" : ""}>
        <summary><span class="fam-text"><span class="fam-name">${esc(f.name)}</span><span class="meta">${esc(sub)}</span></span>
          <span class="fam-side">${famFlag(f.id) ? `<span class="pill ember">Needs prayer</span>` : ""}</span></summary>
        ${famBody(f.id, rs)}
      </details>`;
    }).join("")}</div>`;
  }

  return `<details class="more"${lg.length ? "" : " open"}>
      <summary>Add a family request</summary>
      <form class="form" data-form="add-lifegroup" autocomplete="off">
        <label class="field">Family<input type="text" name="family" list="familyNames" required maxlength="80" placeholder="Smith" autocapitalize="words"></label>
        <label class="field">Request<textarea name="body" required maxlength="2000" placeholder="What should we pray for?"></textarea></label>
        <label class="field">Prayer sheet date<input type="date" name="sheet_date" value="${ymd(lastSunday())}"></label>
        <div class="actions"><button class="btn primary" type="submit">Add request</button></div>
      </form>
    </details>
    <datalist id="familyNames">${state.data.families.map((f) => `<option value="${esc(f.name)}"></option>`).join("")}</datalist>
    ${!searching && state.family === "all" ? lgWeekCard() : ""}
    <div class="sec">
      <div class="toolbar">
        <h2 class="sr">Families</h2>
        <span class="meta">${fams.length ? esc(`${plural(fams.length, "family", "families")} · ${plural(lg.length, "prayer request")} · ${answered.length} answered`) : ""}</span>
        ${!searching && state.family === "all" && fams.length > 1 ? `<button class="btn quiet small" type="button" data-act="expand" data-list="lifegroup">${allOpen ? "Close all" : "Open all"}</button>` : ""}
      </div>
      ${searchBox("lifegroup")}
      ${!searching && fams.length ? `<div class="chips" role="group" aria-label="Families">${[
        chip("data-family", "all", state.family === "all", "All families"),
        chip("data-family", "answered", state.family === "answered", `✓ Answered${answered.length ? ` (${answered.length})` : ""}`),
        ...fams.map((f) => chip("data-family", f.id, state.family === f.id, f.name, famFlag(f.id))),
      ].join("")}</div>` : ""}
      ${list}
    </div>`;
}

// ----- Brothers -----

const manKey = (r) => (r.for_member ? "m:" + r.for_member : "n:" + normalize(r.for_name));

// Everyone in the group, plus anyone a request was added for by name.
function people() {
  const map = new Map();
  for (const m of state.data.members) map.set("m:" + m.id, { key: "m:" + m.id, id: m.id, name: m.display_name, family_id: m.family_id || null });
  for (const r of state.data.requests) {
    if (r.list !== "brothers") continue;
    const k = manKey(r);
    if (!map.has(k)) map.set(k, { key: k, id: r.for_member || null, name: labelOf(r) });
  }
  return [...map.values()].sort((a, b) => normalize(a.name).localeCompare(normalize(b.name)));
}

function personBody(p, rs) {
  const active = rs.filter(isActive).sort(newestFirst);
  const answered = rs.filter((r) => !isActive(r)).sort(byAnswered);
  const adding = state.form && state.form.kind === "add" && state.form.id === p.key;
  const self = p.id === myId();
  return `<div class="fam-body">
    ${personWeek(p)}
    ${active.length ? rows(active, "brothers") : adding ? "" : `<p class="meta">${self ? "You haven’t shared a prayer request yet." : `No open prayer requests. Pray for ${esc(firstName(p.name))} anyway, and ask how you can pray.`}</p>`}
    ${adding ? `<form class="inline" data-form="add-person" data-key="${esc(p.key)}">
      <label class="field">Request for ${esc(p.name)}<textarea name="body" required maxlength="2000" placeholder="What should we pray for?"></textarea></label>
      <div class="actions"><button class="btn primary small" type="submit">Add request</button><button class="btn quiet small" type="button" data-act="close">Cancel</button></div>
    </form>` : `<div class="actions"><button class="btn small" type="button" data-act="add-open" data-key="${esc(p.key)}">Add a request</button></div>`}
    ${answered.length ? `<div class="sub">Answered</div>${rows(answered, "brothers")}` : ""}
  </div>`;
}

// Under a brother's name: his family, who's praying for him, his requests.
function personSub(p, rs) {
  const parts = [];
  if (state.data.weeklyReady && p.id) {
    const fam = p.family_id ? familyById(p.family_id) : null;
    if (fam) parts.push(fam.name + " family");
    const others = prayingFor(p).filter((x) => x.id !== myId() && x.id !== p.id);
    if (p.id !== myId() && onMyList(p.id)) parts.push("on your list this week ✓");
    else if (others.length) parts.push(`${joinNames(others.map((x) => firstName(x.display_name)))} ${others.length === 1 ? "is" : "are"} praying this week`);
  }
  parts.push(countsLine(rs));
  return parts.join(" · ");
}

function viewBrothers() {
  const reqs = state.data.requests.filter((r) => r.list === "brothers");
  const ps = people();
  if (!["all", "answered"].includes(state.man) && !ps.some((p) => p.key === state.man)) state.man = "all";
  const answered = reqs.filter((r) => !isActive(r)).sort(byAnswered);
  const rsFor = (p) => reqs.filter((r) => manKey(r) === p.key);
  const needs = (p) => rsFor(p).some((r) => needsPrayer(r, prayersOf(r), D.latest));
  const searching = !!state.search.brothers.trim();
  const allOpen = ps.length && ps.every((p) => state.open.has("brothers:" + p.key));

  let list;
  if (searching) list = searchResults("brothers");
  else if (!ps.length) list = `<div class="empty">No one here yet. Brothers show up once they're invited and sign in.</div>`;
  else if (state.man === "answered") list = answeredList(answered, "brothers");
  else if (state.man !== "all") {
    const p = ps.find((x) => x.key === state.man);
    const rs = rsFor(p);
    list = `<div class="group"><div class="group-head"><h3>${esc(p.name)}${p.id === myId() ? ` <span class="pill steel">You</span>` : ""}</h3><span class="meta">${esc(countsLine(rs))}</span></div>${personBody(p, rs)}</div>`;
  } else {
    list = `<div class="fams">${ps.map((p) => {
      const rs = rsFor(p);
      const key = "brothers:" + p.key;
      const busy = (state.form && state.form.id === p.key) || rs.some((r) => r.id === state.confirm || (state.form && state.form.id === r.id && state.form.ctx === "brothers"));
      const who = p.id && state.data.weeklyReady ? whoPrayedFor(p.id)
        : [...new Set(rs.flatMap((r) => prayersThisWeek(prayersOf(r)).map((x) => x.member_id)))];
      return `<details class="person" data-group="${esc(key)}"${state.open.has(key) || busy ? " open" : ""}>
        <summary><span class="fam-text"><span class="fam-name">${esc(p.name)}${p.id === myId() ? ` <span class="pill steel">You</span>` : ""}</span><span class="meta">${esc(personSub(p, rs))}</span></span>
          <span class="fam-side">${who.length ? `<span class="pray-count" title="People who prayed for ${esc(firstName(p.name))} this week">\u{1F64F} ${who.length}</span>` : ""}${needs(p) ? `<span class="pill ember">Needs prayer</span>` : ""}</span></summary>
        ${personBody(p, rs)}
      </details>`;
    }).join("")}</div>`;
  }

  const options = state.data.members.map((m) => `<option value="${esc(m.id)}"${m.id === myId() ? " selected" : ""}>${esc(m.display_name)}${m.id === myId() ? " (me)" : ""}</option>`).join("");
  return `<details class="more">
      <summary>Add a request</summary>
      <form class="form" data-form="add-brothers" autocomplete="off">
        <label class="field">For<select name="for">${options}<option value="">Someone else…</option></select></label>
        <label class="field other-name" hidden>Name<input type="text" name="for_name" maxlength="80" placeholder="His name" autocapitalize="words"></label>
        <label class="field">Request<textarea name="body" required maxlength="2000" placeholder="What should we pray for?"></textarea></label>
        <div class="actions"><button class="btn primary" type="submit">Add request</button></div>
      </form>
    </details>
    ${!searching && state.man === "all" ? broWeekCard() : ""}
    <div class="sec">
      <div class="toolbar">
        <h2 class="sr">Brothers</h2>
        <span class="meta">${ps.length ? esc(`${plural(ps.length, "brother")} · ${plural(reqs.length, "prayer request")} · ${answered.length} answered`) : ""}</span>
        ${!searching && state.man === "all" && ps.length > 1 ? `<button class="btn quiet small" type="button" data-act="expand" data-list="brothers">${allOpen ? "Close all" : "Open all"}</button>` : ""}
      </div>
      ${searchBox("brothers")}
      ${!searching && ps.length ? `<div class="chips" role="group" aria-label="Brothers">${[
        chip("data-man", "all", state.man === "all", "Everyone"),
        chip("data-man", "answered", state.man === "answered", `✓ Answered${answered.length ? ` (${answered.length})` : ""}`),
        ...ps.map((p) => chip("data-man", p.key, state.man === p.key, p.name, needs(p))),
      ].join("")}</div>` : ""}
      ${list}
    </div>`;
}

// ----- Calendar -----

// The next two weeks, on This week.
function comingUp() {
  if (!state.data.calendarReady) return "";
  const soon = upcomingEvents(state.data.events, 14);
  return `<div class="sec">
      <div class="sec-head"><h2>Coming up</h2><span class="eyebrow">next 14 days</span></div>
      ${soon.length ? `<div>${soon.map(eventRow).join("")}</div>` : `<div class="empty">Nothing on the calendar for the next two weeks.</div>`}
    </div>`;
}

function eventRow(e) {
  const church = e.source === "church";
  const sheet = e.source === "sheet"; // Bible studies and hangouts from the lifegroup Google Sheet
  const open = state.openEvent === e.id;
  const key = "ev:" + e.id;
  const d = dateBlock(e.starts_on);
  const mayRemove = church ? state.admin : !sheet && (state.admin || e.created_by === myId());
  const removeBtns = e.hidden
    ? (state.admin ? `<button class="btn small" type="button" data-act="ev-unhide" data-id="${esc(e.id)}">Unhide</button>` : "")
    : !mayRemove ? ""
    : state.confirm === key
      ? `<span class="meta">${church ? "Hide this for everyone?" : "Delete this event for everyone?"}</span><button class="btn danger small" type="button" data-act="${church ? "ev-hide" : "ev-del"}" data-id="${esc(e.id)}">${church ? "Hide" : "Delete"}</button><button class="btn quiet small" type="button" data-act="close">Keep</button>`
      : `<button class="btn quiet small" type="button" data-act="confirm" data-id="${esc(key)}">${church ? "Hide" : "Delete"}</button>`;
  const pill = church ? ` <span class="pill steel">Church</span>` : sheet ? ` <span class="pill moss">Lifegroup</span>` : "";
  const addLink = `<a class="btn quiet small" href="${esc(calendarLink(e))}" target="_blank" rel="noopener">Add to my calendar</a>`;
  const url = safeUrl(e.url);
  const details = sheet && open ? `<div class="ev-details" id="evd-${esc(e.id)}">
      ${e.address ? `<div><span class="sub">Address</span><div class="addr">${esc(e.address)}</div></div>`
        : e.kind === "open" ? `<span class="meta">No host yet. Sign up in the Google Sheet to host this week.</span>` : `<span class="meta">No address listed in the sheet.</span>`}
      ${e.notes ? `<div class="meta">${esc(e.notes)}</div>` : ""}
      <div class="actions">
        ${e.address ? `<a class="btn small" href="${esc(mapsLink(e.address))}" target="_blank" rel="noopener">Open in Maps</a>` : ""}
        ${addLink}
      </div>
      <span class="meta">From the lifegroup Google Sheet. To change it, edit the sheet.</span>
    </div>` : "";
  return `<div class="ev${church ? " church" : ""}${sheet ? " sheet" : ""}">
    <div class="ev-date" aria-hidden="true"><span class="dow">${esc(d.dow)}</span><span class="d">${esc(d.day)}</span></div>
    <div class="ev-body">
      <span class="ev-title">${esc(e.title)}${pill}</span>
      <span class="meta">${[dateRange(e), e.time_text, e.location].filter(Boolean).map(esc).join(" · ")}</span>
      ${e.notes && !sheet ? `<span class="meta ev-notes">${esc(e.notes)}</span>` : ""}
      ${sheet
        ? `<div class="actions"><button class="btn quiet small" type="button" data-act="ev-details" data-id="${esc(e.id)}" aria-expanded="${open}"${open ? ` aria-controls="evd-${esc(e.id)}"` : ""}>${open ? "Hide details" : "Details"}</button></div>${details}`
        : `<div class="actions">${addLink}${url ? `<a class="btn quiet small" href="${esc(url)}" target="_blank" rel="noopener">Details</a>` : ""}${removeBtns}</div>`}
    </div>
  </div>`;
}

function viewCalendar() {
  if (!state.data.calendarReady) {
    return `<div class="card"><h2>The calendar is almost ready</h2>
      <p class="lede">${state.admin ? "It needs its one-time database step. The steps are in the README, step 6." : "The group leader still has one setup step to do. Check back soon."}</p></div>`;
  }
  if (state.when === "hidden" && !state.admin) state.when = "upcoming";
  const evs = eventsFor(state.data.events, state.when);
  const hiddenCount = state.data.events.filter((e) => e.hidden).length;
  const seg = [["upcoming", "Upcoming"], ["past", "Past"], ...(state.admin ? [["hidden", hiddenCount ? `Hidden (${hiddenCount})` : "Hidden"]] : [])];
  let list = "", month = "";
  for (const e of evs) {
    const m = eventMonth(e.starts_on);
    if (m !== month) { list += `<h3 class="month">${esc(m)}</h3>`; month = m; }
    list += eventRow(e);
  }
  const draft = state.eventDraft || {};
  return `<details class="more"${state.eventDraft ? " open" : ""}>
      <summary>Add a group event</summary>
      <form class="form" data-form="event" autocomplete="off">
        <label class="field">What<input type="text" name="title" required maxlength="200" value="${esc(draft.title)}" placeholder="Saturday breakfast, workday at Mike's…"></label>
        <div class="form-row">
          <label class="field">Date<input type="date" name="starts_on" required value="${esc(draft.starts_on)}"></label>
          <label class="field">Time<input type="text" name="time_text" maxlength="40" value="${esc(draft.time_text)}" placeholder="7:00 AM"></label>
        </div>
        <label class="field">Where<input type="text" name="location" maxlength="200" value="${esc(draft.location)}" placeholder="Optional"></label>
        <div class="actions"><button class="btn primary" type="submit">Add event</button></div>
      </form>
    </details>
    <div class="sec">
      <div class="toolbar">
        <h2 class="sr">Events</h2>
        <div class="seg" role="group" aria-label="Show">${seg.map(([k, label]) => `<button type="button" data-act="when" data-when="${k}" data-id="${k}" aria-pressed="${state.when === k}">${esc(label)}</button>`).join("")}</div>
        <span class="meta legend"><span class="pill moss">Lifegroup</span> from the group's sheet · <span class="pill steel">Church</span> from the church calendar</span>
      </div>
      ${evs.length ? `<div>${list}</div>` : `<div class="empty">${state.when === "upcoming" ? "No upcoming events. Add a group event above."
        : state.when === "hidden" ? "No hidden events. Church events you hide show up here, so you can bring them back." : "No past events."}</div>`}
    </div>`;
}

// ----- Invites (admins only) -----

function viewGroup() {
  return `<div class="form">
      <div class="sec-head"><h2>Invite someone</h2></div>
      <p class="lede">Only people on this list can sign in. Removing someone takes their access away straight away.</p>
      <form class="form-plain" data-form="invite" autocomplete="off">
        <div class="form-row">
          <label class="field">Name<input type="text" name="name" required maxlength="80" placeholder="First and last name" autocapitalize="words"></label>
          <label class="field">Email<input type="email" name="email" required placeholder="name@example.com" inputmode="email"></label>
        </div>
        <div class="actions"><button class="btn primary" type="submit">Add to invite list</button></div>
      </form>
    </div>
    <div class="list">${state.invites.map((i) => `<div class="row"><div class="row-top">
      <div class="row-main"><span class="who">${esc(i.name)}${i.role === "admin" ? ` <span class="pill steel">Admin</span>` : ""}</span><span class="meta">${esc(i.email)}</span></div>
      ${state.confirm === "invite:" + i.email
        ? `<span class="actions"><button class="btn danger small" type="button" data-act="uninvite" data-email="${esc(i.email)}">Remove</button><button class="btn quiet small" type="button" data-act="close">Keep</button></span>`
        : i.role === "admin" ? "" : `<button class="btn quiet small" type="button" data-act="confirm-invite" data-email="${esc(i.email)}">Remove</button>`}
    </div></div>`).join("")}</div>`;
}

function lastSunday() {
  const d = new Date();
  d.setDate(d.getDate() - d.getDay());
  return d;
}

// ---------- events ----------

// After "I prayed": a verse, or a thank-you when that covers every request this week.
function prayedMessage(id) {
  const wk = thisWeek(state.data.requests, labelOf);
  const all = wk.lifegroup.concat(wk.brothers);
  const coveredNow = all.length && all.some((x) => x.id === id) && all.every((x) => x.id === id || weekCount(x) > 0);
  return coveredNow ? "\u{1F64C} That covers every request this week. Thank you for praying!" : "\u{1F64F} " + nextVerse();
}

// The page redraws after each change, so put focus back where it was.
function refocus(act, id) {
  if (document.activeElement && document.activeElement !== document.body && document.activeElement.isConnected) return;
  const sel = id ? `[data-act="${act}"][data-id="${CSS.escape(id)}"]` : `[data-act="${act}"]`;
  (app.querySelector(sel) || app.querySelector('.tab[aria-selected="true"]'))?.focus();
}

app.addEventListener("click", async (e) => {
  const fd = e.target.closest("[data-famdate]");
  if (fd) { const [k, d] = fd.dataset.famdate.split("|"); state.famDate[k] = d; render(); return; }
  const fam = e.target.closest("[data-family]");
  if (fam) { state.family = fam.dataset.family; state.tab = "lifegroup"; state.form = null; render(); return; }
  const man = e.target.closest("[data-man]");
  if (man) { state.man = man.dataset.man; state.tab = "brothers"; state.form = null; render(); return; }

  const b = e.target.closest("[data-act]");
  if (!b || b.tagName === "INPUT") return;
  const id = b.dataset.id;
  const what = b.dataset.act;
  try { await handleClick(b, id, what); } finally {
    if (!what.startsWith("pn-") && !["tab", "sign-out", "open-update", "open-answer", "add-open"].includes(what)) refocus(what, id);
  }
});

async function handleClick(b, id, what) {
  switch (what) {
    case "tab": state.tab = b.dataset.tab; state.form = null; state.confirm = null; state.picked.clear(); render(); window.scrollTo(0, 0);
      if (state.tab === "group") app.querySelector("#panel-group")?.focus({ preventScroll: true });
      break;
    case "sign-out": await supabase.auth.signOut(); break;
    case "retry": await refresh(); break;
    case "open-update": state.form = { kind: "update", id, ctx: b.dataset.ctx }; state.confirm = null; render(); focusForm(); break;
    case "open-answer": state.form = { kind: "answer", id, ctx: b.dataset.ctx }; state.confirm = null; render(); focusForm(); break;
    case "add-open": state.form = { kind: "add", id: b.dataset.key }; state.confirm = null; render(); focusForm(); break;
    case "close": state.form = null; state.confirm = null; render(); break;
    case "confirm": state.confirm = id; state.form = null; render(); break;
    case "confirm-invite": state.confirm = "invite:" + b.dataset.email; render(); break;
    case "delete": state.confirm = null; await act(() => api.deleteRequest(id), "Request deleted."); break;
    case "reopen": await act(() => api.reopen(id), "Moved back to praying."); break;
    case "uninvite": state.confirm = null; await act(() => api.removeInvite(b.dataset.email), "Removed from the invite list."); break;
    case "expand": {
      const keys = b.dataset.list === "lifegroup"
        ? state.data.families.map((f) => "lifegroup:" + f.id)
        : people().map((p) => "brothers:" + p.key);
      const allOpen = keys.every((k) => state.open.has(k));
      keys.forEach((k) => (allOpen ? state.open.delete(k) : state.open.add(k)));
      render();
      break;
    }
    case "remember-toggle": state.showAllAnswered = !state.showAllAnswered; render(); break;
    case "when": state.when = b.dataset.when; state.confirm = null; render(); break;
    case "ev-details": state.openEvent = state.openEvent === id ? null : id; render(); break;
    case "ev-del": state.confirm = null; await act(() => api.deleteEvent(id), "Event deleted."); break;
    case "ev-hide": state.confirm = null; await act(() => api.setEventHidden(id, true), "Hidden. Find it under Hidden to bring it back."); break;
    case "ev-unhide": await act(() => api.setEventHidden(id, false), "Back on the group calendar."); break;
    case "pick-all": {
      const open = state.data.requests.filter((r) => r.list === b.dataset.list && isActive(r) && matchesSearch(r, state.search[b.dataset.list], labelOf, updatesFor));
      state.picked = state.picked.size === open.length ? new Set() : new Set(open.map((r) => r.id));
      render();
      break;
    }
    case "pick-clear": state.picked.clear(); render(); break;
    case "pn-open": startPrayNow(null); render(); break;
    case "pn-more": startPrayNow(state.prayNow); render(); break;
    case "pn-close": closePrayNow(); break;
    case "pn-skip": if (state.prayNow) { state.prayNow.skipped.push(state.prayNow.ids[state.prayNow.i]); state.prayNow.i++; render(); } break;
    case "pn-pray": {
      const pn = state.prayNow;
      if (!pn || b.disabled) break;
      b.disabled = true;
      const rid = pn.ids[pn.i];
      const ok = await act(() => api.markPrayed(rid));
      if (ok) pn.prayed++;
      if (state.prayNow === pn) {
        if (ok) pn.i++;
        render();
        if (!ok) app.querySelector('.pn-card [data-act="pn-pray"]')?.focus();
      }
      break;
    }
    case "prayed": {
      if (b.disabled) break;
      b.disabled = true;
      try {
        const r = state.data.requests.find((x) => x.id === id);
        if (r && isMine(r)) {
          await act(() => api.undoPrayed(undoIds(prayersOf(r), updatesFor(r), myId())), "Removed your prayer for this week.");
        } else {
          await act(() => api.markPrayed(id), prayedMessage(id), 5000);
        }
      } finally {
        if (b.isConnected) b.disabled = false;
      }
      break;
    }
    case "change-family": state.picking = true; state.tab = "week"; render(); window.scrollTo(0, 0); app.querySelector('[data-form="my-family"] select')?.focus(); break;
    case "pick-cancel": state.picking = false; render(); break;
    case "pray-person": {
      if (b.disabled) break;
      b.disabled = true;
      try {
        const m = memberById(id);
        if (!m) break;
        const first = firstName(m.display_name);
        if (iPrayedFor(id)) {
          const undo = personUndoIds(id, myId(), state.data.personPrayers);
          if (undo.length) await act(() => api.undoPersonPrayers(undo), `Removed your prayer for ${first} this week.`);
          else toast(`You prayed for ${first}’s requests this week. To undo, tap Prayed this week on each one.`, 5000);
        } else {
          await act(() => api.prayForPerson(id), "\u{1F64F} " + nextVerse(), 5000);
        }
      } finally {
        if (b.isConnected) b.disabled = false;
      }
      break;
    }
    case "extra-add-man": await act(() => api.addExtra({ week_of: weekOf(), for_member: id }), "Added to your list for this week."); break;
    case "extra-remove": await act(() => api.removeExtra(id), "Taken off your list."); break;
    case "resend": b.disabled = true; await sendCode(state.sent); if (b.isConnected) b.disabled = false; break;
    case "other-email": state.sent = null; render(); break;
  }
}

// Remember which groups and This week sections are open.
app.addEventListener("toggle", (e) => {
  const d = e.target;
  const key = d.dataset && d.dataset.group;
  if (key) { if (d.open) state.open.add(key); else state.open.delete(key); return; }
  const dk = d.dataset && d.dataset.drop;
  if (!dk) return;
  if (d.open) state.drops.add(dk); else state.drops.delete(dk);
  stored.set("drops-open", [...state.drops]);
  if (dk === "news" && d.open) {
    if (state.newsBaseline === undefined) state.newsBaseline = stored.get("news-seen", null);
    stored.set("news-seen", new Date().toISOString());
    // Clear the "new" count on the section's heading without moving anything.
    const pill = d.querySelector("summary .pill");
    if (pill) pill.remove();
  }
}, true);

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && state.prayNow) { closePrayNow(); return; }
  // Keep keyboard focus inside the Pray now card.
  if (e.key === "Tab" && state.prayNow) {
    const items = [...app.querySelectorAll(".pn-card button")];
    if (!items.length) return;
    const first = items[0], last = items.at(-1);
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    else if (!app.querySelector(".pn-card").contains(document.activeElement)) { e.preventDefault(); first.focus(); }
  }
});

function focusForm() {
  const t = app.querySelector("form.inline textarea");
  if (t) t.focus();
}

app.addEventListener("change", (e) => {
  const t = e.target;
  if (t.matches('select[name="for"]')) {
    const other = t.form.querySelector(".other-name");
    other.hidden = t.value !== "";
    other.querySelector("input").required = t.value === "";
  }
  if (t.matches('[data-form="my-family"] select[name="family"]')) {
    const box = t.form.querySelector(".new-family");
    box.hidden = t.value !== "new";
    box.querySelector("input").required = t.value === "new";
  }
  if (t.matches('input[name="kind"]')) {
    const f = t.form;
    f.querySelector(".new-opts").hidden = t.value !== "new";
    f.querySelector("textarea").placeholder = t.value === "new" ? "Got the job! Now pray for the move to Dallas."
      : t.value === "answered" ? "Got the job, or didn't, and He gave peace about what's next." : "Surgery went well, still recovering…";
  }
  if (t.matches("[data-pick]")) {
    if (t.checked) state.picked.add(t.dataset.pick); else state.picked.delete(t.dataset.pick);
    const y = window.scrollY;
    render();
    window.scrollTo(0, y);
    app.querySelector(`[data-pick="${CSS.escape(t.dataset.pick)}"]`)?.focus();
  }
});

let searchTimer;
app.addEventListener("input", (e) => {
  if (e.target.matches("[data-bulknote]")) { state.bulkNote = e.target.value; return; }
  const which = e.target.dataset.search;
  if (!which) return;
  state.search[which] = e.target.value;
  state.picked.clear();
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    const pos = e.target.selectionStart;
    render();
    const box = app.querySelector(`[data-search="${which}"]`);
    if (box) { box.focus(); box.setSelectionRange(pos, pos); }
  }, 200);
});

// Mark several requests answered with one note. Returns how many saved.
async function answerMany(ids, note) {
  let n = 0;
  try {
    for (const rid of [...new Set(ids)]) { await api.setAnswered(rid, note); n++; }
  } catch (e) {
    toast(friendlyError(e));
  }
  await refresh();
  return n;
}
const answeredMsg = (n) => (n === 1 ? "Marked answered. Praise God." : `Marked ${n} prayers answered. Praise God.`);

app.addEventListener("submit", async (e) => {
  const f = e.target.closest("form[data-form]");
  if (!f) return;
  e.preventDefault();
  const v = Object.fromEntries(new FormData(f));
  const button = f.querySelector('[type="submit"]');
  if (button) button.disabled = true;
  try {
    switch (f.dataset.form) {
      case "sign-in": await sendCode(v.email); break;
      case "code": await verifyCode(v.code); break;
      case "update": {
        const body = String(v.body || "").trim();
        if (!body) break;
        const r = state.data.requests.find((x) => x.id === f.dataset.id);
        if (!r) break;
        let ok;
        if (v.kind === "answered") {
          ok = await act(() => api.setAnswered(r.id, body), "Marked answered. Praise God.");
        } else if (v.kind === "new") {
          const fresh = r.list === "lifegroup"
            ? { list: "lifegroup", family_id: r.family_id, body, sheet_date: null }
            : r.for_member ? { list: "brothers", for_member: r.for_member, body } : { list: "brothers", for_name: r.for_name, body };
          ok = await act(async () => {
            await api.addRequest(fresh);
            if (v.orig_done) await api.setAnswered(r.id, body);
          }, v.orig_done ? "New prayer request added, and the first one marked answered." : "New prayer request added.");
        } else {
          ok = await act(() => api.addUpdate(r.id, body), "Update shared. Everyone who prayed for this will see it.");
        }
        if (ok) { state.form = null; render(); }
        break;
      }
      case "answer": {
        const also = new FormData(f).getAll("also");
        state.form = null;
        const n = await answerMany([f.dataset.id, ...also], String(v.note || "").trim());
        if (n) toast(answeredMsg(n));
        break;
      }
      case "bulk": {
        const n = await answerMany([...state.picked], String(v.note || "").trim());
        state.picked.clear();
        state.bulkNote = "";
        render();
        if (n) toast(answeredMsg(n));
        break;
      }
      case "add-person": {
        const body = String(v.body || "").trim();
        const key = f.dataset.key;
        if (!body) break;
        const fields = key.startsWith("m:") ? { list: "brothers", for_member: key.slice(2), body }
          : { list: "brothers", for_name: people().find((p) => p.key === key)?.name || "", body };
        if (await act(() => api.addRequest(fields), "Request added.")) { state.form = null; render(); }
        break;
      }
      case "add-lifegroup": {
        const family = cleanFamilyName(v.family);
        const body = String(v.body || "").trim();
        if (!family || !body) { toast("Add the family and the request."); break; }
        let fid;
        const ok = await act(async () => {
          fid = await api.familyId(family, state.data.families);
          await api.addRequest({ list: "lifegroup", family_id: fid, body, sheet_date: v.sheet_date || null });
        }, "Request added.");
        if (ok) { state.open.add("lifegroup:" + fid); render(); }
        break;
      }
      case "add-brothers": {
        const body = String(v.body || "").trim();
        const forName = String(v.for_name || "").trim();
        if (!body || (!v.for && !forName)) { toast("Add who it's for and the request."); break; }
        const ok = await act(() => api.addRequest(v.for
          ? { list: "brothers", for_member: v.for, body }
          : { list: "brothers", for_name: forName, body }), "Request added.");
        if (ok) { state.open.add("brothers:" + (v.for ? "m:" + v.for : "n:" + normalize(forName))); render(); }
        break;
      }
      case "event": {
        const title = String(v.title || "").trim();
        if (!title || !v.starts_on) { toast("Add what it is and the date."); break; }
        state.eventDraft = { title, starts_on: v.starts_on, time_text: String(v.time_text || "").trim(), location: String(v.location || "").trim() };
        const fields = { title, starts_on: v.starts_on, time_text: state.eventDraft.time_text || null, location: state.eventDraft.location || null };
        if (await act(() => api.addEvent(fields), "Event added.")) { state.eventDraft = null; render(); }
        break;
      }
      case "my-family": {
        const fresh = v.family === "new";
        const name = fresh ? cleanFamilyName(v.name) : null;
        if (!v.family || (fresh && !name)) { toast("Pick your family, or type its name."); break; }
        const wife = String(v.wife || "").trim() || null;
        const ok = await act(() => api.setMyFamily(fresh ? { name, wife } : { id: v.family, wife }));
        if (ok) {
          state.picking = false;
          render();
          const mine = D.week.fam;
          toast(mine && joinsNextWeek(mine) ? "Saved. Your family joins the prayer circle on Sunday." : "Saved your family.");
        }
        break;
      }
      case "extra": {
        if (!v.pick) { toast("Pick one first."); break; }
        const fields = f.dataset.kind === "family" ? { week_of: weekOf(), family_id: v.pick } : { week_of: weekOf(), for_member: v.pick };
        await act(() => api.addExtra(fields), "Added to your list for this week.");
        break;
      }
      case "invite": {
        if (!isEmail(v.email)) { toast("That email doesn't look right."); break; }
        await act(() => api.addInvite(v.email, v.name), "Added. They can sign in with that email now.");
        break;
      }
    }
  } finally {
    if (button && button.isConnected) button.disabled = false;
  }
});

// ---------- sign-in: an email with a code (and a link) ----------

async function sendCode(email) {
  email = String(email || "").trim().toLowerCase();
  if (!isEmail(email)) { toast("That email doesn't look right."); return; }
  // The link in the email sends people back to the site's home page (the address Supabase allows).
  const back = new URL(import.meta.env.BASE_URL, window.location.origin).href;
  // shouldCreateUser stays on: a person's account is made the first time
  // they sign in, and the database refuses anyone not on the invite list.
  const { error } = await supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: back } });
  if (error) { toast(friendlyError(error)); return; }
  const again = state.sent === email;
  state.sent = email;
  render();
  if (again) toast("Sent a new email. Use the code from the newest one.");
  app.querySelector('input[name="code"]')?.focus();
}

async function verifyCode(code) {
  const token = String(code || "").replace(/\D/g, "");
  if (token.length < 6) { toast("Type the code from the email."); return; }
  const { error } = await supabase.auth.verifyOtp({ email: state.sent, token, type: "email" });
  if (error) { toast(friendlyError(error)); return; }
  state.sent = null;
}

// ---------- start ----------

if (!configured) {
  render();
} else {
  supabase.auth.onAuthStateChange((_event, session) => {
    const changed = (session?.user?.id || null) !== (state.session?.user?.id || null);
    state.session = session;
    state.ready = true;
    if (!session) {
      Object.assign(state, { member: null, data: null, admin: false, invites: [], tab: "week", form: null, confirm: null, prayNow: null, family: "all", man: "all",
        search: { lifegroup: "", brothers: "" }, famDate: {}, showAllAnswered: false, bulkNote: "",
        when: "upcoming", openEvent: null, eventDraft: null, picking: false });
      state.open.clear(); state.picked.clear();
      document.body.classList.remove("noscroll");
      render();
      return;
    }
    // Run outside the auth callback, as Supabase recommends.
    if (changed) { state.sent = null; setTimeout(refresh, 0); }
  });
  render();
}

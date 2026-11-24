import "./styles.css";
import { supabase, configured } from "./supabase.js";
import * as api from "./api.js";
import {
  esc, isActive, entryDay, friendlyDay, ago, cleanFamilyName, isEmail, ymd,
  latestByFamily, needsPrayer, prayersByRequest, prayersThisWeek, iPrayedThisWeek,
  thisWeek, groupBy, matchesSearch, inThisWeek, DAY,
} from "./logic.js";

const $ = (s) => document.querySelector(s);
const app = $("#app");

const state = {
  session: null,
  member: null, // true / false once checked
  admin: false,
  data: null,
  invites: [],
  tab: "week",
  search: { lifegroup: "", brothers: "" },
  form: null, // { kind: "update" | "answer", id, ctx }
  confirm: null, // request id waiting for delete confirmation
  sent: null, // email a sign-in link was sent to
  loading: false,
  ready: false, // true once we know whether someone is signed in
};

// ---------- small page helpers ----------

let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
}

function friendlyError(e) {
  const msg = String((e && e.message) || e || "");
  if (/invite list|Database error saving new user/i.test(msg)) return "That email isn't on the invite list yet. Ask the group leader to add you.";
  if (/rate limit|too many/i.test(msg)) return "Too many sign-in emails just now. Wait a minute and try again.";
  if (/row-level security|permission denied/i.test(msg)) return "You don't have access to do that.";
  if (/Failed to fetch|NetworkError/i.test(msg)) return "Couldn't reach the server. Check your connection and try again.";
  return msg || "Something went wrong. Try again.";
}

async function act(fn, okMsg) {
  try {
    await fn();
    if (okMsg) toast(okMsg);
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
  render();
  try {
    state.member = await api.amIMember();
    if (state.member) {
      const [data, admin] = await Promise.all([api.loadAll(), api.amIAdmin()]);
      state.data = data;
      state.admin = admin;
      state.invites = admin ? await api.loadInvites() : [];
    }
  } catch (e) {
    toast(friendlyError(e));
  }
  state.loading = false;
  render();
}

const myId = () => state.session?.user?.id;

function labelOf(r) {
  const d = state.data;
  if (r.list === "lifegroup") return d.families.find((f) => f.id === r.family_id)?.name || "Unknown family";
  return d.members.find((m) => m.id === r.for_member)?.display_name || r.for_name || "Unknown";
}

const nameOf = (id) => state.data.members.find((m) => m.id === id)?.display_name || "Someone";
const updatesFor = (r) => state.data.updates.filter((u) => u.request_id === r.id);
const canDelete = (r) => state.admin || r.created_by === myId();

// ---------- views ----------

function render() {
  if (!configured) return renderSetup();
  if (!state.ready) { app.innerHTML = shell(`<div class="empty">Loading…</div>`); return; }
  if (!state.session) return renderSignIn();
  if (state.member === false) return renderNotInvited();
  if (state.loading || !state.data) {
    app.innerHTML = shell(`<div class="empty">Loading prayers…</div>`);
    return;
  }
  const views = { week: viewWeek, lifegroup: viewLifegroup, brothers: viewBrothers, group: viewGroup };
  const view = (views[state.tab] || viewWeek)();
  app.innerHTML = shell(tabs() + `<section class="view" role="tabpanel">${view}</section>`);
}

function shell(inner) {
  const signedIn = state.session
    ? `<button class="btn quiet small" data-act="sign-out" type="button">Sign out</button>`
    : "";
  return `<header class="mast">
      <div>
        <h1>Iron Sharpens Iron</h1>
        <div class="verse">Proverbs 27:17 · one man sharpens another</div>
      </div>
      <div class="mast-side"><span class="today mono">${esc(new Date().toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }))}</span>${signedIn}</div>
    </header>${inner}`;
}

function tabs() {
  const list = [["week", "This week"], ["lifegroup", "Lifegroup"], ["brothers", "Brothers"]];
  if (state.admin) list.push(["group", "Invites"]);
  const wk = thisWeek(state.data.requests, labelOf);
  const by = prayersByRequest(state.data.prayers);
  const notYet = wk.lifegroup.concat(wk.brothers).filter((r) => !prayersThisWeek(by.get(r.id)).length).length;
  return `<nav class="tabs" role="tablist" aria-label="Sections">${list.map(([id, label]) => `
    <button class="tab" role="tab" type="button" data-act="tab" data-tab="${id}" aria-selected="${state.tab === id}">
      ${esc(label)}${id === "week" && notYet ? ` <span class="count" title="${notYet} not prayed for yet this week">${notYet}</span>` : ""}
    </button>`).join("")}</nav>`;
}

function renderSetup() {
  app.innerHTML = shell(`<div class="card">
    <h2>Almost ready</h2>
    <p class="lede">This site isn't connected to its database yet. Add the <code>SUPABASE_URL</code> and <code>SUPABASE_ANON_KEY</code> secrets to the repo, then deploy again.</p>
  </div>`);
}

function renderSignIn() {
  const sent = state.sent
    ? `<p class="banner">Check <strong>${esc(state.sent)}</strong> for a sign-in link. You can close this tab; the link opens the site signed in.</p>`
    : "";
  app.innerHTML = shell(`<div class="card">
    <h2>Sign in</h2>
    <p class="lede">Enter the email the group leader invited. We'll email you a link, no password needed.</p>
    ${sent}
    <form class="form-plain" data-form="sign-in" autocomplete="on">
      <label class="field">Email<input type="email" name="email" required autocomplete="email" inputmode="email" placeholder="you@example.com"></label>
      <div class="actions"><button class="btn primary" type="submit">Email me a sign-in link</button></div>
    </form>
  </div>`);
}

function renderNotInvited() {
  app.innerHTML = shell(`<div class="card">
    <h2>Not on the invite list</h2>
    <p class="lede">You're signed in as ${esc(state.session.user.email)}, but that email isn't on the group's invite list. Ask the group leader to add you, then sign in again.</p>
  </div>`);
}

// ----- one prayer request -----

function requestRow(r, ctx, by, latest) {
  const list = by.get(r.id) || [];
  const week = prayersThisWeek(list);
  const mine = iPrayedThisWeek(list, myId());
  const ups = updatesFor(r);
  const flag = needsPrayer(r, list, latest);
  const open = state.form && state.form.id === r.id && state.form.ctx === ctx ? state.form.kind : null;

  const pill = !isActive(r) ? `<span class="pill moss">Answered</span>`
    : flag ? `<span class="pill ember">${list.length ? "Not prayed for this week" : "Not prayed for yet"}</span>` : "";
  const when = r.sheet_date ? `From ${friendlyDay(r.sheet_date)} sheet` : `Added ${friendlyDay(ymd(r.created_at))}`;
  const whoPrayed = [...new Set(list.map((p) => p.member_id))].map(nameOf);
  const prayLine = (week.length ? `<span class="pray-count">\u{1F64F} ${week.length} this week</span> · ` : "")
    + (whoPrayed.length ? `Prayed for by ${esc(whoPrayed.join(", "))}` : "No one has prayed yet");

  let tail;
  if (open === "update") {
    tail = `<form class="inline" data-form="update" data-id="${esc(r.id)}">
      <label class="field">Update<textarea name="body" required maxlength="2000" placeholder="Surgery went well, still recovering…"></textarea></label>
      <div class="actions"><button class="btn primary small" type="submit">Save update</button><button class="btn quiet small" type="button" data-act="close">Cancel</button></div>
    </form>`;
  } else if (open === "answer") {
    tail = `<form class="inline" data-form="answer" data-id="${esc(r.id)}">
      <label class="field">How did God answer?<textarea name="note" maxlength="2000" placeholder="Got the job, or didn't, and He gave peace about what's next."></textarea></label>
      <div class="actions"><button class="btn primary small" type="submit">Save answer</button><button class="btn quiet small" type="button" data-act="close">Cancel</button></div>
    </form>`;
  } else if (state.confirm === r.id) {
    tail = `<div class="actions"><span class="meta">Delete this request for everyone?</span>
      <button class="btn danger small" type="button" data-act="delete" data-id="${esc(r.id)}">Delete</button>
      <button class="btn quiet small" type="button" data-act="close">Keep</button></div>`;
  } else if (!isActive(r)) {
    tail = `<div class="actions"><button class="btn quiet small" type="button" data-act="reopen" data-id="${esc(r.id)}">Not answered yet</button>
      ${canDelete(r) ? `<button class="btn quiet small" type="button" data-act="confirm" data-id="${esc(r.id)}">Delete</button>` : ""}</div>`;
  } else {
    tail = `<div class="actions">
      <button class="btn small ${mine ? "prayed" : ""}" type="button" data-act="prayed" data-id="${esc(r.id)}" aria-pressed="${mine}" title="${mine ? "Tap to undo" : "Mark that you prayed for this"}">${mine ? "Prayed this week ✓" : "I prayed"}</button>
      <button class="btn small" type="button" data-act="open-update" data-id="${esc(r.id)}" data-ctx="${ctx}">Share an update</button>
      <button class="btn small" type="button" data-act="open-answer" data-id="${esc(r.id)}" data-ctx="${ctx}">God answered</button>
      ${canDelete(r) ? `<button class="btn quiet small" type="button" data-act="confirm" data-id="${esc(r.id)}">Delete</button>` : ""}
    </div>`;
  }

  return `<div class="row${flag ? " flag" : ""}">
    <div class="row-top">
      <div class="row-main">
        <span class="who">${esc(labelOf(r))}</span>
        <span class="text">${esc(r.body)}</span>
      </div>
      ${pill}
    </div>
    ${!isActive(r) && r.answered_note ? `<div class="callout answer"><span class="sub">How God answered</span><span class="said">${esc(r.answered_note)}</span></div>` : ""}
    ${ups.length ? `<div class="updates">${ups.slice(0, 3).map((u) => `<div><span class="meta">${esc(friendlyDay(ymd(u.created_at)))} · ${esc(nameOf(u.created_by))}:</span> ${esc(u.body)}</div>`).join("")}</div>` : ""}
    <div class="meta">${esc(when)}${!isActive(r) ? " · answered " + esc(ago(r.answered_at)) : ""} · ${prayLine}</div>
    ${tail}
  </div>`;
}

function rows(list, ctx) {
  const by = prayersByRequest(state.data.prayers);
  const latest = latestByFamily(state.data.requests);
  return list.map((r) => requestRow(r, ctx, by, latest)).join("");
}

// ----- This week -----

function viewWeek() {
  const wk = thisWeek(state.data.requests, labelOf);
  const all = wk.lifegroup.concat(wk.brothers);
  const by = prayersByRequest(state.data.prayers);
  const done = all.filter((r) => prayersThisWeek(by.get(r.id)).length).length;
  const pct = all.length ? Math.round((done / all.length) * 100) : 0;
  const recent = state.data.requests
    .filter((r) => !isActive(r) && r.answered_at && Date.now() - new Date(r.answered_at) < 30 * DAY)
    .sort((a, b) => String(b.answered_at).localeCompare(String(a.answered_at)));

  return `<div class="pulse">
      <div class="pulse-top"><span class="pulse-num">${done} of ${all.length}</span><span class="pulse-label">prayed for this week</span></div>
      <div class="bar" role="img" aria-label="${pct}% prayed for"><span style="width:${pct}%"></span></div>
      <div class="pulse-foot">${all.length === 0 ? "No requests yet this week." : done === all.length ? "Every request has been prayed for this week." : `${all.length - done} still need someone to pray.`}</div>
    </div>
    <div class="sec">
      <div class="sec-head"><h2>Lifegroup prayers</h2><span class="eyebrow">${wk.lifegroup.length ? "from the " + esc(friendlyDay(wk.from)) + " sheet on" : ""}</span></div>
      ${wk.lifegroup.length ? `<div class="list">${rows(wk.lifegroup, "week")}</div>` : `<div class="empty">No lifegroup requests this week. Add them on the Lifegroup tab.</div>`}
    </div>
    <div class="sec">
      <div class="sec-head"><h2>Brothers prayers</h2></div>
      ${wk.brothers.length ? `<div class="list">${rows(wk.brothers, "week")}</div>` : `<div class="empty">No open requests from the brothers.</div>`}
    </div>
    ${recent.length ? `<div class="sec">
      <div class="sec-head"><h2>Remembering God's faithfulness</h2><span class="eyebrow">answered in the last 30 days</span></div>
      <div class="list">${rows(recent, "week")}</div>
    </div>` : ""}`;
}

// ----- Lifegroup -----

function viewLifegroup() {
  const reqs = state.data.requests.filter((r) => r.list === "lifegroup" && matchesSearch(r, state.search.lifegroup, labelOf, updatesFor));
  const groups = groupBy(reqs, (r) => r.family_id, labelOf);
  return `<details class="more"${state.data.requests.some((r) => r.list === "lifegroup") ? "" : " open"}>
      <summary>Add a family request</summary>
      <form class="form" data-form="add-lifegroup" autocomplete="off">
        <label class="field">Family<input type="text" name="family" list="familyNames" required maxlength="80" placeholder="Weeks"></label>
        <label class="field">Request<textarea name="body" required maxlength="2000" placeholder="What should we pray for?"></textarea></label>
        <label class="field">Prayer sheet date<input type="date" name="sheet_date" value="${ymd(lastSunday())}"></label>
        <div class="actions"><button class="btn primary" type="submit">Add request</button></div>
      </form>
    </details>
    <datalist id="familyNames">${state.data.families.map((f) => `<option value="${esc(f.name)}"></option>`).join("")}</datalist>
    ${searchBox("lifegroup")}
    ${groups.length ? groups.map((g) => group(g, "lifegroup")).join("") : `<div class="empty">${state.search.lifegroup ? "No prayers match that search." : "No family requests yet."}</div>`}`;
}

// ----- Brothers -----

function viewBrothers() {
  const reqs = state.data.requests.filter((r) => r.list === "brothers" && matchesSearch(r, state.search.brothers, labelOf, updatesFor));
  const groups = groupBy(reqs, (r) => r.for_member || "name:" + (r.for_name || "").toLowerCase(), labelOf);
  const options = state.data.members.map((m) => `<option value="${esc(m.id)}"${m.id === myId() ? " selected" : ""}>${esc(m.display_name)}${m.id === myId() ? " (me)" : ""}</option>`).join("");
  return `<details class="more">
      <summary>Add a request for a brother</summary>
      <form class="form" data-form="add-brothers" autocomplete="off">
        <label class="field">For<select name="for">${options}<option value="">Someone else…</option></select></label>
        <label class="field other-name" hidden>Name<input type="text" name="for_name" maxlength="80" placeholder="His name"></label>
        <label class="field">Request<textarea name="body" required maxlength="2000" placeholder="What should we pray for?"></textarea></label>
        <div class="actions"><button class="btn primary" type="submit">Add request</button></div>
      </form>
    </details>
    ${searchBox("brothers")}
    ${groups.length ? groups.map((g) => group(g, "brothers")).join("") : `<div class="empty">${state.search.brothers ? "No prayers match that search." : "No requests from the brothers yet."}</div>`}`;
}

function searchBox(which) {
  return `<input type="search" class="search" data-search="${which}" value="${esc(state.search[which])}" placeholder="Search prayers, like job or surgery" aria-label="Search prayers" autocomplete="off">`;
}

function group(g, ctx) {
  const open = g.items.filter(isActive).length;
  return `<details class="person"${state.search[ctx] ? " open" : ""}>
    <summary><span class="fam-text"><span class="fam-name">${esc(g.label)}</span><span class="meta">${open} open · ${g.items.length - open} answered</span></span><span class="fam-side"></span></summary>
    <div class="list">${rows(g.items, ctx)}</div>
  </details>`;
}

// ----- Invites (admins only) -----

function viewGroup() {
  return `<div class="form">
      <div class="sec-head"><h2>Invite someone</h2></div>
      <p class="lede">Only people on this list can sign in. Removing someone takes their access away straight away.</p>
      <form class="form-plain" data-form="invite" autocomplete="off">
        <div class="form-row">
          <label class="field">Name<input type="text" name="name" required maxlength="80" placeholder="First and last name"></label>
          <label class="field">Email<input type="email" name="email" required placeholder="name@example.com"></label>
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

app.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-act]");
  if (!b) return;
  const id = b.dataset.id;
  switch (b.dataset.act) {
    case "tab": state.tab = b.dataset.tab; state.form = null; state.confirm = null; render(); window.scrollTo(0, 0); break;
    case "sign-out": await supabase.auth.signOut(); break;
    case "open-update": state.form = { kind: "update", id, ctx: b.dataset.ctx }; state.confirm = null; render(); focusForm(); break;
    case "open-answer": state.form = { kind: "answer", id, ctx: b.dataset.ctx }; state.confirm = null; render(); focusForm(); break;
    case "close": state.form = null; state.confirm = null; render(); break;
    case "confirm": state.confirm = id; state.form = null; render(); break;
    case "confirm-invite": state.confirm = "invite:" + b.dataset.email; render(); break;
    case "delete": state.confirm = null; await act(() => api.deleteRequest(id), "Request deleted."); break;
    case "reopen": await act(() => api.reopen(id), "Moved back to praying."); break;
    case "uninvite": state.confirm = null; await act(() => api.removeInvite(b.dataset.email), "Removed from the invite list."); break;
    case "prayed": {
      b.disabled = true;
      const mineThisWeek = state.data.prayers.filter((p) => p.request_id === id && p.member_id === myId() && inThisWeek(p.prayed_at));
      if (mineThisWeek.length) await act(() => api.undoPrayed(mineThisWeek.map((p) => p.id)));
      else await act(() => api.markPrayed(id), "Thank you for praying.");
      break;
    }
  }
});

function focusForm() {
  const t = app.querySelector("form.inline textarea");
  if (t) t.focus();
}

app.addEventListener("change", (e) => {
  if (e.target.matches('select[name="for"]')) {
    const other = e.target.form.querySelector(".other-name");
    other.hidden = e.target.value !== "";
    other.querySelector("input").required = e.target.value === "";
  }
});

let searchTimer;
app.addEventListener("input", (e) => {
  const which = e.target.dataset.search;
  if (!which) return;
  state.search[which] = e.target.value;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    const pos = e.target.selectionStart;
    render();
    const box = app.querySelector(`[data-search="${which}"]`);
    if (box) { box.focus(); box.setSelectionRange(pos, pos); }
  }, 200);
});

app.addEventListener("submit", async (e) => {
  const f = e.target.closest("form[data-form]");
  if (!f) return;
  e.preventDefault();
  const v = Object.fromEntries(new FormData(f));
  const button = f.querySelector('[type="submit"]');
  if (button) button.disabled = true;
  try {
    switch (f.dataset.form) {
      case "sign-in": await signIn(v.email); break;
      case "update": {
        const body = String(v.body || "").trim();
        if (!body) break;
        if (await act(() => api.addUpdate(f.dataset.id, body), "Update shared.")) { state.form = null; render(); }
        break;
      }
      case "answer":
        if (await act(() => api.setAnswered(f.dataset.id, String(v.note || "").trim()), "Praise God! Marked answered.")) { state.form = null; render(); }
        break;
      case "add-lifegroup": {
        const family = cleanFamilyName(v.family);
        const body = String(v.body || "").trim();
        if (!family || !body) { toast("Add the family and the request."); break; }
        await act(async () => {
          const familyId = await api.familyId(family, state.data.families);
          await api.addRequest({ list: "lifegroup", family_id: familyId, body, sheet_date: v.sheet_date || null });
        }, "Request added.");
        break;
      }
      case "add-brothers": {
        const body = String(v.body || "").trim();
        const forName = String(v.for_name || "").trim();
        if (!body || (!v.for && !forName)) { toast("Add who it's for and the request."); break; }
        await act(() => api.addRequest(v.for
          ? { list: "brothers", for_member: v.for, body }
          : { list: "brothers", for_name: forName, body }), "Request added.");
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

async function signIn(email) {
  email = String(email || "").trim().toLowerCase();
  if (!isEmail(email)) { toast("That email doesn't look right."); return; }
  // Send people back to this page (without any old sign-in details in the address).
  const back = window.location.origin + window.location.pathname;
  const { error } = await supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: back } });
  if (error) { toast(friendlyError(error)); return; }
  state.sent = email;
  render();
}

// ---------- start ----------

if (!configured) {
  render();
} else {
  supabase.auth.onAuthStateChange((_event, session) => {
    const changed = (session?.user?.id || null) !== (state.session?.user?.id || null);
    state.session = session;
    state.ready = true;
    if (!session) { state.member = null; state.data = null; state.admin = false; state.invites = []; render(); return; }
    // Run outside the auth callback, as Supabase recommends.
    if (changed) setTimeout(refresh, 0);
  });
  render();
}

// Every read and write the site makes. The database decides what each person
// may do; these calls only ask.
import { supabase } from "./supabase.js";

function check({ data, error }) {
  if (error) throw error;
  return data;
}

// Supabase returns at most 1,000 rows per call, so read in pages.
const PAGE = 1000;
async function all(table, columns, orderBy, ascending = false) {
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    const page = check(await supabase.from(table).select(columns).order(orderBy, { ascending }).order("id").range(from, from + PAGE - 1));
    rows.push(...page);
    if (page.length < PAGE) return rows;
  }
}

export async function loadAll() {
  const [members, families, requests, updates, prayers, events, weekly] = await Promise.all([
    all("members", "id, display_name", "display_name", true),
    all("families", "id, name", "name", true),
    all("requests", "*", "created_at"),
    all("request_updates", "*", "created_at"),
    all("prayers", "*", "prayed_at"),
    loadEvents(),
    loadWeekly(),
  ]);
  // Add each person's family, and each family's names and circle, when the
  // weekly partners step has run.
  const link = new Map((weekly?.links || []).map((m) => [m.id, m.family_id]));
  const fam = new Map((weekly?.families || []).map((f) => [f.id, f]));
  return {
    members: members.map((m) => ({ ...m, family_id: link.get(m.id) || null })),
    families: families.map((f) => ({ husband: null, wife: null, since: null, pray_for: null, ...f, ...fam.get(f.id) })),
    requests, updates, prayers,
    events: events || [], calendarReady: events !== null,
    personPrayers: weekly?.personPrayers || [], extras: weekly?.extras || [], weeklyReady: weekly !== null,
  };
}

// True when a table or column isn't there yet because a setup step hasn't run.
const notSetUp = (e) => !!e && (["PGRST205", "PGRST204", "42P01", "42703"].includes(e.code)
  || /could not find the (table|column)|does not exist/i.test(e.message || ""));

// The weekly partners come from their own setup steps (README steps 8 and 9). Until
// it has run, everything else still loads (null).
async function loadWeekly() {
  try {
    const [links, families, personPrayers, extras] = await Promise.all([
      all("members", "id, family_id", "id", true),
      all("families", "id, husband, wife, since, pray_for", "id", true),
      all("person_prayers", "*", "prayed_at"),
      all("week_extras", "*", "created_at"),
    ]);
    return { links, families, personPrayers, extras };
  } catch (e) {
    if (notSetUp(e)) return null;
    throw e;
  }
}

// The calendar's table comes from its own setup step. Until that has run,
// the prayers still load and the calendar says it isn't set up (null).
async function loadEvents() {
  try {
    return await all("events", "*", "starts_on", true);
  } catch (e) {
    if (notSetUp(e)) return null;
    throw e;
  }
}

export async function amIAdmin() {
  return check(await supabase.rpc("is_admin")) === true;
}

export async function amIMember() {
  return check(await supabase.rpc("is_member")) === true;
}

export async function loadInvites() {
  return check(await supabase.from("invites").select("email, name, role, invited_at").order("name"));
}

export async function addInvite(email, name) {
  check(await supabase.from("invites").insert({ email: email.trim().toLowerCase(), name: name.trim() }));
}

export async function removeInvite(email) {
  check(await supabase.from("invites").delete().eq("email", email));
}

// Find a family by name, or add it.
export async function familyId(name, families) {
  const found = families.find((f) => f.name.trim().toLowerCase() === name.trim().toLowerCase());
  if (found) return found.id;
  const res = await supabase.from("families").insert({ name: name.trim() }).select("id").single();
  if (res.error && res.error.code === "23505") {
    // Someone else added it a moment ago.
    const exact = name.trim().replace(/[\\%_]/g, (c) => "\\" + c);
    const again = check(await supabase.from("families").select("id").ilike("name", exact).limit(1));
    if (again.length) return again[0].id;
  }
  return check(res).id;
}

export async function addRequest(fields) {
  check(await supabase.from("requests").insert(fields));
}

export async function setAnswered(id, note) {
  check(await supabase.from("requests").update({ status: "answered", answered_note: note || null }).eq("id", id));
}

export async function reopen(id) {
  check(await supabase.from("requests").update({ status: "active" }).eq("id", id));
}

export async function deleteRequest(id) {
  const rows = check(await supabase.from("requests").delete().eq("id", id).select("id"));
  if (!rows.length) throw new Error("Only the person who added this, or an admin, can delete it.");
}

export async function addUpdate(requestId, body) {
  check(await supabase.from("request_updates").insert({ request_id: requestId, body }));
}

export async function markPrayed(requestId) {
  check(await supabase.from("prayers").insert({ request_id: requestId }));
}

export async function undoPrayed(prayerIds) {
  check(await supabase.from("prayers").delete().in("id", prayerIds));
}

// ----- calendar -----

export async function addEvent(fields) {
  check(await supabase.from("events").insert(fields));
}

export async function deleteEvent(id) {
  const rows = check(await supabase.from("events").delete().eq("id", id).select("id"));
  if (!rows.length) throw new Error("Only the person who added this event, or an admin, can delete it.");
}

// Admins hide a sheet or church event (or bring it back).
export async function setEventHidden(id, hidden) {
  const rows = check(await supabase.from("events").update({ hidden }).eq("id", id).select("id"));
  if (!rows.length) throw new Error("Only an admin can hide church and sheet events.");
}

// ----- your family and brother each week -----

// Pick your family from the list (id), or add it by name. The wife's first
// name is optional.
export async function setMyFamily({ id = null, name = null, wife = null }) {
  return check(await supabase.rpc("set_my_family", { p_family: id, p_name: name, p_wife: wife }));
}

export async function prayForPerson(memberId) {
  check(await supabase.from("person_prayers").insert({ member_id: memberId }));
}

export async function undoPersonPrayers(ids) {
  check(await supabase.from("person_prayers").delete().in("id", ids));
}

export async function addExtra(fields) {
  const res = await supabase.from("week_extras").insert(fields);
  // Already on your list this week: nothing to do.
  if (res.error && res.error.code === "23505") return;
  check(res);
}

export async function removeExtra(id) {
  check(await supabase.from("week_extras").delete().eq("id", id));
}

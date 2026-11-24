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
  const [members, families, requests, updates, prayers] = await Promise.all([
    all("members", "id, display_name", "display_name", true),
    all("families", "id, name", "name", true),
    all("requests", "*", "created_at"),
    all("request_updates", "*", "created_at"),
    all("prayers", "*", "prayed_at"),
  ]);
  return { members, families, requests, updates, prayers };
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

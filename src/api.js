// Every read and write the site makes. The database decides what each person
// may do; these calls only ask.
import { supabase } from "./supabase.js";

function check({ data, error }) {
  if (error) throw error;
  return data;
}

export async function loadAll() {
  const [members, families, requests, updates, prayers] = await Promise.all([
    supabase.from("members").select("id, display_name").order("display_name"),
    supabase.from("families").select("id, name").order("name"),
    supabase.from("requests").select("*").order("created_at", { ascending: false }),
    supabase.from("request_updates").select("*").order("created_at", { ascending: false }),
    supabase.from("prayers").select("*").order("prayed_at", { ascending: false }),
  ]);
  return {
    members: check(members),
    families: check(families),
    requests: check(requests),
    updates: check(updates),
    prayers: check(prayers),
  };
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
    const again = check(await supabase.from("families").select("id").ilike("name", name.trim()).limit(1));
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

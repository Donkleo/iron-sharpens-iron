// Runs the real migration in Postgres (PGlite) and checks the access rules:
// who can sign up, and who can read or change prayers.
import { describe, it, expect, beforeAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const migrationsDir = join(root, "supabase", "migrations");

let db;
const ids = {};

// Run a query as a given role and signed-in user (or as anon with no user).
async function as(who, sql, params = []) {
  await db.exec("reset role");
  const role = who === "anon" ? "anon" : "authenticated";
  const sub = who === "anon" ? "" : ids[who];
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [sub]);
  await db.exec(`set role ${role}`);
  try {
    return await db.query(sql, params);
  } finally {
    await db.exec("reset role");
  }
}

async function signUp(email) {
  const r = await db.query("insert into auth.users (email) values ($1) returning id", [email]);
  return r.rows[0].id;
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(readFileSync(join(import.meta.dirname, "supabase-stub.sql"), "utf8"));
  for (const f of readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()) {
    await db.exec(readFileSync(join(migrationsDir, f), "utf8"));
  }
  // Set up like the admin would: invite yourself as admin, then a member.
  await db.exec(`insert into public.invites (email, name, role) values
    ('admin@example.com', 'Admin', 'admin'),
    ('brother@example.com', 'Brother', 'member'),
    ('removed@example.com', 'Removed', 'member')`);
  ids.admin = await signUp("Admin@Example.com");
  ids.brother = await signUp("brother@example.com");
  ids.removed = await signUp("removed@example.com");
  await db.exec("delete from public.invites where email = 'removed@example.com'");
});

describe("sign-up", () => {
  it("refuses an email that is not on the invite list", async () => {
    await expect(signUp("stranger@example.com")).rejects.toThrow(/invite list/);
  });

  it("creates a member named from the invite", async () => {
    const r = await db.query("select display_name, email from public.members where id = $1", [ids.admin]);
    expect(r.rows[0]).toEqual({ display_name: "Admin", email: "admin@example.com" });
  });
});

describe("anon key", () => {
  const tables = ["invites", "members", "families", "requests", "request_updates", "prayers", "events"];
  for (const t of tables) {
    it(`cannot read ${t}`, async () => {
      await expect(as("anon", `select * from public.${t}`)).rejects.toThrow(/permission denied/);
    });
  }
  it("cannot call the membership checks", async () => {
    await expect(as("anon", "select public.is_member()")).rejects.toThrow(/permission denied/);
    await expect(as("anon", "select public.is_admin()")).rejects.toThrow(/permission denied/);
  });
  it("cannot add a request", async () => {
    await expect(as("anon", "insert into public.requests (list, for_name, body) values ('brothers', 'x', 'y')"))
      .rejects.toThrow(/permission denied/);
  });
});

describe("members", () => {
  let familyId, requestId;

  it("can add a family and a lifegroup request", async () => {
    const f = await as("brother", "insert into public.families (name) values ('Family A') returning id, created_by");
    familyId = f.rows[0].id;
    expect(f.rows[0].created_by).toBe(ids.brother);
    const r = await as("brother",
      "insert into public.requests (list, family_id, body, sheet_date) values ('lifegroup', $1, 'New job', '2026-11-23') returning id",
      [familyId]);
    requestId = r.rows[0].id;
  });

  it("can read each other's requests", async () => {
    const r = await as("admin", "select body from public.requests");
    expect(r.rows.map((x) => x.body)).toContain("New job");
  });

  it("see names but not emails of other members", async () => {
    const r = await as("brother", "select id, display_name from public.members order by display_name");
    expect(r.rows.map((x) => x.display_name)).toEqual(["Admin", "Brother", "Removed"]);
    await expect(as("brother", "select email from public.members")).rejects.toThrow(/permission denied/);
  });

  it("can only rename themselves", async () => {
    await as("brother", "update public.members set display_name = 'Bro' where id = $1", [ids.admin]);
    const r = await db.query("select display_name from public.members where id = $1", [ids.admin]);
    expect(r.rows[0].display_name).toBe("Admin");
  });

  it("mark I prayed only for themselves", async () => {
    await as("brother", "insert into public.prayers (request_id) values ($1)", [requestId]);
    await expect(as("brother", "insert into public.prayers (request_id, member_id) values ($1, $2)", [requestId, ids.admin]))
      .rejects.toThrow(/permission denied/);
    const r = await db.query("select member_id from public.prayers");
    expect(r.rows).toEqual([{ member_id: ids.brother }]);
  });

  it("cannot undo someone else's I prayed", async () => {
    await as("admin", "delete from public.prayers");
    const r = await db.query("select count(*)::int as n from public.prayers");
    expect(r.rows[0].n).toBe(1);
  });

  it("cannot pretend someone else added a request", async () => {
    await expect(as("brother",
      "insert into public.requests (list, for_name, body, created_by) values ('brothers', 'Alex', 'x', $1)", [ids.admin]))
      .rejects.toThrow(/permission denied/);
  });

  it("answered is stamped by the database", async () => {
    await as("admin", "update public.requests set status = 'answered', answered_note = 'Got it' where id = $1", [requestId]);
    let r = await db.query("select answered_by, answered_at, answered_note from public.requests where id = $1", [requestId]);
    expect(r.rows[0].answered_by).toBe(ids.admin);
    expect(r.rows[0].answered_at).not.toBeNull();
    await expect(as("brother", "update public.requests set answered_by = $1 where id = $2", [ids.brother, requestId]))
      .rejects.toThrow(/permission denied/);
    await as("brother", "update public.requests set status = 'active' where id = $1", [requestId]);
    r = await db.query("select answered_by, answered_at, answered_note from public.requests where id = $1", [requestId]);
    expect(r.rows[0]).toEqual({ answered_by: null, answered_at: null, answered_note: null });
  });

  it("can share an update", async () => {
    await as("admin", "insert into public.request_updates (request_id, body) values ($1, 'Interview Friday')", [requestId]);
    const r = await as("brother", "select body from public.request_updates");
    expect(r.rows).toEqual([{ body: "Interview Friday" }]);
  });

  it("only the person who added a request, or an admin, can delete it", async () => {
    const r = await as("admin", "insert into public.requests (list, for_name, body) values ('brothers', 'Alex', 'Health') returning id");
    const id = r.rows[0].id;
    await as("brother", "delete from public.requests where id = $1", [id]);
    let left = await db.query("select count(*)::int as n from public.requests where id = $1", [id]);
    expect(left.rows[0].n).toBe(1);
    await as("admin", "delete from public.requests where id = $1", [id]);
    left = await db.query("select count(*)::int as n from public.requests where id = $1", [id]);
    expect(left.rows[0].n).toBe(0);
  });

  it("cannot see or change the invite list unless admin", async () => {
    const r = await as("brother", "select * from public.invites");
    expect(r.rows).toEqual([]);
    await as("brother", "insert into public.invites (email, name) values ('friend@example.com', 'Friend')").catch(() => {});
    const n = await db.query("select count(*)::int as n from public.invites where email = 'friend@example.com'");
    expect(n.rows[0].n).toBe(0);
    const a = await as("admin", "select email from public.invites order by email");
    expect(a.rows.map((x) => x.email)).toEqual(["admin@example.com", "brother@example.com"]);
    await as("admin", "insert into public.invites (email, name) values ('friend@example.com', 'Friend')");
    await as("admin", "delete from public.invites where email = 'friend@example.com'");
  });
});

describe("removed invite", () => {
  const readable = {
    invites: "*", members: "id, display_name", families: "*", requests: "*", request_updates: "*", prayers: "*",
  };
  for (const [t, cols] of Object.entries(readable)) {
    it(`can no longer read ${t}`, async () => {
      const total = await db.query(`select count(*)::int as n from public.${t}`);
      expect(total.rows[0].n).toBeGreaterThan(0);
      const r = await as("removed", `select ${cols} from public.${t}`);
      expect(r.rows).toEqual([]);
    });
  }

  it("can no longer add anything", async () => {
    const reqId = (await db.query("select id from public.requests limit 1")).rows[0].id;
    const attempts = [
      "insert into public.requests (list, for_name, body) values ('brothers', 'x', 'y')",
      "insert into public.families (name) values ('Another family')",
      `insert into public.request_updates (request_id, body) values ('${reqId}', 'x')`,
      `insert into public.prayers (request_id) values ('${reqId}')`,
    ];
    for (const sql of attempts) await expect(as("removed", sql)).rejects.toThrow(/row-level security/);
  });

  it("can no longer change or delete anything", async () => {
    const before = await db.query("select (select count(*) from public.requests) + (select count(*) from public.request_updates) + (select count(*) from public.prayers) as n");
    await as("removed", "update public.requests set status = 'answered'");
    await as("removed", "delete from public.request_updates");
    await as("removed", "delete from public.prayers");
    await as("removed", "delete from public.requests");
    const after = await db.query("select (select count(*) from public.requests) + (select count(*) from public.request_updates) + (select count(*) from public.prayers) as n");
    expect(after.rows[0].n).toBe(before.rows[0].n);
    const answered = await db.query("select count(*)::int as n from public.requests where status = 'answered'");
    expect(answered.rows[0].n).toBe(0);
  });
});

describe("more member limits", () => {
  let reqId, updateId;
  beforeAll(async () => {
    reqId = (await as("admin", "insert into public.requests (list, for_member, body) values ('brothers', $1, 'Rest') returning id", [ids.admin])).rows[0].id;
    updateId = (await as("admin", "insert into public.request_updates (request_id, body) values ($1, 'Slept well') returning id", [reqId])).rows[0].id;
  });

  it("cannot rewrite someone else's request", async () => {
    await expect(as("brother", "update public.requests set body = 'changed' where id = $1", [reqId])).rejects.toThrow(/permission denied/);
  });

  it("cannot rename a family", async () => {
    await expect(as("brother", "update public.families set name = 'Other'")).rejects.toThrow(/permission denied/);
  });

  it("cannot delete a family unless admin", async () => {
    const id = (await as("brother", "insert into public.families (name) values ('Temp') returning id")).rows[0].id;
    await as("brother", "delete from public.families where id = $1", [id]);
    expect((await db.query("select count(*)::int as n from public.families where id = $1", [id])).rows[0].n).toBe(1);
    await as("admin", "delete from public.families where id = $1", [id]);
    expect((await db.query("select count(*)::int as n from public.families where id = $1", [id])).rows[0].n).toBe(0);
  });

  it("cannot delete someone else's update", async () => {
    await as("brother", "delete from public.request_updates where id = $1", [updateId]);
    expect((await db.query("select count(*)::int as n from public.request_updates where id = $1", [updateId])).rows[0].n).toBe(1);
  });

  it("cannot pretend someone else added a family or update", async () => {
    await expect(as("brother", "insert into public.families (name, created_by) values ('Spoof', $1)", [ids.admin])).rejects.toThrow(/permission denied/);
    await expect(as("brother", "insert into public.request_updates (request_id, body, created_by) values ($1, 'x', $2)", [reqId, ids.admin])).rejects.toThrow(/permission denied/);
  });

  it("keeps the brother's name on his request", async () => {
    const r = await db.query("select for_name from public.requests where id = $1", [reqId]);
    expect(r.rows[0].for_name).toBe("Admin");
  });
});

describe("admins", () => {
  it("cannot remove or demote their own invite", async () => {
    await as("admin", "delete from public.invites where email = 'admin@example.com'");
    await as("admin", "update public.invites set role = 'member' where email = 'admin@example.com'");
    const r = await db.query("select role from public.invites where email = 'admin@example.com'");
    expect(r.rows).toEqual([{ role: "admin" }]);
  });

  it("can invite someone who already had an account", async () => {
    await db.exec("alter table auth.users disable trigger enforce_invite");
    const id = (await db.query("insert into auth.users (email) values ('early@example.com') returning id")).rows[0].id;
    await db.exec("alter table auth.users enable trigger enforce_invite");
    ids.early = id;
    expect((await as("early", "select public.is_member() as ok")).rows[0].ok).toBe(false);
    await as("admin", "insert into public.invites (email, name) values ('early@example.com', 'Early')");
    expect((await as("early", "select public.is_member() as ok")).rows[0].ok).toBe(true);
  });

  it("can remove a member who answered a request", async () => {
    await db.exec("insert into public.invites (email, name) values ('answerer@example.com', 'Answerer')");
    ids.answerer = await signUp("answerer@example.com");
    const id = (await as("brother", "insert into public.requests (list, for_name, body) values ('brothers', 'Alex', 'Peace') returning id")).rows[0].id;
    await as("answerer", "update public.requests set status = 'answered', answered_note = 'Yes' where id = $1", [id]);
    await db.query("delete from auth.users where id = $1", [ids.answerer]);
    const r = await db.query("select status, answered_by, answered_note from public.requests where id = $1", [id]);
    expect(r.rows).toEqual([{ status: "answered", answered_by: null, answered_note: "Yes" }]);
  });

  it("can remove a member who has requests", async () => {
    await as("early", "insert into public.requests (list, for_member, body) values ('brothers', $1, 'x')", [ids.early]);
    await db.query("delete from auth.users where id = $1", [ids.early]);
    const r = await db.query("select for_member, for_name from public.requests where for_name = 'Early'");
    expect(r.rows).toEqual([{ for_member: null, for_name: "Early" }]);
  });
});

describe("calendar", () => {
  let groupEvent, churchEvent;
  const KEY = "test-sync-key-0123456789abcdef";

  beforeAll(async () => {
    await db.query("insert into private.sync_keys (key_hash) values (private.hash_key($1))", [KEY]);
  });

  it("members add a group event, marked as theirs", async () => {
    const r = await as("brother",
      "insert into public.events (title, starts_on, time_text, location) values ('Breakfast', '2026-11-28', '7:00 AM', 'Diner') returning id, source, created_by, hidden");
    groupEvent = r.rows[0].id;
    expect(r.rows[0]).toMatchObject({ source: "group", created_by: ids.brother, hidden: false });
  });

  it("members can't add church or sheet events, or hide them", async () => {
    await expect(as("brother", "insert into public.events (title, starts_on, source) values ('x', '2026-11-28', 'church')"))
      .rejects.toThrow(/permission denied/);
    await expect(as("brother", "insert into public.events (title, starts_on, hidden) values ('x', '2026-11-28', true)"))
      .rejects.toThrow(/permission denied/);
    await expect(as("brother", "insert into public.events (title, starts_on, created_by) values ('x', '2026-11-28', $1)", [ids.admin]))
      .rejects.toThrow(/permission denied/);
  });

  it("people whose invite was removed can't see the calendar", async () => {
    const r = await as("removed", "select id from public.events");
    expect(r.rows).toEqual([]);
  });

  it("the sync key adds and updates sheet and church events", async () => {
    const events = [
      { id: "c1", title: "Thanksgiving service", date: "2026-11-26", time: "6:00 PM", url: "https://example.org/thanks" },
      { id: "c2", title: "Men's retreat", date: "2026-12-04", end_date: "2026-12-06" },
    ];
    const r = await as("anon", "select public.sync_events(p_key => $1, p_source => 'church', p_events => $2::jsonb) as n", [KEY, JSON.stringify(events)]);
    expect(r.rows[0].n).toBe(2);
    const rows = (await as("brother", "select id, external_id, title, ends_on::text, time_text, url, created_by from public.events where source = 'church' order by external_id")).rows;
    expect(rows.map((x) => x.title)).toEqual(["Thanksgiving service", "Men's retreat"]);
    expect(rows[1].ends_on).toBe("2026-12-06");
    expect(rows[0].created_by).toBeNull();
    churchEvent = rows[0].id;
    // Running again updates in place.
    events[0].title = "Thanksgiving Eve service";
    await as("anon", "select public.sync_events(p_key => $1, p_source => 'church', p_events => $2::jsonb)", [KEY, JSON.stringify(events)]);
    const again = await db.query("select count(*)::int as n, min(title) as t from public.events where source = 'church' and external_id = 'c1'");
    expect(again.rows[0]).toEqual({ n: 1, t: "Thanksgiving Eve service" });
  });

  it("refuses a wrong or missing sync key, and group events", async () => {
    await expect(as("anon", "select public.sync_events(p_key => 'wrong-key-wrong-key-wrong-key', p_source => 'church', p_events => '[]'::jsonb)")).rejects.toThrow(/Unknown sync key/);
    await expect(as("anon", "select public.sync_events(p_key => null, p_source => 'church', p_events => '[]'::jsonb)")).rejects.toThrow(/Unknown sync key/);
    await expect(as("anon", "select public.sync_events(p_key => $1, p_source => 'group', p_events => '[]'::jsonb)", [KEY])).rejects.toThrow(/sheet or church/);
    await expect(as("anon", "select public.sync_events(p_key => $1, p_source => 'sheet', p_events => '[{\"title\":\"no id\",\"date\":\"2026-11-30\"}]'::jsonb)", [KEY]))
      .rejects.toThrow(/needs an id .*a title and a real date/);
    await expect(as("anon", "select public.sync_events(p_key => $1, p_source => 'sheet', p_events => '[{\"id\":\"s9\",\"title\":\"no date\"}]'::jsonb)", [KEY]))
      .rejects.toThrow(/needs an id .*a title and a real date/);
  });

  it("the sync key can't read anything or reach the key table", async () => {
    await expect(as("anon", "select * from public.events")).rejects.toThrow(/permission denied/);
    await expect(as("anon", "select * from private.sync_keys")).rejects.toThrow(/permission denied/);
    await expect(as("brother", "select * from private.sync_keys")).rejects.toThrow(/permission denied/);
  });

  it("only admins hide church events, and a sync keeps them hidden", async () => {
    await as("brother", "update public.events set hidden = true where id = $1", [churchEvent]);
    expect((await db.query("select hidden from public.events where id = $1", [churchEvent])).rows[0].hidden).toBe(false);
    await expect(as("brother", "update public.events set title = 'x' where id = $1", [churchEvent])).rejects.toThrow(/permission denied/);
    await as("admin", "update public.events set hidden = true where id = $1", [churchEvent]);
    await as("anon", "select public.sync_events(p_key => $1, p_source => 'church', p_events => $2::jsonb)", [KEY, JSON.stringify([{ id: "c1", title: "Thanksgiving Eve service", date: "2026-11-26" }])]);
    expect((await db.query("select hidden from public.events where id = $1", [churchEvent])).rows[0].hidden).toBe(true);
    // Group events aren't hidden, they're deleted.
    await as("admin", "update public.events set hidden = true where id = $1", [groupEvent]);
    expect((await db.query("select hidden from public.events where id = $1", [groupEvent])).rows[0].hidden).toBe(false);
  });

  it("a sync with a start day removes that source's nights no longer listed", async () => {
    const sheet = [{ id: "s1", title: "Bible study", date: "2026-11-30", address: "12 Oak St" }, { id: "s2", title: "Hangout", date: "2026-12-07", kind: "open" }];
    await as("anon", "select public.sync_events(p_key => $1, p_source => 'sheet', p_events => $2::jsonb, p_replace_from => '2026-11-01')", [KEY, JSON.stringify(sheet)]);
    await as("anon", "select public.sync_events(p_key => $1, p_source => 'sheet', p_events => $2::jsonb, p_replace_from => '2026-11-01')", [KEY, JSON.stringify(sheet.slice(0, 1))]);
    const r = await db.query("select external_id from public.events where source = 'sheet'");
    expect(r.rows).toEqual([{ external_id: "s1" }]);
    // Church events were left alone.
    expect((await db.query("select count(*)::int as n from public.events where source = 'church'")).rows[0].n).toBe(2);
  });

  it("a repeated item or a plain http link doesn't stop the sync", async () => {
    const sheet = [
      { id: "s1", title: "Bible study", date: "2026-11-30", url: "http://example.org/old" },
      { id: "s1", title: "Bible study at the Hills", date: "2026-11-30", url: "HTTPS://example.org/a" },
    ];
    const r = await as("anon", "select public.sync_events(p_key => $1, p_source => 'sheet', p_events => $2::jsonb, p_replace_from => '2026-11-01') as n", [KEY, JSON.stringify(sheet)]);
    expect(r.rows[0].n).toBe(1);
    const row = (await db.query("select title, url from public.events where source = 'sheet'")).rows;
    expect(row).toEqual([{ title: "Bible study at the Hills", url: "https://example.org/a" }]);
    await as("anon", "select public.sync_events(p_key => $1, p_source => 'sheet', p_events => $2::jsonb, p_replace_from => '2026-11-01')", [KEY, JSON.stringify(sheet.slice(0, 1))]);
    expect((await db.query("select url from public.events where source = 'sheet'")).rows[0].url).toBeNull();
  });

  it("sheet events can't be hidden from the site, even by an admin", async () => {
    await as("admin", "update public.events set hidden = true where source = 'sheet'");
    expect((await db.query("select bool_or(hidden) as h from public.events where source = 'sheet'")).rows[0].h).toBe(false);
  });

  it("members can't delete church or sheet events", async () => {
    await as("brother", "delete from public.events where source <> 'group'");
    await as("admin", "delete from public.events where source <> 'group'");
    expect((await db.query("select count(*)::int as n from public.events where source <> 'group'")).rows[0].n).toBe(3);
  });

  it("group events are deleted by whoever added them, or an admin", async () => {
    const other = (await as("admin", "insert into public.events (title, starts_on) values ('Workday', '2026-12-12') returning id")).rows[0].id;
    await as("brother", "delete from public.events where id = $1", [other]);
    expect((await db.query("select count(*)::int as n from public.events where id = $1", [other])).rows[0].n).toBe(1);
    await as("admin", "delete from public.events where id = $1", [other]);
    await as("brother", "delete from public.events where id = $1", [groupEvent]);
    expect((await db.query("select count(*)::int as n from public.events where source = 'group'")).rows[0].n).toBe(0);
  });
});

describe("calendar sync key in a header", () => {
  const KEY = "header-sync-key-0123456789abcdef";
  const ev = JSON.stringify([{ id: "h1", title: "Header test", date: "2027-01-05" }]);
  const withHeaders = async (headers, sql, params = []) => {
    await db.query("select set_config('request.headers', $1, false)", [headers]);
    try { return await as("anon", sql, params); } finally { await db.query("select set_config('request.headers', '', false)"); }
  };

  beforeAll(async () => {
    await db.query("insert into private.sync_keys (key_hash, label) values (private.hash_key($1), 'header test')", [KEY]);
  });

  it("takes the key from the x-sync-key header", async () => {
    const r = await withHeaders(JSON.stringify({ "x-sync-key": KEY }), "select public.sync_events(p_source => 'church', p_events => $1::jsonb) as n", [ev]);
    expect(r.rows[0].n).toBe(1);
  });

  it("refuses a wrong, empty, short or garbled header, or none", async () => {
    const call = "select public.sync_events(p_source => 'church', p_events => $1::jsonb)";
    for (const h of [JSON.stringify({ "x-sync-key": "wrong-key-wrong-key-wrong-key-wrong" }), JSON.stringify({ "x-sync-key": "" }),
      JSON.stringify({ "x-sync-key": KEY.slice(0, 10) }), JSON.stringify({ "x-other": KEY }), "not json", ""]) {
      await expect(withHeaders(h, call, [ev])).rejects.toThrow(/Unknown sync key/);
    }
  });

  it("a wrong key in the body isn't rescued by a right header", async () => {
    await expect(withHeaders(JSON.stringify({ "x-sync-key": KEY }),
      "select public.sync_events(p_key => 'wrong-key-wrong-key-wrong-key-wrong', p_source => 'church', p_events => $1::jsonb)", [ev]))
      .rejects.toThrow(/Unknown sync key/);
  });

  it("the key and its helpers stay out of reach", async () => {
    await expect(as("anon", "select private.header_sync_key()")).rejects.toThrow(/permission denied/);
    await expect(as("anon", "select private.hash_key('x')")).rejects.toThrow(/permission denied/);
    await expect(as("brother", "select private.header_sync_key()")).rejects.toThrow(/permission denied/);
    await expect(as("anon", "select * from private.sync_keys")).rejects.toThrow(/permission denied/);
    const rls = await db.query("select relrowsecurity from pg_class where oid = 'private.sync_keys'::regclass");
    expect(rls.rows[0].relrowsecurity).toBe(true);
    // The old four-argument version (key first) is gone.
    const old = await db.query("select count(*)::int as n from pg_proc where proname = 'sync_events'");
    expect(old.rows[0].n).toBe(1);
  });

  it("an empty body key falls back to the header", async () => {
    const r = await withHeaders(JSON.stringify({ "x-sync-key": KEY }), "select public.sync_events(p_key => '', p_source => 'church', p_events => $1::jsonb) as n", [ev]);
    expect(r.rows[0].n).toBe(1);
  });

  it("refuses ids over 200 characters, impossible dates, an empty replace and huge lists", async () => {
    const call = (items, replace) => withHeaders(JSON.stringify({ "x-sync-key": KEY }),
      `select public.sync_events(p_source => 'sheet', p_events => $1::jsonb${replace ? ", p_replace_from => '2027-01-01'" : ""})`, [JSON.stringify(items)]);
    await expect(call([{ id: "x".repeat(205), title: "Long id", date: "2027-01-09" }], true)).rejects.toThrow(/200 characters at most/);
    await expect(call([{ id: "bad-date", title: "Bad", date: "2027-02-30" }])).rejects.toThrow(/real date/);
    await expect(call([{ id: "zero", title: "Zero", date: "0000-01-01" }])).rejects.toThrow(/real date/);
    await expect(call([], true)).rejects.toThrow(/empty list/);
    await expect(call(Array.from({ length: 2001 }, (_, i) => ({ id: "n" + i, title: "n", date: "2027-01-09" })))).rejects.toThrow(/Too many/);
    // Nothing from those calls was saved, and the sheet's earlier nights are still there.
    const left = await db.query("select count(*)::int as n from public.events where external_id in ('bad-date', 'zero') or external_id like 'n%' or external_id like 'xxxx%'");
    expect(left.rows[0].n).toBe(0);
  });

  it("odd values are cleaned up instead of stopping the sync", async () => {
    const items = [
      { id: "h2", title: "Bible study at the Hills'", date: "2027-01-07", kind: "bible-study", end_date: "2027-01-01", time: "6:30pm" },
      { id: "h3", title: "x".repeat(300), date: "2027-01-08", kind: "open", url: "https://example.org/" + "a".repeat(600), location: "y".repeat(250) },
      { id: "h4", title: "Retreat", date: "2027-01-09", end_date: "2027-13-01", url: 'https://example.org/"><script>' },
    ];
    await withHeaders(JSON.stringify({ "x-sync-key": KEY }), "select public.sync_events(p_source => 'sheet', p_events => $1::jsonb)", [JSON.stringify(items)]);
    const rows = (await db.query("select external_id, kind, ends_on, time_text, length(title) as t, length(location) as l, url from public.events where external_id in ('h2', 'h3', 'h4') order by external_id")).rows;
    expect(rows).toEqual([
      { external_id: "h2", kind: null, ends_on: null, time_text: "6:30pm", t: 25, l: null, url: null },
      { external_id: "h3", kind: "open", ends_on: null, time_text: null, t: 200, l: 200, url: null },
      { external_id: "h4", kind: null, ends_on: null, time_text: null, t: 7, l: null, url: null },
    ]);
  });
});

describe("every table", () => {
  it("has row-level security turned on", async () => {
    const r = await db.query(`select relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`);
    expect(r.rows).toEqual([]);
  });
});

// In Supabase the SQL Editor runs as the "postgres" role, which owns the
// tables and the sync function but is not a superuser. Apply every migration
// that way in a fresh database, then check the sync still reads the key table
// (row-level security is on) and writes events.
describe("as Supabase sets it up (not a superuser)", () => {
  it("the migrations apply and the sync works", async () => {
    const pg = new PGlite();
    await pg.exec(readFileSync(join(import.meta.dirname, "supabase-stub.sql"), "utf8"));
    await pg.exec(`
      create role owner_like_postgres nologin nosuperuser nobypassrls;
      grant all on schema public to owner_like_postgres;
      grant usage on schema auth to owner_like_postgres;
      grant select, trigger, references on auth.users to owner_like_postgres;
      grant anon, authenticated to owner_like_postgres;
    `);
    const db0 = (await pg.query("select current_database() as d")).rows[0].d;
    await pg.exec(`grant create on database "${db0}" to owner_like_postgres`);
    const r0 = await pg.query("select rolsuper, rolbypassrls from pg_roles where rolname = 'owner_like_postgres'");
    expect(r0.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
    await pg.exec("set role owner_like_postgres");
    for (const f of readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()) {
      await pg.exec(readFileSync(join(migrationsDir, f), "utf8"));
    }
    const KEY = "owner-test-key-0123456789abcdef";
    await pg.query("insert into private.sync_keys (key_hash) values (private.hash_key($1))", [KEY]);
    await pg.exec("reset role");
    await pg.query("select set_config('request.headers', $1, false)", [JSON.stringify({ "x-sync-key": KEY })]);
    await pg.exec("set role anon");
    const r = await pg.query("select public.sync_events(p_source => 'church', p_events => $1::jsonb) as n",
      [JSON.stringify([{ id: "o1", title: "Owner test", date: "2027-02-01" }])]);
    expect(r.rows[0].n).toBe(1);
    await expect(pg.query("select public.sync_events(p_key => 'wrong-key-wrong-key-wrong-key-wrong', p_source => 'church', p_events => '[]'::jsonb)"))
      .rejects.toThrow(/Unknown sync key/);
    await expect(pg.query("select * from private.sync_keys")).rejects.toThrow(/permission denied/);
    await pg.exec("reset role");
    const owner = await pg.query("select tableowner from pg_tables where schemaname = 'private' and tablename = 'sync_keys'");
    expect(owner.rows[0].tableowner).toBe("owner_like_postgres");
    await pg.close();
  });
});

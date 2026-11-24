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
  const tables = ["invites", "members", "families", "requests", "request_updates", "prayers"];
  for (const t of tables) {
    it(`cannot read ${t}`, async () => {
      await expect(as("anon", `select * from public.${t}`)).rejects.toThrow(/permission denied/);
    });
  }
  it("cannot add a request", async () => {
    await expect(as("anon", "insert into public.requests (list, for_name, body) values ('brothers', 'x', 'y')"))
      .rejects.toThrow(/permission denied/);
  });
});

describe("members", () => {
  let familyId, requestId;

  it("can add a family and a lifegroup request", async () => {
    const f = await as("brother", "insert into public.families (name) values ('Weeks') returning id, created_by");
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
      "insert into public.requests (list, for_name, body, created_by) values ('brothers', 'Sam', 'x', $1)", [ids.admin]))
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
    const r = await as("admin", "insert into public.requests (list, for_name, body) values ('brothers', 'Sam', 'Health') returning id");
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
  });
});

describe("removed invite", () => {
  it("loses access to everything", async () => {
    const r = await as("removed", "select * from public.requests");
    expect(r.rows).toEqual([]);
    await expect(as("removed", "insert into public.requests (list, for_name, body) values ('brothers', 'x', 'y')"))
      .rejects.toThrow(/row-level security/);
  });
});

describe("every table", () => {
  it("has row-level security turned on", async () => {
    const r = await db.query(`select relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`);
    expect(r.rows).toEqual([]);
  });
});

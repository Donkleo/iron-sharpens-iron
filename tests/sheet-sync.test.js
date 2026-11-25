// Tests the Google Sheet script (apps-script/sheet-sync.gs) in Node, with
// stand-ins for Google's services, and sends what it builds to the real
// database functions (PGlite) to check they fit together.
import { describe, it, expect, beforeAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";

const root = join(import.meta.dirname, "..");
const source = readFileSync(join(root, "apps-script", "sheet-sync.gs"), "utf8");
const TODAY = "2026-11-25";
const KEY = "test-sync-key-0123456789abcdef0123456789";

// Loads the script with fake Google services. Returns its functions and what it sent.
function load({ tabs, props, respond, locked } = {}) {
  const sent = [];
  const logs = [];
  const triggers = [];
  const sheets = Object.entries(tabs || sampleTabs()).map(([name, rows]) => ({
    getName: () => name,
    getDataRange: () => ({ getDisplayValues: () => rows }),
  }));
  const settings = props || { SUPABASE_URL: "https://abcd1234.supabase.co/", SUPABASE_ANON_KEY: "public-anon", SYNC_KEY: KEY };
  const context = {
    module: { exports: {} },
    Logger: { log: (m) => logs.push(String(m)) },
    LockService: { getScriptLock: () => ({ tryLock: () => !locked, releaseLock: () => {} }) },
    Utilities: { formatDate: () => TODAY },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => settings[k] ?? null }) },
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ({
        getSheets: () => sheets,
        getSheetByName: (n) => sheets.find((s) => s.getName() === n) || null,
      }),
    },
    UrlFetchApp: {
      fetch: (url, opts) => {
        const req = { url, opts, body: JSON.parse(opts.payload) };
        sent.push(req);
        const [code, text] = respond ? respond(req) : [200, "3"];
        return { getResponseCode: () => code, getContentText: () => text };
      },
    },
    ScriptApp: {
      getProjectTriggers: () => triggers.slice(),
      deleteTrigger: (t) => triggers.splice(triggers.indexOf(t), 1),
      newTrigger: (fn) => ({
        timeBased: () => ({
          everyHours: (h) => ({ create: () => triggers.push({ fn, h, getHandlerFunction: () => fn }) }),
        }),
      }),
    },
  };
  vm.runInNewContext(source, context, { filename: "sheet-sync.gs" });
  return { ...context.module.exports, sent, logs, triggers };
}

function sampleTabs() {
  return {
    "2026 Q3": [
      ["Date", "Host", "Address"],
      ["9/1/26", "Old", "1 Past St"],
    ],
    "2026 Q4": [
      ["Lifegroup nights", "", "", ""],
      ["“Iron sharpens iron” Proverbs 27:17", "", "", ""],
      ["Date", "Notes", "Host", "Address "],
      ["11/18/26", "", "Oelkers", "10 Past Rd"],
      ["Tue 11/25/26", "", "Farag's", " 20 Main St "],
      ["12/2/2026", "", "", "30 Should Be Hidden"],
      ["12/9/26", "", "Game Night at Rothers", "40 Fun Ave"],
      ["12/16/26", "", "The Weeks", "50 Oak"],
      ["", "", "", ""],
      ["2/30/26", "", "Nobody", "nowhere"],
    ],
    "2027 Q1": [
      ["Date", "Host", "Time", "Address"],
      ["1/6/27", "O'Neals", "7 PM", "60 Elm"],
    ],
    "2025 Q4": [["Date", "Host"], ["12/1/26", "Too old a tab", ""]],
    Events: [
      ["Newlywed Events Calendar"],
      ["A verse"],
      ["Date", "Time", "Event", "Location", "Address", "Notes"],
      ["12/5/26", "18:30", "Christmas Party!", "Church hall", "70 Pine", "Bring a dish"],
      ["12/6/26", "", "Café Night", "", "", ""],
      ["11/1/26", "6:30 PM", "Past event", "", "", ""],
      ["12/7/26", "", "", "No title", "", ""],
    ],
    Families: [
      ["Families"],
      ["A verse"],
      ["Family", "Husband", "Wife", "Pray for (optional)"],
      ["The Weeks", "Sam", "Ana", "New job"],
      ["", "", "", ""],
      ["Peñas", "Luis", "", ""],
    ],
  };
}

describe("reading the sheet", () => {
  const s = load();
  const { events, families } = s.buildSync(Object.keys(sampleTabs()), (n) => sampleTabs()[n], TODAY);
  const byId = Object.fromEntries(events.map((e) => [e.id, e]));

  it("reads only the two newest quarter tabs", () => {
    expect(s.quarterTabs(["2026 Q3", "2026 Q4", "2027 Q1", "2025 Q4", "Events"])).toEqual(["2027 Q1", "2026 Q4"]);
    expect(byId["sheet-2026-09-01"]).toBeUndefined();
    expect(byId["sheet-2026-12-01"]).toBeUndefined();
  });

  it("finds the header row and columns by name, wherever they are", () => {
    expect(byId["sheet-2026-11-25"]).toMatchObject({
      title: "Bible study at the Farags'", address: "20 Main St", time: "6:30pm", location: "", notes: "",
    });
    expect(byId["sheet-2026-11-25"].kind).toBeUndefined();
  });

  it("leaves out past nights, blank rows and impossible dates", () => {
    expect(byId["sheet-2026-11-18"]).toBeUndefined();
    expect(events.some((e) => e.date === "2026-02-30" || e.title.includes("Nobody"))).toBe(false);
  });

  it("marks a night with no host as open and hides its address", () => {
    expect(byId["sheet-2026-12-02"]).toMatchObject({ title: "Bible study · host needed", kind: "open", address: "" });
  });

  it("keeps an activity's own name and writes family names like the app", () => {
    expect(byId["sheet-2026-12-09"].title).toBe("Game Night at Rothers");
    expect(byId["sheet-2026-12-16"].title).toBe("Bible study at the Weeks'");
    expect(byId["sheet-2027-01-06"]).toMatchObject({ title: "Bible study at the O'Neals'", time: "7pm" });
    expect(s.possessive("Oelkers")).toBe("the Oelkers'");
    expect(s.possessive("Smith")).toBe("the Smiths'");
    expect(s.possessive("Coloms'")).toBe("the Coloms'");
  });

  it("reads the Events tab with its own ids", () => {
    expect(byId["sheet-2026-12-05-christmas-party"]).toEqual({
      id: "sheet-2026-12-05-christmas-party", title: "Christmas Party!", date: "2026-12-05", time: "6:30pm",
      location: "Church hall", address: "70 Pine", notes: "Bring a dish",
    });
    expect(byId["sheet-2026-12-06-cafe-night"]).toMatchObject({ title: "Café Night", time: "" });
    expect(events.some((e) => e.title === "Past event" || e.location === "No title")).toBe(false);
  });

  it("reads families in the sheet's order without a leading The", () => {
    expect(families).toEqual([
      { name: "Weeks", husband: "Sam", wife: "Ana", pray_for: "New job" },
      { name: "Peñas", husband: "Luis", wife: "", pray_for: "" },
    ]);
  });

  it("understands the sheet's date and time styles", () => {
    expect(s.parseDate("10/27/26")).toBe("2026-10-27");
    expect(s.parseDate("Tue 11/3/26")).toBe("2026-11-03");
    expect(s.parseDate("11/17/2026")).toBe("2026-11-17");
    expect(s.parseDate("2026-12-01")).toBe("2026-12-01");
    expect(s.parseDate("13/1/26")).toBe("");
    expect(s.parseDate("TBD")).toBe("");
    expect(s.formatTime("6:30 PM")).toBe("6:30pm");
    expect(s.formatTime("6 p.m.")).toBe("6pm");
    expect(s.formatTime("09:15")).toBe("9:15am");
    expect(s.formatTime("12:00:00")).toBe("12:00pm");
    expect(s.formatTime("After service")).toBe("After service");
    expect(s.slug("  Ünïcode — Night!! ")).toBe("unicode-night");
  });

  it("stops instead of sending when a tab is missing or unreadable", () => {
    const tabs = sampleTabs();
    const run = (t) => () => s.buildSync(Object.keys(t), (n) => t[n], TODAY);
    expect(run({ Events: tabs.Events, Families: tabs.Families })).toThrow(/No quarter tab/);
    expect(run({ "2026 Q4": tabs["2026 Q4"], Families: tabs.Families })).toThrow(/No "Events" tab/);
    expect(run({ "2026 Q4": tabs["2026 Q4"], Events: tabs.Events })).toThrow(/No "Families" tab/);
    expect(run({ ...tabs, "2027 Q1": [["When", "Who"]] })).toThrow(/2027 Q1.*no header row/);
    expect(run({ ...tabs, Events: [["Day", "Event"]] })).toThrow(/Events tab has no header/);
    expect(run({ ...tabs, Families: [["Family", "Husband", "Wife"], ["Weeks", "", ""]] })).toThrow(/no "Pray for" column/);
    expect(run({ ...tabs, Families: [["Family", "Husband", "Prayer"]] })).toThrow(/Family, Husband and Wife/);
    expect(run({ ...tabs, Families: [["Family", "Husband", "Wife", "Pray for"]] })).toThrow(/no families/);
  });

  it("stops when a tab's dates can't be read, so a format change can't clear the calendar", () => {
    const tabs = sampleTabs();
    const run = (t) => () => s.buildSync(Object.keys(t), (n) => t[n], TODAY);
    expect(run({ ...tabs, "2027 Q1": [["Date", "Host"], ["January 6, 2027", "O'Neals"]] })).toThrow(/2027 Q1.*dates can't be read/);
    expect(run({ ...tabs, Events: [["Date", "Event"], ["Dec 5", "Party"]] })).toThrow(/Events tab's dates/);
    // One odd cell among readable dates is just skipped.
    expect(run({ ...tabs, "2027 Q1": [["Date", "Host"], ["TBD", "x"], ["1/6/27", "O'Neals"]] })).not.toThrow();
    expect(s.parseDate("111/3/26")).toBe("");
  });

  it("only removes nights when this quarter's tab is there", () => {
    const tabs = sampleTabs();
    const names = (t) => Object.keys(t);
    expect(s.quarterName("2026-11-25")).toBe("2026 Q4");
    expect(s.buildSync(names(tabs), (n) => tabs[n], TODAY).replace).toBe(true);
    const renamed = { ...tabs };
    renamed["Q4 2026"] = renamed["2026 Q4"];
    delete renamed["2026 Q4"];
    delete renamed["2027 Q1"];
    const r = s.buildSync(names(renamed), (n) => renamed[n], TODAY);
    expect(r.replace).toBe(false);
    expect(r.currentQuarter).toBe("2026 Q4");
  });
});

describe("sending to the site", () => {
  it("sends events and families with the key in the body and only the public key in headers", () => {
    const s = load();
    s.syncLifegroupSheet();
    expect(s.sent.map((r) => r.url)).toEqual([
      "https://abcd1234.supabase.co/rest/v1/rpc/sync_events",
      "https://abcd1234.supabase.co/rest/v1/rpc/sync_families",
    ]);
    for (const r of s.sent) {
      expect(r.opts.method).toBe("post");
      expect(r.opts.headers).toEqual({ apikey: "public-anon" });
      expect(r.opts.followRedirects).toBe(false);
      expect(r.body.p_key).toBe(KEY);
    }
    expect(s.sent[0].body).toMatchObject({ p_source: "sheet", p_replace_from: TODAY });
    expect(s.sent[1].body.p_families[0].pray_for).toBe("New job");
    expect(s.sent[0].body.p_events.length).toBe(7);
    expect(s.sent[1].body.p_families.length).toBe(2);
  });

  it("never writes the key or the sheet's data to the log", () => {
    const s = load();
    s.syncLifegroupSheet();
    const log = s.logs.join("\n");
    expect(log).not.toContain(KEY);
    expect(log).not.toMatch(/Main St|Weeks|Farag|Pine/);
    expect(log).toMatch(/3 upcoming events synced/);
  });

  it("only adds and updates nights when this quarter's tab is missing", () => {
    const tabs = sampleTabs();
    tabs["Q4 2026"] = tabs["2026 Q4"];
    delete tabs["2026 Q4"];
    delete tabs["2027 Q1"];
    const s = load({ tabs });
    s.syncLifegroupSheet();
    expect(s.sent[0].body.p_replace_from).toBeUndefined();
    expect(s.logs.join(" ")).toMatch(/not removed/);
  });

  it("skips a run while another is still going", () => {
    const s = load({ locked: true });
    s.syncLifegroupSheet();
    expect(s.sent).toEqual([]);
    expect(s.logs.join(" ")).toMatch(/skipped/);
  });

  it("is plain text, so copying it on a phone can't damage it", () => {
    expect(/[^\x00-\x7f]/.test(source)).toBe(false);
  });

  it("doesn't send an empty calendar, so a bad read can't clear it", () => {
    const tabs = sampleTabs();
    tabs["2026 Q4"] = [["Date", "Host"]];
    tabs["2027 Q1"] = [["Date", "Host"]];
    tabs.Events = [["Date", "Event"]];
    const s = load({ tabs });
    s.syncLifegroupSheet();
    expect(s.sent.map((r) => r.url.split("/").pop())).toEqual(["sync_families"]);
    expect(s.logs.join(" ")).toMatch(/left as it is/);
  });

  it("stops with a plain message when a setting is missing or odd", () => {
    expect(() => load({ props: { SUPABASE_URL: "https://abcd1234.supabase.co" } }).syncLifegroupSheet())
      .toThrow(/Script properties/);
    expect(() => load({ props: { SUPABASE_URL: "https://abcd.supabase.co/rest/v1", SUPABASE_ANON_KEY: "a", SYNC_KEY: KEY } })
      .syncLifegroupSheet()).toThrow(/nothing after it/);
    expect(() => load({ props: { SUPABASE_URL: "http://abcd.supabase.co", SUPABASE_ANON_KEY: "a", SYNC_KEY: KEY } })
      .syncLifegroupSheet()).toThrow(/should look like/);
    expect(() => load({ props: { SUPABASE_URL: "https://abcd.supabase.co.evil.example", SUPABASE_ANON_KEY: "a", SYNC_KEY: KEY } })
      .syncLifegroupSheet()).toThrow(/should look like/);
  });

  it("stops at the site's refusal, without repeating the key", () => {
    const s = load({ respond: () => [401, JSON.stringify({ message: "Unknown sync key." })] });
    let err;
    try { s.syncLifegroupSheet(); } catch (e) { err = e; }
    expect(err.message).toMatch(/refused sync_events \(401\): Unknown sync key\./);
    expect(err.message).not.toContain(KEY);
    expect(s.sent.length).toBe(1);
  });

  it("setUpSync leaves exactly one hourly trigger and runs once; stopSync removes it", () => {
    const s = load();
    s.setUpSync();
    s.setUpSync();
    expect(s.triggers.map((t) => [t.fn, t.h])).toEqual([["syncLifegroupSheet", 1]]);
    expect(s.sent.length).toBe(4);
    s.stopSync();
    expect(s.triggers).toEqual([]);
  });

  it("is limited to this one spreadsheet", () => {
    expect(source).toMatch(/@OnlyCurrentDoc/);
  });
});

// ---------------------------------------------------------------------------
// The database side: the script's requests against the real migrations
// ---------------------------------------------------------------------------

describe("the site's family sync", () => {
  let db;

  async function asAnon(sql, params = []) {
    await db.exec("reset role");
    await db.query("select set_config('request.jwt.claim.sub', '', false)");
    await db.exec("set role anon");
    try {
      return await db.query(sql, params);
    } finally {
      await db.exec("reset role");
    }
  }
  const syncFamilies = (list, key = KEY) =>
    asAnon("select public.sync_families(p_families => $1::jsonb, p_key => $2) as n", [JSON.stringify(list), key]);
  const families = async () =>
    (await db.query("select name, husband, wife, pray_for, sort_order, since::text, from_sheet from public.families order by name")).rows;

  beforeAll(async () => {
    db = new PGlite();
    await db.exec(readFileSync(join(import.meta.dirname, "supabase-stub.sql"), "utf8"));
    const dir = join(root, "supabase", "migrations");
    for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
      await db.exec(readFileSync(join(dir, f), "utf8"));
    }
    await db.query("insert into private.sync_keys (key_hash, label) values (private.hash_key($1), 'test')", [KEY]);
  });

  it("takes what the script sends, events and families", async () => {
    const s = load();
    s.syncLifegroupSheet();
    const [ev, fam] = s.sent.map((r) => r.body);
    const r = await asAnon(
      "select public.sync_events(p_source => $1, p_events => $2::jsonb, p_replace_from => $3::date, p_key => $4) as n",
      [ev.p_source, JSON.stringify(ev.p_events), ev.p_replace_from, ev.p_key]);
    expect(r.rows[0].n).toBe(7);
    const open = await db.query("select kind, address from public.events where external_id = 'sheet-2026-12-02'");
    expect(open.rows[0]).toEqual({ kind: "open", address: null });
    expect((await syncFamilies(fam.p_families)).rows[0].n).toBe(2);
    const today = (await db.query("select (now() at time zone 'America/Chicago')::date::text as d")).rows[0].d;
    expect(await families()).toEqual([
      { name: "Peñas", husband: "Luis", wife: null, pray_for: null, sort_order: 2, since: today, from_sheet: true },
      { name: "Weeks", husband: "Sam", wife: "Ana", pray_for: "New job", sort_order: 1, since: today, from_sheet: true },
    ]);
  });

  it("never removes a family first added on the site, even after the sheet listed it", async () => {
    await db.exec("insert into public.families (name, created_by) values ('Adopted', null)");
    await syncFamilies([{ name: "Weeks" }, { name: "Peñas" }, { name: "adopted", husband: "Al" }]);
    let a = (await families()).find((f) => f.name === "adopted");
    expect(a).toMatchObject({ from_sheet: true, husband: "Al", since: null });
    await syncFamilies([{ name: "Weeks" }, { name: "Peñas" }]);
    a = (await families()).find((f) => f.name === "adopted");
    expect(a).toMatchObject({ from_sheet: false, sort_order: null });
    await db.exec("delete from public.families where name = 'adopted'");
  });

  it("keeps a family's since, follows the sheet's order and spelling, and keeps site families", async () => {
    await db.exec("update public.families set since = '2026-01-04' where name = 'Weeks'");
    await db.exec("insert into public.families (name, created_by) values ('Site Family', null)");
    await syncFamilies([{ name: "peñas", husband: "Luis", wife: "Maria" }, { name: "Weeks", husband: "Sam", wife: "Ana" }]);
    const rows = await families();
    expect(rows.find((f) => f.name === "Weeks")).toMatchObject({ since: "2026-01-04", sort_order: 2, pray_for: null });
    expect(rows.find((f) => f.name === "peñas")).toMatchObject({ wife: "Maria", sort_order: 1 });
    expect(rows.find((f) => f.name === "Site Family")).toMatchObject({ from_sheet: false, since: null });
  });

  it("removes a family taken off the sheet, but keeps one that has prayers", async () => {
    await syncFamilies([{ name: "Weeks" }, { name: "Gone" }, { name: "Has Prayers" }]);
    const hp = (await db.query("select id from public.families where name = 'Has Prayers'")).rows[0].id;
    await db.query("insert into public.requests (list, family_id, body) values ('lifegroup', $1, 'x')", [hp]);
    await syncFamilies([{ name: "Weeks" }]);
    const rows = await families();
    expect(rows.map((f) => f.name)).toEqual(["Has Prayers", "Site Family", "Weeks"]);
    expect(rows.find((f) => f.name === "Has Prayers")).toMatchObject({ from_sheet: false, sort_order: null });
    // It joins the sheet again later without losing its since.
    await syncFamilies([{ name: "Weeks" }, { name: "Has Prayers" }]);
    expect((await families()).find((f) => f.name === "Has Prayers")).toMatchObject({ from_sheet: true, sort_order: 2 });
  });

  it("refuses a wrong key, an empty or huge list and nameless families, changing nothing", async () => {
    const before = await families();
    await expect(syncFamilies([{ name: "X" }], "wrong-key-0123456789abcdefghij")).rejects.toThrow(/Unknown sync key/);
    await expect(syncFamilies([{ name: "X" }], "")).rejects.toThrow(/Unknown sync key/);
    await expect(syncFamilies([])).rejects.toThrow(/empty list/);
    await expect(syncFamilies(Array.from({ length: 301 }, (_, i) => ({ name: "F" + i })))).rejects.toThrow(/300 at most/);
    await expect(syncFamilies([{ name: "Ok" }, { name: "  " }])).rejects.toThrow(/needs a name/);
    await expect(syncFamilies([{ name: "x".repeat(81) }])).rejects.toThrow(/needs a name/);
    await expect(syncFamilies(["Weeks"])).rejects.toThrow(/needs a name/);
    await expect(asAnon("select public.sync_families(p_families => '{}'::jsonb, p_key => $1)", [KEY])).rejects.toThrow(/JSON array/);
    expect(await families()).toEqual(before);
  });

  it("shortens over-long details instead of failing", async () => {
    await syncFamilies([{ name: "Weeks", husband: "h".repeat(100), pray_for: "p".repeat(2100) }]);
    const w = (await families()).find((f) => f.name === "Weeks");
    expect(w.husband.length).toBe(80);
    expect(w.pray_for.length).toBe(2000);
  });

  it("accepts the key from the x-sync-key header too", async () => {
    await db.query("select set_config('request.headers', $1, false)", [JSON.stringify({ "x-sync-key": KEY })]);
    try {
      expect((await syncFamilies([{ name: "Weeks" }], null)).rows[0].n).toBe(1);
    } finally {
      await db.query("select set_config('request.headers', '', false)");
    }
  });

  it("keeps the key check and the new columns away from the public and members", async () => {
    await expect(asAnon("select private.check_sync_key($1)", [KEY])).rejects.toThrow(/permission denied/);
    await expect(asAnon("select husband from public.families")).rejects.toThrow(/permission denied/);
    await db.exec("set role authenticated");
    try {
      await expect(db.query("update public.families set husband = 'x'")).rejects.toThrow(/permission denied/);
      await expect(db.query("insert into public.families (name, since, from_sheet) values ('Z', '2020-01-01', true)"))
        .rejects.toThrow(/permission denied/);
    } finally {
      await db.exec("reset role");
    }
  });
});

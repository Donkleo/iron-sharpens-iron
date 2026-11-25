import { describe, it, expect } from "vitest";
import {
  prayerWeekStart, inThisWeek, weekFrom, thisWeek, latestByFamily, isCurrent, needsPrayer,
  prayersByRequest, iPrayedThisWeek, groupBy, matchesSearch, cleanFamilyName, esc, isEmail, ago,
  upcomingEvents, eventsFor, dateRange, eventEnd, calendarLink, mapsLink, safeUrl, dateBlock,
} from "../src/logic.js";

// Wednesday Nov 25, 2026, noon local time.
const now = new Date(2026, 10, 25, 12);
const req = (o) => ({ status: "active", created_at: "2026-11-20T12:00:00Z", ...o });

describe("prayer week", () => {
  it("starts on Sunday", () => {
    expect(prayerWeekStart(now)).toEqual(new Date(2026, 10, 22));
  });
  it("counts prayers since Sunday only", () => {
    expect(inThisWeek(new Date(2026, 10, 22, 9).toISOString(), now)).toBe(true);
    expect(inThisWeek(new Date(2026, 10, 21, 23).toISOString(), now)).toBe(false);
    expect(inThisWeek(null, now)).toBe(false);
  });
});

describe("this week", () => {
  const requests = [
    req({ id: "a", list: "lifegroup", family_id: "f1", sheet_date: "2026-11-22", body: "a" }),
    req({ id: "b", list: "lifegroup", family_id: "f1", sheet_date: "2026-11-15", body: "b" }),
    req({ id: "c", list: "lifegroup", family_id: "f2", sheet_date: "2026-11-22", body: "c", status: "answered" }),
    req({ id: "d", list: "brothers", for_name: "Alex", body: "d" }),
  ];
  const label = (r) => r.family_id || r.for_name;

  it("starts at the newest prayer sheet", () => {
    expect(weekFrom(requests, now)).toBe("2026-11-22");
  });
  it("falls back to the last seven days when the newest sheet is old", () => {
    expect(weekFrom([req({ list: "lifegroup", sheet_date: "2026-10-01" })], now)).toBe("2026-11-18");
  });
  it("lists open requests from that sheet plus open brothers requests", () => {
    const wk = thisWeek(requests, label, now);
    expect(wk.lifegroup.map((r) => r.id)).toEqual(["a"]);
    expect(wk.brothers.map((r) => r.id)).toEqual(["d"]);
  });
  it("treats only a family's newest request as current", () => {
    const latest = latestByFamily(requests);
    expect(isCurrent(requests[0], latest)).toBe(true);
    expect(isCurrent(requests[1], latest)).toBe(false);
  });
});

describe("I prayed", () => {
  const prayers = [
    { request_id: "a", member_id: "me", prayed_at: new Date(2026, 10, 23).toISOString() },
    { request_id: "b", member_id: "other", prayed_at: new Date(2026, 10, 10).toISOString() },
  ];
  const by = prayersByRequest(prayers);
  const r = req({ id: "a", list: "brothers", for_name: "Alex" });

  it("knows when I prayed this week", () => {
    expect(iPrayedThisWeek(by.get("a"), "me", now)).toBe(true);
    expect(iPrayedThisWeek(by.get("a"), "other", now)).toBe(false);
    expect(iPrayedThisWeek(by.get("b"), "other", now)).toBe(false);
  });
  it("flags a current request nobody prayed for this week", () => {
    const latest = new Map();
    expect(needsPrayer(r, by.get("a"), latest, now)).toBe(false);
    expect(needsPrayer({ ...r, id: "b" }, by.get("b"), latest, now)).toBe(true);
    expect(needsPrayer({ ...r, id: "z" }, undefined, latest, now)).toBe(true);
  });
});

describe("grouping and search", () => {
  it("groups A to Z with newest first", () => {
    const rs = [
      req({ id: 1, for_name: "Zed", sheet_date: "2026-11-01" }),
      req({ id: 2, for_name: "adam", sheet_date: "2026-11-01" }),
      req({ id: 3, for_name: "Zed", sheet_date: "2026-11-08" }),
    ];
    const g = groupBy(rs, (r) => r.for_name.toLowerCase(), (r) => r.for_name);
    expect(g.map((x) => x.label)).toEqual(["adam", "Zed"]);
    expect(g[1].items.map((x) => x.id)).toEqual([3, 1]);
  });
  it("searches the name, request and updates", () => {
    const r = req({ body: "New job interview", for_name: "Alex" });
    const label = (x) => x.for_name;
    expect(matchesSearch(r, "job alex", label)).toBe(true);
    expect(matchesSearch(r, "surgery", label)).toBe(false);
    expect(matchesSearch(r, "surgery", label, () => [{ body: "Surgery went well" }])).toBe(true);
    expect(matchesSearch(r, "  ", label)).toBe(true);
  });
});

describe("small helpers", () => {
  it("cleans family names from the sheet", () => {
    expect(cleanFamilyName("  The Smith:  ")).toBe("Smith");
    expect(cleanFamilyName("Garcia –")).toBe("Garcia");
  });
  it("escapes text before it goes on the page", () => {
    expect(esc(`<img src=x onerror="a">'`)).toBe("&lt;img src=x onerror=&quot;a&quot;&gt;&#39;");
  });
  it("checks emails", () => {
    expect(isEmail("a@b.co")).toBe(true);
    expect(isEmail("nope")).toBe(false);
  });
  it("says how long ago", () => {
    expect(ago(new Date(2026, 10, 24).toISOString(), now)).toBe("yesterday");
    expect(ago(null, now)).toBe("never");
  });
});

import {
  ENCOURAGE, encourager, updatedForMe, prayedCurrent, undoIds, similarOpen, ownerKey,
  weekPulse, weekNews, monthLabel,
} from "../src/logic.js";

describe("verse after I prayed", () => {
  it("hands out every verse in turn", () => {
    const next = encourager(0);
    const seen = ENCOURAGE.map(() => next());
    expect(seen).toEqual(ENCOURAGE);
    expect(next()).toBe(ENCOURAGE[0]);
  });
});

describe("updates bring a prayer back", () => {
  const r = req({ id: "a", list: "brothers", for_name: "Alex" });
  const mine = (id, d) => ({ id, request_id: "a", member_id: "me", prayed_at: new Date(2026, 10, d, 9).toISOString() });
  const upd = (d, by = "other") => ({ request_id: "a", created_by: by, created_at: new Date(2026, 10, d, 10).toISOString(), body: "news" });

  it("shows Pray again when someone shares news after I prayed", () => {
    expect(updatedForMe(r, [mine("p1", 22)], [upd(23)], "me", now)).toBe(true);
    expect(prayedCurrent(r, [mine("p1", 22)], [upd(23)], "me", now)).toBe(false);
  });
  it("ignores my own updates, older news and answered prayers", () => {
    expect(updatedForMe(r, [mine("p1", 22)], [upd(23, "me")], "me", now)).toBe(false);
    expect(updatedForMe(r, [mine("p1", 24)], [upd(23)], "me", now)).toBe(false);
    expect(updatedForMe({ ...r, status: "answered" }, [mine("p1", 22)], [upd(23)], "me", now)).toBe(false);
    expect(updatedForMe(r, [], [upd(23)], "me", now)).toBe(false);
  });
  it("undo after Pray again takes back only the new prayer", () => {
    expect(undoIds([mine("p1", 22), mine("p2", 24)], [upd(23)], "me", now)).toEqual(["p2"]);
    expect(undoIds([mine("p1", 22), mine("p2", 24)], [], "me", now).sort()).toEqual(["p1", "p2"]);
    expect(undoIds([mine("p1", 22)], [upd(23)], "me", now)).toEqual(["p1"]);
  });
});

describe("similar prayers", () => {
  const rs = [
    req({ id: "1", list: "lifegroup", family_id: "f1", body: "Job interview Monday" }),
    req({ id: "2", list: "lifegroup", family_id: "f1", body: "Second interview went well" }),
    req({ id: "3", list: "lifegroup", family_id: "f2", body: "Interview for a new role" }),
    req({ id: "4", list: "lifegroup", family_id: "f1", body: "Interview again", status: "answered" }),
    req({ id: "5", list: "lifegroup", family_id: "f1", body: "Healing for Grandma" }),
  ];
  it("finds open prayers for the same family that share a word", () => {
    expect(similarOpen(rs[0], rs).map((r) => r.id)).toEqual(["2"]);
  });
  it("keys people by member or by name", () => {
    expect(ownerKey({ list: "brothers", for_member: "m1" })).toBe("m:m1");
    expect(ownerKey({ list: "brothers", for_name: " Alex " })).toBe("n:alex");
  });
});

describe("this week's numbers and news", () => {
  const rs = [
    req({ id: "a", list: "brothers", for_name: "A" }),
    req({ id: "b", list: "brothers", for_name: "B" }),
    req({ id: "c", list: "brothers", for_name: "C", status: "answered", answered_at: new Date(2026, 10, 24).toISOString(), answered_by: "x", answered_note: "Yes" }),
    req({ id: "d", list: "brothers", for_name: "D", status: "answered", answered_at: new Date(2026, 9, 1).toISOString() }),
  ];
  const by = prayersByRequest([
    { request_id: "a", member_id: "m1", prayed_at: new Date(2026, 10, 23).toISOString() },
    { request_id: "a", member_id: "m2", prayed_at: new Date(2026, 10, 24).toISOString() },
    { request_id: "b", member_id: "m1", prayed_at: new Date(2026, 10, 10).toISOString() },
  ]);
  it("counts requests covered, prayers and people since Sunday", () => {
    expect(weekPulse(rs.slice(0, 2), rs, by, now)).toEqual({ total: 2, covered: 1, lifted: 2, people: 2 });
  });
  it("lists the last week's updates and answers, newest first", () => {
    const ups = { b: [{ request_id: "b", created_by: "m1", created_at: new Date(2026, 10, 25, 8).toISOString(), body: "Better" }] };
    const news = weekNews(rs, (r) => ups[r.id] || [], now);
    expect(news.map((n) => [n.r.id, n.kind])).toEqual([["b", "update"], ["c", "answer"]]);
  });
  it("labels months, with the year when it differs", () => {
    expect(monthLabel("2026-11", now)).toBe("Nov");
    expect(monthLabel("2025-12", now)).toBe("Dec ’25");
  });
});

describe("calendar", () => {
  const ev = (o) => ({ id: o.title, hidden: false, source: "group", ...o });
  const events = [
    ev({ title: "Retreat", starts_on: "2026-11-24", ends_on: "2026-11-26" }), // started yesterday, still on
    ev({ title: "Late breakfast", starts_on: "2026-11-28", time_text: "9:00 AM" }),
    ev({ title: "Early breakfast", starts_on: "2026-11-28", time_text: "7:00 AM" }),
    ev({ title: "Far off", starts_on: "2026-12-20" }),
    ev({ title: "Last week", starts_on: "2026-11-18" }),
    ev({ title: "Hidden", starts_on: "2026-11-27", hidden: true }),
  ];

  it("Coming up lists the next two weeks, soonest first, without hidden ones", () => {
    expect(upcomingEvents(events, 14, now).map((e) => e.title)).toEqual(["Retreat", "Early breakfast", "Late breakfast"]);
  });

  it("splits the Calendar tab into upcoming, past and hidden", () => {
    expect(eventsFor(events, "upcoming", now).map((e) => e.title)).toEqual(["Retreat", "Early breakfast", "Late breakfast", "Far off"]);
    expect(eventsFor(events, "past", now).map((e) => e.title)).toEqual(["Last week"]);
    expect(eventsFor(events, "hidden", now).map((e) => e.title)).toEqual(["Hidden"]);
  });

  it("sorts same-day events by clock time, not by the text", () => {
    const day = [ev({ title: "Supper", starts_on: "2026-11-28", time_text: "6:30 PM" }), ev({ title: "Brunch", starts_on: "2026-11-28", time_text: "10:00 AM" }),
      ev({ title: "Run", starts_on: "2026-11-28", time_text: "7:00am" }), ev({ title: "All day", starts_on: "2026-11-28" })];
    expect(upcomingEvents(day, 14, now).map((e) => e.title)).toEqual(["All day", "Run", "Brunch", "Supper"]);
  });

  it("Coming up reaches the 14th day even across a clock change", () => {
    const beforeDst = new Date(2026, 9, 30, 12); // Oct 30; clocks change on Nov 1 in the US
    expect(upcomingEvents([ev({ title: "Two weeks out", starts_on: "2026-11-13" })], 14, beforeDst)).toHaveLength(1);
  });

  it("ignores an end day before the start", () => {
    expect(eventEnd({ starts_on: "2026-11-28", ends_on: "2026-11-20" })).toBe("2026-11-28");
  });

  it("writes date ranges", () => {
    expect(dateRange({ starts_on: "2026-12-04", ends_on: "2026-12-06" })).toMatch(/Dec 4.6/);
    expect(dateRange({ starts_on: "2026-11-30", ends_on: "2026-12-02" })).toMatch(/Nov 30 . Dec 2/);
    expect(dateRange({ starts_on: "2026-11-28" })).toMatch(/Sat/);
    expect(dateBlock("2026-11-28")).toMatchObject({ day: 28 });
  });

  it("fills in a Google Calendar event, all day, through the last day", () => {
    const u = new URL(calendarLink({ title: "Retreat", starts_on: "2026-12-04", ends_on: "2026-12-06", time_text: "6 PM", location: "Camp" }));
    expect(u.searchParams.get("dates")).toBe("20261204/20261207");
    expect(u.searchParams.get("details")).toBe("Time: 6 PM");
    expect(u.searchParams.get("location")).toBe("Camp");
  });

  it("only links to https pages", () => {
    expect(safeUrl("javascript:alert(1)")).toBe("");
    expect(safeUrl("http://example.org")).toBe("");
    expect(safeUrl("https://example.org")).toBe("https://example.org");
    expect(mapsLink("12 Oak St & 2nd")).toContain("12%20Oak%20St%20%26%202nd");
  });
});

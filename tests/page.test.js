// @vitest-environment jsdom
// Renders the page with a fake database to check the main screens and buttons.
import { describe, it, expect, vi, beforeAll } from "vitest";
import { ENCOURAGE } from "../src/logic.js";

const me = "11111111-1111-1111-1111-111111111111";
const sunday = new Date();
sunday.setDate(sunday.getDate() - sunday.getDay());
const ymd = (d) => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
const sheet = ymd(sunday);
const oldSheet = ymd(new Date(sunday.getTime() - 14 * 86400000));

const data = {
  members: [{ id: me, display_name: "Me" }],
  families: [{ id: "f1", name: "Smith" }],
  requests: [
    { id: "r1", list: "lifegroup", family_id: "f1", body: "New job <b>soon</b> interview", sheet_date: sheet, status: "active", created_by: me, created_at: new Date().toISOString() },
    { id: "r2", list: "brothers", for_name: "Alex", body: "Healing", status: "active", created_by: "someone-else", created_at: new Date().toISOString() },
    { id: "r3", list: "lifegroup", family_id: "f1", body: "Second interview Friday", sheet_date: oldSheet, status: "active", created_by: "someone-else", created_at: new Date(sunday.getTime() - 14 * 86400000).toISOString() },
  ],
  updates: [],
  prayers: [],
  calendarReady: true,
  events: [
    { id: "e1", title: "Saturday breakfast", starts_on: ymd(new Date(Date.now() + 2 * 86400000)), time_text: "7:00 AM", location: "Diner", source: "group", hidden: false, created_by: me },
    { id: "e2", title: "Bible study <i>night</i>", starts_on: ymd(new Date(Date.now() + 3 * 86400000)), address: "12 Oak St", source: "sheet", hidden: false, created_by: null },
    { id: "e3", title: "Christmas Eve service", starts_on: ymd(new Date(Date.now() + 40 * 86400000)), url: "javascript:alert(1)", source: "church", hidden: false, created_by: null },
    { id: "e4", title: "Old church event", starts_on: ymd(new Date(Date.now() + 5 * 86400000)), source: "church", hidden: true, created_by: null },
  ],
};

let authCallback;
vi.mock("../src/supabase.js", () => ({
  configured: true,
  supabase: {
    auth: {
      onAuthStateChange: (cb) => { authCallback = cb; },
      signOut: vi.fn(),
      signInWithOtp: vi.fn(async () => ({ error: null })),
      verifyOtp: vi.fn(async () => ({ error: null })),
    },
  },
}));

const api = vi.hoisted(() => ({}));
vi.mock("../src/api.js", () => api);
Object.assign(api, {
  amIMember: vi.fn(async () => true),
  amIAdmin: vi.fn(async () => false),
  loadAll: vi.fn(async () => structuredClone(data)),
  loadInvites: vi.fn(async () => []),
  markPrayed: vi.fn(async () => {}),
  undoPrayed: vi.fn(async () => {}),
  addRequest: vi.fn(async () => {}),
  familyId: vi.fn(async () => "f1"),
  addUpdate: vi.fn(async () => {}),
  setAnswered: vi.fn(async () => {}),
  reopen: vi.fn(async () => {}),
  deleteRequest: vi.fn(async () => {}),
  addInvite: vi.fn(async () => {}),
  removeInvite: vi.fn(async () => {}),
  addEvent: vi.fn(async () => {}),
  deleteEvent: vi.fn(async () => {}),
  setEventHidden: vi.fn(async () => {}),
});

const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => { for (let i = 0; i < 5; i++) await tick(); };
const app = () => document.querySelector("#app");
const toast = () => document.querySelector("#toast").textContent;
const click = (sel) => app().querySelector(sel).dispatchEvent(new MouseEvent("click", { bubbles: true }));
const submit = (form) => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
const openDetails = (d) => { d.open = true; d.dispatchEvent(new Event("toggle")); };

beforeAll(async () => {
  document.body.innerHTML = `<main id="app"></main><div id="toast" hidden></div>`;
  window.scrollTo = () => {};
  await import("../src/main.js");
});

describe("signed out", () => {
  it("asks for an email and sends a code, with the link back to the home page", async () => {
    const { supabase } = await import("../src/supabase.js");
    authCallback("INITIAL_SESSION", null);
    expect(app().textContent).toContain("Email me a sign-in code");
    const form = app().querySelector('form[data-form="sign-in"]');
    form.querySelector("input").value = "Friend@Example.com";
    submit(form);
    await settle();
    expect(supabase.auth.signInWithOtp).toHaveBeenCalledWith({
      email: "friend@example.com",
      options: { emailRedirectTo: new URL(import.meta.env.BASE_URL, window.location.origin).href },
    });
    expect(app().textContent).toContain("Check your email");
  });

  it("signs in with the code from the email", async () => {
    const { supabase } = await import("../src/supabase.js");
    const form = app().querySelector('form[data-form="code"]');
    const box = form.querySelector('input[name="code"]');
    expect(box.getAttribute("autocomplete")).toBe("one-time-code");
    box.value = "123 456";
    submit(form);
    await settle();
    expect(supabase.auth.verifyOtp).toHaveBeenCalledWith({ email: "friend@example.com", token: "123456", type: "email" });
  });

  it("explains a code that didn't work", async () => {
    const { supabase } = await import("../src/supabase.js");
    supabase.auth.verifyOtp.mockResolvedValueOnce({ error: { message: "Token has expired or is invalid" } });
    const form = app().querySelector('form[data-form="code"]');
    form.querySelector('input[name="code"]').value = "000000";
    submit(form);
    await settle();
    expect(toast()).toContain("That code didn't work");
    expect(app().querySelector('form[data-form="code"]')).not.toBeNull();
  });
});

describe("signed in", () => {
  beforeAll(async () => {
    authCallback("SIGNED_IN", { user: { id: me, email: "leo@example.com" } });
    await settle();
  });

  it("shows this week's summary with Pray now and who you are", () => {
    expect(app().textContent).toContain("0 of 2");
    expect(app().querySelector('[data-act="pn-open"]')).not.toBeNull();
    expect(app().querySelector(".mecard").textContent).toContain("You’re Me");
  });

  it("shows this week's prayers in fold-out sections, escaped", () => {
    const lg = app().querySelector('details[data-drop="lg"]');
    expect(lg.textContent).toContain("New job <b>soon</b> interview");
    expect(lg.textContent).not.toContain("Second interview");
    expect(app().querySelector(".row b")).toBeNull();
  });

  it("hides the Invites tab from non-admins", () => {
    expect(app().querySelector('[data-tab="group"]')).toBeNull();
  });

  it("shows a verse after I prayed", async () => {
    click('[data-act="prayed"][data-id="r1"]');
    await settle();
    expect(api.markPrayed).toHaveBeenCalledWith("r1");
    expect(ENCOURAGE.some((v) => toast().includes(v))).toBe(true);
    // The page redraws, and focus goes back to the same button.
    expect(document.activeElement.matches('[data-act="prayed"][data-id="r1"]')).toBe(true);
  });

  it("thanks you when that covers every request this week", async () => {
    // Someone else prayed for r1; the next reload picks that up.
    data.prayers = [{ id: "p1", request_id: "r1", member_id: "someone-else", prayed_at: new Date().toISOString() }];
    click('[data-act="prayed"][data-id="r2"]');
    await settle();
    click('[data-act="prayed"][data-id="r2"]');
    await settle();
    expect(toast()).toContain("That covers every request this week");
    data.prayers = [];
    click('[data-act="prayed"][data-id="r2"]');
    await settle();
  });

  it("runs Pray now one prayer at a time and closes with Escape", async () => {
    api.markPrayed.mockClear();
    click('[data-act="pn-open"]');
    const dialog = app().querySelector('.praynow[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(document.body.classList.contains("noscroll")).toBe(true);
    expect(app().querySelector(".pn-step").textContent).toBe("1 of 2");
    click('[data-act="pn-pray"]');
    await settle();
    expect(api.markPrayed).toHaveBeenCalledTimes(1);
    expect(app().querySelector(".pn-step").textContent).toBe("2 of 2");
    click('[data-act="pn-skip"]');
    expect(app().querySelector(".pn-done")).not.toBeNull();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(app().querySelector(".praynow")).toBeNull();
    expect(document.body.classList.contains("noscroll")).toBe(false);
  });

  it("only offers Delete on requests you added", () => {
    click('[data-tab="lifegroup"]');
    openDetails(app().querySelector("details.person"));
    const rowsWithDelete = [...app().querySelectorAll(".row")].filter((r) => r.querySelector('[data-act="confirm"]'));
    expect(rowsWithDelete.map((r) => r.querySelector(".text").textContent)).toEqual(["New job <b>soon</b> interview"]);
  });

  it("filters Lifegroup by family with chips", () => {
    click('[data-family="f1"]');
    expect(app().querySelector(".group-head h3").textContent).toBe("Smith");
    expect(app().querySelector('[data-famdate]')).not.toBeNull();
    click('[data-family="all"]');
  });

  it("keeps a group open while you share an update", () => {
    const g = app().querySelector("details.person");
    openDetails(g);
    click('[data-act="open-update"][data-id="r1"]');
    const after = app().querySelector("details.person");
    expect(after.open).toBe(true);
    expect(after.querySelector('form[data-form="update"]')).not.toBeNull();
  });

  it("adds a new prayer for the same family from an update", async () => {
    const form = app().querySelector('form[data-form="update"]');
    form.querySelector("textarea").value = "Got the job! Now the move.";
    form.querySelector('input[value="new"]').checked = true;
    form.querySelector('input[name="orig_done"]').checked = true;
    submit(form);
    await settle();
    expect(api.addRequest).toHaveBeenCalledWith({ list: "lifegroup", family_id: "f1", body: "Got the job! Now the move.", sheet_date: null });
    expect(api.setAnswered).toHaveBeenCalledWith("r1", "Got the job! Now the move.");
  });

  it("offers similar open prayers when one is answered", async () => {
    api.setAnswered.mockClear();
    openDetails(app().querySelector("details.person"));
    click('[data-act="open-answer"][data-id="r1"]');
    const form = app().querySelector('form[data-form="answer"]');
    const also = form.querySelector('input[name="also"]');
    expect(also.value).toBe("r3");
    also.checked = true;
    form.querySelector("textarea").value = "Hired";
    submit(form);
    await settle();
    expect(api.setAnswered.mock.calls).toEqual([["r1", "Hired"], ["r3", "Hired"]]);
  });

  it("searches and marks several answered together", async () => {
    api.setAnswered.mockClear();
    const box = app().querySelector('[data-search="lifegroup"]');
    box.value = "interview";
    box.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 250));
    expect(app().querySelectorAll(".pick").length).toBe(2);
    click('[data-act="pick-all"]');
    submit(app().querySelector('form[data-form="bulk"]'));
    await settle();
    expect(api.setAnswered).toHaveBeenCalledTimes(2);
    const b = app().querySelector('[data-search="lifegroup"]');
    b.value = "";
    b.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 250));
  });

  it("opens the Brothers tab and adds a request inline", async () => {
    click('[data-tab="brothers"]');
    expect(app().textContent).toContain("Alex");
    expect(app().querySelector('[data-man="n:alex"]')).not.toBeNull();
    click('[data-man="n:alex"]');
    click('[data-act="add-open"]');
    const form = app().querySelector('form[data-form="add-person"]');
    form.querySelector("textarea").value = "Travel";
    submit(form);
    await settle();
    expect(api.addRequest).toHaveBeenCalledWith({ list: "brothers", for_name: "Alex", body: "Travel" });
  });
});

describe("calendar", () => {
  it("shows Coming up on This week, without hidden or far-off events", () => {
    click('[data-tab="week"]');
    const text = app().textContent;
    expect(text).toContain("Coming up");
    expect(text).toContain("Saturday breakfast");
    expect(text).toContain("Bible study <i>night</i>");
    expect(text).not.toContain("Christmas Eve service");
    expect(text).not.toContain("Old church event");
  });

  it("has a Calendar tab in place of Invites, like the app", () => {
    const tabs = [...app().querySelectorAll(".tab")].map((t) => t.dataset.tab);
    expect(tabs).toEqual(["week", "lifegroup", "brothers", "calendar"]);
    expect(app().querySelector('[data-tab="calendar"]').textContent.trim()).toBe("Calendar");
    click('[data-tab="calendar"]');
    expect(app().querySelector("#panel-calendar").textContent).toContain("Christmas Eve service");
    expect(app().querySelector('[data-when="hidden"]')).toBeNull();
    expect(app().textContent).not.toContain("Old church event");
  });

  it("never links to a non-https page", () => {
    expect(app().querySelector('a[href^="javascript"]')).toBeNull();
  });

  it("opens a sheet event's details with the address and Maps", () => {
    click('[data-act="ev-details"][data-id="e2"]');
    const d = app().querySelector(".ev-details");
    expect(d.textContent).toContain("12 Oak St");
    expect(d.querySelector('a[href^="https://www.google.com/maps/"]')).not.toBeNull();
  });

  it("only shows Hide on church events to admins", () => {
    expect(app().querySelector('[data-act="confirm"][data-id="ev:e3"]')).toBeNull();
  });

  it("adds a group event, and keeps what was typed if saving fails", async () => {
    api.addEvent.mockRejectedValueOnce(new Error("Couldn't reach it"));
    let form = app().querySelector('form[data-form="event"]');
    form.closest("details").open = true;
    form.querySelector('[name="title"]').value = "Workday at Mike's";
    form.querySelector('[name="starts_on"]').value = "2026-12-12";
    form.querySelector('[name="time_text"]').value = "8:00 AM";
    submit(form);
    await settle();
    form = app().querySelector('form[data-form="event"]');
    expect(form.closest("details").open).toBe(true);
    expect(form.querySelector('[name="title"]').value).toBe("Workday at Mike's");
    submit(form);
    await settle();
    expect(api.addEvent).toHaveBeenLastCalledWith({ title: "Workday at Mike's", starts_on: "2026-12-12", time_text: "8:00 AM", location: null });
    expect(toast()).toBe("Event added.");
    expect(app().querySelector('form[data-form="event"] [name="title"]').value).toBe("");
  });

  it("deletes your own group event after asking", async () => {
    click('[data-act="confirm"][data-id="ev:e1"]');
    expect(app().textContent).toContain("Delete this event for everyone?");
    click('[data-act="ev-del"][data-id="e1"]');
    await settle();
    expect(api.deleteEvent).toHaveBeenCalledWith("e1");
  });

  it("shows past events", () => {
    click('[data-act="when"][data-when="past"]');
    expect(app().textContent).toContain("No past events.");
  });
});

describe("calendar for an admin", () => {
  beforeAll(async () => {
    api.amIAdmin.mockResolvedValue(true);
    authCallback("SIGNED_OUT", null);
    authCallback("SIGNED_IN", { user: { id: me, email: "leo@example.com" } });
    await settle();
  });

  it("opens the invite list from the footer", () => {
    click('[data-tab="calendar"]');
    click('.foot [data-act="tab"][data-tab="group"]');
    expect(app().textContent).toContain("Invite someone");
    expect(app().querySelector('.tab[aria-selected="true"]')).toBeNull();
  });

  it("hides a church event and brings a hidden one back", async () => {
    click('[data-tab="calendar"]');
    click('[data-act="confirm"][data-id="ev:e3"]');
    click('[data-act="ev-hide"][data-id="e3"]');
    await settle();
    expect(api.setEventHidden).toHaveBeenCalledWith("e3", true);
    click('[data-act="when"][data-when="hidden"]');
    expect(app().textContent).toContain("Old church event");
    click('[data-act="ev-unhide"][data-id="e4"]');
    await settle();
    expect(api.setEventHidden).toHaveBeenCalledWith("e4", false);
  });

  it("says when the calendar's setup step hasn't run", async () => {
    api.loadAll.mockResolvedValueOnce({ ...structuredClone(data), events: [], calendarReady: false });
    click('[data-act="ev-unhide"][data-id="e4"]');
    await settle();
    expect(app().textContent).toContain("The calendar is almost ready");
    click('[data-tab="week"]');
    expect(app().textContent).not.toContain("Coming up");
  });
});

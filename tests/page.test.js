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

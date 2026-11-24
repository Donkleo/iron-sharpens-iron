// @vitest-environment jsdom
// Renders the page with a fake database to check the main screens and buttons.
import { describe, it, expect, vi, beforeAll } from "vitest";

const me = "11111111-1111-1111-1111-111111111111";
const sunday = new Date();
sunday.setDate(sunday.getDate() - sunday.getDay());
const sheet = sunday.getFullYear() + "-" + String(sunday.getMonth() + 1).padStart(2, "0") + "-" + String(sunday.getDate()).padStart(2, "0");

const data = {
  members: [{ id: me, display_name: "Me" }],
  families: [{ id: "f1", name: "Smith" }],
  requests: [
    { id: "r1", list: "lifegroup", family_id: "f1", body: "New job <b>soon</b>", sheet_date: sheet, status: "active", created_by: me, created_at: new Date().toISOString() },
    { id: "r2", list: "brothers", for_name: "Alex", body: "Healing", status: "active", created_by: "someone-else", created_at: new Date().toISOString() },
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
const app = () => document.querySelector("#app");
const click = (sel) => app().querySelector(sel).dispatchEvent(new MouseEvent("click", { bubbles: true }));

beforeAll(async () => {
  document.body.innerHTML = `<main id="app"></main><div id="toast" hidden></div>`;
  await import("../src/main.js");
});

describe("signed out", () => {
  it("asks for an email", async () => {
    authCallback("INITIAL_SESSION", null);
    expect(app().textContent).toContain("Email me a sign-in link");
  });
});

describe("signed in", () => {
  beforeAll(async () => {
    authCallback("SIGNED_IN", { user: { id: me, email: "leo@example.com" } });
    await tick(); await tick(); await tick();
  });

  it("shows this week's prayers, escaped", () => {
    expect(app().textContent).toContain("0 of 2");
    expect(app().textContent).toContain("New job <b>soon</b>");
    expect(app().querySelector(".row b")).toBeNull();
  });

  it("hides the Invites tab from non-admins", () => {
    expect(app().textContent).not.toContain("Invites");
  });

  it("only offers Delete on requests you added", () => {
    const rowsWithDelete = [...app().querySelectorAll(".row")].filter((r) => r.querySelector('[data-act="confirm"]'));
    expect(rowsWithDelete.map((r) => r.querySelector(".who").textContent)).toEqual(["Smith"]);
  });

  it("marks I prayed", async () => {
    click('[data-act="prayed"][data-id="r1"]');
    await tick();
    expect(api.markPrayed).toHaveBeenCalledWith("r1");
  });

  it("opens the Brothers tab", async () => {
    click('[data-tab="brothers"]');
    expect(app().textContent).toContain("Alex");
    expect(app().textContent).toContain("Add a request for a brother");
  });

  it("keeps a group open while you share an update", async () => {
    click('[data-tab="lifegroup"]');
    const g = app().querySelector("details.person");
    g.open = true;
    g.dispatchEvent(new Event("toggle"));
    click('[data-act="open-update"][data-id="r1"]');
    const after = app().querySelector("details.person");
    expect(after.open).toBe(true);
    expect(after.querySelector('form[data-form="update"]')).not.toBeNull();
  });

  it("signs in back to the site's home page", async () => {
    const { supabase } = await import("../src/supabase.js");
    authCallback("SIGNED_OUT", null);
    const form = app().querySelector('form[data-form="sign-in"]');
    form.querySelector("input").value = "Friend@Example.com";
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await tick();
    expect(supabase.auth.signInWithOtp).toHaveBeenCalledWith({
      email: "friend@example.com",
      options: { emailRedirectTo: new URL(import.meta.env.BASE_URL, window.location.origin).href },
    });
  });
});

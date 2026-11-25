// @vitest-environment jsdom
// Your family and brother each week: renders the page with a fake database.
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { weekOf } from "../src/logic.js";

const me = "11111111-1111-1111-1111-111111111111";
const mike = "22222222-2222-2222-2222-222222222222";
const sunday = new Date();
sunday.setDate(sunday.getDate() - sunday.getDay());
const ymd = (d) => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
const now = () => new Date().toISOString();

const base = () => ({
  members: [{ id: me, display_name: "Me Person", family_id: "f1" }, { id: mike, display_name: "Mike Jones", family_id: "f2" }],
  families: [
    { id: "f1", name: "Smith", husband: "Me", wife: null, since: null, pray_for: null },
    { id: "f2", name: "Jones", husband: "Mike", wife: "Ann", since: null, pray_for: null },
    // Added this week, so it joins next Sunday.
    { id: "f3", name: "Brown", husband: "Sam", wife: null, since: ymd(new Date(sunday.getTime() + 86400000 * 8)), pray_for: null },
  ],
  requests: [
    { id: "r1", list: "lifegroup", family_id: "f2", body: "Ann's new job", sheet_date: ymd(sunday), status: "active", created_by: me, created_at: now() },
    { id: "r2", list: "brothers", for_member: mike, for_name: "Mike Jones", body: "Rest for his back", status: "active", created_by: mike, created_at: now() },
  ],
  updates: [],
  prayers: [],
  calendarReady: true,
  events: [],
  personPrayers: [],
  extras: [],
  weeklyReady: true,
});
let data = base();

let authCallback;
vi.mock("../src/supabase.js", () => ({
  configured: true,
  supabase: { auth: { onAuthStateChange: (cb) => { authCallback = cb; }, signOut: vi.fn() } },
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
  setMyFamily: vi.fn(async () => "f1"),
  prayForPerson: vi.fn(async () => {}),
  undoPersonPrayers: vi.fn(async () => {}),
  addExtra: vi.fn(async () => {}),
  removeExtra: vi.fn(async () => {}),
});

const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => { for (let i = 0; i < 5; i++) await tick(); };
const app = () => document.querySelector("#app");
const toast = () => document.querySelector("#toast").textContent;
const click = (sel) => app().querySelector(sel).dispatchEvent(new MouseEvent("click", { bubbles: true }));
const submit = (form) => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
const change = (el) => el.dispatchEvent(new Event("change", { bubbles: true }));
const card = () => app().querySelector(".mecard");
const goTab = async (t) => { click(`[data-act="tab"][data-tab="${t}"]`); await settle(); };

beforeAll(async () => {
  document.body.innerHTML = `<main id="app"></main><div id="toast" hidden></div>`;
  window.scrollTo = () => {};
  await import("../src/main.js");
  authCallback("SIGNED_IN", { user: { id: me, email: "me@example.com" } });
  await settle();
});

// Load the data again, as the page does after any change.
async function reload() {
  const b = document.createElement("button");
  b.dataset.act = "retry";
  app().appendChild(b);
  b.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await settle();
}

beforeEach(async () => {
  data = base();
  api.amIAdmin.mockResolvedValue(false);
  await goTab("week");
  await reload();
  Object.values(api).forEach((f) => f.mockClear?.());
});

describe("This week card", () => {
  it("shows the family and brother to pray for, with the couple's names and their prayers", () => {
    const t = card().textContent;
    expect(t).toContain("Your family to pray for");
    expect(t).toContain("Jones");
    expect(t).toContain("Mike & Ann");
    expect(t).toContain("Ann's new job");
    expect(t).toContain("Your brother");
    expect(card().querySelector(`[data-act="pray-person"][data-id="${mike}"]`).textContent).toContain("I prayed for Mike");
    expect(card().textContent).toContain("Smith family");
  });

  it("saves I prayed for Mike, and shows it pressed afterwards", async () => {
    click(`.mecard [data-act="pray-person"][data-id="${mike}"]`);
    data.personPrayers = [{ id: "pp1", member_id: mike, prayed_by: me, prayed_at: now() }];
    await settle();
    expect(api.prayForPerson).toHaveBeenCalledWith(mike);
    const b = card().querySelector('[data-act="pray-person"]');
    expect(b.getAttribute("aria-pressed")).toBe("true");
    expect(b.textContent).toContain("Prayed for Mike ✓");
  });

  it("undoes only my own marks from this week", async () => {
    data.personPrayers = [
      { id: "pp1", member_id: mike, prayed_by: me, prayed_at: now() },
      { id: "pp-old", member_id: mike, prayed_by: me, prayed_at: new Date(sunday.getTime() - 3 * 86400000).toISOString() },
    ];
    data.personPrayers.push({ id: "pp-other", member_id: mike, prayed_by: "someone-else", prayed_at: now() });
    await reload();
    click(`.mecard [data-act="pray-person"][data-id="${mike}"]`);
    await settle();
    expect(api.undoPersonPrayers).toHaveBeenCalledWith(["pp1"]);
    expect(api.prayForPerson).not.toHaveBeenCalled();
  });

  it("counts praying for his requests as praying for him, without a second mark", async () => {
    data.prayers = [{ id: "p1", request_id: "r2", member_id: me, prayed_at: now() }];
    await reload();
    const b = card().querySelector(`[data-act="pray-person"][data-id="${mike}"]`);
    expect(b.getAttribute("aria-pressed")).toBe("true");
    click(`.mecard [data-act="pray-person"][data-id="${mike}"]`);
    await settle();
    expect(api.prayForPerson).not.toHaveBeenCalled();
    expect(api.undoPersonPrayers).not.toHaveBeenCalled();
    expect(toast()).toContain("You prayed for Mike’s requests this week");
  });

  it("shows who prayed for you and your family", async () => {
    data.requests.push({ id: "r9", list: "lifegroup", family_id: "f1", body: "Our move", sheet_date: ymd(sunday), status: "active", created_by: me, created_at: now() });
    data.prayers = [{ id: "p9", request_id: "r9", member_id: mike, prayed_at: now() }];
    await reload();
    expect(card().querySelector(".prayed-for-me").textContent).toContain("Mike Jones prayed for you and your family this week");
  });

  it("follows the sheet's Pray for column", async () => {
    data.families[0].pray_for = "The Browns";
    data.families.push({ id: "f4", name: "Browns", husband: "Al", wife: "Bea", since: null, pray_for: null });
    await reload();
    expect(card().querySelector(".weekfam").textContent).toContain("Al & Bea");
  });
});

describe("picking your family", () => {
  it("asks which family is yours, and adds a new one by name", async () => {
    data.members[0].family_id = null;
    await reload();
    const form = app().querySelector('form[data-form="my-family"]');
    expect(form).not.toBeNull();
    const sel = form.querySelector('select[name="family"]');
    sel.value = "new";
    change(sel);
    expect(form.querySelector(".new-family").hidden).toBe(false);
    form.querySelector('input[name="name"]').value = "The Garcias:";
    form.querySelector('input[name="wife"]').value = "Rosa";
    submit(form);
    await settle();
    expect(api.setMyFamily).toHaveBeenCalledWith({ name: "Garcias", wife: "Rosa" });
  });

  it("picks a family from the list, from Change family", async () => {
    click('[data-act="change-family"]');
    const form = app().querySelector('form[data-form="my-family"]');
    form.querySelector('select[name="family"]').value = "f2";
    submit(form);
    await settle();
    expect(api.setMyFamily).toHaveBeenCalledWith({ id: "f2", wife: null });
    expect(app().querySelector('form[data-form="my-family"]')).toBeNull();
  });

  it("welcomes a family that joins next Sunday", async () => {
    data.families[0].since = ymd(new Date(sunday.getTime() + 86400000 * 9));
    await reload();
    expect(card().textContent).toContain("joins the weekly prayer circle on Sunday");
  });
});

describe("Brothers and Lifegroup tabs", () => {
  it("puts your brother at the top of Brothers, and says who's praying for each man", async () => {
    await goTab("brothers");
    const top = card();
    expect(top.textContent).toContain("Your brother this week");
    expect(top.textContent).toContain("Rest for his back");
    const row = app().querySelector(`details[data-group="brothers:m:${mike}"] summary`).textContent;
    expect(row).toContain("Jones family");
    expect(row).toContain("on your list this week ✓");
  });

  it("shows who's praying for you on your own page, with no button for yourself", async () => {
    await goTab("brothers");
    click(`[data-man="m:${me}"]`);
    await settle();
    // Your own page has no button to pray for yourself.
    expect(app().querySelector(`[data-act="pray-person"][data-id="${me}"]`)).toBeNull();
    expect(app().textContent).toContain("Mike Jones is praying for you this week");
  });

  it("adds another family for this week on Lifegroup", async () => {
    await goTab("lifegroup");
    const form = card().querySelector('form[data-form="extra"][data-kind="family"]');
    expect([...form.querySelectorAll("option")].map((o) => o.value)).toEqual(["", "f3"]);
    form.querySelector("select").value = "f3";
    submit(form);
    await settle();
    expect(api.addExtra).toHaveBeenCalledWith({ week_of: weekOf(), family_id: "f3" });
  });

  it("lists this week's extras with a Remove button, and moves them up in Pray now", async () => {
    data.extras = [{ id: "x1", member_id: me, week_of: weekOf(), family_id: "f3", for_member: null }];
    data.requests.push({ id: "r3", list: "lifegroup", family_id: "f3", body: "Brown baby due", sheet_date: ymd(sunday), status: "active", created_by: me, created_at: now() });
    data.requests.push({ id: "r4", list: "lifegroup", family_id: "f1", body: "Our own", sheet_date: ymd(sunday), status: "active", created_by: me, created_at: now() });
    await reload();
    await goTab("lifegroup");
    expect(card().textContent).toContain("Brown baby due");
    click('.mecard [data-act="extra-remove"][data-id="x1"]');
    await settle();
    expect(api.removeExtra).toHaveBeenCalledWith("x1");
    await goTab("week");
    click('[data-act="pn-open"]');
    // Your family for the week first, then your brother, then the family you added.
    const who = () => app().querySelector(".pn-who").textContent.trim();
    expect(who()).toBe("Jones");
    click('[data-act="pn-skip"]');
    expect(who()).toBe("Mike Jones");
    click('[data-act="pn-skip"]');
    expect(who()).toBe("Brown");
    click('[data-act="pn-close"]');
  });
});

describe("before the setup step", () => {
  it("tells admins which README steps turn it on, and hides it from everyone else", async () => {
    data.weeklyReady = false;
    data.personPrayers = []; data.extras = [];
    await reload();
    expect(app().textContent).not.toContain("Which family is yours?");
    expect(app().textContent).not.toContain("README");
    api.amIAdmin.mockResolvedValue(true);
    await reload();
    expect(card().textContent).toContain("README, steps 8 and 9");
  });
});

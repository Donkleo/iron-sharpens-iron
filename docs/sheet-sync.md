# Sheet sync: a script inside the Google Sheet

A small Google Apps Script in the lifegroup sheet sends the sheet to the
site every hour, the same way the app's sheet sync fills the app:

- **Upcoming nights** from the two newest quarter tabs (like "2026 Q4"). A
  night with no host shows as "host needed" with no address; "Game Night at
  …" keeps its own name; a family's night reads "Bible study at the Weeks'".
- **The Events tab:** every row dated today or later.
- **The Families tab:** husband, wife and "pray for", in the sheet's order.
  A new family's start day is saved so the weekly prayer rotation can add it
  the following Sunday.

Nights and events removed from the sheet disappear from the site. Past ones
stay. A family removed from the sheet is removed from the site, unless
prayers are filed under it; then it stays. If the script can't find a tab or
a header row, it stops and sends nothing, so a renamed tab can't wipe the
calendar. Google runs it, so it uses no Claude.

Before you start: README steps 7 and 8, and the sync key from
`docs/calendar-sync.md` step 1.

## Set it up (once)

1. **Open the script editor.** Open the lifegroup sheet in a web browser:
   on a computer, or on your phone with the browser's **Desktop site** turned
   on (the Sheets app has no script editor). Then go to **Extensions >
   Apps Script**.
2. **Paste the script.** Open the file as plain text:
   https://raw.githubusercontent.com/Donkleo/iron-sharpens-iron/main/apps-script/sheet-sync.gs
   Select all of its text and copy it. In the editor, select everything in
   `Code.gs`, paste over it, and press the **Save** (disk) button.
3. **Add the three settings.** Press **Project Settings** (the gear on the
   left), scroll to **Script properties**, press **Add script property** and
   add these three, then press **Save script properties**:
   - `SUPABASE_URL`: the Project URL from Supabase (Project Settings, Data
     API), like `https://abcd1234.supabase.co`
   - `SUPABASE_ANON_KEY`: the project's public anon (or publishable) key, the
     same one the site uses
   - `SYNC_KEY`: the sync key from `docs/calendar-sync.md` step 1. Paste it
     here only, not in a chat or a note.
4. **Turn it on.** Go back to the **Editor** (the `< >` on the left), pick
   **setUpSync** in the function list at the top, and press **Run**.
   - Google asks for permission the first time. Press **Review permissions**
     and pick your account. It warns "Google hasn't verified this app"
     because it's your own script: press **Advanced**, then **Go to …
     (unsafe)**, then **Allow**. It asks to see and edit this one
     spreadsheet, connect to an outside service (the site) and run while
     you're away (every hour).
5. **Check it.** The log at the bottom should say "Calendar: N upcoming
   events synced." and "Families: N synced." Open the site's Calendar tab to
   see the events.

After that it runs every hour on its own. If a run fails, Google emails you
a summary. To turn it off, pick **stopSync** and press **Run**.

## Keeping the key safe

- The key sits in the script's settings. Anyone who can **edit** the sheet
  can open the script and see it. Someone who has the key can change the
  site's sheet events and sheet families, but can't read anything or touch
  prayers. Only share edit access to the sheet with people you trust.
- The script only sends the key to the site, over HTTPS. It never writes the
  key or the sheet's contents to its log.
- If you think the key was seen by someone it shouldn't be: in Supabase run
  `delete from private.sync_keys;`, make a new key (calendar-sync step 1),
  and put it in `SYNC_KEY` here (and in the church routine's environment, if
  you set that up).

## What it sends

Two POSTs, with only the public key in the `apikey` header and the sync key
in the body as `p_key`:

- `rpc/sync_events` with `p_source: "sheet"`, `p_replace_from: <today>` and
  the events (see `docs/calendar-sync.md` section 3).
- `rpc/sync_families` with `p_families`: `[{ "name", "husband", "wife",
  "pray_for" }, …]` in the sheet's order. An empty list is refused.

# Iron Sharpens Iron

A small prayer site for our lifegroup and brothers: this week's prayers, who
has prayed, updates and answered prayers. Members sign in with a code (or a link) sent
to their email; only people on the invite list can get in.

- **Site:** https://donkleo.github.io/iron-sharpens-iron/
- **Code:** Vite and plain JavaScript in `src/`
- **Database:** Supabase. Tables and access rules are in
  `supabase/migrations/`. Prayers never go in this repo.
- **Backlog:** `docs/backlog.md`

## How changes ship

Every change is one pull request. CI builds the site and runs the tests,
including tests that run the database migrations in a real Postgres and check
that only invited, signed-in members can read prayers. Merging to `main`
deploys to GitHub Pages.

## One-time Supabase setup

1. **Database:** copy the whole text of the migration file and run it.
   - Open the file as plain text:
     https://raw.githubusercontent.com/Donkleo/iron-sharpens-iron/main/supabase/migrations/20261124000000_prayer_core.sql
     (or open [the file](supabase/migrations/20261124000000_prayer_core.sql)
     on GitHub and tap **Raw**).
   - Select all of the text and copy it. Paste the text itself, not the
     file's name.
   - In the Supabase dashboard, open **SQL Editor**, start a new query, paste,
     and press **Run**. It should say "Success. No rows returned".
2. **Invite yourself as admin:** in a new SQL Editor query, paste this, change
   the email and name to your own, and press **Run**:

   ```sql
   insert into public.invites (email, name, role)
   values ('you@example.com', 'Your Name', 'admin');
   ```

   After you sign in, add everyone else from the site's **Invites** tab.
3. **Sign-in link address:** Authentication, URL Configuration, set **Site URL**
   to `https://donkleo.github.io/iron-sharpens-iron/` and add the same address
   under **Redirect URLs** (add `http://localhost:5173/iron-sharpens-iron/` too
   if you run the site on your own computer).
4. **Email sender:** Supabase's built-in sender only emails the project's own
   team and only a few times an hour, so members won't get their links until
   the project sends through a real email account. Under Authentication, Emails,
   SMTP Settings, turn on custom SMTP with a free sender such as Brevo or
   Resend, or a Gmail app password. Until then, only you can sign in.
5. **Sign-in code in the email:** Supabase's emails only have a link at
   first. A link can open inside the mail app's own browser, which forgets
   the sign-in, so add the code too. Do this for two templates, **Magic Link**
   (people who signed in before) and **Confirm signup** (first sign-in):
   - Open the template's text, which is plain text on GitHub:
     - Magic Link: https://raw.githubusercontent.com/Donkleo/iron-sharpens-iron/main/docs/email-templates/magic-link.html
     - Confirm signup: https://raw.githubusercontent.com/Donkleo/iron-sharpens-iron/main/docs/email-templates/confirm-signup.html
   - On a phone, press and hold the text, tap **Select All**, then **Copy**.
   - In the Supabase dashboard, open Authentication, Emails, **Templates**,
     pick the template, and set **Subject** to `Your Iron Sharpens Iron sign-in code`.
   - In **Message body**, select everything that is there, delete it, paste
     the contents you copied, and press **Save**.

6. **Calendar:** copy the whole text of the calendar file and run it, the
   same way as step 1.
   - Open the file as plain text:
     https://raw.githubusercontent.com/Donkleo/iron-sharpens-iron/main/supabase/migrations/20261125000000_calendar.sql
   - Select all of the text and copy it. Paste the text itself, not the
     file's name.
   - In **SQL Editor**, start a new query, paste, and press **Run**. It should
     say "Success. No rows returned".

   If Supabase warns that `private.sync_keys` has no row-level security,
   press **Run and enable RLS**; step 7 turns it on anyway.

   Until this runs, the Calendar tab says it's almost ready, and prayers work
   as before.
7. **Calendar sync key:** run the next file the same way as step 1.
   - Open the file as plain text:
     https://raw.githubusercontent.com/Donkleo/iron-sharpens-iron/main/supabase/migrations/20261125140000_sync_key_header.sql
   - Select all of the text and copy it, then paste it into a new
     **SQL Editor** query and press **Run**. It should say "Success. No rows
     returned".

   Sheet and church events arrive once the syncs are pointed at the site.
   `docs/calendar-sync.md` has the steps.
8. **Families from the sheet:** run the next file the same way as step 1.
   - Open the file as plain text:
     https://raw.githubusercontent.com/Donkleo/iron-sharpens-iron/main/supabase/migrations/20261125220000_sheet_families.sql
   - Select all of the text and copy it, then paste it into a new
     **SQL Editor** query and press **Run**. It should say "Success. No rows
     returned".

   Then set up the Google Sheet script with `docs/sheet-sync.md`.

The repo's Actions secrets `SUPABASE_URL` and `SUPABASE_ANON_KEY` are read at
deploy time. Without them the site builds and shows a setup notice.

## Working on it locally

```sh
npm ci
cp .env.example .env.local   # then fill in the two values
npm run dev
npm test
```

# Iron Sharpens Iron

A small prayer site for our lifegroup and brothers: this week's prayers, who
has prayed, updates and answered prayers. Members sign in with a link sent to
their email; only people on the invite list can get in.

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

1. **Database:** in the Supabase dashboard open SQL Editor, paste
   `supabase/migrations/20261124000000_prayer_core.sql`, and run it.
2. **Invite yourself as admin:** in SQL Editor run, with your own email and name:

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

The repo's Actions secrets `SUPABASE_URL` and `SUPABASE_ANON_KEY` are read at
deploy time. Without them the site builds and shows a setup notice.

## Working on it locally

```sh
npm ci
cp .env.example .env.local   # then fill in the two values
npm run dev
npm test
```

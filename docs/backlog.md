# Backlog

Improvements, in order. Each item becomes one small pull request that is
reviewed before the group leader sees it. Taken from the Product Vision doc and the Website
Move Plan, with the group leader's notes: scale back, get prayer right first, keep it easy
for everyone to reach, email over texts, no phone app for now.

## Done

- [x] **Prayer core (first release):** email sign-in link with an invite list,
  This week, Lifegroup and Brothers prayers, I prayed, updates, answered.
- [x] **Looks and works like the app:** a verse after each "I prayed", Pray
  now (a few prayers at a time), "Pray again" when someone shares news on a
  prayer you prayed for, similar prayers when answering, family and brother
  chips, date tabs, search with mark-several-answered, and a sign-in code in
  the email next to the link.
- [x] **Calendar:** a Calendar tab (upcoming, past, and hidden for admins),
  group events anyone can add, sheet events with address and Maps, "Add to
  my calendar", and Coming up on This week. The invite list moved to a
  button at the bottom of the page so the tabs match the app.
- [x] **Your family and brother each week:** pick your family once; each
  Sunday you get a family and a brother to pray for, "I prayed for Mike",
  "Also praying for" for the week, who's praying for each brother, and who
  prayed for you and your family.

## Next

1. **Move today's prayers once.** Copy the current page's prayers and families
   into the database, after the group leader's yes. Who prayed when is tied to Claude
   accounts, so those counts start fresh.
2. **Switch the group.** Share the site link; the current page stays as a
   backup for a few weeks.
3. **Encouragement notes.** Send a brother a short note that shows on his
   page and his This week card, like the app.
4. **Live refresh.** New prayers and "I prayed" show up without reloading.
5. **Calendar syncs.** Point the "Sync lifegroup sheet" and church event
   routines at the site (`docs/calendar-sync.md`), after the group leader's yes.
6. **Sheet photo scanning.** A small server function that reads the paper
   prayer sheet with the Claude API (a few cents a photo). the group leader does the
   scanning.
7. **Rooted Women.** The women's side on the same site and database, sharing
   lifegroup prayers, so the paused prayer sync routine is no longer needed.
8. **Email reminders.** Weekly summary and "not prayed for yet" nudges by
    email (free tier), not texts.

## Later, needs more thought

- Check-ins and an "extra care" flag, with privacy rules for who sees them.
- Accountability partners.
- Roles beyond admin and member.
- Text messages (carrier registration and per-message cost).

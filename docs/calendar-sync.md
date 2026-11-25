# Calendar syncs

The lifegroup Google Sheet and the church calendar are copied in by syncs.
They write with a **sync key**, which can only add, change or remove sheet
and church events. It can't read anything, and it can't touch prayers,
invites or group events. The database keeps only a fingerprint (SHA-256) of
the key, so the key itself is only ever in one place: wherever the sync runs.

Run README steps 6 and 7 first.

## 1. Make a sync key (once)

In the Supabase SQL Editor, run this. It makes a random key, saves only its
fingerprint, and shows the key once. Copy it straight into step 2; don't
paste it into a chat, a note or a file in this repo.

```sql
with k as (select replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '') as key)
insert into private.sync_keys (key_hash, label)
select private.hash_key(key), 'calendar sync' from k
returning (select key from k) as copy_this_key;
```

To turn every sync key off (for example, if one leaks), run
`delete from private.sync_keys;` and make a new one.

## 2. Let the sync reach Supabase, with the key kept secret

The sync runs in a Claude cloud environment, which only reaches the sites
it's allowed to. In that environment's settings:

- **Allowed host:** your project's host, like `abcd1234.supabase.co` (from
  the project URL in Supabase's project settings).
- **Network secret:** for that same host, a header named `x-sync-key` whose
  value is the key from step 1.

The environment adds the header to every request to that host, so the key is
never written into the sync's instructions and the sync never sees it.

## Check it once

From that environment, a call with a made-up key must be refused. Put it in
the body, where it takes priority over the header:

```sh
curl -s -X POST "<SUPABASE_URL>/rest/v1/rpc/sync_events" \
  -H "apikey: <ANON_KEY>" -H "Content-Type: application/json" \
  --data '{"p_key":"made-up-key-made-up-key-made-up","p_source":"church","p_events":[]}'
```

The answer should say "Unknown sync key.". The same call without `p_key`
should answer `0`, which shows the header arrived and the key matched.
After the first real run, look once at the request logs in Supabase to make
sure the key header isn't shown there in full.

## 3. What a sync sends

A POST to `<SUPABASE_URL>/rest/v1/rpc/sync_events` with the project's public
key in the `apikey` header (it's public: the site itself uses it), the
`x-sync-key` header (added by the environment), and this JSON body:

```json
{
  "p_source": "sheet",
  "p_replace_from": "2026-11-26",
  "p_events": [
    { "id": "sheet-2026-11-30", "title": "Bible study at the Smiths'", "date": "2026-11-30",
      "time": "6:30pm", "address": "12 Oak St" },
    { "id": "sheet-2026-12-07", "title": "Bible study · host needed", "date": "2026-12-07", "kind": "open" }
  ]
}
```

- `p_source` is `sheet` or `church`.
- Each event needs `id` (the sync's own id, the same from run to run),
  `title` and `date`. Optional: `end_date`, `time`, `location`, `address`,
  `notes`, `url` (https only; anything else is dropped), and `kind: "open"`
  for a night with no host yet (any other kind is ignored).
- Running again updates events in place, matched on `id`. Church events an
  admin hid stay hidden.
- With `p_replace_from`, that source's events on or after that day that
  aren't in the list are removed. Leave it out to only add and update. An
  empty list with `p_replace_from` is refused, so a failed sheet read can't
  clear the calendar.
- At most 2,000 events per call. An event with no id, an id over 200
  characters, no title, or a date that isn't real stops the call with a
  clear message and nothing is changed. Other odd values (an end date before
  the start, a link that isn't a plain https link, text that's too long) are
  dropped or shortened.
- The answer is the number of events saved. A wrong or missing key gets
  "Unknown sync key." and changes nothing.
- The key can also be sent in the body as `p_key`, but the header keeps it
  out of the sync's instructions.

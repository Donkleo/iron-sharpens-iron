# Calendar syncs

The lifegroup Google Sheet and the church calendar are copied in by syncs.
They write with a **sync key**, which can only add, change or remove sheet
and church events. It can't read anything, and it can't touch prayers or
group events.

## Make a sync key (once)

In the Supabase SQL Editor, run this. It makes a random key, saves only its
fingerprint, and shows the key once:

```sql
with k as (select replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '') as key)
insert into private.sync_keys (key_hash, label)
select private.hash_key(key), 'calendar sync' from k
returning (select key from k) as copy_this_key;
```

Keep the key somewhere private, like the sync's own settings. To turn a key
off, delete its row: `delete from private.sync_keys;`

## What a sync sends

A POST to `<SUPABASE_URL>/rest/v1/rpc/sync_events` with the project's public
(anon) key in the `apikey` header and this JSON body:

```json
{
  "p_key": "the sync key",
  "p_source": "sheet",
  "p_replace_from": "2026-11-01",
  "p_events": [
    { "id": "sheet-2026-11-30", "title": "Bible study", "date": "2026-11-30",
      "time": "6:30 PM", "location": "Smith home", "address": "12 Oak St" },
    { "id": "sheet-2026-12-07", "title": "Hangout", "date": "2026-12-07", "kind": "open" }
  ]
}
```

- `p_source` is `sheet` or `church`.
- Each event needs `id` (the sync's own id, stable from run to run), `title`
  and `date`. Optional: `end_date`, `time`, `location`, `address`, `notes`,
  `url` (https only), and `kind: "open"` for a night with no host yet.
- Running again updates events in place, matched on `id`. Church events an
  admin hid stay hidden.
- With `p_replace_from`, that source's events on or after that day that
  aren't in the list are removed. Leave it out to only add and update.

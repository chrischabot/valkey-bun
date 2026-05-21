# Client-Side Caching & Keyspace Notifications

## CLIENT TRACKING (RESP3 client-side caching)

`CLIENT TRACKING ON|OFF [REDIRECT id] [PREFIX p [PREFIX p ...]] [BCAST] [OPTIN] [OPTOUT] [NOLOOP]`

When tracking is on, the server sends an **invalidation message** whenever a
key the client may have cached changes:

- **Default mode:** keys the client *read* are remembered; a later mutation
  to such a key invalidates it (one-shot — re-read to re-track).
- **BCAST mode:** no per-key bookkeeping; the client is notified for every
  changed key matching one of its `PREFIX`es (or all keys if none given).
- `OPTIN`/`OPTOUT` (default mode) gate tracking on `CLIENT CACHING YES|NO`
  issued immediately before the read. `OPTIN`/`OPTOUT` are incompatible with
  `BCAST` and with each other.
- `REDIRECT id` sends invalidations to another (RESP2-or-3) connection that
  subscribed to `__redis__:invalidate`. `NOLOOP` suppresses the notification
  to the client that performed the write.

Invalidation wire form: RESP3 push `>2 "invalidation" [keys]` (or, for a
RESP2 redirect target, a `message __redis__:invalidate [keys]`). `FLUSHDB`/
`FLUSHALL` send a flush signal (`["invalidation", nil]`).

`CLIENT TRACKINGINFO` reports `flags`/`redirect`/`prefixes`;
`CLIENT GETREDIR` returns the redirect id (`-1` if not tracking).
`RESET` and disconnect clear all tracking state.

```bash
# RESP3 client
HELLO 3
CLIENT TRACKING ON BCAST PREFIX user:
# ... another client: SET user:1 alice
# this client receives:  >2 "invalidation" ["user:1"]
```

## Keyspace notifications

Set the `notify-keyspace-events` flag string (e.g. `KEA` = keyspace +
keyevent + all classes) via config or `CONFIG SET`. The server then
publishes, on each mutation:

- `__keyspace@<db>__:<key>` → the **event name** (e.g. `set`, `del`,
  `expire`, `lpush`, `hset`, `zadd`, `xadd`, …)
- `__keyevent@<db>__:<event>` → the **key**

gated by the `K` (keyspace), `E` (keyevent) and class flags
(`A`=all, or `g $ l s h z x …`). Subscribe with `PSUBSCRIBE __key*@0__:*`.

```bash
CONFIG SET notify-keyspace-events KEA
# subscriber on __key*@0__:*  ; then: SET foo bar ; DEL foo
# -> __keyspace@0__:foo = set ; __keyevent@0__:set = foo
# -> __keyspace@0__:foo = del ; __keyevent@0__:del = foo
```
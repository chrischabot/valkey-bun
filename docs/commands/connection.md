# Connection & Client Commands

Manage the connection: liveness, protocol negotiation, authentication,
database selection, and client introspection. A new connection starts on
DB 0, RESP2, unauthenticated.

---

## PING

`PING [message]` · Arity ≥ 1

- Normal mode: `+PONG`, or echo `message` (bulk) if given.
- **Subscribe mode:** `PING` is allowed. With no argument it replies
  `["pong", ""]` (array) under RESP2, `+PONG` under RESP3; with an argument it
  replies the argument (bulk).

## ECHO

`ECHO message` · Arity 2 → the message (bulk).

## AUTH

`AUTH [username] password` · Arity ≥ 2

Authenticate. valkey2 has a single password (no real ACL users); a username,
if supplied, is ignored.
- No password configured → `ERR Client sent AUTH, but no password is set...`.
- Correct password → `+OK` (connection marked authenticated).
- Wrong → `WRONGPASS invalid username-password pair or user is disabled.`

## HELLO

`HELLO [protover [AUTH username password] [SETNAME name]]` · Arity ≥ 1

Negotiate the protocol and return server metadata.
- `protover` must be `2` or `3`, else `NOPROTO unsupported protocol version`.
- `AUTH username password`: authenticate inline (same rules as `AUTH`; a
  passwordless server rejects an explicit password).
- `SETNAME name`: set the connection name.

**Reply:** a map with: `server` (`valkey`), `version` (`7.4.0`), `proto`
(2/3), `id` (connection id), `mode` (`standalone`), `role` (`master`),
`modules` (empty array). After `HELLO 3` the connection uses RESP3.

```bash
HELLO 3
HELLO 3 AUTH default s3cret SETNAME app1
```

## SELECT

`SELECT index` · Arity 2 → `+OK`; switch the connection's database.
Out-of-range/invalid → `ERR DB index is out of range`.

## CLIENT

`CLIENT subcommand [args]` · Arity ≥ 2

| Subcommand | Reply |
|------------|-------|
| `ID` | connection id (integer) |
| `GETNAME` | the name (bulk) or nil |
| `SETNAME name` | `+OK` |
| `INFO` | `id=… name=… db=…` (bulk) |
| `LIST` | one line per connection (`id=… name=… db=…`) |
| `SETINFO` / `NO-EVICT` / `NO-TOUCH` / `REPLY` / `PAUSE` / `UNPAUSE` / `KILL` | `+OK` (accepted, no-ops) |
| `GETREDIR` | the tracking redirect client id, or `-1` if tracking is off |
| `TRACKING …` | enable/disable client-side-caching tracking (see below) |
| `CACHING YES\|NO` | per-read opt for `OPTIN`/`OPTOUT` tracking |
| `TRACKINGINFO` | map: `flags`/`redirect`/`prefixes` |
| _unknown_ | `ERR Unknown CLIENT subcommand` |

### CLIENT TRACKING (RESP3 client-side caching)

`CLIENT TRACKING ON|OFF [REDIRECT id] [PREFIX p [PREFIX p ...]] [BCAST] [OPTIN] [OPTOUT] [NOLOOP]`

Turn invalidation tracking on/off for the connection. When on, the server
sends an **invalidation message** when a key the client may have cached
changes:

- **Default mode:** keys the client *reads* are remembered; a later mutation
  to such a key invalidates it (one-shot — re-read to re-track).
- **`BCAST` mode:** no per-key bookkeeping; the client is notified for every
  changed key matching one of its `PREFIX`es (or all keys if none given).
- `OPTIN`/`OPTOUT` (default mode only) gate tracking on
  `CLIENT CACHING YES|NO` issued immediately before the read.
- `REDIRECT id` delivers invalidations to another connection (which must
  exist, else `ERR The client ID you want redirect to does not exist`).
- `NOLOOP` suppresses the notification to the client that performed the
  write.

Validation errors: `ERR You can't specify both OPTIN mode and OPTOUT mode`;
`ERR PREFIX option requires BCAST mode to be enabled`;
`ERR OPTIN and OPTOUT are not compatible with BCAST`. Re-issuing
`CLIENT TRACKING ON` first clears prior tracked-key state.

Invalidation wire form: a RESP3 push `>2 "invalidation" [keys]` (or, for a
RESP2 redirect target, `message __redis__:invalidate [keys]`).
`FLUSHDB`/`FLUSHALL` send a flush signal (`["invalidation", nil]`).

`CLIENT TRACKINGINFO` → map with `flags` (e.g. `on`, `bcast`, `optin`,
`optout`, `noloop`, `caching-yes`/`caching-no`), `redirect`
(id or `-1`), `prefixes`. `CLIENT GETREDIR` → the redirect id (`-1` if not
tracking). `RESET` and disconnect clear all tracking state.

See [client-side-caching.md](../client-side-caching.md) for the full guide.

```bash
HELLO 3
CLIENT TRACKING ON BCAST PREFIX user:
# another client: SET user:1 alice
#  -> this client receives:  >2 "invalidation" ["user:1"]
CLIENT TRACKINGINFO
CLIENT TRACKING OFF
```

## RESET

`RESET` · Arity 1 → `+RESET`

Return the connection to a clean state: unsubscribe all, exit `MULTI`, clear
the queue/errors, clear `WATCH`, clear all `CLIENT TRACKING` state,
`SELECT 0`, clear the name. Allowed in subscribe mode.

## QUIT

`QUIT` · Arity 1 → `+OK`, then the server closes the connection. Allowed in
subscribe mode.

### TypeScript sample

```ts
import { Redis } from "ioredis";
const r = new Redis({ port: 6379 });
console.log(await r.ping());            // "PONG"
console.log(await r.echo("hi"));        // "hi"
await r.client("SETNAME", "reporting"); // OK
console.log(await r.client("GETNAME")); // "reporting"
await r.select(1);                      // switch to DB 1
r.disconnect();
```
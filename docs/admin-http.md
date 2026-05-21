# Admin / HTTP Endpoint

Alongside the RESP server, valkey2 runs an HTTP admin/metrics endpoint built on
**Bun 1.3.14's native HTTP/3 (QUIC)** support (`src/admin.ts`).

## Protocols

`Bun.serve({ http3: true, tls })` binds, on the **same port**
(`VALKEY_ADMIN_PORT`, default `8080`):

- **HTTP/3 over QUIC** (UDP)
- **HTTP/2 and HTTP/1.1 over TLS** (TCP)

HTTP/1.1 and HTTP/2 responses automatically carry an `Alt-Svc: h3=":<port>"`
header so capable clients discover and upgrade to QUIC. One `fetch` handler
serves all three protocols identically. HTTP/3 is experimental in Bun 1.3.x.

## TLS (required by QUIC)

Resolution order (see [configuration.md](./configuration.md)):

1. `VALKEY_ADMIN_TLS_KEY` + `VALKEY_ADMIN_TLS_CERT` (operator PEMs), else
2. a self-signed dev certificate generated once into `.certs/` (gitignored)
   via `openssl` on first boot; the key is `chmod 0o600`.

Because the dev cert is self-signed, pass `-k`/`rejectUnauthorized: false`
when testing locally.

## Routes

| Method | Path | Status | Content-Type | Body |
|--------|------|--------|--------------|------|
| GET | `/` or `/health` | 200 | `text/plain` | `OK\n` |
| GET | `/info` | 200 | `application/json` | JSON status document (below) |
| GET | `/metrics` | 200 | `text/plain; version=0.0.4` | Prometheus exposition |
| GET | _other_ | 404 | `text/plain` | `not found\n` |
| non-GET | any | 405 | `text/plain` | `method not allowed\n` |

### `/info` JSON

```json
{
  "server": "valkey2",
  "version": "7.4.0",
  "protocol": "http/3 (quic) + http/2 + http/1.1",
  "uptime_seconds": 42,
  "connected_clients": 3,
  "total_commands_processed": 1500,
  "total_keys": 12,
  "databases": 16,
  "rss_bytes": 81956864,
  "heap_used_bytes": 8290235
}
```

### `/metrics` (Prometheus)

```
# HELP valkey2_uptime_seconds Server uptime in seconds.
# TYPE valkey2_uptime_seconds gauge
valkey2_uptime_seconds 42
# HELP valkey2_connected_clients Currently connected clients.
# TYPE valkey2_connected_clients gauge
valkey2_connected_clients 3
# HELP valkey2_commands_processed_total Total commands processed.
# TYPE valkey2_commands_processed_total counter
valkey2_commands_processed_total 1500
# HELP valkey2_keys_total Total keys across all databases.
# TYPE valkey2_keys_total gauge
valkey2_keys_total 12
# HELP valkey2_rss_bytes Resident set size in bytes.
# TYPE valkey2_rss_bytes gauge
valkey2_rss_bytes 81956864
# HELP valkey2_heap_used_bytes Heap used in bytes.
# TYPE valkey2_heap_used_bytes gauge
valkey2_heap_used_bytes 8290235
```

## Accessing it

```bash
# HTTP/1.1 / HTTP/2 over TLS (works with any curl)
curl -sk https://127.0.0.1:8080/health
curl -sk https://127.0.0.1:8080/info
curl -sk https://127.0.0.1:8080/metrics

# Show the Alt-Svc upgrade advertisement
curl -skI https://127.0.0.1:8080/health | grep -i alt-svc
# -> alt-svc: h3=":8080"; ma=86400

# HTTP/3 (curl built with HTTP/3 support)
curl --http3-only -sk https://127.0.0.1:8080/info
```

From Bun's HTTP/3-capable fetch client:

```ts
const r = await fetch("https://127.0.0.1:8080/info", {
  proto: "h3",
  tls: { rejectUnauthorized: false },
} as RequestInit);
console.log(r.status, await r.json());
```

## Clustering note

Under `VALKEY_CLUSTER_SIZE > 1`, the admin endpoint binds on **worker 0
only** (to avoid `EADDRINUSE`); the RESP port is shared across workers via
`SO_REUSEPORT`. See [deployment.md](./deployment.md).

## Scraping with Prometheus

```yaml
scrape_configs:
  - job_name: valkey2
    scheme: https
    tls_config:
      insecure_skip_verify: true   # self-signed dev cert; use real PEMs in prod
    static_configs:
      - targets: ["127.0.0.1:8080"]
```
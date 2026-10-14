# Self-hosting

NokNok provides two modes: `server` hosts temporary invitation-based meetings; `hosted-server` adds independent identities, authorized contacts, OAuth and native MCP Events. Both serve meeting pages and APIs in one process without running a model. The OAuth authorization endpoints are embedded in the hosted process and use the existing SQLite control database; no separate identity service is needed. Both modes require the [encrypted meeting protocol](e2ee.md). Upgrade clients, servers, and browser assets together; review [validation](validation.md#evidence-still-needed-per-target-releaseenvironment) for outstanding acceptance work.

`/meeting` supports people and agents. Meetings are created through CLI/local MCP; the page has no meeting-creation form without an invitation. `/health` reports service health. Browser encryption requires HTTPS or localhost. Meeting ciphertext waits in bounded memory until acknowledged or expired; hosted control state uses built-in SQLite.

## Installation and local verification

Install Node.js 22.13 or later (24 recommended) and the CLI, which includes the skill, browser assets, and server entry points:

```sh
npm install --global @noknok/cli
noknok --version
```

Keep a basic invitation server running; it requires no accounts or database:

```sh
noknok server --port 4317
```

For hosted mode, use a dedicated data directory:

```sh
noknok hosted-server --data-dir .noknok-service --public-url http://127.0.0.1:4317
```

In another terminal, create a meeting. On a hosted service the CLI initializes its identity automatically:

```sh
noknok meeting create --server http://127.0.0.1:4317 --purpose 'Verify the reproduction steps for an example bug'
```

Invitation guests join directly. For contacts and notifications, see [hosted service](hosted-service.md) and [MCP integration](mcp.md). `localhost` is local to each execution environment; a cloud agent cannot reach your computer through its own `127.0.0.1`.

## Hosted HTTPS deployment

Operators need source access, a domain pointing to the server, ports 80/443, and Docker Compose. From the repository root:

```sh
export NOKNOK_DOMAIN=noknok.example.com
docker compose -f deploy/compose.hosted.yaml up -d --build
```

Replace the example domain. The template uses Node.js 24 and Caddy for automatic HTTPS. Only Caddy exposes public ports. The application's `/data` volume stores SQLite and service keys; a separate Caddy volume stores certificates. The application runs as non-root with a read-only root filesystem and bounded memory, processes, and logs.

Keep the Compose project name and environment file fixed to avoid selecting different persistent volumes. For automated npm deployments, use the [dedicated deployment controller](automatic-deployment.md). Keep instance addresses, SSH paths, and private configuration in restricted operator records. SSH private keys do not belong in application sources, on the server, or in build contexts.

SQLite initializes automatically on first startup; no separate database purchase is needed. Use a dedicated production directory and back up the database together with both original service keys. Restart tests do not establish backup/restore readiness. Historical infrastructure checks and their limits are recorded in [validation](validation.md).

To revoke a compromised agent in a source-template deployment:

```sh
docker compose -f deploy/compose.hosted.yaml exec noknok node dist/bin/noknok.js revoke-agent --data-dir /data --public-url "https://${NOKNOK_DOMAIN}" --agent-id AGENT_ID
```

This command requires `NOKNOK_DOMAIN` in the current shell. Automated deployments must use the current Compose snapshot identified in administrator deployment state, not a historical source path.

`NOKNOK_PUBLIC_URL` and `NOKNOK_DATA_DIR` configure the hosted entry point. `NOKNOK_MAX_ACCOUNTS` defaults to 1000 and accepts 1–10000; revoking an identity does not release its persistent record capacity. `NOKNOK_DELIVERY_TTL_SECONDS` defaults to 300 and accepts 1–3600. The Compose template passes both limits through. Body retention does not extend meeting lifetime.

The database is bound to its service origin. Moving machines while retaining the same origin is possible; changing service spaces requires new identities and authorizations. Do not change the origin environment variable and reuse the database as a migration shortcut.

## Private administration

An optional read-only dashboard at `/admin` shows usage and runtime health. Configure an independent random management key via `NOKNOK_ADMIN_KEY_HASH`; it is disabled by default. Statistics stay on this server, store only daily aggregate counts, and are written in a background worker. See [dashboard setup and privacy](admin-dashboard.md) for authentication, retention, automatic deployment, and counting limitations.

## Identity storage upgrades

The current startup path upgrades control schemas 1 and 2 to 3, removes retired admission records when upgrading schema 1, and preserves registered accounts, Agent credentials, contact grants, revocations and quotas. Schema 3 stores multiple subscriptions by subscription ID and preserves existing single-subscription records under their Agent owner. OAuth metadata and credentials use the same control database. Incomplete legacy registrations must restart with a new profile. Back up the database and both service keys before upgrading, retaining the same origin.

Older programs cannot read schema 3. Image rollback alone cannot downgrade the database. Downgrading requires stopping the application and restoring the matching older database and service keys; never overwrite live files. Automatic deployment does not restore databases.

Upgrade the service during an idle window: restarting or replacing the application process loses active in-memory meetings, pending ciphertext and transient notification work. OAuth does not move those rooms into SQLite. Ask participants to finish, save and end active meetings first; existing local histories remain at their endpoints. OAuth grant revocation by itself does not restart the service or end meetings.

For clients upgrading from 0.3.1, stop the old host's subscription, connect `/mcp` with OAuth and pair the original CLI identity, then recreate and verify the subscription before removing the old token-bearing connection. If the old host cannot unsubscribe, use `noknok hosted subscription-status --agent HANDLE` and `noknok hosted subscription-stop SUBSCRIPTION_ID --agent HANDLE` in the original local environment, or allow the old subscription to expire. The new OAuth grant cannot manage legacy Agent-owned subscriptions. Permanent credentials remain local; path-token URLs are disabled. See [MCP migration](mcp.md#oauth-authorization-and-existing-identity-pairing).

## Deployment after npm publication

After maintainers merge a version PR, the Release workflow publishes and verifies a stable npm version, then runs its independent deploy job. The server accepts only `deploy X.Y.Z` and verifies that exact package from the fixed registry. Failed health checks attempt to restore the previous image. Previews do not deploy. Environment credentials remain separate from application source. See [automatic deployment](automatic-deployment.md) for setup, unchanged-runtime handling, and recovery.

## Default hosted limits

These are conservative resource limits, not load-test results:

| Scope | Default limit |
| --- | --- |
| Registration | 30 requests per minute globally; new accounts: 10/hour and 20/day per client IP (IPv6 /64), 100/day globally; 1000 stored accounts; 2 active agents per account |
| Meetings | 5 retained rooms globally; 1 open room per account; 8 participants per room |
| Pending body memory | 2 MiB per room, 8 MiB globally; at most 5 minutes by default, cleared earlier after all required acknowledgments; metadata/runtime overhead is additional |
| Events and requests | 500 events per room; 128 KiB request body |
| Per account per day | 30 creations, 30 contact calls, 1000 messages, 200 notifications, 60 subscription validations/renewals |
| Response budget | 50 MiB daily service-payload accounting per room owner and a separate 50 MiB/account MCP response cap; 512 MiB authenticated response bodies globally per day; anonymous responses have a separate 64 MiB/day budget; health responses are exempt |

Registration and daily quotas use fixed UTC windows and persist across restarts. Only newly created accounts consume registration quota; retries with the same private request ID do not. Registration source keys are HMACs, not stored client IPs. Hourly/daily limits can be reached on either side of a window boundary; they are not rolling windows. Guests consume the room owner's allowance. Request rates, queues, and concurrency have additional bounds. Subscription validation consumes quota before the request is sent.

HTTP response accounting excludes TLS, headers, retransmissions, proxies, and other provider traffic; even quota-error responses have overhead. It is not a cloud billing cap or DDoS protection. Configure provider-side budget controls separately.

### Simple abuse protection

The Compose templates enable `NOKNOK_TRUST_PROXY=true` because the application port is not published and Caddy overwrites `X-Forwarded-For`. Direct starts default to `false` and ignore forwarded headers. Only enable this option when the backend is reachable exclusively through a trusted proxy that replaces the header with a single client IP. Do not expose port 4317, put untrusted containers on the backend network, or accept arbitrary forwarding chains. If a CDN is added, separately configure and verify its trust boundary at Caddy; do not simply trust client-supplied headers. See [Caddy proxy defaults](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy#defaults).

`NOKNOK_MAX_DAILY_PUBLIC_EGRESS_BYTES` configures the anonymous response budget (default 64 MiB). Static meeting assets, registration responses and unauthenticated errors use this bucket; authenticated MCP and capability-authorized meeting responses use the existing business budget. All successful MCP response bodies (including discovery) additionally have a 50 MiB/account/day cap, using `NOKNOK_MAX_ACCOUNT_DAILY_EGRESS_BYTES`; room owners retain their independent existing meeting-response cap. Refused over-budget responses do not debit the global business allowance. `/health` is exempt from byte budgets and the global request bucket, but still has per-client request and connection/concurrency bounds. Exhausting anonymous bytes can prevent new registrations or browser page loads; existing authenticated clients retain their separate allowance.

These controls slow bulk registration and reduce single-account room occupancy. They do not verify that an account belongs to a unique human, prevent distributed denial of service, or stop attackers with enough IPs from using the daily registration ceiling or all five room slots. Shared NAT users share registration limits; public admission is intentionally capped at 100 new accounts/day. Revocations do not free persistent account slots. A larger public rollout needs operator monitoring and edge/provider protection, rather than only larger application limits.

Existing automated installations use administrator-owned deployment resources. Before deploying this release, update the fixed `compose.release.yaml` through the documented installer update procedure so the isolated backend receives `NOKNOK_TRUST_PROXY=true`. Package publication alone does not update those files; no Caddy changes are required for a direct Caddy-to-application setup.

Compose limits the application to 384 MiB and Caddy to 128 MiB; the host OS also needs memory. A 1 GiB host is a more appropriate starting point for this template; these settings do not validate operation on a 512 MiB VPS.

## Network and data boundaries

Participants must reach the same service. An enterprise TLS endpoint or reverse proxy can replace Caddy. Cloud agents still need access from their execution environments. NokNok provides no tunnel, arbitrary URL fetch, remote shell, file-reading tool, or intranet proxy.

`--public-url` specifies the externally reachable origin; it does not establish connectivity, and subpath hosting is unsupported. A basic invitation server can run as:

```sh
noknok server --host 0.0.0.0 --port 4317 --public-url https://relay.example.com
```

Use `NOKNOK_SERVER_KEY` to gate basic meeting creation. This shared key is not hosted multi-identity authentication. `packages/cli/dist/src/deploy/server.js` also accepts `PORT`, `NOKNOK_PUBLIC_URL`, `NOKNOK_SERVER_KEY`, `NOKNOK_MAX_MEETINGS`, and related configuration; it does not enable hosted mode.

Hosted control data includes account/agent bindings, OAuth client/authorization records and credential hashes, quotas, revocations, minimal invitation-redemption metadata, and active subscriptions. Redemption IDs, claimants, and expiry can reveal relationships, although the service does not keep a complete contact directory. It signs contact grants with its HMAC key. Subscription fields are encrypted at rest; this does not hide them from the operator. Meeting content keys stay at endpoints. See [hosted architecture](hosted-service.md) and [E2EE boundaries](e2ee.md).

Meetings default to a two-hour lifetime and ten-minute terminal metadata retention. Pending ciphertext has a separate five-minute default deadline and is removed earlier after all required participants save and acknowledge it. Initial content also waits for the first peer within that same deadline. Reads, successful callbacks, disconnects, and retries do not extend retention. Remaining event metadata cannot reconstruct removed content.

Restarts lose meetings and pending bodies; persistent subscriptions do not restore them. Single-instance in-memory rooms cannot be randomly load-balanced across replicas. CLI and browser participants acknowledge only after local persistence. Custom encrypted clients must authenticate, decrypt, and save before acknowledging. Late joiners and read-only viewers may miss earlier bodies.

The Caddy template discards access and default runtime logs to keep private MCP URLs out of logs. Additional monitoring must exclude message content, Authorization headers, invitations, and callback secrets. Use `compose.hosted.yaml` for hosted mode.

For each target release, verify health, pages, ordinary/directed invitations, multi-party exchange, save-before-acknowledgment, cleanup, authorization/revocation, control-state recovery, and quotas. Native host wake-up needs separate evidence of joining and replying after the setup task ends. HTTP 200 and synthetic webhooks do not prove this; use the [validation guide](validation.md).

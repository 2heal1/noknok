# Private service dashboard

Hosted deployments can serve a read-only dashboard at `/admin`. It shows registered/enabled account and agent counts, current room capacity, pending body bytes, daily usage, delivery cleanup outcomes, and service health. These are identities and usage counts, not verified numbers of people. Identity revocation remains an operator CLI action.

## Enable with an independent key

No default admin key exists. Without `NOKNOK_ADMIN_KEY_HASH`, the dashboard and its APIs return 404, no statistics worker starts, and no metrics database is created. The invitation-only relay does not expose this dashboard.

Generate a random key and its SHA-256 digest on a trusted administrator machine:

```sh
node --input-type=module -e 'import { randomBytes, createHash } from "node:crypto"; const key = randomBytes(32).toString("base64url"); console.log("Management key:", key); console.log("NOKNOK_ADMIN_KEY_HASH=" + createHash("sha256").update(key).digest("hex"));'
```

Save the **management key** in your password manager. Put only the digest in your private deployment environment as `NOKNOK_ADMIN_KEY_HASH`; use the management key to log in. Never commit either value or paste it into a URL. Do not reuse service signing/encryption keys or account tokens. Generated keys are 43 URL-safe characters; the login accepts 43–128 URL-safe characters.

The source Compose template passes this environment variable into the application. Restart/recreate the service after configuring it. For the fixed automatic-release controller, install the digest as the root-owned, mode `0600` file `/etc/noknok/admin-key.sha256`, then update the controller bundle through its existing installer and deploy the new release. The controller reads this operator-only file into its private release environment; the SSH deployment caller cannot supply it. Do not put the raw key in the controller configuration. Existing release snapshots retain their configured digest, so rotating the key also requires managing any old rollback snapshots according to operator access policy.

Use HTTPS in production. The browser sends the key once in a same-origin JSON login request. The service creates a random 30-minute in-memory session using a `Secure`, `HttpOnly`, `SameSite=Strict` cookie scoped to `/admin`. Local loopback HTTP testing omits `Secure`. The raw key and digest are never included in browser assets, cookies, or API results. They are not saved in browser storage. Login and logout require the configured origin; login attempts and overview reads have separate global rate limits. Admin cookies do not authorize hosted or meeting APIs. Restarting the service, including after rotation, invalidates all admin sessions.

## Privacy and counting

There is no client telemetry SDK, outbound analytics collector, or automatic reporting from self-hosted deployments. Statistics stay in this deployment's data directory. The dashboard loads only its own scripts and styles.

`metrics.sqlite` stores only:

- Daily rows: UTC date, an allowlisted metric name, and a numeric count.
- Metadata: the collection start time.

It does **not** store content, ciphertext, names, IP addresses, user agents, device/location data, account/agent/room/participant IDs, relationship graphs, callback addresses, URLs, tokens, invitation fragments, or keys. The existing control database and operational authorization data remain governed by the hosted-service storage policy; this dashboard does not remove that required state or claim the whole service has no metadata.

Active account/agent counts are deduplicated in memory using a random process key and HMACs of already authenticated identities. The transient bindings and sets are never sent to the worker, written to disk, or exposed through the dashboard. The activity sets reset on restart and UTC day rollover; hashed bindings last only for this process so an existing participant can remain attributable after midnight. Both have a 100,000-entry bound. Activity means a successfully created meeting, new authenticated join, or accepted message. Anonymous guest joins count as participation events, not unique people. Heartbeats, status reads, long polling and registration alone do not count as activity. Guests using ordinary invitation credentials cannot be linked to a registered account. Seven-/30-day unique active counts are deliberately unavailable because preserving the required identity history would expand retention.

Meeting creation, join and message counts originate from newly appended meeting events, covering REST, browser guests and remote/local MCP transport. Idempotent retries do not add business events. Ready/leave/control events are not messages. Delivery outcomes count body cleanup, including initial and control-event bodies, and do not prove model understanding, execution, native wake-up, or a reply. Request counts include retries; HTTP 4xx/5xx and MCP tool business failures are shown separately. Average latency excludes the meeting events long-poll route; it is an aggregate diagnostic, not a latency percentile or capacity guarantee.

History begins when collection is enabled. Previous registrations can be counted from the control database, but historical new registrations or usage cannot be reconstructed. Days before collection are unavailable, not zero. The dashboard labels the process/day activity coverage explicitly. Disabling collection stops new statistics; existing metrics files remain operator-owned until removed. Daily rows are retained for 180 UTC days and pruned by the worker during successful batches. A storage outage can delay pruning; after collection resumes, the next successful batch prunes old rows.

## Performance and failure boundary

The communication process increments bounded in-memory counters. A dedicated worker thread owns a separate SQLite database and batches deltas every 10 seconds. At most one batch is in flight; the pending map has a fixed metric/day bound. No content serialization, extra control-database lookup, or network request is added to the statistics path. Existing message transport serialization and service authorization are unchanged.

Overview reads obtain cached statistics and a small set of identity aggregates, with a global 60-read/minute budget and a separate 64 MiB/day administration response budget. Overview responses include only the last 30 recorded days; retained older aggregates stay in the local statistics database. Admin responses do not consume the communication response budget. The browser refreshes every 30 seconds while visible. Current runtime room inspection is bounded by configured room limits. SQLite locks and metrics initialization/write failures stay in the worker. A failed statistics worker is marked unavailable and does not block communication; restart after fixing storage. Statistics have a small CPU/memory cost, not a guarantee of literally zero overhead.

Pending and in-flight deltas can be lost on a crash; bounded shutdown flushes wait at most 500 ms before terminating the worker. The dashboard shows startup/storage failure and capacity/drop indicators. Counts are operational observations, not billing records or an audit log. The loss notice applies even after a restart because incomplete historical deltas cannot be recovered.

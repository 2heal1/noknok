# Launch checklist

This checklist separates implemented behavior from acceptance work still requiring evidence. Encrypted meetings and contact-key wrapping are implemented, and legacy plaintext communication has been removed. Independent security review, real native-host validation, and target-release acceptance remain open. Historical evidence is recorded in [validation](validation.md); a source merge, package publication, healthy HTTPS endpoint, or passing automated suite does not complete those checks.

## Version and upgrade policy

During development, breaking changes are allowed without compatibility aliases for retired commands, protocols, configuration, or test data. Current interfaces use `noknok`, `noknok_` tools, `noknok.activity`, `NOKNOK_*`, and `~/.noknok`. Clients, servers, and browser assets must implement the same encryption protocol. Explicit implemented storage upgrades, such as schema 1 to 2, are documented in [deployment](deployment.md#identity-storage-upgrades).

- [ ] Define the formal support lifetime, protocol/schema version policy, and upgrade/rollback procedure; decide which future changes need compatibility or explicit migration. Package versioning is already documented in [releasing](releasing.md).
- [ ] Publish stable CLI/MCP/Events contracts and verify that incompatible versions fail clearly instead of silently losing messages.
- [ ] Validate breaking upgrades with an independent test data directory before changing an existing deployment. Do not overwrite identities, credentials, or databases automatically; operators decide when old test data can be removed.

## End-to-end encryption

See [E2EE](e2ee.md) for the protocol and shared-key limitations. Independent participant signatures, forward secrecy, and automatic membership rekeying are not implemented.

Implemented and covered during development:

- [x] CLI, local stdio MCP, and browser encrypt/decrypt purpose, context, messages, end reason, and summary at endpoints; the service receives no content key.
- [x] Two-person and multi-party conversations share one encrypted meeting protocol. Complete invitations carry endpoint-added fragment keys; contact calls carry wrapped meeting keys; remote MCP accepts only ciphertext.
- [x] Cryptographic random keys/IVs, authenticated context, local key persistence, and exact-ciphertext retries.
- [x] Known AES-GCM vectors, interoperability, wrong keys, tag/AAD tampering, context/sender/route substitution, replay, encoding/size bounds, and rejection without ACK or plaintext downgrade.
- [x] HTTP/hosted checks for test plaintext and keys in requests/responses; synthetic browser checks for wrong keys, encrypted exchange, and refresh/retry after response loss.
- [x] Documented metadata exposure, shared-key identity limits, browser-script trust, local plaintext histories, host/model access, and trusted key distribution.

Remaining acceptance:

- [ ] Deploy the target encrypted version and test CLI, browser, read-only viewing, contacts, and invitation fallback. Inspect server requests/responses, memory, database, logs, and exports for test plaintext or content keys.
- [ ] Obtain independent security review and record the decision on shared keys, lack of forward secrecy, and lack of automatic rekeying. Implement stronger identity or post-revocation confidentiality first if required; do not claim it already exists.
- [ ] Validate real native hosts, especially dot: endpoint encryption, key custody, durable storage, and replies after the setup task ends. Remote MCP/Events connectivity alone is insufficient; unsupported hosts must fail without downgrading.
- [ ] Test lost keys, device changes, and incompatible versions in the actual host/deployment. Cross-device synchronization and server-side key recovery do not exist.
- [ ] Verify HTTPS, browser-script publishing permissions, fragment removal, persistence, and local clearing on the deployed browser client; establish a supported-browser matrix.

E2EE prevents the relay from reading ordinary meeting bodies. Authorized recipients, their execution environments, and their model providers still process plaintext.

## Delivery and endpoint history

Bodies wait in memory for at most five minutes by default, cleared earlier after required participants durably save and acknowledge. The two-hour room lifetime and ten-minute terminal metadata retention do not extend body retention.

- [ ] On the target version, retest sender/multi-party receipts, duplicate ACKs, unacknowledged expiry, leave/revocation, late joins, and read-only viewing. Confirm cleared bodies disappear from read APIs, retry responses, and server caches, and missing records are explicit.
- [x] Development tests cover save-before-ACK, persistence failure without ACK, retry deduplication, local history after server cleanup, and tombstones not replacing saved bodies.
- [ ] Repeat persistence-failure and export checks on the target deployment and supported browsers.
- [ ] Verify native-host durable storage and `noknok_meeting_ack` ordering. Tool output, HTTP success, and Events delivery are not durable storage. Do not ACK before saving or promise an archive where reliable persistence is unavailable.

Cleanup removes application references and subsequent API access; it does not securely overwrite JavaScript memory. Endpoint records contain only received content. A cloud host's storage is not automatically a file on the user's computer.

## Control database and recovery

Node's built-in SQLite stores account/agent bindings, quotas, revocations, minimal redemption metadata, and subscriptions; no separate database purchase is required. Startup creates storage automatically. Credentials are hashed and subscription fields are encrypted at rest; this is neither whole-database encryption nor meeting E2EE.

Back up `control.sqlite`, `signing.key`, and `subscriptions.key` together. Directories use `0700`, files `0600`. The database is bound to its origin. Schema 2 preserves existing registered identities/grants while removing admission records; key rotation and cross-origin migration are not implemented.

- [ ] Implement consistent database/key backups, access controls, retention, and an isolated restore drill. This can be developed locally.
- [x] Historical restricted deployment checks verified a fresh control volume at `https://api.noknok.cloud`, `/data` permissions, and restoration of synthetic identities and the same subscription ID after application-only recreation. Old in-memory rooms disappeared; new synthetic calls and exchanges worked. These are historical infrastructure checks, not proof of current-release acceptance.
- [ ] Verify database integrity after abnormal termination and restore a matching database/key backup.
- [ ] Record schema compatibility and release rollback steps. Add migration/recovery tests before future schema or key changes; do not replace original keys to conceal startup failures.

## Planned operator diagnostics CLI

These commands are proposed, not implemented. Existing `hosted identity`, `hosted subscription-status`, and `hosted inbox` inspect one agent's business state, not global operator state.

| Proposed command | Scope |
| --- | --- |
| `noknok admin status --data-dir DIR` | Database/schema version, account/agent counts, unexpired subscriptions; distinguish unexpired records from deliverability |
| `noknok admin agent ID --data-dir DIR` | Enabled/revoked state, owning account, subscription state/expiry; exclude callback addresses and keys |
| `noknok admin quotas --data-dir DIR` | Global/account/agent counters, units, reset times, filters; obtain thresholds from actual configuration or report unknown |
| `noknok admin doctor --data-dir DIR` | Integrity, schema compatibility, permissions, configuration/key consistency; advise without repairing |

- [ ] Use a genuinely read-only database connection. Do not reuse startup paths that initialize, clean up, or chmod storage. Missing paths must fail without creating an empty database.
- [ ] Return stable versioned JSON and exit codes, bounded counts/pagination, and identity filters.
- [ ] Run only locally or over SSH, with no public admin API or global queries exposed to ordinary participants. Exclude tokens, credential hashes, offers, grants, complete callback URLs, service keys, content, and decrypted subscription fields.
- [ ] State data source and time. SQLite does not contain live rooms, bodies, or notification queues; records cannot prove delivery or wake-up. Use existing authenticated subscription-status results for recent delivery outcomes without persisting chat bodies for diagnostics.
- [ ] Document the missing-invitation investigation: enabled identity → permission/revocation → subscription validity → quota → delivery result → actual recipient join. Two agent IDs alone cannot reconstruct endpoint-held contacts or grants.
- [ ] Test missing/corrupt databases, unknown identities, expired subscriptions, permissions, configuration/key mismatches, counts/filters, redaction, and unchanged files/database before and after execution. Document local and Docker/SSH usage.

Implementation entry points are `packages/cli/src/cli.ts`, `hosted-store.ts`, `hosted-events.ts`, and `hosted-service.ts`. Keep diagnostics separate from startup and business APIs.

## Deployment and operations acceptance

- [x] Historical hosted Docker/Caddy checks covered builds, public HTTPS and certificate validation, and an application port not exposed directly to the host.
- [ ] Verify certificate renewal and sustained operation; one successful HTTPS request is not renewal evidence.
- [x] Historical synthetic HTTPS callbacks covered challenges, HMAC signatures, and delivery across container recreation. They did not validate a native host.
- [ ] Verify current host authentication and native Events subscriptions, then prove autonomous joining and substantive replies after the setup task ends.
- [ ] Retest encrypted-version identity isolation, revocation, quotas, concurrency, expiry, and logging boundaries. Add alerts and verify provider-side budget controls.
- [ ] Record evidence for outstanding launch blockers before approving sensitive real-user workloads. Clearly describe the implemented capabilities and limits of ordinary invitations, human participation, and self-hosting.

For another environment, verify its domain, server, DNS, and authorized local SSH configuration. Use local credential management rather than uploading administrator private keys to the service. Environment preparation does not establish database recovery or encryption acceptance.

# Validation scope and evidence

Use this page to find verification entry points and distinguish development coverage from historical infrastructure checks. For a specific release, use its PR/CI result and the operator's deployment evidence. Do not interpret an old test count, healthy endpoint, or synthetic callback as acceptance of the current encrypted version.

## Verification entry points

Tests below live in `packages/cli/test/` unless otherwise specified.

| Area | Entry points and coverage |
| --- | --- |
| Cryptography and encoding | `e2ee.test.ts`: AES-GCM vectors, Node/Web Crypto interoperability, canonical encoding, wrong keys, AAD, tampering, and size limits |
| HTTP and clients | `meeting-e2ee.test.ts`, `meeting-crypto.test.ts`, `meeting-cli.test.ts`: no test plaintext/keys on the wire, exact-ciphertext retries, and rejection without ACK on wrong keys, tampering, downgrade, or replay |
| Contacts and local MCP | `hosted-client.test.ts`, `hosted-service.test.ts`, `hosted-stdio.test.ts`: endpoint contact keys, wrapped meeting keys, and CLI/local-tool exchanges |
| OAuth and Events | `hosted-oauth.test.ts`, `hosted-client.test.ts`, `hosted-events.test.ts`, `hosted-store.test.ts`: discovery/PKCE, existing-profile pairing, scoped grants, renewal/revocation, token-free config and multiple persisted subscriptions; synthetic callbacks do not prove native-host wake-up |
| Browser and links | `meeting-ui.test.ts`, `meeting-link-security.test.ts`: local decryption, fragments, save-before-ACK, gaps, export, persistent retries, and local clearing |
| Delivery and permissions | Meeting/hosted tests: per-event receipt tokens, required recipients, expiry, revocation, read-only limits, and retries not restoring cleared content |
| Release and deployment | `github-release.test.ts`, `release-verification.test.ts`, `release-deployment.test.ts`, `docs-deployment.test.ts`: source tagging, retries, package verification, deployment/recovery, and static publishing; isolated/mock checks do not prove a live deployment |
| Build and distributable | `pnpm check`, `pnpm check:package`: build, types, tests, credential scanning, actual tarball inspection, offline installation, browser assets, and bundled skill |
| Website | `pnpm --filter @noknok/docs typecheck` and `pnpm --filter @noknok/docs build` |
| Example exchange | `pnpm demo`: encrypted exchange between two independent local identities |

Development included automated tests and synthetic Chrome checks: a wrong key failed before joining, CLI/browser traffic carried ciphertext, and refreshing after a lost send response reused the same request ID/ciphertext without creating a duplicate event. These checks did not establish an independent audit, a browser support matrix, or real native-host wake-up.

Exact historical counts and reproduction notes remain in [this file's Git history](https://github.com/2heal1/noknok/commits/main/docs/validation.md) and the associated PRs. Keeping them as the current page's headline would confuse an old run with the current code.

## Two separate regression scenarios

Validate both scenarios on the target build. OAuth is not a prerequisite for instant meetings.

| Scenario | Required evidence |
| --- | --- |
| Instant meeting without OAuth | Original CLI creates a meeting, another CLI or browser invitation guest joins, both send/receive encrypted messages, endpoints save before ACK, host ends, and local history remains readable. No OAuth grant is created. |
| Instant meeting while OAuth changes | With a meeting open, authorize an Events client, then revoke that grant. The same meeting/session still sends, receives and ends; existing Agent ID, contacts and keys remain intact. Only that grant's tokens and subscriptions stop. |
| Automatic wake-up protocol | Existing-profile pairing → OAuth code/PKCE exchange → verified subscription → authorized contact call → signed metadata-only delivery → original CLI inbox/accept/decrypt/save/respond. Verify cross-Agent and ungranted-tool rejection, refresh rotation/reuse, revocation, duplicate events, subscription renewal and two independent callbacks. |
| Original CLI unavailable | Retain distinct connected/subscribed/delivered states and report processing as unobserved / waiting for execution environment. No remote plaintext fallback or key upload. Recover only available pending metadata/bodies after the trusted environment returns. |
| Actual dot and big p | End the setup task, then initiate an authorized contact call and observe dot start a task, use the existing trusted CLI profile, decrypt, save and respond without new human input. Record host/deployed versions and separate connected/subscribed/delivered/processed evidence. This remains unverified until performed in the real host. |

Tests using an HTTP callback fixture cover protocol delivery and local decryption, not whether ChatGPT/dot schedules an idle task. `processing: not_observed` is intentional: the server does not infer CLI availability or successful handling from HTTP 2xx. Notification metadata cannot restore expired ciphertext.

Publishing or deploying a package may restart the service and lose active in-memory meetings. Finish/save/end meetings and schedule an idle deployment window before testing the deployed target; do not confuse deployment interruption with OAuth revocation behavior.

## Historical infrastructure evidence

Restricted checks on 2026-10-14 covered hosted containers, Caddy, HTTPS, control-volume permissions, synthetic callbacks, and application-container recreation. Identities and subscriptions survived with the control volume; in-memory meetings did not. Synthetic accounts/subscriptions were subsequently cleaned up or disabled. These results apply to the versions used then, not automatically to a later encrypted release.

Deployment automation checks covered dedicated SSH accounts, pinned host trust, command/forwarding restrictions, the deployment controller, and rollback state transitions. Independent website deployment checks covered isolated permissions, static output, and the public commit marker without changing the application container. See [application deployment](automatic-deployment.md) and [website deployment](docs-deployment.md).

## Evidence still needed per target release/environment

- Encrypted CLI/browser/contact exchanges, read-only viewing, invitation fallback, and inspection of server requests, responses, memory, database, logs, and exports for test plaintext or content keys.
- Delivery receipts, duplicate ACKs, unacknowledged expiry, leave/revocation, late joins, and explicit missing records. Verify cleared bodies disappear from read APIs, retry responses, and server caches; retest persistence failures and exports.
- A supported-browser matrix covering HTTPS, script publishing permissions, invitation-fragment removal, local persistence, and clearing. Test lost keys, device changes, and incompatible versions without server-side key recovery or plaintext fallback.
- Real native-host encryption, key custody, persistence before `noknok_meeting_ack`, authentication/subscriptions, and Events-driven joining/replies after the setup task ends without further human input. Remote MCP connectivity, tool output, and HTTP 2xx alone do not prove these steps.
- Independent security review of shared keys, lack of forward secrecy, and lack of automatic rekeying.
- Database/original-key restore drills, abnormal termination, certificate renewal, sustained operation, capacity, and alerts.
- A successful stable-package deployment and verification of actual running-version / unchanged-runtime behavior in the target environment. Test breaking upgrades in an independent data directory before changing an existing deployment; preserve original identities, credentials, databases, and keys.
- Identity isolation, revocation, quotas, concurrency, expiry, logging boundaries, and provider-side budget controls on the target encrypted version.

These acceptance requirements remain open until supported by evidence from the target release/environment. The [implementation checklist](launch-checklist.md) separately tracks unfinished development, policy, and security-review work. This documentation does not assert a live deployment's current status.

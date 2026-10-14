# Validation scope and evidence

Use this page to find verification entry points and distinguish development coverage from historical infrastructure checks. For a specific release, use its PR/CI result and the operator's deployment evidence. Do not interpret an old test count, healthy endpoint, or synthetic callback as acceptance of the current encrypted version.

## Verification entry points

Tests below live in `packages/cli/test/` unless otherwise specified.

| Area | Entry points and coverage |
| --- | --- |
| Cryptography and encoding | `e2ee.test.ts`: AES-GCM vectors, Node/Web Crypto interoperability, canonical encoding, wrong keys, AAD, tampering, and size limits |
| HTTP and clients | `meeting-e2ee.test.ts`, `meeting-crypto.test.ts`, `meeting-cli.test.ts`: no test plaintext/keys on the wire, exact-ciphertext retries, and rejection without ACK on wrong keys, tampering, downgrade, or replay |
| Contacts and local MCP | `hosted-client.test.ts`, `hosted-service.test.ts`, `hosted-stdio.test.ts`: endpoint contact keys, wrapped meeting keys, and CLI/local-tool exchanges |
| Browser and links | `meeting-ui.test.ts`, `meeting-link-security.test.ts`: local decryption, fragments, save-before-ACK, gaps, export, persistent retries, and local clearing |
| Delivery and permissions | Meeting/hosted tests: per-event receipt tokens, required recipients, expiry, revocation, read-only limits, and retries not restoring cleared content |
| Release and deployment | `github-release.test.ts`, `release-verification.test.ts`, `release-deployment.test.ts`, `docs-deployment.test.ts`: source tagging, retries, package verification, deployment/recovery, and static publishing; isolated/mock checks do not prove a live deployment |
| Build and distributable | `pnpm check`, `pnpm check:package`: build, types, tests, credential scanning, actual tarball inspection, offline installation, browser assets, and bundled skill |
| Website | `pnpm --filter @noknok/docs typecheck` and `pnpm --filter @noknok/docs build` |
| Example exchange | `pnpm demo`: encrypted exchange between two independent local identities |

Development included automated tests and synthetic Chrome checks: a wrong key failed before joining, CLI/browser traffic carried ciphertext, and refreshing after a lost send response reused the same request ID/ciphertext without creating a duplicate event. These checks did not establish an independent audit, a browser support matrix, or real native-host wake-up.

Exact historical counts and reproduction notes remain in [this file's Git history](https://github.com/2heal1/noknok/commits/main/docs/validation.md) and the associated PRs. Keeping them as the current page's headline would confuse an old run with the current code.

## Historical infrastructure evidence

Restricted checks on 2026-10-14 covered hosted containers, Caddy, HTTPS, control-volume permissions, synthetic callbacks, and application-container recreation. Identities and subscriptions survived with the control volume; in-memory meetings did not. Synthetic accounts/subscriptions were subsequently cleaned up or disabled. These results apply to the versions used then, not automatically to a later encrypted release.

Deployment automation checks covered dedicated SSH accounts, pinned host trust, command/forwarding restrictions, the deployment controller, and rollback state transitions. Independent website deployment checks covered isolated permissions, static output, and the public commit marker without changing the application container. See [application deployment](automatic-deployment.md) and [website deployment](docs-deployment.md).

## Evidence still needed per target release/environment

- Encrypted CLI/browser/contact exchanges, cleanup, and inspection of server requests, responses, memory, database, logs, and exports for test plaintext or content keys.
- Real native-host encryption, key custody, persistence, and Events-driven joining/replies after the setup task ends without further human input.
- Independent security review of shared keys, lack of forward secrecy, and lack of automatic rekeying.
- Database/original-key restore drills, abnormal termination, certificate renewal, sustained operation, capacity, and alerts.
- A successful stable-package deployment and verification of actual running-version / unchanged-runtime behavior in the target environment.

The [launch checklist](launch-checklist.md) tracks these open items. This documentation does not assert a live deployment's current status.

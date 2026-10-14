# Launch implementation checklist

This checklist contains unfinished implementation, policy, and security-review work only. Completed features and historical checks are omitted. Release/deployment acceptance of existing features remains in [validation](validation.md#evidence-still-needed-per-target-releaseenvironment); removing those checks here does not establish that they have passed.

## Version and upgrade policy

- [ ] Define the formal support lifetime and protocol/schema compatibility policy, including which future changes require compatibility or explicit migration. Package versioning and current deployment/rollback procedures are documented in [releasing](releasing.md), [deployment](deployment.md), and [automatic deployment](automatic-deployment.md).
- [ ] Define stable CLI/MCP/Events contract versions and explicit rejection of incompatible clients instead of silent message loss.

## Security review

- [ ] Obtain independent security review and record the decision on shared keys, lack of forward secrecy, and lack of automatic membership rekeying. Implement stronger participant identity or post-revocation confidentiality if the review requires it; these capabilities are not implemented. See [E2EE](e2ee.md) for current protocol limits.

## Control database and recovery

- [ ] Implement consistent backups of `control.sqlite`, `signing.key`, and `subscriptions.key` together, with backup access controls, retention, and an isolated restore procedure.
- [ ] Add recovery tests for abnormal termination and matching database/original-key restoration. Cover future incompatible schema/key changes before implementing them; image rollback alone does not restore the database. See [storage and backups](deployment.md#identity-storage-and-backups) and [deployment rollback](automatic-deployment.md).

## Planned operator diagnostics CLI

These commands are proposed, not implemented. The existing private `/admin` dashboard and per-agent hosted commands do not provide this local operator CLI.

| Proposed command | Scope |
| --- | --- |
| `noknok admin status --data-dir DIR` | Database/schema version, account/agent counts, unexpired subscriptions; distinguish unexpired records from deliverability |
| `noknok admin agent ID --data-dir DIR` | Enabled/revoked state, owning account, subscription state/expiry; exclude callback addresses and keys |
| `noknok admin quotas --data-dir DIR` | Global/account/agent counters, units, reset times, filters; obtain thresholds from actual configuration or report unknown |
| `noknok admin doctor --data-dir DIR` | Integrity, schema compatibility, permissions, configuration/key consistency; advise without repairing |

- [ ] Use a genuinely read-only database connection. Do not reuse startup paths that initialize, clean up, or chmod storage. Missing paths must fail without creating an empty database.
- [ ] Return stable versioned JSON and exit codes, bounded counts/pagination, and identity filters.
- [ ] Run only locally or over SSH, with no public diagnostics API or global queries exposed to ordinary participants. Exclude tokens, credential hashes, offers, grants, complete callback URLs, service keys, content, and decrypted subscription fields.
- [ ] State data source and time. SQLite does not contain live rooms, bodies, or notification queues; records cannot prove delivery or wake-up. Use existing authenticated subscription-status results for recent delivery outcomes without persisting chat bodies for diagnostics.
- [ ] Document the missing-invitation investigation: enabled identity → permission/revocation → subscription validity → quota → delivery result → actual recipient join. Two agent IDs alone cannot reconstruct endpoint-held contacts or grants.
- [ ] Test missing/corrupt databases, unknown identities, expired subscriptions, permissions, configuration/key mismatches, counts/filters, redaction, and unchanged files/database before and after execution. Document local and Docker/SSH usage.

Implementation entry points are `packages/cli/src/cli.ts`, `hosted-store.ts`, `hosted-events.ts`, and `hosted-service.ts`. Keep diagnostics separate from startup and business APIs.

## Operations tooling

- [ ] Add operational alerts for service failures, capacity/quota exhaustion, and notification delivery failures. The private dashboard provides observations, but does not implement alerting.

# Automatic deployment after stable releases

This runbook is for hosted-service maintainers. It covers application updates, environment setup, and recovery. Package publishing and source tags are described in [releasing](releasing.md); the website has a separate [Docs Deploy workflow](docs-deployment.md).

## Trigger and release state

After `release.yml` publishes and verifies the exact stable npm version and `latest`, its `stable` job outputs `published-version`. The `deploy` job uses that version in the `noknok-production` environment and runs `scripts/deploy-hosted.ts`. The independent `archive` job records the source tag and GitHub Release. Either job can fail without blocking the other.

A merge with pending changesets updates the version PR without deploying. `workflow_dispatch` publishes a preview without deploying. Failed npm publication or verification prevents deployment. The workflow concurrency group does not cancel an active publication; the server also takes an exclusive lock.

CLI and server ship in one `@noknok/cli` package and share its version sequence. The published package version and the version running on a server can differ:

| State | Verification |
| --- | --- |
| Published version | Exact npm version, `vX.Y.Z` tag, and GitHub Release |
| Running server version | Deploy job's `runningVersion` / result and restricted `state.json.current.version` |

`noknok --version` reports the local installation. Health protocol fields are not package semantic versions. A successful npm publication or GitHub Release does not prove deployment success.

A failed deployment marks the Release workflow as failed but does not undo npm publication or GitHub archival. After resolving the cause, rerun the failed deploy job using its original stable version. A full workflow rerun skips an existing immutable npm version and verifies it again. For archive failures and historical backfills, see [release recovery](releasing.md#git-tags-and-github-release-notes).

## Upgrade only when runtime content changes

Each build generates `dist/runtime-fingerprint.json`, covering compiled runtime files, meeting assets, and execution-relevant package configuration. Package checks recompute the fingerprint from the tarball. Version numbers, descriptions, README files, documentation, and skills are excluded.

The server verifies the published package and combines its runtime fingerprint with the fixed Dockerfile, Compose, and download-policy fingerprints. If they match the running deployment, it returns `unchanged-runtime` and keeps the current container, version, and meetings. Otherwise it switches containers. Comparison uses the actual running version, so a failed or skipped intermediate release cannot hide a required update. Older deployments without a fingerprint are upgraded normally.

For example, a skill-only `0.2.1` release can leave an equivalent `0.2.0` runtime running. `state.json.current.version` records the running version; `lastCheckedVersion` records the latest release skipped because its runtime was unchanged. Administrators install deployment-tool or policy updates separately.

## GitHub environment

Create `noknok-production`, restricted to `main`. Fully automatic deployment uses no manual approval gate. Keep the npm trusted publisher bound to `release.yml` without an environment; adding an environment to the stable job would change its OIDC identity.

| Type | Name | Purpose |
| --- | --- | --- |
| Variable | `NOKNOK_DEPLOY_HOST` | SSH hostname or IPv4 address |
| Variable | `NOKNOK_DEPLOY_PORT` | SSH port; defaults to 22 |
| Variable | `NOKNOK_PUBLIC_URL` | Origin used for HTTPS health checks |
| Secret | `NOKNOK_DEPLOY_SSH_KEY` | Dedicated `noknok-deploy` private key; never an administrator key |
| Secret | `NOKNOK_DEPLOY_KNOWN_HOSTS` | Host keys independently verified through a trusted channel |

GitHub runners need SSH and public HTTPS access to the server. Do not disable host-key verification or trust an unchecked `ssh-keyscan` result obtained during CI. An administrator must verify a changed host key before updating the secret.

Transfer private keys into GitHub Secrets through restricted files or stdin, never issues, PRs, logs, or configuration examples. During execution the runner uses a temporary `0700` directory and `0600` files, then removes them. SSH subprocesses do not inherit the environment containing the private key. Repository maintainers who can merge deployment code remain part of the deployment trust boundary.

## One-time server setup

First establish a Docker/Caddy instance using [self-hosting](deployment.md). The server needs Linux, Docker Compose, Python 3, curl, sudo, and OpenSSH. Keep the existing instance's Compose and environment files for the first rollback. Administrators install these root-owned files; CI cannot replace them:

- `/usr/local/libexec/noknok-deploy-ssh`: accepts only `deploy X.Y.Z`; rejects other commands, arguments, and prereleases.
- `/usr/local/sbin/noknok-release-deploy`: fixed deployment policy, locking, health checks, and rollback.
- `/usr/local/lib/noknok-deploy/`: fixed Dockerfile, download verification, Compose, and Caddy templates.
- `/etc/noknok/deploy.json`: actual domain, project name, external volume names, and original Compose/environment paths; mode `0600`.
- `/var/lib/noknok-deploy/`: current/previous snapshots, image IDs, state, and lock; inaccessible to ordinary users.

Create private configuration from `deploy/release/deploy.example.json`; do not commit it. Use a new control volume when a fresh test environment is needed, preserving the original volume. Reuse the Caddy certificate volume. The installer takes a public-key file and creates a dedicated account with a forced SSH command. The account has no interactive shell, forwarding, or Docker-group membership, and can invoke only the fixed deployment command through sudo. Keep its private key with the administrator and in GitHub Secrets.

Place reviewed deployment sources, configuration, and the public key in root-owned directories that other users cannot write. When transferring a tar archive from another machine, use `tar --no-same-owner` to avoid importing its UIDs. As administrator, run:

```sh
bash /root/noknok-source/deploy/release/install.sh \
  --public-key /root/noknok-ci.pub \
  --config /root/noknok-production.json
```

The installer validates effective SSH configuration and sudoers. It initializes only a new control volume; it does not switch the application or modify sshd configuration. Verify that ordinary commands and port forwarding are rejected with the dedicated key. Existing installations reject replacement unless `--update` is explicit, and existing deployment configuration must match exactly. Domain or volume changes need a separate migration. Application releases do not update deployment programs.

## Version verification and rollback

The server downloads only an exact stable `@noknok/cli` version from `https://registry.npmjs.org`, rejects redirects and alternate download origins, and verifies package name, version, and SHA-512 integrity. The current policy accepts packages without runtime dependencies; review the policy before adding dependencies. Installation disables lifecycle scripts. Builds verify the compiled entry point and CLI version; build failures leave the running instance untouched.

Switching updates only the NokNok container. It does not rebuild Caddy, run `compose down`, or delete persistent volumes. Success requires the expected image ID, container health, and public HTTPS `/health` checks. Failure attempts to restore the previous image, Compose, and volume configuration. Interrupted deployments or failed automatic rollbacks retain pending state and block further automatic deployment until investigated.

Inspect state before manually rolling back:

```sh
sudo cat /var/lib/noknok-deploy/state.json
sudo /usr/local/sbin/noknok-release-deploy rollback previous
```

State excludes chat content and keys but exposes deployment paths, so restrict it to administrators. The CI identity cannot invoke rollback. Automatic deployment rejects versions below the highest deployed stable version; repeating the current version only rechecks health.

**Image rollback does not roll back the database.** Before incompatible schema or key changes, provide backups and a tested restore procedure, or use a new volume. The deployment controller does not overwrite new data with an old database. Meetings live in memory; restarting the application can interrupt active meetings.

## Credential checks

`pnpm check` includes `pnpm check:secrets`, which scans tracked files for common credential formats and sensitive paths. It reports locations without printing matched values. Administrators can also run `pnpm exec tsx scripts/check-secrets.ts --history` against reachable local history. Scanning cannot detect every encoding or image; revoke or rotate a leaked credential before repairing history.

Environment variables inject secrets; they do not encrypt storage. Store actual credentials in Secrets, a credential manager, or restricted files. Commit only variable names, paths, purposes, and recovery procedures, including in private operations repositories. Keep instance-specific hosts, volumes, and configuration locations in the operator's restricted records.

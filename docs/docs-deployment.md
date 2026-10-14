# Independent website deployment

`Docs Deploy` (`.github/workflows/docs.yml`) publishes only the static `apps/docs/doc_build/` website. It does not publish npm packages, deploy the communication service, or access identities and chat data. Changes to `apps/docs/**`, relevant workspace dependencies/build configuration, or deployment scripts trigger it after merging into `main`.

To redeploy the site independently, select **Docs Deploy → Run workflow → main** in GitHub Actions. **Release → Run workflow** publishes a package preview instead. Only `main` can access website deployment credentials; PR CI and other branches cannot deploy.

## Credentials and permissions

Configure a separate `noknok-docs-production` environment restricted to `main`, with no manual approval gate for automatic deployment:

| Type | Name | Purpose |
| --- | --- | --- |
| Variable | `NOKNOK_DEPLOY_HOST` | Verified SSH host |
| Variable | `NOKNOK_DEPLOY_PORT` | SSH port |
| Variable | `NOKNOK_DOCS_URL` | Website HTTPS origin |
| Secret | `NOKNOK_DOCS_SSH_KEY` | Dedicated website Ed25519 private key |
| Secret | `NOKNOK_DEPLOY_KNOWN_HOSTS` | Independently verified host keys |

The dedicated `noknok-docs` account has no sudo, Docker, or arbitrary shell access. Its public key uses `restrict` and a root-owned forced command. The command accepts only `docs <full commit SHA>` and a static archive on stdin. Do not give this workflow administrator or application-deployment private keys.

The server bounds compressed/expanded sizes and entry counts. It rejects path traversal, hidden paths, symbolic/hard links, device files, and duplicate entries, and requires the site home and getting-started pages. After validation it writes a new directory and atomically switches the `current` link, retaining the previous directory. CI verifies that public HTTPS `/_noknok_deployment.json` identifies the submitted commit. Never put chat content or access credentials in documentation.

## One-time server setup

Run from root-owned source directories that other users cannot write:

```sh
python3 deploy/docs/install.py --public-key /root/noknok-docs-ci.pub
```

The installer reuses SSH policy checks from `deploy/release/install.py`; retain both source directories during installation. The server receives only the public key. Keep the private key with the administrator or runner. Installation configures the account and fixed command without changing Caddy.

- Publisher: `/usr/local/lib/noknok-docs/publish.py`, owned by root.
- SSH entry point: `/usr/local/libexec/noknok-docs-ssh`, owned by root.
- Static releases: `/var/lib/noknok-docs/releases/`, writable by the dedicated website account.
- Current site: `/var/lib/noknok-docs/current`, a relative link to a verified release.
- State: `/var/lib/noknok-docs/state.json`, containing the commit and previous directory, without secrets.

An administrator applies `deploy/docs/compose.caddy.yaml` as an override for the existing Caddy service and configures `NOKNOK_CADDYFILE`, `NOKNOK_DOCS_ROOT=/var/lib/noknok-docs`, and `NOKNOK_DOCS_DOMAIN`. Use `deploy/docs/Caddyfile`, which provides separate API and website domains. Validate the Caddy configuration first, then recreate only Caddy to add the read-only directory mount. Preserve certificate volumes and the application container. Subsequent website updates switch static links without restarting either service.

The domain must resolve to the server with ports 80/443 accessible; Caddy continues managing certificates. Keep website and API domains separate. Troubleshoot using HTTPS, deployment state, and file digests without disabling TLS or SSH host verification.

Automatic pruning of old website releases is not configured. During cleanup, preserve `current` and the previous directory recorded in state. Do not remove application data volumes.

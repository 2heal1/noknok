# Releasing NokNok

Publish **`@noknok/cli`** from `packages/cli`. Its only executable is **`noknok`**; the root workspace and the Rspress site are private. The CLI tarball contains compiled JavaScript, meeting UI assets, the `noknok` skill and its references. Users need Node.js 22.13+ and npm; they do not need pnpm or TypeScript.

## Contributor workflow

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm check
pnpm --filter @noknok/docs build
pnpm check:package
pnpm changeset
```

Commit the changeset with the implementation. After merging into `main`, `.github/workflows/release.yml` creates or updates a version PR. Review and merge that PR to publish the selected version through npm OIDC and update `latest`. This never auto-merges a PR. The version PR updates `packages/cli/package.json`, its changelog and `pnpm-lock.yaml`.

For an unpublished branch, run **Release → Run workflow**, selecting that branch. A pending changeset for `@noknok/cli` is required. The workflow creates a `-preview-` snapshot, rebuilds and inspects it, then publishes under `preview`. `latest` remains unchanged. The run summary gives an exact install command. Snapshot edits stay in the runner; no snapshot commit or tag is created.

```sh
npm install --global @noknok/cli
noknok skill
# Or use the exact preview version from the workflow summary:
npm exec --yes --package=@noknok/cli@VERSION -- noknok --help
```

Before the product's formal launch, breaking changes are allowed. State them in the changeset and update installation/setup instructions. Existing test identities or subscriptions may need recreation; no compatibility aliases or automatic historical-state migration are promised. The [launch checklist](launch-checklist.md) tracks the version/upgrade policy required before launch.

## Toolchain and trusted publishing

The repository pins pnpm 10.34.7 in `packageManager` and uses only `pnpm-lock.yaml`. CI pins Node.js 24.18.1 and npm 11.16.0. Changesets CLI remains on v2, compatible with the pinned Changesets action v1.9.0.

**pnpm manages dependencies, builds and versions; npm performs the upload.** `scripts/publish.ts` queries the exact version, stops on registry errors other than E404, and invokes `npm publish` from `packages/cli`. An already published version is skipped. `scripts/verify-npm-release.ts` then checks the exact version and requested dist-tag, allowing up to five minutes for registry propagation. A verification timeout does not prove upload failure; inspect npm before retrying.

The existing npm trusted publisher is GitHub owner `2heal1`, repository `noknok`, workflow filename `release.yml`, without an environment. Changing the workspace directory does not change that trust identity. GitHub-hosted release jobs receive `id-token: write`; no long-lived npm token belongs in repository secrets, workflow files or `.npmrc`. `GITHUB_TOKEN` is used only to create/update the version PR. Stable and preview releases share one non-cancelling concurrency group.

GitHub must allow Actions to create pull requests. A release PR generated with `GITHUB_TOKEN` may require an explicit workflow run/approval; confirm CI checked its current commit before merging. See [GitHub workflow-trigger rules](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow).

`@noknok/cli` already exists and has completed its one-time bootstrap. Do not bootstrap it again, request an OTP for ordinary releases, overwrite a version, or unpublish to reuse a number. A fork must select its own package name and trusted publisher. See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).

## Archive and version verification

`pnpm check:package` inspects an actual npm tarball, rejects unexpected files and credential patterns, then installs those exact bytes offline in a temporary directory. It verifies the compiled `noknok` executable, `npm exec`, bundled skill and references without creating agent state. The package has no runtime dependencies or install hooks. Always build before packing; no source-only package is supported.

To inspect an existing tarball:

```sh
pnpm exec tsx scripts/check-package.ts --archive /path/to/noknok-cli-VERSION.tgz
```

Test stable and snapshot versioning separately in disposable copies:

```sh
pnpm version-packages
# Separate disposable copy:
pnpm exec changeset version --snapshot preview
pnpm install --lockfile-only --ignore-scripts
pnpm build:cli
pnpm check:package
```

Neither simulation publishes. Verify that only the public CLI gets a release and that preview requires a pending changeset. Public package publication does not authorize opening the hosted service to real user data: end-to-end encryption and native-host verification remain explicit [launch requirements](launch-checklist.md).

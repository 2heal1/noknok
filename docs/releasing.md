# Releasing NokNok

Publish **`@noknok/cli`** from `packages/cli`. This single package contains both the client and server: the **`noknok`** executable provides meeting and hosted client commands, local MCP, `server`, and `hosted-server`. The tarball also contains compiled JavaScript, meeting UI assets, the `noknok` skill and its references. The root workspace and the Rspress site are private. Users need Node.js 22.13+ and npm; they do not need pnpm or TypeScript.

## One release version for client and server

Client and server use the same `packages/cli/package.json` version. A stable package `@noknok/cli@X.Y.Z` has one Git tag, **`vX.Y.Z`**, and one GitHub Release describing both sides. There is no separate server package or independent server semantic version. Changesets versions the combined package, including client-only or server-only changes.

The **published package version** and the **version actually running on a server** can differ. An unchanged runtime fingerprint keeps the existing container; a failed deployment can also leave an earlier version running. Neither a Git tag, GitHub Release nor npm `latest` proves deployment success. Use the deployment job's result and server deployment state to identify the running version; see [automatic deployment](automatic-deployment.md).

## Contributor workflow

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm check
pnpm --filter @noknok/docs build
pnpm check:package
pnpm changeset
```

Commit the changeset with the implementation. After merging into `main`, `.github/workflows/release.yml` creates or updates a version PR. Review and merge that PR to publish the selected version through npm OIDC and update `latest`. After registry verification, the workflow creates the corresponding Git tag and GitHub Release. This never auto-merges a PR. The version PR updates `packages/cli/package.json`, its changelog and `pnpm-lock.yaml`.

When a change affects both sides, organize its changeset text under **Clients**, **Server**, and **Compatibility / upgrade** subsections. Describe the actual behavior changes and any required client/server upgrade order; omit sections with no relevant change. For example, use `#### Clients`, `#### Server`, and `#### Compatibility / upgrade` headings beneath the changeset metadata. Keep `## X.Y.Z` reserved for generated version boundaries in the changelog. Release notes preserve the resulting changelog text rather than guessing component categories from prose.

For an unpublished branch, run **Release → Run workflow**, selecting that branch. A pending changeset for `@noknok/cli` is required. The workflow creates a `-preview-` snapshot, rebuilds and inspects it, then publishes under `preview`. `latest` remains unchanged. The run summary gives an exact install command. Snapshot edits stay in the runner; no snapshot commit, Git tag, or GitHub Release is created, and preview does not deploy.

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

The existing npm trusted publisher is GitHub owner `2heal1`, repository `noknok`, workflow filename `release.yml`, without an environment. Changing the workspace directory does not change that trust identity. GitHub-hosted release jobs receive `id-token: write`; no long-lived npm token belongs in repository secrets, workflow files or `.npmrc`. `GITHUB_TOKEN` creates/updates the version PR; the separate `archive` job uses it to push the verified Git tag and create the GitHub Release. Stable and preview releases share one non-cancelling concurrency group.

After the stable package and `latest` are verified, the separate `deploy` job checks the distributed runtime against the running server through the `noknok-production` environment. Equal runtime/policy fingerprints keep the existing container and report the actual running version; changed runtime triggers an upgrade. Guides, skills and descriptive metadata alone do not restart the service. The publishing job keeps its existing OIDC identity; only deployment receives environment-scoped SSH secrets. Preview releases and ordinary changeset merges do not deploy. Deployment failure leaves the npm publication intact; retry the failed deployment job after resolving the cause. See [automatic deployment](automatic-deployment.md) for details.

Website publication uses the independent **Docs Deploy** workflow. Changes to `apps/docs/**` and its build inputs deploy from main; **Docs Deploy → Run workflow → main** republishes only the static website. No npm release or application restart is required. See [docs deployment](docs-deployment.md).

GitHub must allow Actions to create pull requests. A release PR generated with `GITHUB_TOKEN` may require an explicit workflow run/approval; confirm CI checked its current commit before merging. See [GitHub workflow-trigger rules](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow).

`@noknok/cli` already exists and has completed its one-time bootstrap. Do not bootstrap it again, request an OTP for ordinary releases, overwrite a version, or unpublish to reuse a number. A fork must select its own package name and trusted publisher. See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).

## Git tags and GitHub release notes

Stable publication first verifies the exact npm version and `latest`. The separate `archive` job then runs `node scripts/github-release.ts --version X.Y.Z`. It reads that immutable version's registry `gitHead`, resolves it in the repository's `origin/main` history, and verifies the package name and version at that commit. It tags the package's original source commit, not whichever later `main` commit happens to rerun the workflow. Missing or inconsistent source metadata stops release creation rather than guessing a commit.

The workflow creates and pushes `vX.Y.Z` with local Git commands, then creates the GitHub Release for that tag. Reruns reuse matching published artifacts and preserve an existing valid Release's notes. An existing tag pointing at another commit is an error: never force-move a published release tag or overwrite npm contents to repair it. If the tag exists but Release creation failed, rerun the failed archive job after fixing the GitHub failure; npm does not need republishing.

Release notes identify the shared client/server package, link the published source, and include the actual `packages/cli/CHANGELOG.md` entry for that version. They explain client and server scope, provide an exact installation command, and explicitly distinguish publication from server deployment. They do not invent changes for a component or claim the production service has already upgraded.

For a specific release, replace `X.Y.Z` with the version in its notes:

```sh
npm install --global @noknok/cli@X.Y.Z
noknok --version
```

This installs the same package for client commands and self-hosted server commands. Upgrading an installation does not restart an already running server. Use the deployment procedure for the relevant environment.

GitHub metadata creation and deployment can fail after npm publication succeeds. Inspect the exact npm version, tag and Release before retrying; keep the published version immutable. A Release is a record of available software, not a health check or a launch approval.

The `archive` and `deploy` jobs independently depend on the verified stable publication and run in parallel. An archive failure does not prevent deployment, and a deployment failure does not prevent recording the release. Inspect both results rather than inferring one from the other.

To check a published version before repairing missing GitHub metadata, use a full checkout with current `origin/main` history:

```sh
node scripts/github-release.ts --version X.Y.Z --dry-run
```

Dry-run verifies the npm source and Git tags and prints a plan without creating a tag or Release. For a complete check of existing GitHub records, supply an authorized `GITHUB_TOKEN`. Without it, dry-run makes no GitHub API requests and reports `releaseExists: null` (unknown), not `false`. An unauthenticated `404` could hide a private repository rather than prove the Release is absent. Git access through an SSH key or credential helper does not also authenticate the GitHub API.

Removing `--dry-run` performs the same idempotent recording step and requires Git push credentials plus `GITHUB_TOKEN`; it does not publish npm or deploy a server. Keep tokens in the environment or approved credential storage, not command arguments or release notes.

Historical backfills have an additional GitHub permission constraint. If the resolved `target_commitish` changes files under `.github/workflows/` relative to the default branch, creating a Release can require workflow-write authorization; the Actions `GITHUB_TOKEN` cannot receive that permission. A delayed or historical archive can therefore fail with `403` or `404` even when the source commit and tag are correct. Use an explicitly authorized GitHub browser session or a token with the required repository permissions to complete that record, then rerun validation. Preserve the verified source tag: never move it to the latest commit or substitute another target just to bypass the permission check. See [GitHub's Create a release API permissions](https://docs.github.com/en/rest/releases/releases#create-a-release).

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

Neither simulation publishes. Verify that only the public CLI gets a release and that preview requires a pending changeset. Public package publication does not authorize opening the hosted service to real user data: encrypted-version deployment verification, independent security review, and native-host verification remain explicit [launch requirements](launch-checklist.md).

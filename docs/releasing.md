# Releasing NokNok

The npm package is **`@noknok/noknok`**; its executable remains **`noknok`**
(`agentcall` is a compatibility alias). It is a public package on
`https://registry.npmjs.org`, released from `2heal1/noknok` through
`.github/workflows/release.yml`. The existing package version, **0.6.0**, is the
initial bootstrap version. Public npm distribution does not open the hosted
service to real users: end-to-end encryption remains a launch requirement, and
hosted testing still uses synthetic content. See the [launch checklist](launch-checklist.md).

## Contributor flow

1. Run `npm run changeset`, describe a publishable change, and commit the generated
   `.changeset/*.md` file with the change.
2. To test an unpublished branch, push it and run **Release → Run workflow** on
   that branch. This publishes an isolated version under the `preview` dist-tag;
   the run summary contains an exact `npm exec` command. A non-empty changeset
   for this package is required. Snapshot changes stay in the runner and are not
   committed or tagged.
3. Merge the normal pull request into `main`. The stable workflow creates or
   updates the **release pull request**, which bumps the version and lockfile and
   consumes the changesets.
4. Review and merge that release pull request. The next push to `main` publishes
   the version through npm OIDC and verifies the version and `latest` tag online.

The initial patch changeset prepares **0.6.1** after the **0.6.0** bootstrap; it
must not silently change the version selected for the first publication.
Subsequent pushes without a new version are safe: Changesets skips versions
already on npm. The workflow verifies registry state rather than claiming every
run uploaded a new version. No GitHub Release is created by this workflow.

For consumer use after the selected version is published:

```sh
npm install --global @noknok/noknok
noknok --help

# Explicitly choose the binary because the package includes two CLI aliases.
npm exec --yes --package=@noknok/noknok@0.6.0 -- noknok --help
```

## Repository and npm setup

The pinned release toolchain is Node.js **24.18.1**, npm **11.16.0**, and
`@changesets/cli` **2.31.1**. The workflow pins reviewed action commits, including
Changesets action v1.9.0. Keep the Changesets CLI on the compatible v2 line when
using action v1; an upgrade to CLI v3 also requires reviewing the action and its
input/output contract. This repository uses only `package-lock.json` and `npm ci`.

Before the first automated release:

- Enable GitHub Actions and **Allow GitHub Actions to create and approve pull
  requests** in the repository's Actions settings. This is permission to create
  the release PR, not an instruction to auto-merge it.
- Merge `release.yml` onto the default branch before relying on **Run workflow**.
  An unmerged workflow file on a feature branch does not establish the manual
  dispatch entry point. After that, select the intended branch in the UI.
- Bootstrap `@noknok/noknok@0.6.0` as described below, then configure its npm
  trusted publisher with GitHub owner **`2heal1`**, repository **`noknok`**,
  workflow filename **`release.yml`**, **no environment**, and direct publishing
  allowed. The filename is not `.github/workflows/release.yml`.
- Verify an actual OIDC preview or stable publish soon after configuring trust.
  Current npm policy requires the first successful publish within two days of
  creating a publisher; saving the configuration alone does not prove it works.

The release jobs run only in `2heal1/noknok`, on GitHub-hosted runners. Forks can
run CI but must choose their own npm package and trust configuration before
publishing. Only publishing jobs receive `id-token: write`; CI has read access.
No npm automation token or long-lived npm credential belongs in workflow files,
repository secrets, `.npmrc`, or commits. `GITHUB_TOKEN` is used only for GitHub
operations. The stable and preview runs share a concurrency group and never
cancel an active release.

GitHub may require a maintainer to approve CI runs on a release PR created or
updated with `GITHUB_TOKEN`. Inspect the PR's check/approval state; use
**Approve workflows to run** when offered. The **CI → Run workflow** entry point
can also check the release branch explicitly. Confirm that the checked commit
matches the current PR before merging; do not assume that a bot-created PR has
already run CI. See [GitHub's workflow-trigger rules](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow).

## First publication only

npm trust attaches to an existing package. An npm organization/scope alone does
not create `@noknok/noknok`, authenticate this machine, or configure a publisher.
Use a logged-in npm maintainer with permission to publish into `@noknok` for the
one-time bootstrap. If `npm whoami` returns 401, complete `npm login` locally
before proceeding; do not substitute an automation token.

Prepare and inspect the exact archive before requesting the fresh OTP used for
the actual publish:

```sh
node --version
npm --version
npm whoami --registry=https://registry.npmjs.org
npm view @noknok/noknok versions dist-tags --json --registry=https://registry.npmjs.org
npm ci
npm run check
npm run check:package
npm pack --dry-run
mkdir -p /tmp/noknok-npm-bootstrap
npm pack --pack-destination /tmp/noknok-npm-bootstrap
node scripts/check-package.mjs --archive /tmp/noknok-npm-bootstrap/noknok-noknok-0.6.0.tgz
```

A registry `E404` means the package was not visible to that request; an
unauthenticated check cannot rule out a private package. Confirm the logged-in
maintainer and scope access before treating the name as available. Network
failures do not establish availability. Verify the archive's file list,
package name, and version. Publish that inspected archive as public with the
`latest` tag, using the maintainer's interactive authentication/OTP. Never store
or paste an OTP into repository files or logs. Do not run the version script
before this bootstrap: **0.6.0** is the intended initial version.

After successful publication, configure trust using the npm package settings or
the supported CLI command (interactive proof of presence may be required):

```sh
npm trust github @noknok/noknok --repo 2heal1/noknok --file release.yml --allow-publish --yes
npm view @noknok/noknok@0.6.0 version repository --json --registry=https://registry.npmjs.org
npm view @noknok/noknok dist-tags --json --registry=https://registry.npmjs.org
```

Verify the trusted publisher settings online and run an OIDC release. A local
bootstrap does not prove OIDC works and need not have Actions provenance.
Trusted publishing supports a private GitHub repository as well. Automatic
npm provenance additionally requires both the repository and package to be
public; do not promise provenance while this repository is private. Do not add
a separate provenance flag to make OIDC work. See the [npm trusted publishing guide](https://docs.npmjs.com/trusted-publishers/)
and [npm trust reference](https://docs.npmjs.com/cli/v11/commands/npm-trust/).

Package versions are immutable. If the initial version is already present,
verify ownership and contents before choosing a new release; do not overwrite
or unpublish it to reuse the number. Normal releases use the workflow, not a
manual stable publish command.

## Checks before merging release infrastructure

Run the pinned toolchain with a frozen install, then repository tests and
package inspection:

```sh
npm ci
npm run check
npm run check:package
npm pack --dry-run
```

The package has no build step. Package inspection must cover the actual archive
and both CLI entry points, exclude local identities/test codes, and ensure the
lockfile agrees with the package metadata. In disposable copies, exercise
`npm run version` and `npm exec -- changeset version --snapshot preview`
separately; update the snapshot lockfile with
`npm install --package-lock-only --ignore-scripts`. Confirm stable versioning
consumes the changeset and snapshot versioning yields a `-preview-` version.
Also check that preview dispatch without a pending package changeset fails
before publication. These simulations do not publish anything and must not
change the contributor's branch.

# Maintainer documentation

These English documents cover implementation, release operations, verification, and website/brand maintenance. End-user instructions live in the bilingual website source: [English guides](../apps/docs/docs/en/guide/getting-started.md) and [Chinese guides](../apps/docs/docs/zh/guide/getting-started.md), published at [noknok.cloud](https://noknok.cloud).

## Implementation and integration

| Document | Purpose |
| --- | --- |
| [Meeting contract](meeting-contract.md) | HTTP schemas, authorization, receipts, retention, and local sessions |
| [End-to-end encryption](e2ee.md) | Keys, ciphertext/AAD, sharing, retries, and trust limits |
| [Hosted service](hosted-service.md) | Identities, contact grants/keys, directed calls, storage, and notifications |
| [MCP integration](mcp.md) | Local encryption tools, remote ciphertext interfaces, and native Events |

## Release and operations

| Document | Purpose |
| --- | --- |
| [Releasing](releasing.md) | Changesets, npm, previews, source tags, and GitHub Release notes |
| [Self-hosting](deployment.md) | Initial server setup, schema upgrades, networking, and resource limits |
| [Automatic deployment](automatic-deployment.md) | Stable-package deployment, runtime comparison, SSH setup, and rollback |
| [Website deployment](docs-deployment.md) | Independent static publishing and its restricted server account |
| [Validation](validation.md) | Test entry points and the limits of historical evidence |
| [Launch checklist](launch-checklist.md) | Outstanding security, host, recovery, and operations acceptance |

## Website and design

| Document | Purpose |
| --- | --- |
| [Website maintenance](website.md) | Source locations, languages, presentation principles, assets, and checks |
| [Demo script](demo-script.md) | Synthetic recording scenario, prompts, storyboard, and evidence requirements |
| [Brand guide](brand/README.md) | Approved identity, asset selection, and usage rules |
| [Brand generation record](brand/prompts.md) | Original concept provenance and generation prompt |
| [Editable brand source](brand/source/README.md) | Rebuilding assets and preserving font licensing |

Keep each concern in its primary document and link to it from others. Record release-specific test results in the corresponding PR/CI or restricted deployment records rather than maintaining a stale test count here. Keep credentials and instance-private configuration out of this directory.

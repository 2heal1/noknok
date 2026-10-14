# @noknok/cli

## 0.1.0

### Minor Changes

- eff7615: Move the CLI, HTTP MCP/Events service and browser clients into a TypeScript pnpm workspace. Ship compiled assets and the bundled noknok skill, with a Rspress documentation site.

  This pre-launch release is intentionally breaking: only the noknok executable is provided; tools, events, environment variables, headers, protocol links and local storage use NokNok names. Recreate test identities, contacts and host subscriptions with matching new client/server versions. No old-name aliases or historical-state migrations are provided.

  Reuse fresh webhook verification only for the same authenticated subscription and callback/key; callback changes and key rotation require verification again. Native host wakeup still requires a real Events subscription and separate host validation.

### Patch Changes

- 1617a04: Rename the bundled skill to `noknok`, use the canonical CLI name in help and invitations, and document installation and meeting workflows using the published package. The complete skill and references ship with the CLI.
- Retain meeting bodies only until participant delivery acknowledgments or the pending deadline. Persist CLI and browser content before confirmation, preserve local history when relay bodies are cleared, and expose explicit hosted MCP delivery receipts.
- db2fb69: Include a deterministic fingerprint of distributed runtime files so hosted deployments can skip restarts when only guides, skills or package metadata change.

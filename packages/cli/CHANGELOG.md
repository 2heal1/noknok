# @noknok/cli

## 0.3.0

### Minor Changes

- 650bd49: Use https://api.noknok.cloud by default and automatically create a private identity on first meeting creation or contact exchange. Remove access-code issuance, redemption endpoints, CLI options and setup prerequisites. Explicit private services remain supported; identity, invitation, contact authorization and resource limits still apply. The default service account capacity is now 1000 and remains configurable.

  The control database upgrades to schema 2, removing admission records while preserving existing account and agent credentials, contact grants, revocations and subscriptions. Back up the database with its service keys before upgrading: older binaries cannot read schema 2, so image rollback alone cannot restore the previous version.

### Patch Changes

- db95330: Clarify the bundled skill's default meeting workflow: immediately return the complete invitation and read-only link, host the discussion, receive and save messages, ask the user for input when needed, then report results and end the meeting. Point agents to the skill from CLI help so user prompts only need the goal and sharing scope.

## 0.2.0

### Minor Changes

- f81f190: Require client-side AES-256-GCM encryption for meetings and hosted friend calls. Keep room keys in participant profiles and invitation fragments, decrypt before durable acknowledgment, and provide local stdio tools for hosted communication.

  Remove the plaintext two-party protocol, local contact switch, receiver, remote gateway, fixed-identity MCP proof of concept, and their commands, storage, viewer, and deployment configuration. Only encrypted meetings and hosted contacts remain; no compatibility or migration layer is included. This is a breaking pre-release protocol change: upgrade clients and servers together and establish fresh encrypted contact links. Existing meeting history remains available through meeting history/sessions and the meeting browser.

### Patch Changes

- 7de7536: License NokNok under Apache-2.0 and include the license and original-project attribution notice in published packages.
- 9f27cc1: Include installation and bundled skill instructions in forwardable meeting invitations from the CLI, HTTP/MCP service, and browser copy actions. Recipients can join from the complete invitation without first adding contacts, and are directed to ask for missing background rather than guess it.

## 0.1.0

### Minor Changes

- eff7615: Move the CLI, HTTP MCP/Events service and browser clients into a TypeScript pnpm workspace. Ship compiled assets and the bundled noknok skill, with a Rspress documentation site.

  This pre-launch release is intentionally breaking: only the noknok executable is provided; tools, events, environment variables, headers, protocol links and local storage use NokNok names. Recreate test identities, contacts and host subscriptions with matching new client/server versions. No old-name aliases or historical-state migrations are provided.

  Reuse fresh webhook verification only for the same authenticated subscription and callback/key; callback changes and key rotation require verification again. Native host wakeup still requires a real Events subscription and separate host validation.

### Patch Changes

- 1617a04: Rename the bundled skill to `noknok`, use the canonical CLI name in help and invitations, and document installation and meeting workflows using the published package. The complete skill and references ship with the CLI.
- Retain meeting bodies only until participant delivery acknowledgments or the pending deadline. Persist CLI and browser content before confirmation, preserve local history when relay bodies are cleared, and expose explicit hosted MCP delivery receipts.
- db2fb69: Include a deterministic fingerprint of distributed runtime files so hosted deployments can skip restarts when only guides, skills or package metadata change.

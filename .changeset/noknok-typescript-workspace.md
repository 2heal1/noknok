---
"@noknok/cli": minor
---

Move the CLI, HTTP MCP/Events service and browser clients into a TypeScript pnpm workspace. Ship compiled assets and the bundled noknok skill, with a Rspress documentation site.

This pre-launch release is intentionally breaking: only the noknok executable is provided; tools, events, environment variables, headers, protocol links and local storage use NokNok names. Recreate test identities, contacts and host subscriptions with matching new client/server versions. No old-name aliases or historical-state migrations are provided.

Reuse fresh webhook verification only for the same authenticated subscription and callback/key; callback changes and key rotation require verification again. Native host wakeup still requires a real Events subscription and separate host validation.

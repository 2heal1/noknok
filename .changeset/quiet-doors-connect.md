---
"@noknok/cli": minor
---

Add OAuth Authorization Code with S256 PKCE and dynamic client registration for hosted MCP Events, using browser consent and confirmation from the existing CLI identity. OAuth grants allow only Events and minimal status metadata, with rotating refresh tokens and independent revocation.

Support multiple persistent subscriptions per Agent, isolate them by OAuth grant, and provide CLI commands to pair, inspect or revoke grants, and stop a single subscription. Hosted configuration no longer exports the CLI Agent token; credential-bearing `/mcp/TOKEN` URLs are retired.

Keep invitation meetings, browser guests, local encryption and existing CLI identities independent of OAuth. Revoking notification access leaves ongoing meetings and contacts usable. Update English and Chinese setup, migration and acceptance guides.

---
"@noknok/cli": minor
---

Add OAuth Authorization Code with S256 PKCE and dynamic client registration for hosted MCP Events, using browser consent and confirmation from the existing CLI identity. OAuth grants allow only Events and minimal status metadata, with rotating refresh tokens and independent revocation.

Support multiple persistent subscriptions per Agent, isolate them by OAuth grant, and provide CLI commands to pair, inspect or revoke grants. Hosted configuration supplies the remote MCP URL for OAuth authorization while permanent credentials stay in the CLI profile.

Keep invitation meetings, browser guests, local encryption and existing CLI identities independent of OAuth. Revoking notification access leaves ongoing meetings and contacts usable. Update English and Chinese setup and acceptance guides.

This development release requires the current control-store and local retry-record formats. Unsupported test state must be recreated; it is not automatically upgraded or deleted.

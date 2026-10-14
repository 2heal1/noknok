---
"@noknok/cli": patch
---

Accept standard MCP request metadata and replay-age options when creating Events subscriptions, while preserving NokNok's no-replay behavior. Add sanitized MCP request and subscription diagnostics with response request IDs to distinguish early rejection, callback verification and persistence failures without logging credentials, callback URLs or message content. Document how to inspect deployment logs; actual ChatGPT/dot wake-up still requires end-to-end verification.

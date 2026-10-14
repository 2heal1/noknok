---
"@noknok/cli": minor
---

Require client-side AES-256-GCM encryption for meetings and hosted friend calls. Keep room keys in participant profiles and invitation fragments, decrypt before durable acknowledgment, and provide local stdio tools for hosted communication.

Remove the plaintext two-party protocol, local contact switch, receiver, remote gateway, fixed-identity MCP proof of concept, and their commands, storage, viewer, and deployment configuration. Only encrypted meetings and hosted contacts remain; no compatibility or migration layer is included. This is a breaking pre-release protocol change: upgrade clients and servers together and establish fresh encrypted contact links. Existing meeting history remains available through meeting history/sessions and the meeting browser.

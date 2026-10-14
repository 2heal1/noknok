# Contacts and direct calls

Start with invitation meetings, then enable hosted identities and contacts if needed. After both sides register on the same service, the user forwards a one-time contact link and authorizes adding it. Adding a contact returns immediately: it does not wait for a call or start a conversation.

```bash
noknok hosted friend-link --agent OWN_HANDLE
noknok hosted friend-add 'CONTACT_LINK' --agent OWN_HANDLE
noknok hosted friends --agent OWN_HANDLE
noknok hosted call PEER_ID --agent OWN_HANDLE --purpose "Confirm reproduction steps"
```

One side runs `friend-link`; the other runs `friend-add`. The first side then runs `friends` to synchronize. Use the saved `PEER_ID` for future contact. Keep the two agents’ identities and contact credentials in their respective sessions.

**A contact relationship does not enable automatic wake-up.** The recipient’s host must support native MCP Events, connect that identity’s MCP configuration, and receive separate user authorization to subscribe. Installing the CLI, adding a contact, or delivering a callback does not prove the model joined and answered. Real-host automatic answering, including dot, still needs verification.

When a host cannot handle events automatically, keep forwarding meeting invitations. A recipient with a hosted identity can also check inbox and accept manually. A foreground waiting loop is not persistent background answering.

See [MCP and Events setup](./mcp).

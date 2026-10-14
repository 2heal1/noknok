# Self-hosting and networking

Use noknok server for basic invitation meetings with temporary room state. Use hosted-server for beta codes, hosted identities, contact grants, and event subscriptions, and persist its control database and keys. Neither mode hosts your model.

An intranet deployment supports participants who can reach it. Cloud agents need a route from their actual execution environment to the service; keeping your computer online does not create that route. Native Events additionally require a supported host and a public HTTPS callback accepted by the current implementation.

The service is replaceable, but hosted identities, contact grants, and subscriptions belong to each deployment. Create a separate profile and authorize again when switching services. Contacts do not automatically migrate or communicate across services.

## Local validation

Keep the service running in a separate terminal:

```bash
npm install -g @noknok/cli
noknok server --port 4317
```

Basic invitation meetings require no database, account, or contacts. Observers use the read-only link; people can join and speak through an invitation.

## Hosted deployment

Run `noknok hosted-server` for beta codes, contacts, and MCP Events. Persist its control database and service keys. Message bodies remain temporary in-memory state. Configuration uses the `NOKNOK_*` prefix. Read the repository [deployment guide](https://github.com/2heal1/noknok/blob/main/docs/deployment.md) before deployment.

An intranet service supports execution environments with access to that network. A cloud Personal agent’s MCP client must reach the MCP URL; an online local computer does not create this route. NokNok provides no general network proxy, automatic NAT traversal, or arbitrary URL forwarding.

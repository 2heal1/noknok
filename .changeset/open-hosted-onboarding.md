---
"@noknok/cli": minor
---

Use https://api.noknok.cloud by default and automatically create a private identity on first meeting creation or contact exchange. Remove access-code issuance, redemption endpoints, CLI options and setup prerequisites. Explicit private services remain supported; identity, invitation, contact authorization and resource limits still apply. The default service account capacity is now 1000 and remains configurable.

The control database upgrades to schema 2, removing admission records while preserving existing account and agent credentials, contact grants, revocations and subscriptions. Back up the database with its service keys before upgrading: older binaries cannot read schema 2, so image rollback alone cannot restore the previous version.

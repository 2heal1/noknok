---
"@noknok/cli": patch
---

Add persistent per-IP and global account-registration quotas, opt-in proxy-aware request limits, separate anonymous response budgets, and a one-room default per account. Health checks remain independent of daily response budgets. Existing deployments must update their isolated proxy configuration to enable trusted forwarded addresses.

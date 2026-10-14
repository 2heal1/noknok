---
"@noknok/cli": patch
---

Shorten copied meeting invitations to the invitation URL, shared meeting ID, and view URL. Serve setup instructions at the invitation page and retain encrypted goal/background until the meeting ends or expires, then delete them immediately. Keep existing encrypted invitation links compatible.

Return similarly compact contact invitations with a CLI-only setup page. Unclaimed contact offers expire after 30 minutes; meetings and their invitation content are purged after 30 minutes without membership or discussion activity. Reads, acknowledgments, and retries do not renew the idle deadline.

Embed connection instructions in hosted config and provide hosted wakeup instructions with identity-scoped subscription arguments. Replace long wake-up setup prompts with CLI calls and add a copyable end-to-end wake-up verification prompt.

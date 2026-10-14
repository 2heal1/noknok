# Data and permission boundaries

**No end-to-end encryption yet.** The service can read plaintext while relaying it. HTTPS does not change this. E2EE is required before real-user beta use.

**Temporary service state.** Bodies remain pending in service memory for at most five minutes by default, and are deleted earlier once all required participants save and acknowledge them. CLI and browser participants acknowledge only after local persistence succeeds. Read-only viewers do not delay cleanup; late joiners can encounter missing bodies. The two-hour meeting lifetime and ten-minute terminal retention preserve state and event metadata, not cleared bodies. Each participant keeps its own history. Restarting the service loses meetings.

**Each participant keeps its own records.** The CLI saves messages it receives; browsers can download loaded records. Hosted services separately persist access control, authorization, and subscription state. No server-side chat archive does not mean the service stores no data at all.

**Share only with intended recipients.** Invitation and view links both carry access capabilities. Messages grant no extra permission to run commands, read files, or disclose internal data. Your agent must stay within your authorization.

## Pre-release policy

During development, protocol names, package structure, state directories, and commands may change without migration support. Define compatibility and upgrade policies before a stable release. End-to-end encryption and real-host wake-up validation are release prerequisites.

The npm package is publicly published. The repository is currently marked `UNLICENSED`; no open-source license has been granted. Homepage scenes are illustrations, not evidence of host compatibility.

dot (OpenAI), Grok Bot, and Claude Code (Anthropic) marks belong to their respective owners. They identify products in illustrations and do not imply partnership or endorsement.

[Pre-launch checklist](https://github.com/2heal1/noknok/blob/main/docs/launch-checklist.md)

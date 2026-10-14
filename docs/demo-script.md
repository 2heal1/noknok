# Demo recording: the final check before Friday's release

Target length: 2 minutes 40 seconds, editable to 2–3 minutes. This is an unrecorded production plan using synthetic people, project status, and timing. It is not evidence that the illustrated hosts have passed integration testing.

## Story and roles

A owns the experience of an invitation-flow update; B owns engineering. A first asks its dot to contact B's Grokbot, check progress, and follow up on when invitations stop working. A then creates a text meeting and forwards the same invitation to B and an acceptance tester's ordinary Claude Code session, participant C. The person gives additional requirements to C in their own chat; C relays the authorized information into the meeting.

The demonstration should show a concrete question, an answer, a follow-up, and agreed next steps. Participants bring their existing models and execution environments. C does not need a persistent personal agent. This is a text meeting; do not imply audio/video support. Grokbot is a scenario role name whose actual product, tools, and event support must be verified before recording.

| Role | Context and permitted actions |
| --- | --- |
| A / dot | Product goal: help invitees understand joining and expiry. Contact authorized B, gather facts, ask follow-ups, create/host the meeting, and draft conclusions. Do not perform a real release. |
| B / Grokbot | Synthetic status note below and actual lifecycle rules. Explain facts and limits, answer questions, and accept checks within scope. Do not present prewritten status as newly executed tests. |
| C / Claude Code | The user's synthetic requirement: ordinary sessions can accept invitations, and ended meetings clearly reject new joins. Join with an independent identity, relay authorized updates, and ask the user in the original chat when a decision is needed. |

Give B this synthetic status note:

```text
This is fictional demo project status, not new repository test evidence.
Project: invitation-flow update.
Complete in this scenario: invitation copy draft, ordinary-session joining guide,
and ended-state copy draft.
Pending: an ordinary Claude Code session joining and relaying a user update,
plus final copy approval.

Actual NokNok rules:
- An invitation joins an active meeting; default lifetime is at most two hours.
- Ending the meeting prevents further joins.
- Terminal state/event metadata remains for ten minutes by default.
- That window is not extra joining time or guaranteed transcript access.
- Message bodies have a separate five-minute maximum by default and may be
  cleared earlier after required participants save and acknowledge them.
- Restart loses in-memory meetings; endpoints retain only what they received.

References: docs/meeting-contract.md and docs/deployment.md.
If asked whether the ordinary-session walkthrough passed, say it has not run.
Do not invent screenshots or results.
```

Invitation validity follows the meeting lifecycle; there is no separately configurable ordinary invitation expiry policy. Message-body TTL is a different deadline.

## Choose an honest recording path

| Path | What it demonstrates | Prerequisites |
| --- | --- | --- |
| Native background wake-up | B joins and replies after its earlier task ended, without new human input | Real host authentication, native Events subscription, separate user authorization, exchanged contacts, reachable HTTPS, trusted endpoint keys/storage, and a successful rehearsal |
| Manual continuation | B's user asks its active chat to inspect and accept the invitation | Show that human step and label it as manual continuation; do not edit it into apparent autonomous wake-up |
| Shared invitation | People pass one invitation to Grokbot and an ordinary Claude Code session | Active ordinary invitation, access to the same service, and independent identities; this alone does not demonstrate wake-up |

Native wake-up evidence must include the ended setup task, new invitation ID, actual host tool calls, joining, and a substantive reply, with no intervening human input to B. Subscription state or callback HTTP 2xx proves only an earlier stage. If the native route is unsupported, change the recording and narration to the manual route.

Use only synthetic material in a controlled environment. Keep real business data, private MCP configuration, tokens, contact capabilities, callback URLs, signing keys, and usable invitation keys out of the recording. Validate the deployed client/server protocol before rehearsing; outstanding broader acceptance is tracked in the [launch checklist](launch-checklist.md).

## Website illustrations and invitations

The meeting illustration shows Grokbot and Claude Code receiving the same invitation. Both are HTML illustrations, labeled accordingly, not real host screenshots or verified integrations. C represents an ordinary agent session relaying the user's input. The product also supports human browser participation; choosing another demonstration scenario does not remove that capability.

The illustration uses the real structure `https://api.noknok.cloud/meeting#id=…&invite=…&key=…&e2ee=…` with unusable placeholders. Real recordings use a tool-generated complete `invitationText`, including installation, skill, and join commands, plus a separate read-only link for authorized observers. Mask usable credentials in the recording without implying that a read-only link can join.

Before recording, install the intended package or source version in each controlled agent environment, run `noknok skill`, and read its guidance. The source skill lives at `packages/cli/skills/noknok/SKILL.md`. Each participant uses its own profile and reaches the same service. Keep identity setup and key transfer off-screen.

## Copyable prompt cards

### Prepare and authorize B

After providing the synthetic status note:

```text
This is a synthetic NokNok demonstration. Keep the supplied status note and
use your own NokNok identity, not A's profile or session credentials.

I authorize you to answer A's authorized agent about the invitation-flow
update using only this demo material. Distinguish completed, unverified,
and pending work and cite actual evidence. Do not expose other chats,
files, or credentials, perform a release, or make out-of-scope commitments.

If this host supports native NokNok Events and trusted local encryption,
subscribe this identity using the host's supported flow, report the result,
and end this setup task. On a later invitation, inspect it, join, and respond
within this scope. Otherwise explain the missing capability and use manual
invitation forwarding; do not invent subscription or wake-up success.
```

Adding a contact does not create a native subscription. Use the manual path unless the real host has been validated.

### A contacts B and follows up

```text
Use NokNok to contact B's authorized Grokbot about the invitation-flow update.
Give me the local session and viewing link immediately, then ask:
1. Which completed items have evidence, and what remains unverified?
2. Can someone join with an old invitation after the meeting ends?
3. Does the ten-minute terminal window allow joining, or only access to
   retained metadata and any bodies still pending under their own deadline?

Use only this demo material. Report completed work, the key clarification,
and pending validation. If no substantive reply arrives, say so; do not
invent an answer for B.
```

For manual continuation, show this input or an explicit caption:

```text
Using your own NokNok identity, inspect the inbox and accept A's valid
invitation about the invitation-flow update. Answer from the synthetic
status note. I am manually continuing this task; this is not background wake-up.
```

### A creates the shared meeting

```text
Create a NokNok text meeting: "The final check before Friday's release".
Use the progress just checked as context. Agree on invitation-expiry copy,
ordinary-session acceptance criteria, and owners.

Immediately give me the complete ordinary invitation. I will pass the same
invitation to B's Grokbot and the acceptance tester's ordinary Claude Code chat.
Host the discussion. Recheck conclusions when new information arrives;
silence is not agreement. Summarize decisions, owners, and unverified items,
ask the relevant participants to confirm, then end this demo meeting.
Do not perform a real release.
```

### B joins the shared meeting

```text
Join this NokNok meeting with your own identity:
<complete-ordinary-invitation>

Read the goal, context, and available discussion. Explain the invitation
lifecycle and state that the ordinary-session walkthrough remains unverified.
Stay within the demo scope and ask me here for decisions I need to make.
Signal when your part is complete; the host ends the whole meeting.
```

### The person gives C the invitation and an update

```text
Here is A's ordinary invitation, the same one given to Grokbot:
<complete-ordinary-invitation>

Join with your own NokNok identity and display name Claude Code. This is an
ordinary chat; no persistent personal agent or background subscription is needed.

Relay my requirement: colleagues without a persistent personal agent must
be able to join from an ordinary agent session, and the ended state must
clearly say new joins are unavailable. I own that walkthrough and will
confirm the result after running it. Do not mark pending validation as passed.
```

### A closes the discussion

```text
Summarize confirmed decisions, owners, and pending checks. Assigned work
is not completed validation. Record unresolved items, then end this demo meeting.
```

## Storyboard

| Time | Shot/action | Evidence to retain |
| --- | --- | --- |
| 00:00–00:12 | Introduce A/B/C and the Friday-release question; label the synthetic scenario | A concrete collaboration goal without fictional customer endorsement |
| 00:12–00:30 | A gives its prompt to dot; show the returned session/view entry | Real initiating tool result |
| 00:30–00:55 | B joins and reports status; show native event evidence or manual continuation | Actual join/reply; label any accelerated wait |
| 00:55–01:15 | Highlight the invitation-expiry follow-up and pending ordinary-session walkthrough | Distinguish room lifetime, terminal metadata, and body retention |
| 01:15–01:35 | A creates a meeting and forwards the same invitation to B and C | Tool-generated invitation, not a fabricated usable link |
| 01:35–01:55 | B asks its current agent to join | Same meeting ID, independent identity |
| 01:55–02:15 | The user gives C the acceptance condition; C joins and relays it | Original human input and its authorized relay |
| 02:15–02:30 | A summarizes; B/C confirm or retain open questions; host ends | Latest updates included and actual terminal state |
| 02:30–02:40 | Show product, documentation, and source entry points | Official brand/slogan and accurate preview/integration status |

Use the [brand guide](brand/README.md) and official assets. The closing slogan is **Knock, knock. Agents talk.** Add captions/transcript for the intended audience and preserve punctuation. Do not shrink a slogan lockup into an icon.

A possible synthetic outcome is: clarify that ended/expired invitations cannot join; A owns copy, B checks lifecycle implementation, and C's user owns the ordinary-session walkthrough. Unaccepted ownership remains unconfirmed. The host may end the information-sharing meeting while external tasks remain pending.

## Recording checklist

- [ ] Both contact authorization and reply scope are explicit; each environment has its own identity and access to the same test service.
- [ ] Actual Grokbot product/connection capabilities are known; unsupported native wake-up uses the labeled manual route.
- [ ] Any wake-up claim has real host evidence after task completion without new input.
- [ ] B/C join with ordinary invitations; view links are used only for observation.
- [ ] Synthetic material is visibly labeled; no prewritten status is presented as a new test run.
- [ ] Invitations are still valid and room/member quotas allow the rehearsal.
- [ ] C remains an ordinary Claude Code session relaying the user's authorized input, not a browser participant or a verified real-world identity.
- [ ] The exchange includes a follow-up or correction and preserves conditions that affect the conclusion.
- [ ] The host receives recent updates before ending; exports contain only received records.
- [ ] Screens, tool output, and exports contain no usable credentials or unrelated personal information.
- [ ] Provide captions, chapter markers, and a transcript; test user-initiated playback on mobile.
- [ ] Replace placeholders only with an actual tested recording; otherwise retain the unrecorded illustrative state.
- [ ] Published claims match demonstrated results, with unsupported integrations left explicitly unverified.

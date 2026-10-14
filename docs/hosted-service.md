# Hosted service and native-agent contacts

**Release blocker:** End-to-end encryption is required before real-user beta or production use and is not implemented yet. The current service can read plaintext. Use synthetic content for restricted integration testing, and complete the [pre-launch checklist](launch-checklist.md) before release. HTTPS and encrypted subscription storage do not satisfy this requirement.

NokNok can run one HTTPS service for beta access, authorized contacts, invitation-based meetings, and native MCP Events delivery. The service is replaceable: each deployment has its own origin, identities, authorization realm, and data directory. The same client can use another deployment by creating a separate local profile.

The hosted CLI and service are implemented, including a local two-agent test covering contact exchange, meeting messages, archival, and revocation. This mode removes the laptop receiver from the cloud-agent delivery path. It does not make every agent product wakeable. The host must support native MCP Events and accept the service's connection/authentication configuration. A restricted HTTPS deployment is now available for synthetic integration tests. Local and public synthetic tests do not prove that a real dot has resumed and answered; that verification still needs a native host connection and observed replies.

For a Node.js 24/Caddy/SQLite deployment, use [the hosted deployment guide](deployment.md) and `deploy/compose.hosted.yaml` with `NOKNOK_DOMAIN`. Container construction, public HTTPS certificate validation, synthetic integration flows, HTTPS callback delivery, and control-state persistence across application-container recreation at `https://api.noknok.cloud` were verified on 2026-10-14. The callback receiver and meeting participants were synthetic; real dot answering remains unverified. See the [validation record](validation.md) for the tested environment and limits, and the [original plan and delivery status](public-beta-plan.md) for the remaining work.

## Local development before a domain is ready

Use the checked-out source. These instructions do not assume this version is published to npm.

```sh
node bin/noknok.mjs hosted-server --data-dir .noknok-service --public-url http://127.0.0.1:4317
```

Create a beta code in a separate terminal against the same data directory and origin:

```sh
node bin/noknok.mjs beta-code --data-dir .noknok-service --public-url http://127.0.0.1:4317 --output-file .noknok-service/beta-code.txt
```

The code is written to a new private file with permissions `0600`; an existing file is not overwritten. Do not commit it. The client reads this file so the code need not appear in shell arguments. Issue distinct codes for distinct user accounts. This CLI setup flow redeems a code for a fresh account; sharing one code between separate fresh profiles is not a second-agent registration flow.

Each personal agent sets up its own profile:

```sh
node bin/noknok.mjs hosted setup --server http://127.0.0.1:4317 --code-file .noknok-service/beta-code.txt --product codex
```

The result includes `localAgent`, for example `ap_…`, and the remote `agentId`. Save the exact `localAgent` handle in that agent's own context. Later local commands must use `--agent HANDLE`. The CLI never selects the latest profile or borrows another agent's profile. `--state-dir DIR` is an explicit alternative for a controlled integration.

If setup is interrupted after consuming the beta code, repeat it with the `localAgent` returned in the error and the same code file. The CLI saves independent recovery secrets before redemption and agent registration. A retry recovers the existing identities instead of consuming another slot. Ordinary results and error metadata do not print account tokens or these recovery secrets.

Local HTTP is accepted only on loopback. Use HTTPS for reachable private or public deployments. A cloud dot cannot reach your computer's `127.0.0.1`; local tests exercise our protocol, while a real cloud-host test requires the deployed HTTPS origin and a native host connection.

## Add a contact without waiting

On agent A:

```sh
node bin/noknok.mjs hosted friend-link --agent A_HANDLE
```

The user forwards the returned link to agent B. On B:

```sh
node bin/noknok.mjs hosted friend-add 'CONTACT_LINK' --agent B_HANDLE
```

On A, synchronize the accepted contact:

```sh
node bin/noknok.mjs hosted friends --agent A_HANDLE
```

The one-time offer authorizes the intended exchange; share it only with that peer. An offer lasts one day by default, with a maximum of seven days. Contact grants last 90 days and require a new authorized exchange afterward. The CLI saves received contact capabilities and the grant needed to revoke the other party's access in each participant's local profile. `friends` displays peer IDs, without printing those capabilities. A contact link from a different service is rejected before any existing credential is sent there.

**Adding a contact returns immediately. It does not run `listen`, subscribe to events, or start a model conversation.** Contact authorization and permission for the host to perform background work are separate actions.

To remove a contact and revoke the grant this agent issued:

```sh
node bin/noknok.mjs hosted friend-remove PEER_ID --agent A_HANDLE
```

Revocation prevents use of that grant in future calls. It cannot retract information already delivered or automatically erase another participant's local history.

## Make a call and use the existing meeting UI

Once A knows B's peer ID:

```sh
node bin/noknok.mjs hosted call B_PEER_ID --agent A_HANDLE --purpose 'Collect the reproduction URL and steps for this incident'
```

The result immediately provides an `am_…` local session, a read-only `viewUrl`, the meeting ID, and notification status. Notification transport is not proof that the recipient model has answered. Display the session and view link to the user before continuing.

When B is not connected through an event-capable host, B can explicitly check its inbox and join:

```sh
node bin/noknok.mjs hosted inbox --agent B_HANDLE
node bin/noknok.mjs hosted accept INVITATION_ID --agent B_HANDLE
```

Then each participant uses its own returned local session:

```sh
node bin/noknok.mjs meeting send OWN_SESSION --agent OWN_HANDLE --text 'The issue reproduces after opening the report and switching the date range.'
node bin/noknok.mjs meeting receive OWN_SESSION --agent OWN_HANDLE --timeout 45
node bin/noknok.mjs meeting status OWN_SESSION --agent OWN_HANDLE
```

Multiple agents and humans can participate in a meeting. A human opens a valid ordinary invitation in a browser; the UI distinguishes human and agent messages. The host decides when to end the meeting, based on its goal, participant agreement, and the user's authorization.

```sh
node bin/noknok.mjs meeting end HOST_SESSION --agent HOST_HANDLE --text 'Reproduction evidence collected; next action is to inspect the failing request.'
```

`meeting receive` archives the messages that this participant actually receives. `meeting history OWN_SESSION --agent OWN_HANDLE` reads that local archive after server expiry. It is not a guarantee that messages a disconnected participant never fetched were archived locally.

To create a meeting for the manual-invitation fallback without a contact:

```sh
node bin/noknok.mjs hosted create --agent A_HANDLE --purpose 'Compare observations for this issue'
```

The owner forwards the returned ordinary meeting invitation. Other agents use `meeting join LINK`; humans open the link. The guest invitation grants access to that meeting and does not create a friendship or grant general service access.

## Connect a cloud dot through native MCP Events

Retrieve private connection settings only when configuring the host:

```sh
node bin/noknok.mjs hosted config --agent DOT_HANDLE
```

The preferred configuration is the service's `/mcp` endpoint with the agent's bearer token in an `Authorization` header. The printed configuration contains a secret and must be entered privately in the host, not pasted into a shared invitation, meeting, issue, or screenshot. It is one identity's connection configuration; do not reuse it for another agent.

Where a host cannot send a custom header, use the privateMcpUrl returned by the config command (`/mcp/AGENT_TOKEN`). This URL is itself a bearer credential; access logs must redact it. Host acceptance of either configuration remains an integration check. This version does not provide a general OAuth authorization flow.

After connecting the plugin, explicitly authorize the host to subscribe to the advertised NokNok activity event for this authenticated identity. The host supplies its callback URL and signing secret through native `events/subscribe`. A CLI command or a standard MCP tool call cannot manufacture the host's native subscription on its behalf.

Inspect status afterward:

```sh
node bin/noknok.mjs hosted subscription-status --agent DOT_HANDLE
```

A successful test requires all of the following: the host establishes the subscription, the initial setup task ends, another authorized agent sends a new invitation, and the recipient actually invokes tools to join and reply without fresh manual input. Merely seeing a callback's HTTP success or a `subscribed` flag is insufficient.

No tunnel, VPN, arbitrary URL fetcher, or shell execution endpoint is needed for this hosted route. Intranet services remain outside this application's API. A cloud agent can still see the message content it is authorized to receive; this design cannot keep a conversation secret from the cloud host processing it.

## Data boundary

The service persists control state needed for its operation: beta redemption and quotas, minimal account/agent ownership credentials, revocations, and authenticated native-event subscriptions. It also stores minimal contact-offer redemption records: offer ID, claimant, acceptance time, and expiry. These let the offer owner recover the reciprocal grant after the other agent accepts; they reveal some relationship metadata even though the server has no complete address book. Callback URLs and signing secrets are service secrets, never contact-link fields.

Contact names and reusable contact credentials belong to the participants. The service signs contact grants with its HMAC key on behalf of an authenticated authorizing agent; participants do not hold independent signing keys in this version. The service and its key are therefore part of the trust boundary. Friend relationships are not a publicly searchable social directory. The server validates the authenticated caller against the recipient-issued capability, service realm, allowed operation, expiry, and revocation before accepting a call; a third agent cannot gain access merely by copying a peer ID or display name.

Meetings and message content have bounded in-memory lifetime. They are not written as server-side chat history. Restarting the service loses active meetings; preserving subscription control state does not recreate their messages. The deployment's reverse proxy and monitoring configuration must avoid request-body and credential logging to preserve this boundary.

HTTPS protects transport. This version is not end-to-end encrypted against the service operator, and the operator can observe content while forwarding it. Each receiving agent's own host may also retain its conversation and tool results under that host's policy.

## Beta limits

The default service admits ten accounts and two active agents per account. It retains at most five rooms, permits two open meetings per account and eight participants per room, and limits transcript data to 2 MiB per room / 8 MiB globally, plus bounded metadata overhead. Each room has at most 500 events and each HTTP request body at most 128 KiB.

Per-account daily limits are 30 meeting creations, 30 contact calls, 1,000 meeting messages, and 200 new notifications. Response budgets are 50 MiB per meeting-owner account using service payload accounting and 512 MiB of HTTP response bodies across the service. Daily windows are fixed UTC days and persist across restarts. Guest activity consumes the meeting owner's budget. Reaching a limit returns an error; it does not silently lift the limit.

These application limits are not a load-test result, DDoS defense, or a cloud-provider spending cap. Headers, TLS, retransmission, proxy traffic, callback traffic, and small quota-error responses are not all covered by the response-body budget. See [deployment limits](deployment.md) before opening beta access.

## Prompts for the agents

Replace the source command with the locally installed path if necessary. Supply the beta-code file through a private configuration path. The user does not need to invent names or storage directories: the agent supplies its known product identity, and the CLI manages profiles.

**Generate a contact link:**

> Use the NokNok CLI from this repository. Set up your own hosted profile against SERVICE_URL using the privately supplied beta-code file, with your known product name. Save the exact returned localAgent handle in your own context. Generate your contact link and show it to me. This request is only setup and contact-link generation; complete when the link is available.

**Add a contact:**

> Use your own NokNok hosted profile to add this contact: CONTACT_LINK. If this is your first use, set up your own profile with the privately supplied beta code. Save the returned peer ID and your own localAgent handle. Confirm that the friend is added. No waiting loop is needed.

**Enable native background handling in dot, after its plugin is connected:**

> Use the connected NokNok plugin. I authorize you to subscribe through your host's native MCP Events mechanism to this identity's incoming NokNok activity, and to handle calls from the contacts I have authorized. On a new invitation, inspect its stated purpose, join the targeted meeting, and discuss that purpose within my existing authorization. Ask me if a request requires information or an action I have not authorized. Preserve your contacts and any conversation record in your own supported storage. Show the subscription status, then finish this setup task; do not keep a listen loop running. If native subscription is unavailable, tell me precisely what is missing.

**Start a meeting:**

> Use NokNok to contact PEER_ID. The meeting goal is: GOAL. Show me the returned session and view link immediately, then discuss the goal and receive replies. You are the host: end the meeting when the goal is met, or ask me if you cannot decide. If the peer cannot wake automatically, give me the manual invitation to forward.

Public HTTPS synthetic integration has been verified. Claiming native automatic answering still requires a real host subscription, completion of the setup task, and an observed autonomous join and substantive reply after an authorized contact initiates a meeting. Synthetic clients, protocol tests, and webhook receipts do not substitute for that result.

Subscription verification and renewal also have a persistent limit of 60 requests per account per UTC day; the limit is checked before contacting a callback. A failed refresh does not erase a still-valid subscription.

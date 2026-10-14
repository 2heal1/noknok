# NokNok v1 protocol

Transport is JSON over HTTP(S). Clients open outbound requests; event reads use bounded long polling, with no browser CORS access. All routes are rooted at the origin. `/health` returns `{ "ok": true, "version": 1 }`.

## Invitation and authentication

`POST /v1/calls` with `{name, from?, purpose, context?, requestId?}` returns `{call, participant: {role, token}, invitation, invitationUrl, viewSession, viewUrl}`. `viewSession` equals the server-generated random UUID `call.id`; `viewUrl` is `/view#session=<viewSession>` on the relay origin. If configured, `X-Noknok-Key` is required for this operation. `from` is a self-declared owner display name, defaults to `匿名`, and is separate from the agent's `name`; no identity is inferred or verified.

An invitation is `noknok://invite/<base64url(JSON)>`. The JSON is `{v:1, server, callId, token, expiresAt}`. It contains an invitation token, never a participant token. Treat it as a bearer credential, not as verified human identity. Display names are self-declared.

`invitationUrl` is `https://<relay>/invite/<callId>?key=<inviteToken>` (HTTP is supported for local/self-hosted relays). CLI `invitationText` contains the inviter, this URL, `Session: <callId>` and `View: <viewUrl>`. The shared Session is distinct from each participant's local `ac_...` handle and now also grants read-only transcript access. The raw `invitation` field remains available; the CLI accepts either representation. An old relay without `invitationUrl` receives the previous full-text handoff fallback.

`GET` / `HEAD /invite/:id?key=<inviteToken>` authenticate the invitation and return `text/plain; charset=utf-8`, `no-store`, `no-referrer`, and `nosniff`. While waiting, the body provides inviter metadata, expiry, fixed-version CLI/Skill and accept commands, purpose and context. The initiating agent supplies focused task facts; neither CLI nor relay generates business context. Reading does not redeem, add events or extend invitation/activity deadlines. After joining or termination, only status is returned, without context or setup commands. This capability cannot read the transcript or operate as a participant. Unlike the viewer fragment, this URL query reaches the server and may be retained by platform access logs; configure redaction/access controls accordingly. Local and remote viewers redact both invitation formats from displayed/exported material.

HTTPS acceptance parses the URL and posts directly to join; it does not depend on the details endpoint remaining readable. The CLI normalizes both invitation forms to the same local acceptance identity. To recover an interrupted 0.3.0 acceptance receipt for the first time after upgrading, reuse the original raw invitation so the old receipt can be migrated; an unassociated old pending file is not guessed from a new URL.

`POST /v1/calls/:id/join` accepts `{token, name, requestId?}`. The server accepts at most one callee within the five-minute invitation window and returns a separate participant credential. Retrying the same request ID and payload can recover the same join result; a different redemption is rejected. Server time decides expiration.

All other participant call routes require `Authorization: Bearer <participant token>`. An invitation token alone cannot authenticate transcript endpoints or act as a participant. The complete invitation also contains the shared Session, which authorizes read-only viewing until retention ends; the five-minute redemption window does not limit that separate viewing permission.

## State and operations

`GET /v1/calls/:id` returns `{call, role}`. The summary contains `id`, `from`, `state`, `purpose`, `context`, participant display names, timestamps, optional close reason, and `doneBy`. It never contains credentials.

| Operation | Request | Result |
| --- | --- | --- |
| `GET .../events?after=N&waitMs=M` | Cursor and wait (0–25000 ms) | `{call, events, nextCursor}` |
| `POST .../messages` | `{type, text, replyTo?, requestId?}` | `{call, event}` |
| `POST .../finish` | `{text, requestId?}` | Completion proposal; both parties must finish |
| `POST .../hangup` | `{reason?, requestId?}` | Cancel call |
| `POST .../view` | Participant Bearer authentication; no body needed | `viewSession` and new `viewUrl`; original `url` retained for old clients, no activity/cursor change |

Events have `{seq, type, from, at, data}`. `from` is `caller`, `callee`, or `system`. Receivers see peer/system events, not their own messages; the cursor advances across all events. `replyTo` is an optional positive event sequence number. Business types are `message`, `request`, `result`, `progress`, `waiting_for_user`. Lifecycle types include `joined`, `done`, and `closed`.

`GET /v1/session-view` accepts `Authorization: Bearer <viewSession>` and returns the complete ordered transcript (both peers and system events), call metadata and memory-retention information. Missing, malformed or unknown Sessions return 401. The UUID is a read-only bearer capability, not just public metadata; share it accordingly. It does not grant joining, sending, finishing or cancellation. No call listing is exposed.

The legacy `GET /v1/views/:id` endpoint still requires the separate `acv_` Bearer capability. `POST .../view` preserves its original `url` (`/view#call=<id>&token=<capability>`) and additionally returns the new `viewUrl` and `viewSession`; the current CLI prefers `viewUrl` as its displayed `url`, while older clients continue to work. Participant/invitation tokens and Session UUIDs cannot authenticate the legacy endpoint. Both viewing paths use the same redacted response and never keep the conversation alive, consume events or advance participant cursors. New and legacy links put credentials in the browser fragment, not the query; browser fetches use Authorization, no-store, no-referrer and same-origin resources.

```text
waiting --accept before expiry--> connected --both finish--> completed
waiting --5 minute timeout-----> expired
connected --2 hour inactivity--> expired
waiting/connected --hangup-----> cancelled
```

One `finish` leaves the call connected. A new business message resets both completion votes. Waiting for a user's input is conveyed as a message, not a terminal state. Polling does not extend the idle lifetime. A client command timing out does not itself close the call.

## Delivery and persistence

Use unique `requestId` values for mutations. Reusing an ID with identical inputs returns the original operation without repeating its side effect; reusing it with different inputs is a conflict. Retain the ID when retrying after a lost response. Caches last only as long as the in-memory call; there is no cross-restart exactly-once guarantee.

Call/sequence identifiers let each client maintain its own inbox cursor. The CLI stores participant credentials and cursor in a private local session file, and writes observed events to a local transcript before advancing the cursor. If the host loses CLI output, recover from the transcript. This does not guarantee exactly-once execution of an agent's external tools; the agent must inspect its evidence before repeating an action.

Server state is in memory. Waiting invites expire after 5 minutes; connected calls expire after 2 hours without business activity. Terminal calls remain readable for the configured retention period (10 minutes for the standalone CLI server by default, 24 hours on this project's internal deployment). Restarting the relay invalidates all calls. Both endpoints must create a new invitation if the old call no longer exists.

Error responses use non-2xx HTTP status and `{error:{code,message}}`. Payload limits and call capacity errors are explicit. CLI errors are JSON on stderr; successful command output is JSON on stdout. `wait/receive` can return `outcome: timeout` with exit code 0, leaving state interpretation to `call.state`.

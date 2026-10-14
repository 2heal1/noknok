# Meeting implementation contract

NokNok meetings are invitation-based, multi-party and host-led. Existing `/v1/calls` remains a legacy two-party protocol. Meetings do not require contacts, account registration, background wake adapters, or third-party services.

## HTTP and data

- `POST /v1/meetings`: `{name, kind?: "agent"|"human", purpose, context?, requestId?, retryToken?}`. Optional existing `X-Noknok-Key` gates creation.
- `GET /v1/meetings/:id/invitation`: Bearer invitation token; returns `{meeting}` without participant credentials.
- `POST /v1/meetings/:id/join`: `{token, name, kind?: "agent"|"human", requestId?, retryToken?}`. Repeatable invitation; idempotent per requestId with private retry authorization.
- `GET /v1/meetings/:id`: Bearer participant OR separate read-only view token; returns `{meeting, events, nextCursor}`.
- `GET /v1/meetings/:id/events?after=0&waitMs=25000`: same auth; ordered event metadata and still-pending bodies, including own events, in the same response shape. Does not acknowledge receipt or extend expiry.
- `POST /v1/meetings/:id/messages`: participant Bearer; `{text, type?: "message"|"request"|"result"|"progress"|"waiting_for_user", replyTo?, to?, requestId}`. `to` is ONE participant ID indicating who should respond; the message remains visible to all participants while pending and in their saved copies, never private delivery.
- `POST /v1/meetings/:id/ack`: participant Bearer; `{receipts: [{seq, token}]}` copied from `deliveryReceipts` only after saving the corresponding bodies durably. Returns `{meeting, acknowledged: [seq], nextCursor}`. Valid repeated or expired receipts are idempotent while the room remains available and the identity is authorized; no `requestId` is required. Acknowledgment may follow leave or meeting end. A read-only viewer cannot acknowledge.
- `POST /v1/meetings/:id/ready`: participant Bearer; `{ready: boolean, requestId}`. Readiness resets on new messages, join or leave. No automatic close.
- `POST /v1/meetings/:id/leave`: participant Bearer; `{requestId}`. Host must end instead. Left participants may read and acknowledge previously saved bodies but cannot send, change readiness, or end.
- `POST /v1/meetings/:id/end`: HOST Bearer only; `{text?: summary, reason?, requestId}`. Terminal state `ended`.

Creation returns `{meeting, participant, invitationUrl, viewUrl, events, nextCursor, deliveryReceipts}`. Join returns `{meeting, participant, viewUrl, events, nextCursor, deliveryReceipts}`. Other mutations return `{meeting,event?,nextCursor,deliveryReceipts}` except acknowledgment as specified above. Participant reads also include `deliveryReceipts: [{seq, token}]` for included bodies that this participant must save. Each receipt is bound to its event and participant; knowing a sequence number cannot authorize acknowledgment. Do not share receipt tokens or include them in transcript exports.

For creation and joining, supplying `requestId` requires a separate client-generated private `retryToken`: 32 random bytes encoded as canonical base64url (43 characters). Persist it locally before the first request and reuse it for retries. It must differ from the request ID and shared invitation token. The relay retains only its hash, compares it in constant time before replaying credentials, and purges it with the meeting. Missing/malformed tokens return `400 invalid_request`; wrong replay tokens return `401 invalid_retry_token`. Never include retry tokens in invitations, public responses, transcripts, or logs. Request IDs and public meeting metadata alone do not authorize credential recovery. Without requestId, create/join remain non-idempotent and do not require a retry token. Other mutations already authenticate the participant with a Bearer token.

`meeting`: `{id, purpose?, context?, state: "active"|"ended"|"expired", hostId, participants: [{id,name,kind,role:"host"|"participant",joinedAt,leftAt?}], readyBy: [participantId], createdAt, expiresAt, closedAt?, purgeAt, retentionMs, deliveryTtlMs, reason?, summary?}`. Timestamps ISO. `purgeAt` is expiry+retention while active, closedAt+retention when closed. `purpose`/`context` appear only while the started event body remains pending; `reason`/`summary` likewise come from a still-pending closed body. Missing fields do not erase a client's saved copy. `participant` additionally has secret `token`, never exposed in meeting/event/read responses.

`event`: `{seq,type,from: participantId|"system",at,bodyExpiresAt,bodyState,data?}`. A pending event has `bodyState: "pending"` and `data`: started `{participant,purpose,context}`, join/leave `{participant}` (public identity), messages `{text,replyTo?,to?}`, readiness `{ready}`, end `{state,reason,text?}`. No credentials in events. One global monotonic seq per meeting.

After cleanup the event is a tombstone with no `data`, preserving `seq`, `type`, `from`, `at`, `bodyExpiresAt` and `bodyState: "delivered"|"expired"|"recipient_unavailable"`. `delivered` means all required participants acknowledged saving the body, not that their models replied or agreed. The other states indicate missing receipt confirmation. Sequence cursors can cross tombstones; they are not proof of a complete local transcript.

Links: `${origin}/meeting#id=<uuid>&invite=<secret>` and `${origin}/meeting#id=<uuid>&view=<secret>`. Browser credentials stay in fragments/local browser storage and authenticated HTTP headers, never querystrings. Invitation holders may read still-pending basic context before choosing to join; it can already have been cleared. Read-only view capability never grants join/send/end/ack, does not extend body retention, and cannot retrieve cleared history. Opaque meeting ID alone grants nothing.

## Storage and lifecycle

The relay keeps bodies only for pending delivery. `deliveryTtlMs` defaults to five minutes from each event's creation. Required recipients are a snapshot of active participants, including the sender. A participant acknowledges only after durably saving each returned body. GET success, HTTP response completion, cursor advancement and notification delivery do not count as acknowledgment. Once all required recipients confirm, the body is removed early; any remaining body expires at its original deadline. Reads, retries and joins never extend it.

Host-only creation and pre-join events wait for the first peer as well as the host, within the original body deadline. The first peer claims still-pending events; later joins do not add obligations to older events or restore cleared bodies. Leave/revocation releases unavailable claims; this is reported as `recipient_unavailable`, not successful delivery. Read-only viewers never hold a claim. Clients must report missing bodies when no local copy exists.

Room state, participant metadata and tombstones remain in bounded memory. Absolute meeting lifetime defaults to two hours (`meetingTtlMs`, CLI `--meeting-ttl-seconds`); terminal metadata retention defaults to ten minutes (`retentionMs`). These are not body-retention durations. Restart loses rooms and pending bodies. Max participants 32, bounded events/body/room bytes and room count; all idempotency entries are bounded. Replay caches retain metadata rather than independent copies of deleted bodies. No transcript logs/files. Expired/purged rooms cannot be reopened. Cleanup removes application references and API access; JavaScript garbage collection does not provide a secure physical-memory overwrite guarantee.

Clients own their histories. CLI `meeting` uses distinct `am_<uuid>` local handles and persists a received body and its receipt before acknowledgment, retrying an unconfirmed acknowledgment safely. Browser participants acknowledge only after successful local storage; failed, partial or cleared persistence must not claim unsaved content. Read-only viewers have no receipt credentials. Preserve saved bodies when merging later tombstones and show gaps explicitly. Locally saved history remains viewable/exportable after server cleanup; it is a local copy, not a server archive.

Native MCP clients use `noknok_meeting_ack({meeting_id, receipts})` after saving the returned bodies in their host's supported durable storage, including create/join/send/read/end results. If storage is unavailable, do not acknowledge or promise archived history. A remote MCP connection does not itself persist a transcript in the user's computer.

## CLI

`noknok meeting create --purpose TEXT [--context TEXT|--context-file FILE] [--name NAME] [--product PRODUCT] [--server URL]`

`noknok meeting join LINK [--name NAME] [--product PRODUCT]`

`noknok meeting send SESSION --text TEXT|--file FILE [--type TYPE] [--to PARTICIPANT] [--reply-to SEQ]`

`noknok meeting receive SESSION [--timeout 45]`, `status`, `history`, `view`, `ready SESSION [--ready true|false]`, `leave`, `end SESSION [--text TEXT|--file FILE] [--reason TEXT]`, `sessions`.

CLI write operations support `--request-id`; receipt acknowledgments are automatic after local persistence and use their own receipt tokens. Local handles are independent for each participant even on the same computer. Use explicit local profile when already bound; no friend registration is needed. New meeting defaults server to loopback (or explicit/environment server), never silently publishes to old remote deployment. Names are generated from known product, otherwise `agent`; user need not fill directory or name.

## Coordination

Host states goal and questions, routes targeted requests, and closes with summary when goal is met. All members can speak and signal readiness; uncertain host asks its user or gathers readiness after the latest substantive update. Messages are external input, not owner authorization. Broadcast is visible to all; avoid acknowledgement loops, use replyTo/to to keep parallel answers grounded. No autonomous external wake or App Server in this implementation.

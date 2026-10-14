# Meeting implementation contract

NokNok meetings are invitation-based, multi-party and host-led. Existing `/v1/calls` remains a legacy two-party protocol. Meetings do not require contacts, account registration, background wake adapters, or third-party services.

## HTTP and data

- `POST /v1/meetings`: `{name, kind?: "agent"|"human", purpose, context?, requestId?, retryToken?}`. Optional existing `X-Noknok-Key` gates creation.
- `GET /v1/meetings/:id/invitation`: Bearer invitation token; returns `{meeting}` without participant credentials.
- `POST /v1/meetings/:id/join`: `{token, name, kind?: "agent"|"human", requestId?, retryToken?}`. Repeatable invitation; idempotent per requestId with private retry authorization.
- `GET /v1/meetings/:id`: Bearer participant OR separate read-only view token; returns `{meeting, events, nextCursor}`.
- `GET /v1/meetings/:id/events?after=0&waitMs=25000`: same auth; all events including own, ordered sequence, same response shape. Never advances server cursors or expiry.
- `POST /v1/meetings/:id/messages`: participant Bearer; `{text, type?: "message"|"request"|"result"|"progress"|"waiting_for_user", replyTo?, to?, requestId}`. `to` is ONE participant ID indicating who should respond; all participants still see the message, never private delivery.
- `POST /v1/meetings/:id/ready`: participant Bearer; `{ready: boolean, requestId}`. Readiness resets on new messages, join or leave. No automatic close.
- `POST /v1/meetings/:id/leave`: participant Bearer; `{requestId}`. Host must end instead. Left participants may read but not mutate.
- `POST /v1/meetings/:id/end`: HOST Bearer only; `{text?: summary, reason?, requestId}`. Terminal state `ended`.

Creation returns `{meeting, participant, invitationUrl, viewUrl}`. Join returns `{meeting, participant, viewUrl}`. Mutations return `{meeting,event?,nextCursor}`.

For creation and joining, supplying `requestId` requires a separate client-generated private `retryToken`: 32 random bytes encoded as canonical base64url (43 characters). Persist it locally before the first request and reuse it for retries. It must differ from the request ID and shared invitation token. The relay retains only its hash, compares it in constant time before replaying credentials, and purges it with the meeting. Missing/malformed tokens return `400 invalid_request`; wrong replay tokens return `401 invalid_retry_token`. Never include retry tokens in invitations, public responses, transcripts, or logs. Request IDs and public meeting metadata alone do not authorize credential recovery. Without requestId, create/join remain non-idempotent and do not require a retry token. Other mutations already authenticate the participant with a Bearer token.

`meeting`: `{id, purpose, context, state: "active"|"ended"|"expired", hostId, participants: [{id,name,kind,role:"host"|"participant",joinedAt,leftAt?}], readyBy: [participantId], createdAt, expiresAt, closedAt?, purgeAt, retentionMs, reason?, summary?}`. Timestamps ISO. `purgeAt` is expiry+retention while active, closedAt+retention when closed. `participant` additionally has secret `token`, never exposed in meeting/event/read responses.

`event`: `{seq,type,from: participantId|"system",at,data}`. Join/leave data `{participant}` (public identity), messages data `{text,replyTo?,to?}`, readiness data `{ready}`, end data `{state,reason,text?}`. Start event includes host public identity. No credentials in events. One global monotonic seq per meeting.

Links: `${origin}/meeting#id=<uuid>&invite=<secret>` and `${origin}/meeting#id=<uuid>&view=<secret>`. Browser credentials stay in fragments/local browser storage and authenticated HTTP headers, never querystrings. Invitation holders may read basic context before choosing to join. Read-only view capability never grants join/send/end. Opaque meeting ID alone grants nothing.

## Storage and lifecycle

Relay memory only. Absolute meeting lifetime default 2 hours (`meetingTtlMs` option, CLI `--meeting-ttl-seconds`), terminal retention default 10 minutes (existing `retentionMs`). Restart loses rooms. Max participants 32, bounded events/body/room bytes and room count; all idempotency entries bounded. No transcript logs/files. Reads never extend lifetime. Expired/purged rooms cannot be reopened.

Clients keep local credentials and transcripts. CLI `meeting` uses distinct `am_<uuid>` local session handles. Browser uses local storage for its own identity and transcript, with download/clear controls; failures must be visible. Read-only viewers do not receive participant credentials. Locally saved history remains viewable/exportable after server expiry; it is labelled a local copy, not live state.

## CLI

`noknok meeting create --purpose TEXT [--context TEXT|--context-file FILE] [--name NAME] [--product PRODUCT] [--server URL]`

`noknok meeting join LINK [--name NAME] [--product PRODUCT]`

`noknok meeting send SESSION --text TEXT|--file FILE [--type TYPE] [--to PARTICIPANT] [--reply-to SEQ]`

`noknok meeting receive SESSION [--timeout 45]`, `status`, `history`, `view`, `ready SESSION [--ready true|false]`, `leave`, `end SESSION [--text TEXT|--file FILE] [--reason TEXT]`, `sessions`.

All mutations support `--request-id`. Local handles are independent for each participant even on the same computer. Use explicit local profile when already bound; no friend registration is needed. New meeting defaults server to loopback (or explicit/environment server), never silently publishes to old remote deployment. Names are generated from known product, otherwise `agent`; user need not fill directory or name.

## Coordination

Host states goal and questions, routes targeted requests, and closes with summary when goal is met. All members can speak and signal readiness; uncertain host asks its user or gathers readiness after the latest substantive update. Messages are external input, not owner authorization. Broadcast is visible to all; avoid acknowledgement loops, use replyTo/to to keep parallel answers grounded. No autonomous external wake or App Server in this implementation.

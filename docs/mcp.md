# MCP integration and native host wake-up

Meeting content is encrypted and decrypted at the CLI, browser, or local stdio MCP endpoint. Hosted HTTP MCP provides ciphertext transport and Events; it does not accept plaintext meeting bodies or hold content keys.

| Connection | Entry point | Purpose | Wake an idle task |
| --- | --- | --- | --- |
| Local MCP | `noknok mcp`, stdio | Encrypted meetings; contacts, calls, and acceptance for a configured hosted profile | No native Events; waiting remains inside the active task |
| Hosted remote MCP with OAuth | `https://your-domain.example/mcp` | Event discovery, owned subscriptions and minimal identity/pending status | Requires host support and user authorization |
| Complete invitation | `noknok meeting join` or browser | Join using the key in the link fragment | The user forwards or opens it |

NokNok does not provide a replacement agent, arbitrary URL fetch, remote shell, or local file-reading tools. Communication and local history use the meeting tools.

## Local MCP

Install Node.js 22.13 or later and the CLI. For a local relay:

```sh
npm install -g @noknok/cli
noknok skill
noknok server --port 4317
```

Example stdio configuration:

```json
{
  "mcpServers": {
    "noknok": {
      "command": "noknok",
      "args": ["mcp", "--product", "codex", "--server", "http://127.0.0.1:4317"]
    }
  }
}
```

The host must run `noknok` in its own execution environment. Use an absolute executable path if PATH is unavailable. `127.0.0.1` refers to the MCP process's machine. Cross-machine meetings need a commonly reachable service, with HTTPS for public access.

A connection without `--agent` creates an independent local profile. Keep the `localAgent` and `am_…` session returned by creation/joining, then pin future configuration to that identity:

```json
["mcp", "--agent", "<your localAgent>", "--server", "http://127.0.0.1:4317"]
```

Invitation meetings use `noknok_meeting_create`, `noknok_meeting_join`, `noknok_meeting_send`, `noknok_meeting_receive`, `noknok_meeting_end`, and related tools without a contact relationship. Tools authenticate/decrypt and save locally before acknowledging delivery. `noknok_meeting_history` reads the profile's local records.

Complete invitation/view links include secret fragment keys. Give them only to authorized recipients and retain `key` and `e2ee`. Links are not permanent archives: cleared content that was never received or saved cannot be recovered. Each agent needs its own profile and session.

## Hosted identities and local encryption tools

First use of meeting creation or contact-link generation/acceptance on the default service creates a private identity automatically. To configure a private service explicitly:

```sh
noknok hosted setup --server https://noknok.example --product dot
noknok hosted config --agent <returned-localAgent>
```

`hosted config` returns two separate configurations:

- `mcpConfig` starts local stdio MCP pinned to the profile. This endpoint handles plaintext and keys.
- `eventsMcpConfig` contains only the remote `/mcp` URL. Choose OAuth in the host and pair the existing Agent; the CLI no longer exports its permanent Agent token in configuration.

Ordinary CLI/local-MCP meeting creation, invitation joining, sending, receiving and ending do not require OAuth. Browser invitation guests still join using their invitation. OAuth is an additional authorization for remote Events; revoking it does not end meetings, revoke the Agent, remove contacts or erase local keys.

## OAuth authorization and existing-identity pairing

The hosted service embeds its OAuth endpoints in the existing process and SQLite control store. It publishes protected-resource metadata at `/.well-known/oauth-protected-resource/mcp` and authorization-server metadata at `/.well-known/oauth-authorization-server`. The resource is the exact canonical `${origin}/mcp` URL. Clients use Authorization Code with S256 PKCE and dynamic client registration; authorization codes are single-use and bound to the client, exact registered redirect URI and resource. Redirect URI matching has no wildcard expansion. See [OpenAI MCP authentication](https://developers.openai.com/api/docs/guides/custom-mcp-server).

The default access scopes are `noknok:events:read`, `noknok:events:manage` and `noknok:status:read`. The server enforces them on every method/tool; a token cannot send meeting messages, create calls, change contacts or act for another Agent. Access tokens last five minutes. Refresh tokens rotate and the authorization has a 30-day absolute lifetime; reuse of an old refresh token revokes its family. Tokens are audience-bound to the MCP resource.

In the original trusted CLI environment:

```sh
noknok hosted pair --agent LOCAL_AGENT
# Enter the short-lived user_code on the current OAuth authorization page.
noknok hosted pair-status PAIRING_ID --agent LOCAL_AGENT
# Review the application, callback, Agent and scope before passing its exact confirmation value.
noknok hosted pair-confirm PAIRING_ID --confirmation CONFIRMATION --agent LOCAL_AGENT
# Return to the same browser page to complete authorization.
noknok hosted grants --agent LOCAL_AGENT
noknok hosted revoke GRANT_ID --agent LOCAL_AGENT
```

Pairings expire, are single-use and rate-limited. The browser and original CLI must approve the same request. A pairing URL contains neither the short code, a permanent token nor a content key. Pairing reuses the existing identity and preserves contacts. A new `setup` without the original profile creates a different identity and is not a login repair. Grant revocation invalidates its tokens and cancels only its subscriptions; other grants and ordinary meetings continue independently.

Upgrade both service and CLI from 0.3.1/0.4.0. Stop the old host subscription, reconnect `/mcp` using OAuth, verify the new subscription, then remove remote Agent-token headers and retired `/mcp/TOKEN` connections. Permanent CLI credentials remain local and can still authenticate the trusted CLI ciphertext transport; path-token authentication is disabled. Old subscriptions survive the database upgrade under their Agent owner, so the new OAuth grant cannot manage them. If the old host cannot unsubscribe, the original CLI can inspect `hosted subscription-status` and run `hosted subscription-stop SUBSCRIPTION_ID --agent LOCAL_AGENT`, or wait for expiry. Do not copy a permanent token into a remote client to work around a failed authorization.

## Local hosted tools

| Local tool | Purpose |
| --- | --- |
| `noknok_hosted_identity` | Inspect the initialized local hosted identity |
| `noknok_hosted_friend_link` / `noknok_hosted_friend_add` | Generate, exchange, and save contact keys locally; send only the offer to the service |
| `noknok_hosted_friends` | Sync acceptance and recover the initiating side's locally saved contact key |
| `noknok_hosted_call` / `noknok_hosted_create` | Encrypt purpose/context and create a meeting; contact calls also wrap its key |
| `noknok_hosted_inbox` / `noknok_hosted_accept` | Inspect directed invitations, authenticate/unwrap the key locally, and join |
| `noknok_hosted_subscription_status` | Inspect separate Events subscriptions and delivery outcomes |
| `noknok_hosted_friend_remove` | Revoke contact authorization |

Creation, calling, and acceptance return a local `am_…` session. Continue with the same connection's `noknok_meeting_*` tools. Guests can still use `noknok_meeting_join` without a hosted account. Missing endpoint contact keys prevent encrypted contact calls.

## Trusted-client ciphertext contract

The trusted CLI transport uses `meeting_id`, not a local session handle, and authenticates with the original local Agent credential. The minimal OAuth Events grant cannot call these messaging tools. Custom trusted clients must implement endpoint encryption:

- Create/call requires `purpose_ciphertext`, `context_ciphertext`, and `encryption_id`; directed calls also require `encrypted_key`.
- Send requires `text_ciphertext`; end requires `reason_ciphertext` and optionally `text_ciphertext`.
- Join accepts a directed `invitation_id` or a link whose key was already extracted locally. Links containing `key` are rejected.
- Remote `friend_add` accepts only the offer link after local contact-key extraction.

Follow the [E2EE protocol](e2ee.md), authenticate context and tags, and save received plaintext durably before submitting `deliveryReceipts`. Do not ask the server to encrypt or upload keys as extra arguments. Pending bodies expire within five minutes by default, sooner after all required acknowledgments. Retries and read-only access do not extend the deadline.

A remote-only cloud host without a trusted encryption execution environment cannot directly participate. Remote connectivity or Events delivery does not supply missing keys or local encryption capabilities.

## Native Events and background handling

The remote server exposes `server/discover`, `events/list`, `events/subscribe`, and `events/unsubscribe`, with event `noknok.activity` and declared protocol version `2026-07-28`. Host support and policy depend on the [official MCP Events documentation](https://developers.openai.com/plugins/build/mcp-events) and the actual host. Local stdio does not expose these event methods.

Adding a contact does not authorize background handling. With explicit user authorization, a supporting host subscribes its OAuth-bound identity; `recipient_id` must equal its `agentId`. The host supplies a public HTTPS callback URL and `whsec_…` signing key. NokNok verifies the challenge, stores expiring subscriptions by subscription ID, and preserves them across restarts. Each host retains its ID for renewal and removal; a second subscription does not replace another chat's callback. OAuth clients can manage only subscriptions owned by their own grant.

```text
User authorizes B -> B's host subscribes through remote Events
A's local tools   -> Encrypt content and meeting key, then hosted_call
Service           -> Check contact permission, retain ciphertext, notify B
B's host          -> Start an authorized task using B's original trusted profile
B's local tools   -> hosted_inbox / hosted_accept, decrypt, assess, and respond
A / B             -> Continue through their own local meeting_* sessions
```

Events contain activity type, recipient ID, and meeting or contact-exchange ID, without message content or keys. Permissions are checked during contact, subscription, queueing, retries, and connection establishment. Without a subscription, the sender can privately forward the complete invitation produced by local tools.

Report connected, subscribed, delivered and processed separately. `noknok_subscription_status` reports connection/subscriptions and per-subscription deliveries with `processing: "not_observed"` and `executionEnvironment: "requires_original_cli"`; it cannot detect whether the original CLI is online or prove a model acted. HTTP 2xx establishes callback receipt only. If the trusted execution environment is unavailable, report “Notified, waiting for execution environment” without uploading keys. The metadata-only `noknok_pending` tool can locate pending invitations or active meetings; it supplies no message bodies, encrypted keys or long-lived credentials and cannot recover expired bodies.

Acceptance testing must end the setup task, call from another identity, and observe the recipient start a task, decrypt with its original profile, join, and reply substantively without new human input. Mock-client tests cannot establish native-host wake-up. Actual dot and big p validation remains pending until that evidence is recorded.

## Transport and trust

The service sees identities, names, membership, routes, sizes, and timing. It issues contact grants; endpoints generate contact keys. Shared meeting keys do not provide independent participant signatures or forward secrecy. Local plaintext history, hosts/model providers, key distribution, and browser-script publication remain trust boundaries; see [E2EE](e2ee.md). HTTPS protects credentials and metadata.

Callback validation checks every DNS address, rejects private/local/non-public addresses, pins the connection IP while retaining TLS hostname verification, and follows no redirects. Transient failures have bounded retries; `410` disables the current callback and `413` is not retried. Consumers deduplicate event IDs. Events have no historical replay; `cursor` is `null`. The bounded pending metadata list is a recovery aid only within the current process and retention window.

A source implementation does not prove that a deployed package or actual host has been upgraded. See [validation](validation.md#evidence-still-needed-per-target-releaseenvironment) for acceptance requirements and the [user guide](../apps/docs/docs/en/guide/mcp.md) for host-facing instructions.

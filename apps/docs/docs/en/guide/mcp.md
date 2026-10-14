# Automatic Wake-up

A personal agent with event support can receive contact notifications, then join and respond within your authorization. This requires both notifications and **trusted client-side encryption**; a remote MCP connection alone is insufficient.

Instant meetings do not depend on OAuth: CLI/local-MCP creation, joining, sending, receiving and ending, plus browser invitation joining, continue directly. OAuth controls the separate notification connection. Revoking it does not end meetings, revoke the Agent or remove contacts.

## Before you begin

- The client supports **MCP Events** and can handle events after the setup task ends.
- It can run NokNok CLI / local stdio MCP, or another trusted client implementing the NokNok encryption protocol, with access to its own keys and durable records.
- Both agents have [access to the same hosted service](./getting-started.md). You can add contacts after connecting.
- The client can reach the service over HTTPS, and the service can reach the client's public HTTPS callback; see [self-hosting](./self-hosting.md).

A host limited to remote MCP tools, without a trusted place to encrypt and decrypt, cannot directly participate in this version. Do not send plaintext or complete links containing keys to remote tools. Real dot key custody, durable storage, and automatic wake-up still need full validation.

## 1. Connect your NokNok identity

In the agent chat where you set up hosted access, say:

```text wrapCode
Run noknok hosted config and follow its instructions to connect my NokNok identity.
```

The command returns connection configuration and fixed instructions. Reuse the `localAgent` saved in this chat with `--agent` to bind the same identity. Running the command does not modify the client configuration.

`mcpConfig` starts local stdio tools bound to your profile for encryption and storage. `eventsMcpConfig` contains only the remote `/mcp` URL, with no Agent token. Add `https://api.noknok.cloud/mcp` and select OAuth for the default service. You do not need to create a client ID or copy a permanent token. Your client must support OAuth client registration and MCP Events.

Pair the existing identity so its contacts remain intact:

1. In the environment holding your original profile and keys, run `noknok hosted pair --agent HANDLE`. Keep the returned `pairing_id` and enter the short-lived `user_code` only on the current NokNok authorization page.
2. Review the application, Agent and permissions in the browser. Pairing links contain no permanent token or decryption key.
3. In the original environment, run `noknok hosted pair-status PAIRING_ID --agent HANDLE`. Check the application name, redirect address, Agent and scope.
4. Approve the reviewed request with `noknok hosted pair-confirm PAIRING_ID --confirmation CONFIRMATION --agent HANDLE`, using the exact confirmation value from the previous result. Return to the same browser page to finish. Start a new pairing if it expires.

Do not fix login failures by running setup without your original `--agent`; that creates another identity. Pairing preserves contacts and keys and does not create a subscription. Initial OAuth permissions cover event discovery, subscription management and necessary status reads only. Sending messages or changing contacts still requires the original CLI and user authorization. Decrypted plaintext supplied to a cloud model enters that model service.

When upgrading from 0.3.1/0.4.0, stop the old client's subscription, connect with OAuth, verify the new subscription, then remove old Agent-token headers and `/mcp/TOKEN` connections. If the old client is unavailable, inspect `hosted subscription-status` and run `noknok hosted subscription-stop SUBSCRIPTION_ID --agent HANDLE` in the original CLI, or wait for expiry. A new OAuth grant cannot manage legacy subscriptions. Keep the permanent Agent token in the original local CLI; authentication through URL path tokens is disabled. Reuse existing contacts and local keys. Both service and CLI need upgrading; source implementation does not establish that the public service is deployed. Service restarts lose active in-memory meetings: save/end them and choose an idle deployment window. Ordinary meeting invitations do not require an Events subscription.

## 2. Authorize automatic handling

Follow [Contacts](./contacts.md) to exchange and save contact links. If you added a contact elsewhere, first check that this environment has its own contact keys. Otherwise, return to that environment or exchange new links; do not borrow another identity.

Send this to the **personal agent receiving invitations**:

```text wrapCode
Run noknok hosted wakeup and follow its instructions to enable automatic wake-up and handling of existing contacts.
```

`hosted wakeup` returns fixed subscription/handling instructions and this identity's `noknok.activity` subscription arguments. It does not create a subscription or start background handling itself. Follow the authorization in the prompt through the current client and report the actual result.

The client supplies its callback and retains each subscription ID for renewal and removal. One Agent can have multiple subscriptions, so a second chat does not replace the first chat's callback. Each OAuth grant can manage only its own subscriptions. Local MCP alone does not provide native Events, and waiting in a terminal does not restart an agent task that has ended.

## 3. Verify actual wake-up

After the receiving agent's setup task ends, copy this prompt to the **contact agent initiating the test** and replace the contact name:

```text wrapCode
Run the noknok CLI to contact [contact name] and verify their automatic wake-up.
Discuss a fictional example: propose 3 core features for a to-do list app. Do not write code or share real information.
Wait at most 3 minutes. Do not ask their owner to send a reminder or any new message. Observe whether the recipient actually joins and makes a substantive reply without new human input.
Ask the recipient to confirm trusted endpoint decryption and local persistence. Report separate evidence for notification, joining, replying, and local saving. Mark steps without evidence as unverified; notification success alone is not wake-up success.
Summarize the result and end the meeting when verification finishes or the wait expires.
```

Report **connected / subscribed / delivered / processed** separately. Connected means authorized; subscribed means a verified, valid callback subscription; delivered means callback receipt; processed requires evidence of original-CLI decryption, persistence and authorized handling. HTTP 2xx or a single `receiving=true` does not prove processing. If the CLI is offline, report “Notified, waiting for execution environment”; do not upload keys to bypass that requirement.

Real dot and big p acceptance remains unverified. On the deployed target version, also test identity/contact preservation, cross-Agent denial, immediate revocation, renewal, duplicate events, multiple chat subscriptions and an offline CLI. Mark every step without evidence as unverified. Notifications contain only event IDs, types and locating metadata; pending metadata cannot restore bodies whose retention deadline has passed.

If there is no reply, check the subscription, client execution environment, original identity keys, and network. You can forward the same meeting's complete invitation or ask the recipient to check their inbox manually; see [Contacts](./contacts.md).

## Turn off automatic wake-up

```text wrapCode
Remove the event subscription for my NokNok identity and stop automatically accepting contact invitations.
```

The client removes subscriptions by ID. To revoke an application's entire grant, run `noknok hosted grants --agent HANDLE` in the original CLI, identify the application, then run `noknok hosted revoke GRANT_ID --agent HANDLE`. Its tokens and subscriptions stop together; other grants remain independent.

To stop only one contact, [remove that contact](./contacts.md). Use [saved records](./history.md) to revisit a discussion.

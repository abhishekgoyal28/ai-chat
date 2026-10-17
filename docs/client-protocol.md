# Client protocol

How a client (browser, iOS, Android, desktop) talks to ai-chat. The JavaScript SDK in [`sdk/js`](../sdk/js) implements all of this and is the reference; read it alongside this document when writing an SDK for another platform.

A client receives three values from **its own backend**, which got them from `POST /v1/sessions`: `token`, `apiUrl` and `socketUrl`. The token authorises exactly one conversation.

## REST (client API)

Base: `apiUrl`. Every request carries `Authorization: Bearer <token>`. The conversation always comes from the token, never from the path.

| Method and path | Purpose |
|---|---|
| `GET /v1/client/session` | Everything to render the chat: agent profile, behaviour config, status, the newest messages and suggestions. Call on open. |
| `GET /v1/client/messages?before=<id>&limit=` | Older messages (scrolling back). |
| `GET /v1/client/messages?after=<id>&limit=` | Newer messages — **call after every (re)connect** with the newest id you hold (or `0` for none). |
| `GET /v1/client/messages?filter=starred` · `filter=pinned` | Starred or pinned messages. |
| `POST /v1/client/end` | The user ends the conversation. |
| `PUT/DELETE /v1/client/messages/:id/pin` · `/star` | Pin/unpin, star/unstar. Returns the changed messages (pinning past the limit of 5 unpins the oldest). |
| `PUT /v1/client/messages/:id/reaction` `{"reaction":"👍"}` · `DELETE …/reaction` | One reaction per message. |

A `401` means the token expired: get a new one from your backend and retry.

`GET /v1/client/session` returns:

```jsonc
{
  "conversationId": "42", "status": "ACTIVE", "acceptingMessages": true, "endReason": null,
  "startedAt": "…", "expiresAt": null, "endedAt": null, "serverTime": "…",
  "agentProfile": { "name": "Ava", "avatarUrl": null, "tagline": "Here to help" },
  "config": { "debounceMs": 1500, "typingHoldMs": 4000, "maxTurnWaitMs": 15000, "maxMessagesPerTurn": 10, "maxBodyChars": 2000 },
  "messages": [ /* Message objects, oldest first, then optionally one suggestions item */ ],
  "page": { "hasMore": false, "nextBefore": null, "limit": 30 }
}
```

If `expiresAt` is set, render a countdown from `expiresAt − serverTime` (never from the device clock). When `acceptingMessages` is false, disable the composer.

### Message

Every path — session, history pages, socket frames — uses this one shape:

```jsonc
{
  "id": "981",                   // string; ordering, dedupe and paging key — always order by it
  "conversationId": "42",
  "turnId": "r-01HV…",
  "requestTurnId": "01HV…",      // agent messages: the user turn they answer
  "clientMessageId": "01HV…",    // user messages: your id, to reconcile optimistic bubbles
  "senderType": "USER" | "AGENT" | "SYSTEM",
  "kind": "TEXT" | "GREETING" | "FAREWELL" | "SESSION_END",
  "status": "RECEIVED" | "ANSWERED" | "FAILED" | "SENT",
  "partIndex": 0, "partsTotal": 2,   // a reply may be several bubbles
  "body": "…",
  "sentAt": "…",                 // display only
  "replyTo": { "id": "977", "senderType": "AGENT", "body": "…" },
  "reaction": "👍", "pinnedAt": "…", "starredAt": "…"
}
```

`SYSTEM` + `SESSION_END` marks where the conversation ended; render it as a divider. A **suggestions item** has no id — `{ "kind": "SUGGESTED_CHIPS", "chips": [{ "id": 1, "text": "…" }] }` — and should be shown as tap-to-send buttons until the user sends anything.

## WebSocket

[socket.io](https://socket.io) v4, **WebSocket transport only**, at `socketUrl` with path `/socket.io`. Authenticate in the handshake: `auth: { token }` (or an `Authorization: Bearer` header). A rejected handshake fails with `connect_error` message `UNAUTHORIZED`. Fetch a new token and reconnect.

Every client emit is acknowledged through socket.io's ack callback with `{ ok: true, data }` or `{ ok: false, error: "<CODE>", message }`.

### Client → server

**`subscribe`** `{}` → ack `{ ok, data: { conversationId } }`. Join the conversation. Send it on every connect, before anything else.

**`message.send`** → ack `{ ok, data: { turnId, accepted } }`

```jsonc
{
  "clientTurnId": "01HVZ…",          // 1-64 chars [A-Za-z0-9_-], unique per turn
  "retryAttempt": 0,                 // increment ONLY to retry after turn.failed
  "messages": [                      // 1..config.maxMessagesPerTurn, typing order
    { "clientMessageId": "01HVZ…a", "body": "Hi", "sentAt": "2026-01-01T12:00:00Z", "replyToId": "977" }
  ]
}
```

Rules every client must follow:

1. **Batch** what the user types in one go into one turn. Send `debounceMs` after the last message. If the user starts typing again inside that window, wait for them — up to `typingHoldMs` past the last message, never more than `maxTurnWaitMs` after the first. Send immediately at `maxMessagesPerTurn`.
2. **Send turns one at a time, in order.** Wait for one turn's ack before sending the next.
3. **Resend until acked.** If no ack arrives (8 s is reasonable), or the ack's error is `ENQUEUE_FAILED`, `NOT_SUBSCRIBED` or `RATE_LIMITED`, resend the **identical** payload with backoff. The server deduplicates, so resends never create duplicates. Other errors are final for that turn.
4. **Show ticks:** sending → accepted (ack) → stored (`turn.persisted`) → answered (an agent part with this `requestTurnId` arrives).

**`unsubscribe`** `{}`: stop receiving frames (optional; disconnecting does the same).

### Server → client

| Event | Payload | Do |
|---|---|---|
| `turn.persisted` | `{ conversationId, turnId, messages: [{ clientMessageId, id }] }` | Swap optimistic bubbles for server ids. |
| `agent.typing` | `{ conversationId, turnId, maxDurationMs }` | Show "typing…"; clear it on the reply's last part, `turn.failed`, or after `maxDurationMs`. |
| `message.part` | a Message, or a suggestions item | Insert by `id` (ignore duplicates). Parts of one reply arrive spaced out. |
| `message.updated` | a Message | Replace by `id` (pin/star/reaction changed on another device). |
| `turn.failed` | `{ conversationId, turnId, reason, retryable }` | Mark the turn's messages failed and offer a retry: resend the same `clientTurnId` and messages with `retryAttempt + 1`. |
| `error` | `{ code, message, turnId? }` | With a `turnId`, that turn was rejected (`SESSION_ENDED`, `INVALID_REPLY_TARGET`, `MESSAGE_TOO_LONG`, …). `UNAUTHORIZED` means the token expired. Refresh it and reconnect. |
| `session.ended` | `{ conversationId, endReason, endedAt }` | Disable the composer. The goodbye bubbles may still be arriving. |
| `session.completed` | `{ conversationId, endReason, completedAt }` | The transcript is final; close the socket. |
| `server.shutdown` | `{ graceMs }` | A server is restarting: reconnect after a random delay within `graceMs`. |

`reason` in `turn.failed` is one of `TIMEOUT`, `PROVIDER_ERROR`, `SAFETY_BLOCKED`, `MALFORMED`, `NOT_CONFIGURED` (an operator must fix the agent; `retryable: false`) and `PAST_DEADLINE`.

### Reconnecting

Frames are delivered at most once: nothing is queued for a disconnected client. After **every** connect, `subscribe`, then `GET /v1/client/messages?after=<newest id you hold>` (repeat while `page.hasMore`) and merge by id. While the user has not sent anything yet, re-read `GET /v1/client/session` for suggestions published while you were away. This is the whole recovery story: there are no gaps to track.

## Limits

| | |
|---|---|
| Messages per turn, characters per message | from the agent (`config`), enforced by the socket and again by the server |
| Turns per minute per connection | `SOCKET_MAX_TURNS_PER_MINUTE` (default 20), error `RATE_LIMITED` |
| Client API requests per minute per conversation | `CLIENT_API_RATE_LIMIT_PER_MINUTE` (default 120), HTTP 429 |
| Socket frame size | 256 KB |

# Host API and webhooks

The host API is called by **your backend** with a host API key:

```
Authorization: Bearer aic_...
Content-Type: application/json
```

Never call it from a browser or app. Errors always have the shape `{ "error": { "code": "...", "message": "...", "details"?: {...} } }` with codes such as `VALIDATION_FAILED` (400, with `details.issues` keyed by field), `UNAUTHORIZED` (401), `FORBIDDEN` (403), `NOT_FOUND` (404), `CONFLICT` (409) and `RATE_LIMITED` (429).

## Sessions

### `POST /v1/sessions` — create or resume

| Field | Type | |
|---|---|---|
| `agent` | string, required | The agent's slug. |
| `user.id` | string, required, ≤ 191 | Your id for the user. |
| `user.name` | string | Used in greetings and given to the model. |
| `user.attributes` | `{ [key]: string }`, ≤ 30 keys | Facts about the user the agent may use (plan, locale, role…). Information only, never instructions. |
| `scope` | string, ≤ 191 | Your key for what this conversation is about (an order, a ticket, a booking). Same agent + user + scope = same conversation. Omit for one conversation per user and agent. |
| `context.title`, `context.text`, `context.data` | string, string (≤ 20k), object | What the conversation is about. `data` is rendered as JSON. Total ≤ 32 KB. |
| `metadata` | object | Stored on the conversation, never sent to the model. |

Response `200`:

```json
{
  "conversationId": "42",
  "agent": { "id": "3", "slug": "support" },
  "externalUserId": "user-123",
  "scope": "order-4521",
  "status": "ACTIVE",
  "acceptingMessages": true,
  "endReason": null,
  "startedAt": "2026-01-01T12:00:00.000Z",
  "expiresAt": null,
  "endedAt": null,
  "created": true,
  "token": "eyJ...",
  "tokenExpiresAt": "2026-01-01T13:00:00.000Z",
  "socketUrl": "https://chat.example.com",
  "apiUrl": "https://chat.example.com"
}
```

Behaviour:

- **New** → created `ACTIVE`. If the agent has a session length, `expiresAt` is set now and never moves. The opening message is written (template) or requested (model-written). `session.started` webhook.
- **Existing, not ended** → the same conversation continues; `user.name`, `user.attributes` and `context` are updated if you send them.
- **Ended** → returned with `status: "ENDED"`, `acceptingMessages: false`. Read-only: the client can load the transcript but not send. Use a different `scope` for a new conversation.
- A conversation whose timer ran out begins ending as soon as it is opened.

Every call mints a fresh `token`, so calling `POST /v1/sessions` again is also the way to refresh one.

### `GET /v1/sessions/:id`

The session summary (the response above, without the token fields).

### `POST /v1/sessions/:id/token`

A fresh token for an existing conversation.

### `PATCH /v1/sessions/:id/context`

```json
{ "user": { "name": "Sam", "attributes": { "plan": "enterprise" } }, "context": { "title": "...", "text": "..." } }
```

Either key may be omitted; `null` clears it. Applies from the next turn.

### `POST /v1/sessions/:id/end`

Ends the conversation with reason `HOST_ENDED`: the agent says goodbye (per its closing-message setting), then `session.ended`. Idempotent.

### `GET /v1/sessions/:id/messages?before=&after=&limit=`

The visible transcript, oldest first, in the [message shape](client-protocol.md#message). `before` pages backwards; `after` reads forwards; `limit` ≤ 200 (default 100).

## Users

### `GET /v1/users/:userId/sessions?before=&limit=`

That user's conversations, newest first: `{ "sessions": [...], "nextBefore": "17" | null }`.

### `DELETE /v1/users/:userId`

Erases every conversation, message, action record and push token of the user. Returns `{ "conversations": 3 }`.

### `PUT /v1/users/:userId/devices` · `DELETE /v1/users/:userId/devices`

```json
{ "platform": "ANDROID" | "IOS" | "WEB", "token": "<FCM registration token>" }
```

Registers (or removes) a push token, used when **Settings → Offline delivery** is "Firebase Cloud Messaging". Tokens FCM reports as unregistered are removed automatically. The push is a data message:

```json
{ "type": "aic.message", "conversationId": "42", "scope": "...", "messageId": "981", "title": "Ava", "body": "First 180 characters…" }
```

## Webhooks

Configure the URL, signing secret and events in **Settings → Webhooks**. Each delivery is a `POST` with:

```
Content-Type: application/json
AIC-Event: session.ended
AIC-Delivery: 7b0e…            (unique per event; use it to deduplicate)
AIC-Signature: t=1767268800,v1=5f2c…
```

```json
{ "id": "7b0e…", "type": "session.ended", "createdAt": "2026-01-01T12:05:00.000Z", "data": { ... } }
```

**Verify the signature:** compute `HMAC-SHA256(secret, "<t>.<raw request body>")` as hex, compare it to `v1` in constant time, and reject timestamps older than 5 minutes.

**Delivery:** a `2xx` response acknowledges the event. Any other response, or a timeout after 10 s, is retried with exponential backoff up to 8 attempts. `4xx` responses other than 408, 409, 425 and 429 are treated as permanent and not retried. Delivery is at-least-once, so deduplicate on `id`.

| Event | `data` |
|---|---|
| `session.started` | `conversationId`, `externalUserId`, `agentId`, `agentSlug`, `scope`, `startedAt`, `expiresAt` |
| `session.ended` | `conversationId`, `externalUserId`, `agentId`, `scope`, `endReason` (`USER_ENDED`, `HOST_ENDED`, `ADMIN_ENDED`, `TIMER_EXPIRED`), `endedAt` |
| `action.invoked` | `invocationId`, `action`, `arguments` (`{ [name]: string }`), `conversationId`, `externalUserId`, `scope`, `agent.{id,slug}` |
| `message.undelivered` | `conversationId`, `externalUserId`, `scope`, `agent` (display name), `messageId`, `preview` |

**Actions.** Define them per agent (**Agents → Actions**): a `lower_snake_case` name, a precise description of when to trigger it (told to the model verbatim), parameters, and a per-conversation limit. An action is only offered to the model while a webhook URL is set and its limit has room. Required parameters are checked before the webhook is sent. The model's reply is delivered to the user as normal, so tell the model in the description what to say ("Tell the user a teammate will reply by email").

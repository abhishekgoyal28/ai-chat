# @ai-chat/client

JavaScript/TypeScript client for [ai-chat](../../README.md). Works in browsers and Node 20+.

It loads the session, keeps one merged transcript, batches what the user types into turns, delivers each turn until the server acknowledges it, shows typing and suggestions, resyncs after every reconnect, and refreshes expired tokens through your callback.

```bash
npm install @ai-chat/client
```

```ts
import { ChatClient } from '@ai-chat/client';

// token, apiUrl and socketUrl come from YOUR backend, which called POST /v1/sessions.
const chat = new ChatClient({ apiUrl, socketUrl, token, refreshToken: () => myBackend.newChatToken() });

chat.on('messages', (messages) => render(messages));       // ChatMessage[], ordered, deduplicated
chat.on('suggestions', (chips) => renderChips(chips));     // [] clears them
chat.on('typing', (isTyping) => setTyping(isTyping));
chat.on('turnFailed', ({ turnId, retryable }) => retryable && showRetry(() => chat.retry(turnId)));
chat.on('sessionEnded', () => disableComposer());
chat.on('connection', (state) => showConnectionState(state)); // connecting · connected · reconnecting · closed

const session = await chat.connect();   // session.agentProfile, session.config, session.expiresAt …
input.addEventListener('input', () => chat.notifyTyping());
send.addEventListener('click', () => chat.send(input.value));
```

| Method | |
|---|---|
| `connect()` | Load the session and open the socket. Resolves with the session view. |
| `send(text, { replyToId? })` | Queue a message; it goes out with whatever else the user types in the next moment as one turn. Returns the optimistic message. |
| `notifyTyping()` | Call on keystrokes, to hold the batch while the user is still typing. |
| `flush()` | Send the current batch now. |
| `retry(turnId)` | Retry a turn after `turnFailed`. |
| `loadOlder(limit?)` | Load older messages; resolves `false` at the beginning. |
| `end()` | End the conversation. |
| `pin(id, on?)`, `star(id, on?)`, `react(id, emoji \| null)`, `listStarred()` | Message actions. |
| `disconnect()` | Close the connection. |

Without a bundler, load `dist/ai-chat.global.js` with a `<script>` tag and use `window.AiChat.ChatClient`.

The wire protocol is documented in [docs/client-protocol.md](../../docs/client-protocol.md).

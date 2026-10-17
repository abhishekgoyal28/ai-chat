import { ChatClient, ChatMessage, SuggestedChip } from '@ai-chat/client';
import { FormEvent, useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';
import { useSession } from '../../lib/session';
import { Card, ErrorAlert } from '../ui';

interface Grant {
  conversationId: string;
  token: string;
  socketUrl: string;
}

/** A real conversation with the SAVED agent, through the host API, the socket and the SDK — what an end user gets. */
export const TestChatTab = ({ agentSlug, dirty }: { agentSlug: string; dirty: boolean }) => {
  const { meta } = useSession();
  const [client, setClient] = useState<ChatClient | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [suggestions, setSuggestions] = useState<SuggestedChip[]>([]);
  const [typing, setTyping] = useState(false);
  const [ended, setEnded] = useState(false);
  const [text, setText] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [status, setStatus] = useState('');
  const windowRef = useRef<HTMLDivElement>(null);

  useEffect(() => () => client?.disconnect(), [client]);
  useEffect(() => {
    windowRef.current?.scrollTo({ top: windowRef.current.scrollHeight });
  }, [messages, typing]);

  const start = async () => {
    client?.disconnect();
    setError(null);
    setEnded(false);
    setMessages([]);
    try {
      const grant = await api.post<Grant>('/test-sessions', { agentSlug, fresh: true });
      const sameOrigin = new URL(grant.socketUrl).origin === new URL(meta?.publicAppUrl ?? window.location.origin).origin;
      const chat = new ChatClient({
        apiUrl: window.location.origin,
        // Path-based installs serve the socket on the dashboard's own origin.
        socketUrl: sameOrigin ? window.location.origin : grant.socketUrl,
        token: grant.token,
        refreshToken: async () => (await api.post<Grant>(`/test-sessions/${grant.conversationId}/token`)).token,
      });
      chat.on('messages', setMessages);
      chat.on('suggestions', setSuggestions);
      chat.on('typing', setTyping);
      chat.on('connection', setStatus);
      chat.on('sessionEnded', () => setEnded(true));
      chat.on('turnFailed', (event) => setError(new Error(`Turn failed: ${event.reason}`)));
      chat.on('error', (event) => setError(new Error(`${event.code}: ${event.message}`)));
      await chat.connect();
      setClient(chat);
    } catch (caught) {
      setError(caught);
    }
  };

  const send = (event: FormEvent) => {
    event.preventDefault();
    if (!client || !text.trim()) {
      return;
    }
    try {
      client.send(text);
      client.flush();
      setText('');
    } catch (caught) {
      setError(caught);
    }
  };

  return (
    <Card
      title="Test chat"
      description="Starts a fresh conversation with the saved agent as you, through the same host API, socket and SDK your product uses."
      actions={
        <div className="row">
          {status && <span className="badge">{status}</span>}
          <button className="primary small" onClick={() => void start()}>
            {client ? 'Restart' : 'Start conversation'}
          </button>
          {client && !ended && (
            <button className="small" onClick={() => void client.end()}>
              End session
            </button>
          )}
        </div>
      }
    >
      {dirty && <div className="alert warn">You have unsaved changes — the test chat uses the saved agent.</div>}
      <ErrorAlert error={error} />
      <div className="chat-window" ref={windowRef}>
        <div className="transcript">
          {!client && <p className="muted">Start a conversation to try the agent end to end.</p>}
          {messages.map((message) => (
            <div key={message.id} className={`bubble-row ${message.senderType === 'USER' ? 'user' : message.senderType === 'SYSTEM' ? 'system' : ''}`}>
              <div>
                <div className="bubble">{message.body}</div>
                {message.senderType === 'USER' && <div className="bubble-meta">{message.status.toLowerCase()}</div>}
              </div>
            </div>
          ))}
          {typing && <div className="typing">typing…</div>}
          {suggestions.length > 0 && (
            <div className="chips">
              {suggestions.map((chip) => (
                <button key={chip.id} className="chip" onClick={() => { client?.send(chip.text); client?.flush(); }}>
                  {chip.text}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
      <form onSubmit={send} className="row" style={{ marginTop: 12, flexWrap: 'nowrap' }}>
        <input
          type="text"
          value={text}
          placeholder={ended ? 'This conversation has ended' : 'Type a message…'}
          disabled={!client || ended}
          onChange={(event) => {
            setText(event.target.value);
            client?.notifyTyping();
          }}
        />
        <button className="primary" type="submit" disabled={!client || ended || !text.trim()}>
          Send
        </button>
      </form>
    </Card>
  );
};

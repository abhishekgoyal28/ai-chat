import { useCallback, useEffect, useRef, useState } from 'react';
import { ChatClient } from '@ai-chat/client';
import type { ChatMessage, SuggestedChip } from '@ai-chat/client';
import { api } from '../lib/api';

interface TestSession {
  conversationId: string;
  token: string;
  tokenExpiresAt: string;
  socketUrl: string;
  apiUrl: string;
}

export const GuideChat = () => {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chips, setChips] = useState<SuggestedChip[]>([]);
  const [typing, setTyping] = useState(false);
  const [input, setInput] = useState('');
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const clientRef = useRef<ChatClient | null>(null);
  const sessionRef = useRef<TestSession | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const startSession = useCallback(async () => {
    if (clientRef.current) return;
    setStatus('loading');
    setErrorMsg(null);
    try {
      const session = await api.post<TestSession>('/test-sessions', { agentSlug: 'guide', fresh: false });
      sessionRef.current = session;

      const client = new ChatClient({
        apiUrl: session.apiUrl,
        socketUrl: session.socketUrl,
        token: session.token,
        refreshToken: async () => {
          const r = await api.post<TestSession>(`/test-sessions/${session.conversationId}/token`);
          return r.token;
        },
      });

      client.on('messages', (msgs) => setMessages([...msgs]));
      client.on('suggestions', (s) => setChips([...s]));
      client.on('typing', (t) => setTyping(t));

      await client.connect();
      clientRef.current = client;
      setStatus('ready');
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Failed to connect';
      setErrorMsg(msg);
      setStatus('error');
    }
  }, []);

  const handleOpen = useCallback(() => {
    setOpen(true);
    if (!clientRef.current) {
      void startSession();
    } else {
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [startSession]);

  const handleClose = useCallback(() => setOpen(false), []);

  const send = useCallback(
    (text: string) => {
      if (!clientRef.current || !text.trim()) return;
      clientRef.current.send(text.trim());
      setInput('');
      setChips([]);
    },
    [],
  );

  useEffect(() => {
    if (status === 'ready') {
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [status]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, typing]);

  useEffect(() => {
    return () => {
      clientRef.current?.disconnect();
    };
  }, []);

  const visibleMessages = messages.filter(
    (m) => m.body && (m.senderType === 'AGENT' || m.senderType === 'USER'),
  );

  return (
    <>
      <button
        className="guide-fab"
        onClick={handleOpen}
        title="Ask Ava — ai-chat Platform Guide"
        aria-label="Open ai-chat guide"
      >
        <span className="guide-fab-letter">A</span>
        <span className="guide-fab-pulse" />
      </button>

      {open && (
        <div className="guide-panel" role="dialog" aria-label="ai-chat Guide" aria-modal="false">
          <div className="guide-panel-header">
            <div className="guide-panel-avatar">A</div>
            <div className="guide-panel-identity">
              <div className="guide-panel-name">Ava</div>
              <div className="guide-panel-tagline">ai-chat Platform Guide</div>
            </div>
            <button className="guide-panel-close" onClick={handleClose} aria-label="Close guide chat">
              ✕
            </button>
          </div>

          <div className="guide-panel-messages">
            {status === 'loading' && (
              <div className="guide-panel-notice">Connecting…</div>
            )}
            {status === 'error' && (
              <div className="guide-panel-notice guide-panel-notice--error">
                {errorMsg ?? 'Connection failed.'}{' '}
                <button
                  onClick={() => { clientRef.current = null; void startSession(); }}
                  style={{ textDecoration: 'underline', background: 'none', border: 'none', cursor: 'pointer', color: 'inherit', padding: 0 }}
                >
                  Retry
                </button>
              </div>
            )}
            {visibleMessages.map((m) => (
              <div
                key={m.id}
                className={`guide-msg guide-msg--${m.senderType === 'USER' ? 'user' : 'agent'}`}
              >
                {m.body}
              </div>
            ))}
            {typing && (
              <div className="guide-msg guide-msg--agent guide-msg--typing">
                <span /><span /><span />
              </div>
            )}
            <div ref={bottomRef} />
          </div>

          {chips.length > 0 && (
            <div className="guide-chips">
              {chips.map((c) => (
                <button key={c.id} className="guide-chip" onClick={() => send(c.text)}>
                  {c.text}
                </button>
              ))}
            </div>
          )}

          <form
            className="guide-input-row"
            onSubmit={(e) => { e.preventDefault(); send(input); }}
          >
            <input
              ref={inputRef}
              className="guide-input"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask anything about ai-chat…"
              disabled={status !== 'ready'}
            />
            <button
              type="submit"
              className="guide-send"
              disabled={!input.trim() || status !== 'ready'}
              aria-label="Send"
            >
              ↑
            </button>
          </form>
        </div>
      )}
    </>
  );
};

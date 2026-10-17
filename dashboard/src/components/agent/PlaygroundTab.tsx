import { FormEvent, useState } from 'react';
import { api, PreviewResult } from '../../lib/api';
import { Card, ErrorAlert, Field } from '../ui';
import { AgentDraft } from './types';

interface Turn {
  role: 'USER' | 'AGENT';
  body: string;
}

/**
 * One generation at a time against the UNSAVED draft, through the real
 * chat-expert worker — for tuning prompts before saving. The exact system
 * prompt is shown so you can see what the model saw.
 */
export const PlaygroundTab = ({ draft, agentId }: { draft: AgentDraft; agentId: string | null }) => {
  const [history, setHistory] = useState<Turn[]>([]);
  const [message, setMessage] = useState('');
  const [userName, setUserName] = useState('Alex');
  const [contextText, setContextText] = useState('');
  const [result, setResult] = useState<PreviewResult | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const run = async (kind: 'REPLY' | 'GREETING' | 'FAREWELL', text?: string) => {
    setBusy(true);
    setError(null);
    try {
      const response = await api.post<PreviewResult>('/playground', {
        kind,
        agent: {
          agentId,
          name: draft.name || 'Draft agent',
          personaId: draft.personaId,
          domainPromptId: draft.domainPromptId,
          modelRoutes: draft.modelRoutes,
          settings: draft.settings,
        },
        message: text,
        history,
        user: { name: userName || undefined },
        ...(contextText.trim() && { context: { text: contextText } }),
      });
      setResult(response);
      if (response.status === 'SUCCESS') {
        setHistory((current) => [...current, ...(text ? [{ role: 'USER' as const, body: text }] : []), { role: 'AGENT' as const, body: response.parts.join('\n') }]);
      }
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  const send = (event: FormEvent) => {
    event.preventDefault();
    if (message.trim()) {
      void run('REPLY', message.trim());
      setMessage('');
    }
  };

  return (
    <div className="grid-2" style={{ alignItems: 'start' }}>
      <div>
        <Card title="Try the draft" description="Uses your unsaved changes and the first model route with weight > 0. Nothing is stored.">
          <div className="grid-2">
            <Field label="User name">
              <input type="text" value={userName} onChange={(event) => setUserName(event.target.value)} />
            </Field>
            <Field label="Host context (optional)">
              <input type="text" placeholder="e.g. The user is on the pricing page" value={contextText} onChange={(event) => setContextText(event.target.value)} />
            </Field>
          </div>
          <div className="chat-window" style={{ height: 320 }}>
            <div className="transcript">
              {history.length === 0 && <p className="muted">Send a message, or generate the opening.</p>}
              {history.map((turn, index) => (
                <div key={index} className={`bubble-row ${turn.role === 'USER' ? 'user' : ''}`}>
                  <div className="bubble">{turn.body}</div>
                </div>
              ))}
              {busy && <div className="typing">Generating…</div>}
            </div>
          </div>
          <form onSubmit={send} className="row" style={{ marginTop: 12, flexWrap: 'nowrap' }}>
            <input type="text" value={message} placeholder="Ask something…" onChange={(event) => setMessage(event.target.value)} disabled={busy} />
            <button className="primary" type="submit" disabled={busy || !message.trim()}>
              Send
            </button>
          </form>
          <div className="row" style={{ marginTop: 10 }}>
            <button className="small" disabled={busy} onClick={() => void run('GREETING')}>
              Generate opening
            </button>
            <button className="small" disabled={busy} onClick={() => void run('FAREWELL')}>
              Generate goodbye
            </button>
            <button className="small" disabled={busy} onClick={() => { setHistory([]); setResult(null); }}>
              Clear
            </button>
          </div>
        </Card>
      </div>
      <div>
        <ErrorAlert error={error} />
        {result && (
          <Card title="Last generation">
            {result.status === 'FAILED' ? (
              <div className="alert danger">
                {result.failureReason}: {result.errorMessage}
              </div>
            ) : (
              <>
                <p className="hint">
                  {result.meta?.model} · {result.meta?.latencyMs} ms · {result.meta?.inputTokens ?? '?'} in / {result.meta?.outputTokens ?? '?'} out tokens · {result.parts.length} bubble
                  {result.parts.length === 1 ? '' : 's'} · {result.meta?.knowledgeDocuments ?? 0} knowledge documents
                </p>
                {result.chips && result.chips.length > 0 && (
                  <div className="chips" style={{ margin: '10px 0' }}>
                    {result.chips.map((chip) => (
                      <span key={chip} className="chip">
                        {chip}
                      </span>
                    ))}
                  </div>
                )}
                {result.action && (
                  <div className="alert ok">
                    Action triggered: <code>{result.action.name}</code> {JSON.stringify(result.action.arguments)}
                  </div>
                )}
              </>
            )}
            <details style={{ marginTop: 12 }}>
              <summary>System prompt ({result.systemPrompt.length.toLocaleString()} characters)</summary>
              <pre className="block" style={{ marginTop: 8 }}>
                {result.systemPrompt}
              </pre>
            </details>
          </Card>
        )}
      </div>
    </div>
  );
};

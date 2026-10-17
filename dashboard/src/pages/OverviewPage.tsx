import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Card, ErrorAlert, formatNumber, Loading, PageHeader } from '../components/ui';
import { api } from '../lib/api';
import { useSession } from '../lib/session';

interface Overview {
  last24h: { conversations: number; replies: number; avgReplyLatencyMs: number | null; inputTokens: number; outputTokens: number };
  activeConversations: number;
  conversationsByAgent7d: Array<{ agentId: string; name: string; conversations: number }>;
  setup: { providerAdded: boolean; agentCreated: boolean; agentRouted: boolean; apiKeyCreated: boolean; hasConversations: boolean };
}

const steps: Array<{ key: keyof Overview['setup']; label: string; to: string; detail: string }> = [
  { key: 'providerAdded', label: 'Add an LLM provider', to: '/providers', detail: 'OpenAI, Anthropic, Gemini, Vertex AI, or a self-hosted OpenAI-compatible server such as Ollama.' },
  { key: 'agentCreated', label: 'Create an agent', to: '/agents/new', detail: 'Pick a persona, write a domain prompt, choose how sessions start and end.' },
  { key: 'agentRouted', label: 'Route the agent to a model', to: '/agents', detail: 'On the agent’s Model tab, add at least one provider and model.' },
  { key: 'apiKeyCreated', label: 'Create a host API key', to: '/api-keys', detail: 'Your backend uses it to start sessions for signed-in users.' },
  { key: 'hasConversations', label: 'Have a first conversation', to: '/agents', detail: 'Use an agent’s Test chat tab, or call POST /v1/sessions from your backend.' },
];

export const OverviewPage = () => {
  const { isAdmin, meta } = useSession();
  const overview = useQuery({ queryKey: ['overview'], queryFn: () => api.get<Overview>('/overview'), refetchInterval: 30_000 });

  if (overview.isLoading) {
    return <Loading />;
  }
  if (!overview.data) {
    return <ErrorAlert error={overview.error} />;
  }
  const data = overview.data;
  const setupDone = Object.values(data.setup).every(Boolean);

  return (
    <>
      <PageHeader title="Overview" description="Live usage across every agent. Numbers refresh every 30 seconds." />
      {!setupDone && (
        <Card title="Getting started" description="A fresh install needs these steps before your product can start conversations.">
          <ol className="checklist">
            {steps.map((step) => (
              <li key={step.key}>
                {data.setup[step.key] ? '✓ ' : ''}
                {isAdmin || !['providerAdded', 'apiKeyCreated'].includes(step.key) ? <Link to={step.to}>{step.label}</Link> : step.label}
                <span className="hint" style={{ display: 'block' }}>{step.detail}</span>
              </li>
            ))}
          </ol>
        </Card>
      )}
      <div className="grid-3" style={{ marginBottom: 18 }}>
        <div className="stat">
          <div className="label">Active conversations</div>
          <div className="value">{formatNumber(data.activeConversations)}</div>
        </div>
        <div className="stat">
          <div className="label">Conversations · 24h</div>
          <div className="value">{formatNumber(data.last24h.conversations)}</div>
        </div>
        <div className="stat">
          <div className="label">Replies · 24h</div>
          <div className="value">{formatNumber(data.last24h.replies)}</div>
        </div>
        <div className="stat">
          <div className="label">Avg model latency · 24h</div>
          <div className="value">{data.last24h.avgReplyLatencyMs === null ? '—' : `${(data.last24h.avgReplyLatencyMs / 1000).toFixed(2)} s`}</div>
        </div>
        <div className="stat">
          <div className="label">Input tokens · 24h</div>
          <div className="value">{formatNumber(data.last24h.inputTokens)}</div>
        </div>
        <div className="stat">
          <div className="label">Output tokens · 24h</div>
          <div className="value">{formatNumber(data.last24h.outputTokens)}</div>
        </div>
      </div>
      <Card title="Conversations by agent · 7 days">
        {data.conversationsByAgent7d.length === 0 ? (
          <p className="muted">No conversations yet.</p>
        ) : (
          <table>
            <tbody>
              {data.conversationsByAgent7d.map((row) => (
                <tr key={row.agentId}>
                  <td>
                    <Link to={`/agents/${row.agentId}`}>{row.name}</Link>
                  </td>
                  <td style={{ textAlign: 'right' }} className="mono">
                    {formatNumber(row.conversations)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      {meta && (
        <p className="hint">
          Host API at <code>{meta.publicAppUrl}/v1</code> · WebSocket at <code>{meta.publicSocketUrl}</code> · queue driver <code>{meta.queueDriver}</code>
        </p>
      )}
    </>
  );
};

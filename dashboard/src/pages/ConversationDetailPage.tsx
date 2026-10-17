import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { Card, confirmAction, ErrorAlert, formatDate, Loading, PageHeader, StatusBadge, useToast } from '../components/ui';
import { api, ConversationItem, TranscriptMessage } from '../lib/api';

interface Detail {
  conversation: ConversationItem & {
    userAttributes: Record<string, string> | null;
    context: Record<string, unknown> | null;
    metadata: Record<string, unknown> | null;
    llmProviderId: string | null;
    llmModel: string | null;
    generating: boolean;
  };
  messages: TranscriptMessage[];
  actions: Array<{ id: string; actionName: string; arguments: Record<string, string>; status: string; error: string | null; createdAt: string }>;
}

const metaLine = (meta: Record<string, unknown> | null): string | null => {
  if (!meta || meta.latencyMs === undefined) {
    return null;
  }
  const parts = [meta.model, `${meta.latencyMs} ms`, `${meta.inputTokens ?? '?'} → ${meta.outputTokens ?? '?'} tokens`];
  const revisions = meta.revisions as Record<string, number | null> | undefined;
  if (revisions) {
    parts.push(`agent r${revisions.agent ?? '–'} · persona r${revisions.persona ?? '–'} · domain r${revisions.domainPrompt ?? '–'} · master r${revisions.masterPrompt ?? '–'}`);
  }
  return parts.join(' · ');
};

export const ConversationDetailPage = () => {
  const { id } = useParams<{ id: string }>();
  const toast = useToast();
  const queryClient = useQueryClient();
  const detail = useQuery({ queryKey: ['conversation', id], queryFn: () => api.get<Detail>(`/conversations/${id}`), refetchInterval: 5000 });

  if (!detail.data) {
    return detail.isLoading ? <Loading /> : <ErrorAlert error={detail.error} />;
  }
  const { conversation, messages, actions } = detail.data;

  const end = async () => {
    if (!confirmAction('End this conversation? The agent says goodbye and the user can no longer reply.')) {
      return;
    }
    await api.post(`/conversations/${id}/end`);
    toast('Ending conversation');
    await queryClient.invalidateQueries({ queryKey: ['conversation', id] });
  };

  return (
    <>
      <PageHeader
        crumbs={<Link to="/conversations">Conversations</Link>}
        title={`Conversation #${conversation.id}`}
        description={
          <span className="row">
            <StatusBadge status={conversation.status} />
            {conversation.agent && <Link to={`/agents/${conversation.agent.id}`}>{conversation.agent.name}</Link>}
            <span className="muted">started {formatDate(conversation.startedAt)}</span>
            {conversation.expiresAt && <span className="muted">· expires {formatDate(conversation.expiresAt)}</span>}
            {conversation.generating && <span className="badge accent">generating</span>}
          </span>
        }
        actions={conversation.status === 'ACTIVE' && <button className="danger" onClick={() => void end()}>End conversation</button>}
      />
      <div className="grid-2" style={{ gridTemplateColumns: '2fr 1fr', alignItems: 'start' }}>
        <Card title="Transcript" description="Everything stored, including parts not yet revealed and failed turns.">
          <div className="transcript">
            {messages.map((message) => (
              <div key={message.id} className={`bubble-row ${message.senderType === 'USER' ? 'user' : message.senderType === 'SYSTEM' ? 'system' : ''}`}>
                <div style={{ maxWidth: '100%' }}>
                  <div className="bubble">{message.body}</div>
                  <div className="bubble-meta">
                    #{message.id} · {message.kind.toLowerCase()} · {message.status.toLowerCase()} · {formatDate(message.clientSentAt ?? message.publishedAt ?? message.createdAt)}
                    {metaLine(message.meta) && <div>{metaLine(message.meta)}</div>}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </Card>
        <div>
          <Card title="User">
            <p style={{ margin: 0 }}>
              <strong>{conversation.userName ?? 'No name'}</strong>
            </p>
            <p className="mono muted" style={{ margin: '2px 0 10px' }}>
              {conversation.externalUserId}
            </p>
            {conversation.scope && (
              <p className="hint">
                scope <code>{conversation.scope}</code>
              </p>
            )}
            {conversation.userAttributes && <pre className="block">{JSON.stringify(conversation.userAttributes, null, 2)}</pre>}
          </Card>
          <Card title="Model">
            <p className="mono" style={{ margin: 0 }}>
              {conversation.llmModel ?? 'agent default'} {conversation.llmProviderId && <span className="muted">(provider #{conversation.llmProviderId})</span>}
            </p>
          </Card>
          {conversation.context && (
            <Card title="Host context">
              <pre className="block">{JSON.stringify(conversation.context, null, 2)}</pre>
            </Card>
          )}
          {actions.length > 0 && (
            <Card title="Actions">
              {actions.map((action) => (
                <div key={action.id} style={{ marginBottom: 10 }}>
                  <div className="row">
                    <code>{action.actionName}</code> <StatusBadge status={action.status} />
                  </div>
                  <pre className="block" style={{ marginTop: 4 }}>
                    {JSON.stringify(action.arguments, null, 2)}
                  </pre>
                  {action.error && <div className="error">{action.error}</div>}
                </div>
              ))}
            </Card>
          )}
        </div>
      </div>
    </>
  );
};

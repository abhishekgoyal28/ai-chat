import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, Empty, ErrorAlert, formatDate, Loading, PageHeader, StatusBadge } from '../components/ui';
import { Agent, api, ConversationItem } from '../lib/api';

interface ConversationPage {
  conversations: ConversationItem[];
  nextBefore: string | null;
}

export const ConversationsPage = () => {
  const navigate = useNavigate();
  const [agentId, setAgentId] = useState('');
  const [status, setStatus] = useState('');
  const [user, setUser] = useState('');
  const agents = useQuery({ queryKey: ['agents'], queryFn: () => api.get<Agent[]>('/agents') });

  const list = useInfiniteQuery({
    queryKey: ['conversations', agentId, status, user],
    initialPageParam: '',
    queryFn: ({ pageParam }) => {
      const query = new URLSearchParams({ limit: '25' });
      if (agentId) query.set('agentId', agentId);
      if (status) query.set('status', status);
      if (user.trim()) query.set('externalUserId', user.trim());
      if (pageParam) query.set('before', pageParam);
      return api.get<ConversationPage>(`/conversations?${query.toString()}`);
    },
    getNextPageParam: (page) => page.nextBefore ?? undefined,
  });
  const rows = list.data?.pages.flatMap((page) => page.conversations) ?? [];

  return (
    <>
      <PageHeader title="Conversations" description="Every conversation across all agents, newest first. Open one to read the full transcript with model, latency and token details per reply." />
      <Card>
        <div className="grid-3">
          <select value={agentId} onChange={(event) => setAgentId(event.target.value)}>
            <option value="">All agents</option>
            {agents.data?.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
          </select>
          <select value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value="">Any status</option>
            <option value="ACTIVE">Active</option>
            <option value="ENDED">Ended</option>
          </select>
          <input type="text" placeholder="External user id" value={user} onChange={(event) => setUser(event.target.value)} />
        </div>
      </Card>
      <ErrorAlert error={list.error} />
      {list.isLoading ? (
        <Loading />
      ) : rows.length === 0 ? (
        <Card>
          <Empty title="No conversations match" />
        </Card>
      ) : (
        <div className="card table-card">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Agent</th>
                <th>User</th>
                <th>Scope</th>
                <th>Status</th>
                <th>Started</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="clickable" onClick={() => navigate(`/conversations/${row.id}`)}>
                  <td className="mono muted">{row.id}</td>
                  <td>{row.agent?.name ?? '—'}</td>
                  <td>
                    {row.userName ?? <span className="muted">no name</span>}
                    <div className="mono muted">{row.externalUserId}</div>
                  </td>
                  <td className="mono">{row.scope || <span className="muted">—</span>}</td>
                  <td>
                    <StatusBadge status={row.status} />
                    {row.endReason && <div className="muted" style={{ fontSize: 12 }}>{row.endReason.toLowerCase().replace('_', ' ')}</div>}
                  </td>
                  <td className="muted">{formatDate(row.startedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {list.hasNextPage && (
            <div style={{ padding: 14, textAlign: 'center' }}>
              <button disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
                {list.isFetchingNextPage ? 'Loading…' : 'Load more'}
              </button>
            </div>
          )}
        </div>
      )}
    </>
  );
};

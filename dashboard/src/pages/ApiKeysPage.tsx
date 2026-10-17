import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Card, confirmAction, ErrorAlert, Field, formatDate, Loading, Modal, PageHeader } from '../components/ui';
import { api } from '../lib/api';
import { useSession } from '../lib/session';

interface ApiKey {
  id: string;
  name: string;
  keyPrefix: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export const ApiKeysPage = () => {
  const { meta } = useSession();
  const queryClient = useQueryClient();
  const keys = useQuery({ queryKey: ['api-keys'], queryFn: () => api.get<ApiKey[]>('/api-keys') });
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [created, setCreated] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  const create = async () => {
    setError(null);
    try {
      const result = await api.post<ApiKey & { key: string }>('/api-keys', { name });
      setCreated(result.key);
      setCreating(false);
      setName('');
      await queryClient.invalidateQueries({ queryKey: ['api-keys'] });
    } catch (caught) {
      setError(caught);
    }
  };

  const revoke = async (key: ApiKey) => {
    if (!confirmAction(`Revoke "${key.name}"? Requests using it fail within 30 seconds.`)) {
      return;
    }
    await api.del(`/api-keys/${key.id}`);
    await queryClient.invalidateQueries({ queryKey: ['api-keys'] });
  };

  return (
    <>
      <PageHeader
        title="Host API keys"
        description="Server-to-server credentials for YOUR backend. Never put one in a browser or app — clients get a short-lived session token instead."
        actions={<button className="primary" onClick={() => setCreating(true)}>Create key</button>}
      />
      {created && (
        <div className="alert ok">
          <strong>Copy this key now — it is not shown again.</strong>
          <pre className="block" style={{ marginTop: 8 }}>
            {created}
          </pre>
          <p className="hint">Try it:</p>
          <pre className="block">{`curl -X POST ${meta?.publicAppUrl ?? ''}/v1/sessions \\
  -H "Authorization: Bearer ${created}" \\
  -H "Content-Type: application/json" \\
  -d '{"agent": "<agent-slug>", "user": {"id": "user-123", "name": "Sam"}}'`}</pre>
          <button className="small" style={{ marginTop: 8 }} onClick={() => setCreated(null)}>
            Done
          </button>
        </div>
      )}
      {keys.isLoading ? (
        <Loading />
      ) : (
        <Card>
          {keys.data?.length === 0 ? (
            <p className="muted">No keys yet.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Key</th>
                  <th>Last used</th>
                  <th>Created</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {keys.data?.map((key) => (
                  <tr key={key.id}>
                    <td>
                      <strong>{key.name}</strong>
                    </td>
                    <td className="mono">{key.keyPrefix}…</td>
                    <td className="muted">{formatDate(key.lastUsedAt)}</td>
                    <td className="muted">{formatDate(key.createdAt)}</td>
                    <td style={{ textAlign: 'right' }}>
                      {key.revokedAt ? (
                        <span className="badge">revoked</span>
                      ) : (
                        <button className="small danger" onClick={() => void revoke(key)}>
                          Revoke
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      )}
      {creating && (
        <Modal
          title="Create host API key"
          onClose={() => setCreating(false)}
          actions={
            <>
              <button onClick={() => setCreating(false)}>Cancel</button>
              <button className="primary" disabled={!name.trim()} onClick={() => void create()}>
                Create
              </button>
            </>
          }
        >
          <ErrorAlert error={error} />
          <Field label="Name" hint="Where it is used, e.g. “production backend”.">
            <input type="text" value={name} onChange={(event) => setName(event.target.value)} autoFocus />
          </Field>
        </Modal>
      )}
    </>
  );
};

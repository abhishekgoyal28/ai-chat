import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, Empty, ErrorAlert, Field, formatDate, formatNumber, Loading, Modal, PageHeader } from '../components/ui';
import { api, KnowledgeBase } from '../lib/api';

export const KnowledgePage = () => {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const bases = useQuery({ queryKey: ['knowledge-bases'], queryFn: () => api.get<KnowledgeBase[]>('/knowledge-bases') });
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<unknown>(null);

  const create = async () => {
    setError(null);
    try {
      const base = await api.post<KnowledgeBase>('/knowledge-bases', { name, description: description || null });
      await queryClient.invalidateQueries({ queryKey: ['knowledge-bases'] });
      navigate(`/knowledge/${base.id}`);
    } catch (caught) {
      setError(caught);
    }
  };

  return (
    <>
      <PageHeader
        title="Knowledge"
        description="Collections of text documents an agent draws on — FAQs, policies, product docs, manuals. Attach them on an agent's Knowledge tab."
        actions={<button className="primary" onClick={() => setCreating(true)}>New knowledge base</button>}
      />
      {bases.isLoading ? (
        <Loading />
      ) : bases.data?.length === 0 ? (
        <Card>
          <Empty title="No knowledge bases" action={<button className="primary" onClick={() => setCreating(true)}>Create one</button>}>
            Paste or upload .txt and .md documents.
          </Empty>
        </Card>
      ) : (
        <div className="card table-card">
          <table>
            <thead>
              <tr>
                <th>Knowledge base</th>
                <th>Documents</th>
                <th>Characters</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {bases.data?.map((base) => (
                <tr key={base.id} className="clickable" onClick={() => navigate(`/knowledge/${base.id}`)}>
                  <td>
                    <strong>{base.name}</strong>
                    {base.description && <div className="muted">{base.description}</div>}
                  </td>
                  <td className="mono">{formatNumber(base.documents)}</td>
                  <td className="mono">{formatNumber(base.chars)}</td>
                  <td className="muted">{formatDate(base.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {creating && (
        <Modal
          title="New knowledge base"
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
          <Field label="Name">
            <input type="text" value={name} onChange={(event) => setName(event.target.value)} autoFocus />
          </Field>
          <Field label="Description">
            <input type="text" value={description} onChange={(event) => setDescription(event.target.value)} />
          </Field>
        </Modal>
      )}
    </>
  );
};

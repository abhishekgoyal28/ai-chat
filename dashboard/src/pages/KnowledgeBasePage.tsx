import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChangeEvent, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { NumberInput } from '../components/inputs';
import { Card, confirmAction, Empty, ErrorAlert, Field, fieldError, formatDate, formatNumber, Loading, Modal, PageHeader, ReadOnlyNotice, StatusBadge, useToast } from '../components/ui';
import { api, KnowledgeBase, KnowledgeDocument } from '../lib/api';
import { useSession } from '../lib/session';

interface DocumentForm {
  id?: string;
  revision?: number;
  title: string;
  content: string;
  status: 'ACTIVE' | 'DISABLED';
  position: number | null;
}

const MAX_UPLOAD_BYTES = 2_000_000;

export const KnowledgeBasePage = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { canModify } = useSession();
  const base = useQuery({ queryKey: ['knowledge-base', id], queryFn: () => api.get<KnowledgeBase & { documentList: KnowledgeDocument[] }>(`/knowledge-bases/${id}`) });
  const [form, setForm] = useState<DocumentForm | null>(null);
  const [error, setError] = useState<unknown>(null);

  if (!base.data) {
    return base.isLoading ? <Loading /> : <ErrorAlert error={base.error} />;
  }
  const editable = canModify(base.data);
  const refresh = () => Promise.all([queryClient.invalidateQueries({ queryKey: ['knowledge-base', id] }), queryClient.invalidateQueries({ queryKey: ['knowledge-bases'] })]);

  const openDocument = async (document: KnowledgeDocument) => {
    setError(null);
    const full = await api.get<KnowledgeDocument>(`/knowledge-bases/${id}/documents/${document.id}`);
    setForm({ id: full.id, revision: full.revision, title: full.title, content: full.content ?? '', status: full.status, position: full.position });
  };

  const upload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) {
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      toast('Files are limited to 2 MB of text', 'error');
      return;
    }
    setError(null);
    setForm({ title: file.name.replace(/\.(txt|md|markdown)$/i, ''), content: await file.text(), status: 'ACTIVE', position: null });
  };

  const save = async () => {
    if (!form) {
      return;
    }
    setError(null);
    const body = { title: form.title, content: form.content, status: form.status, ...(form.position !== null && { position: form.position }) };
    try {
      if (form.id) {
        await api.put(`/knowledge-bases/${id}/documents/${form.id}`, { ...body, expectedRevision: form.revision });
      } else {
        await api.post(`/knowledge-bases/${id}/documents`, body);
      }
      setForm(null);
      await refresh();
      toast('Document saved');
    } catch (caught) {
      setError(caught);
    }
  };

  const removeDocument = async (document: KnowledgeDocument) => {
    if (!confirmAction(`Delete "${document.title}"?`)) {
      return;
    }
    await api.del(`/knowledge-bases/${id}/documents/${document.id}`);
    await refresh();
  };

  const removeBase = async () => {
    if (!confirmAction('Delete this knowledge base and all its documents?')) {
      return;
    }
    try {
      await api.del(`/knowledge-bases/${id}`);
      await queryClient.invalidateQueries({ queryKey: ['knowledge-bases'] });
      navigate('/knowledge');
    } catch (caught) {
      toast((caught as Error).message, 'error');
    }
  };

  const totalChars = base.data.documentList.filter((document) => document.status === 'ACTIVE').reduce((sum, document) => sum + document.charCount, 0);

  return (
    <>
      <PageHeader
        crumbs={<Link to="/knowledge">Knowledge</Link>}
        title={base.data.name}
        description={`${base.data.documentList.length} documents · ${formatNumber(totalChars)} active characters. Lower position goes into the prompt first.`}
        actions={
          editable && (
            <>
              <button className="danger" onClick={() => void removeBase()}>
                Delete
              </button>
              <label className="button">
                Upload .txt / .md
                <input type="file" accept=".txt,.md,.markdown,text/plain,text/markdown" hidden onChange={(event) => void upload(event)} />
              </label>
              <button className="primary" onClick={() => { setError(null); setForm({ title: '', content: '', status: 'ACTIVE', position: null }); }}>
                New document
              </button>
            </>
          )
        }
      />
      {!editable && <ReadOnlyNotice what="knowledge base" />}
      {base.data.documentList.length === 0 ? (
        <Card>
          <Empty title="No documents yet">Paste text or upload a .txt or .md file.</Empty>
        </Card>
      ) : (
        <div className="card table-card">
          <table>
            <thead>
              <tr>
                <th>Position</th>
                <th>Title</th>
                <th>Characters</th>
                <th>Status</th>
                <th>Updated</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {base.data.documentList.map((document) => (
                <tr key={document.id} className="clickable" onClick={() => void openDocument(document)}>
                  <td className="mono">{document.position}</td>
                  <td>
                    <strong>{document.title}</strong>
                  </td>
                  <td className="mono">{formatNumber(document.charCount)}</td>
                  <td>
                    <StatusBadge status={document.status} />
                  </td>
                  <td className="muted">{formatDate(document.updatedAt)}</td>
                  <td style={{ textAlign: 'right' }}>
                    {editable && (
                      <button className="small danger" onClick={(event) => { event.stopPropagation(); void removeDocument(document); }}>
                        Delete
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {form && (
        <Modal
          title={!editable ? 'Document' : form.id ? 'Edit document' : 'New document'}
          onClose={() => setForm(null)}
          actions={
            <>
              <button onClick={() => setForm(null)}>{editable ? 'Cancel' : 'Close'}</button>
              {editable && (
                <button className="primary" onClick={() => void save()}>
                  Save
                </button>
              )}
            </>
          }
        >
          <ErrorAlert error={error} />
          <Field label="Title" error={fieldError(error, 'title')}>
            <input type="text" value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} />
          </Field>
          <div className="grid-2">
            <Field label="Status" hint="Disabled documents stay here but are left out of the prompt.">
              <select value={form.status} onChange={(event) => setForm({ ...form, status: event.target.value as DocumentForm['status'] })}>
                <option value="ACTIVE">Active</option>
                <option value="DISABLED">Disabled</option>
              </select>
            </Field>
            <Field label="Position" hint="Empty puts it last.">
              <NumberInput value={form.position} nullable min={0} onChange={(position) => setForm({ ...form, position })} />
            </Field>
          </div>
          <Field label={`Content (${form.content.length.toLocaleString()} characters)`} error={fieldError(error, 'content')}>
            <textarea className="code" rows={16} value={form.content} onChange={(event) => setForm({ ...form, content: event.target.value })} />
          </Field>
        </Modal>
      )}
    </>
  );
};

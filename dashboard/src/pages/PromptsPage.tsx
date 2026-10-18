import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { RevisionHistory } from '../components/RevisionHistory';
import { Card, confirmAction, ErrorAlert, Field, fieldError, formatDate, Loading, Modal, OwnedBadge, PageHeader, ReadOnlyNotice, useToast } from '../components/ui';
import { api, Prompt } from '../lib/api';
import { useSession } from '../lib/session';

const MasterPromptCard = () => {
  const queryClient = useQueryClient();
  const toast = useToast();
  const { canModify } = useSession();
  const master = useQuery({ queryKey: ['master-prompt'], queryFn: () => api.get<Prompt>('/prompts/master') });
  const [text, setText] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [showHistory, setShowHistory] = useState(false);

  useEffect(() => {
    if (master.data) {
      setText(master.data.text);
    }
  }, [master.data]);

  if (!master.data) {
    return master.isLoading ? <Loading /> : <ErrorAlert error={master.error} />;
  }

  const editable = canModify(master.data);

  const save = async () => {
    setError(null);
    try {
      const updated = await api.put<Prompt>('/prompts/master', { text, expectedRevision: master.data.revision });
      queryClient.setQueryData(['master-prompt'], updated);
      toast('Master prompt saved');
    } catch (caught) {
      setError(caught);
    }
  };

  return (
    <Card
      title="Master prompt"
      description={
        <>
          The platform-wide frame every agent opens with: scope, honesty, data-vs-instructions and reply format. <code>{'{{MAX_REPLY_PARTS}}'}</code> and{' '}
          <code>{'{{MAX_PART_CHARS}}'}</code> are filled from each agent&apos;s reply settings. Revision {master.data.revision}, saved {formatDate(master.data.updatedAt)}.
        </>
      }
      actions={
        <div className="row">
          <button className="small" onClick={() => setShowHistory(!showHistory)}>
            {showHistory ? 'Hide history' : 'History'}
          </button>
          {editable && (
            <>
              <button className="small" onClick={() => master.data.defaultText && setText(master.data.defaultText)}>
                Load default
              </button>
              <button className="small primary" disabled={text === master.data.text} onClick={() => void save()}>
                Save
              </button>
            </>
          )}
        </div>
      }
    >
      {!editable && <div className="alert warn">Read-only: the master prompt is shared by every agent, so only admins and editors can change it.</div>}
      <ErrorAlert error={error} />
      <textarea className="code" rows={18} value={text} readOnly={!editable} onChange={(event) => setText(event.target.value)} />
      {showHistory && (
        <div style={{ marginTop: 14 }}>
          <RevisionHistory
            type="PROMPT"
            resourceId={master.data.id}
            restorePath={`/prompts/${master.data.id}/restore`}
            currentRevision={master.data.revision}
            canRestore={editable}
            onRestored={() => void queryClient.invalidateQueries({ queryKey: ['master-prompt'] })}
          />
        </div>
      )}
    </Card>
  );
};

type PromptForm = Pick<Prompt, 'name' | 'description' | 'text'>;

export const PromptsPage = () => {
  const queryClient = useQueryClient();
  const toast = useToast();
  const { isGuest, canModify } = useSession();
  const prompts = useQuery({ queryKey: ['prompts'], queryFn: () => api.get<Prompt[]>('/prompts') });
  const [editing, setEditing] = useState<Prompt | 'new' | null>(null);
  const [form, setForm] = useState<PromptForm>({ name: '', description: null, text: '' });
  const [error, setError] = useState<unknown>(null);
  const [showHistory, setShowHistory] = useState(false);

  const open = (prompt: Prompt | 'new') => {
    setEditing(prompt);
    setError(null);
    setShowHistory(false);
    setForm(prompt === 'new' ? { name: '', description: null, text: '' } : { name: prompt.name, description: prompt.description, text: prompt.text });
  };

  const save = async () => {
    setError(null);
    try {
      if (editing === 'new') {
        await api.post('/prompts', form);
      } else if (editing) {
        await api.put(`/prompts/${editing.id}`, { ...form, expectedRevision: editing.revision });
      }
      await queryClient.invalidateQueries({ queryKey: ['prompts'] });
      setEditing(null);
      toast('Domain prompt saved');
    } catch (caught) {
      setError(caught);
    }
  };

  const remove = async (prompt: Prompt) => {
    if (!confirmAction(`Delete "${prompt.name}"?`)) {
      return;
    }
    try {
      await api.del(`/prompts/${prompt.id}`);
      await queryClient.invalidateQueries({ queryKey: ['prompts'] });
    } catch (caught) {
      toast((caught as Error).message, 'error');
    }
  };

  const editable = editing === 'new' || (editing !== null && canModify(editing));

  return (
    <>
      <PageHeader title="Prompts" description="How the system prompt is assembled: master → domain → persona → language → knowledge → host context → user. Static parts come first so providers can cache them." />
      <MasterPromptCard />
      <Card
        title="Domain prompts"
        description="What an agent helps with: the subject, what is in and out of scope, example answers. Shared by any number of agents."
        actions={<button className="small primary" onClick={() => open('new')}>New domain prompt</button>}
      >
        {prompts.data?.length === 0 ? (
          <p className="muted">No domain prompts yet.</p>
        ) : (
          <table>
            <tbody>
              {prompts.data?.map((prompt) => (
                <tr key={prompt.id} className="clickable" onClick={() => open(prompt)}>
                  <td>
                    <strong>{prompt.name}</strong> <OwnedBadge show={isGuest && canModify(prompt)} />
                    {prompt.description && <div className="muted">{prompt.description}</div>}
                  </td>
                  <td className="muted">{prompt.text.length.toLocaleString()} chars</td>
                  <td className="muted">{formatDate(prompt.updatedAt)}</td>
                  <td style={{ textAlign: 'right' }}>
                    {canModify(prompt) && (
                      <button className="small danger" onClick={(event) => { event.stopPropagation(); void remove(prompt); }}>
                        Delete
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {editing && (
        <Modal
          title={editing === 'new' ? 'New domain prompt' : editable ? `Edit ${editing.name}` : editing.name}
          onClose={() => setEditing(null)}
          actions={
            <>
              {editing !== 'new' && <button onClick={() => setShowHistory(!showHistory)}>{showHistory ? 'Hide history' : 'History'}</button>}
              <button onClick={() => setEditing(null)}>{editable ? 'Cancel' : 'Close'}</button>
              {editable && (
                <button className="primary" onClick={() => void save()}>
                  Save
                </button>
              )}
            </>
          }
        >
          {!editable && <ReadOnlyNotice what="domain prompt" />}
          <ErrorAlert error={error} />
          <Field label="Name" error={fieldError(error, 'name')}>
            <input type="text" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
          </Field>
          <Field label="Description" hint="For your team; never sent to the model.">
            <input type="text" value={form.description ?? ''} onChange={(event) => setForm({ ...form, description: event.target.value || null })} />
          </Field>
          <Field label="Prompt" error={fieldError(error, 'text')}>
            <textarea className="code" rows={14} value={form.text} onChange={(event) => setForm({ ...form, text: event.target.value })} />
          </Field>
          {showHistory && editing !== 'new' && (
            <RevisionHistory
              type="PROMPT"
              resourceId={editing.id}
              restorePath={`/prompts/${editing.id}/restore`}
              currentRevision={editing.revision}
              canRestore={editable}
              onRestored={() => {
                void queryClient.invalidateQueries({ queryKey: ['prompts'] });
                setEditing(null);
              }}
            />
          )}
        </Modal>
      )}
    </>
  );
};

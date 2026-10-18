import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { RevisionHistory } from '../components/RevisionHistory';
import { confirmAction, ErrorAlert, Field, fieldError, Loading, Modal, OwnedBadge, PageHeader, ReadOnlyNotice, useToast } from '../components/ui';
import { api, Persona } from '../lib/api';
import { useSession } from '../lib/session';

type PersonaForm = Pick<Persona, 'name' | 'displayName' | 'avatarUrl' | 'tagline' | 'prompt'>;

const blank: PersonaForm = { name: '', displayName: '', avatarUrl: null, tagline: null, prompt: '' };

export const PersonasPage = () => {
  const queryClient = useQueryClient();
  const toast = useToast();
  const { isGuest, canModify } = useSession();
  const personas = useQuery({ queryKey: ['personas'], queryFn: () => api.get<Persona[]>('/personas') });
  const [editing, setEditing] = useState<Persona | 'new' | null>(null);
  const [form, setForm] = useState<PersonaForm>(blank);
  const [error, setError] = useState<unknown>(null);
  const [showHistory, setShowHistory] = useState(false);

  const open = (persona: Persona | 'new') => {
    setEditing(persona);
    setError(null);
    setShowHistory(false);
    setForm(persona === 'new' ? blank : { name: persona.name, displayName: persona.displayName, avatarUrl: persona.avatarUrl, tagline: persona.tagline, prompt: persona.prompt });
  };

  const save = async () => {
    setError(null);
    try {
      if (editing === 'new') {
        await api.post('/personas', form);
      } else if (editing) {
        await api.put(`/personas/${editing.id}`, { ...form, expectedRevision: editing.revision });
      }
      await queryClient.invalidateQueries({ queryKey: ['personas'] });
      setEditing(null);
      toast('Persona saved');
    } catch (caught) {
      setError(caught);
    }
  };

  const remove = async (persona: Persona) => {
    if (!confirmAction(`Delete persona "${persona.name}"?`)) {
      return;
    }
    try {
      await api.del(`/personas/${persona.id}`);
      await queryClient.invalidateQueries({ queryKey: ['personas'] });
    } catch (caught) {
      toast((caught as Error).message, 'error');
    }
  };

  const editable = editing === 'new' || (editing !== null && canModify(editing));

  return (
    <>
      <PageHeader
        title="Personas"
        description="Who an agent is: the name and avatar users see, and the persona prompt that sets its voice. One persona can serve many agents."
        actions={<button className="primary" onClick={() => open('new')}>New persona</button>}
      />
      {personas.isLoading ? (
        <Loading />
      ) : (
        <div className="card table-card">
          <table>
            <thead>
              <tr>
                <th>Persona</th>
                <th>Shown as</th>
                <th>Prompt</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {personas.data?.map((persona) => (
                <tr key={persona.id} className="clickable" onClick={() => open(persona)}>
                  <td>
                    <strong>{persona.name}</strong> <OwnedBadge show={isGuest && canModify(persona)} />
                  </td>
                  <td>
                    <div className="row">
                      {persona.avatarUrl && <img src={persona.avatarUrl} alt="" width={24} height={24} style={{ borderRadius: '50%' }} />}
                      {persona.displayName}
                    </div>
                    {persona.tagline && <div className="muted">{persona.tagline}</div>}
                  </td>
                  <td className="muted" style={{ maxWidth: 420 }}>
                    {persona.prompt.slice(0, 140)}
                    {persona.prompt.length > 140 ? '…' : ''}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    {canModify(persona) && (
                      <button className="small danger" onClick={(event) => { event.stopPropagation(); void remove(persona); }}>
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

      {editing && (
        <Modal
          title={editing === 'new' ? 'New persona' : editable ? `Edit ${editing.name}` : editing.name}
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
          {!editable && <ReadOnlyNotice what="persona" />}
          <ErrorAlert error={error} />
          <div className="grid-2">
            <Field label="Internal name" error={fieldError(error, 'name')}>
              <input type="text" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
            </Field>
            <Field label="Display name" hint="Shown to users in the chat header." error={fieldError(error, 'displayName')}>
              <input type="text" value={form.displayName} onChange={(event) => setForm({ ...form, displayName: event.target.value })} />
            </Field>
          </div>
          <div className="grid-2">
            <Field label="Avatar URL" error={fieldError(error, 'avatarUrl')}>
              <input type="url" value={form.avatarUrl ?? ''} onChange={(event) => setForm({ ...form, avatarUrl: event.target.value || null })} />
            </Field>
            <Field label="Tagline">
              <input type="text" value={form.tagline ?? ''} onChange={(event) => setForm({ ...form, tagline: event.target.value || null })} />
            </Field>
          </div>
          <Field label="Persona prompt" hint="Voice and character: tone, warmth, how formal, what it never does. The subject matter belongs in a domain prompt." error={fieldError(error, 'prompt')}>
            <textarea rows={10} value={form.prompt} onChange={(event) => setForm({ ...form, prompt: event.target.value })} />
          </Field>
          {showHistory && editing !== 'new' && (
            <RevisionHistory
              type="PERSONA"
              resourceId={editing.id}
              restorePath={`/personas/${editing.id}/restore`}
              currentRevision={editing.revision}
              canRestore={editable}
              onRestored={() => {
                void queryClient.invalidateQueries({ queryKey: ['personas'] });
                setEditing(null);
              }}
            />
          )}
        </Modal>
      )}
    </>
  );
};

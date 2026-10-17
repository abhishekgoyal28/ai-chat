import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, Persona, Prompt } from '../../lib/api';
import { Card, Field, fieldError } from '../ui';
import { TabProps } from './types';

export const GeneralTab = ({ draft, update, error }: TabProps) => {
  const personas = useQuery({ queryKey: ['personas'], queryFn: () => api.get<Persona[]>('/personas') });
  const prompts = useQuery({ queryKey: ['prompts'], queryFn: () => api.get<Prompt[]>('/prompts') });

  return (
    <>
      <Card title="Identity">
        <div className="grid-2">
          <Field label="Name" error={fieldError(error, 'name')}>
            <input type="text" value={draft.name} onChange={(event) => update({ name: event.target.value })} />
          </Field>
          <Field
            label="Slug"
            hint={<>Your backend passes this as <code>agent</code> in POST /v1/sessions.</>}
            error={fieldError(error, 'slug')}
          >
            <input type="text" className="mono" value={draft.slug} onChange={(event) => update({ slug: event.target.value.toLowerCase() })} />
          </Field>
        </div>
        <Field label="Description" hint="For your team; never shown to users or the model.">
          <input type="text" value={draft.description ?? ''} onChange={(event) => update({ description: event.target.value || null })} />
        </Field>
        <Field label="Status" hint="A disabled agent rejects new sessions; existing conversations stay readable.">
          <select value={draft.status} onChange={(event) => update({ status: event.target.value as 'ACTIVE' | 'DISABLED' })}>
            <option value="ACTIVE">Active</option>
            <option value="DISABLED">Disabled</option>
          </select>
        </Field>
      </Card>

      <Card title="Who it is and what it knows about" description="The persona is who the agent is; the domain prompt is the subject it helps with. Both can be shared by many agents.">
        <div className="grid-2">
          <Field label="Persona" hint={<Link to="/personas">Manage personas</Link>} error={fieldError(error, 'personaId')}>
            <select value={draft.personaId} onChange={(event) => update({ personaId: event.target.value })}>
              {!draft.personaId && <option value="">Choose a persona…</option>}
              {personas.data?.map((persona) => (
                <option key={persona.id} value={persona.id}>
                  {persona.name} ({persona.displayName})
                </option>
              ))}
            </select>
          </Field>
          <Field label="Domain prompt" hint={<Link to="/prompts">Manage prompts</Link>} error={fieldError(error, 'domainPromptId')}>
            <select value={draft.domainPromptId ?? ''} onChange={(event) => update({ domainPromptId: event.target.value || null })}>
              <option value="">None — the persona and master prompt only</option>
              {prompts.data?.map((prompt) => (
                <option key={prompt.id} value={prompt.id}>
                  {prompt.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </Card>
    </>
  );
};

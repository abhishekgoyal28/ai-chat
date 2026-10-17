import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, Provider } from '../../lib/api';
import { NumberInput } from '../inputs';
import { Card, Field, fieldError } from '../ui';
import { TabProps } from './types';

export const ModelTab = ({ draft, update, updateSettings, error }: TabProps) => {
  const providers = useQuery({ queryKey: ['providers'], queryFn: () => api.get<Provider[]>('/providers') });
  const routes = draft.modelRoutes;
  const { reply, history } = draft.settings;
  const totalWeight = routes.reduce((sum, route) => sum + route.weight, 0);

  const setRoute = (index: number, patch: Partial<(typeof routes)[number]>) =>
    update({ modelRoutes: routes.map((route, position) => (position === index ? { ...route, ...patch } : route)) });

  const addRoute = () => {
    const provider = providers.data?.[0];
    update({ modelRoutes: [...routes, { providerId: provider?.id ?? '', model: provider?.defaultModel ?? '', weight: routes.length === 0 ? 100 : 0 }] });
  };

  return (
    <>
      <Card
        title="Model routes"
        description="Each new conversation picks one route by weight and keeps it for its whole life, so a split is a clean A/B test. Weight 0 keeps a route configured but unused."
        actions={<button className="small" onClick={addRoute}>Add route</button>}
      >
        {providers.data?.length === 0 && (
          <div className="alert warn">
            No LLM providers yet. <Link to="/providers">Add one</Link> first.
          </div>
        )}
        {routes.length === 0 ? (
          <p className="muted">No route — this agent cannot reply until you add one.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Provider</th>
                <th>Model</th>
                <th style={{ width: 110 }}>Weight</th>
                <th style={{ width: 80 }}>Share</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {routes.map((route, index) => (
                <tr key={index}>
                  <td>
                    <select value={route.providerId} onChange={(event) => setRoute(index, { providerId: event.target.value })}>
                      <option value="">Choose…</option>
                      {providers.data?.map((provider) => (
                        <option key={provider.id} value={provider.id}>
                          {provider.name} ({provider.kind.toLowerCase()})
                        </option>
                      ))}
                    </select>
                    {fieldError(error, `modelRoutes.${index}.providerId`) && <span className="error">{fieldError(error, `modelRoutes.${index}.providerId`)}</span>}
                  </td>
                  <td>
                    <input type="text" className="mono" placeholder="e.g. gpt-4o-mini" value={route.model} onChange={(event) => setRoute(index, { model: event.target.value })} />
                  </td>
                  <td>
                    <NumberInput value={route.weight} min={0} max={100} onChange={(value) => setRoute(index, { weight: value ?? 0 })} />
                  </td>
                  <td className="mono muted">{totalWeight > 0 ? `${Math.round((route.weight / totalWeight) * 100)}%` : '—'}</td>
                  <td>
                    <button className="small danger" onClick={() => update({ modelRoutes: routes.filter((_, position) => position !== index) })}>
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card title="Replies">
        <div className="grid-2">
          <Field label="Max bubbles per reply" hint="An upper bound. The model is asked to use as few as the answer needs.">
            <NumberInput value={reply.maxParts} min={1} max={8} onChange={(value) => updateSettings('reply', { maxParts: value ?? 1 })} />
          </Field>
          <Field label="Max characters per bubble">
            <NumberInput value={reply.maxPartChars} min={40} max={4000} onChange={(value) => updateSettings('reply', { maxPartChars: value ?? 600 })} />
          </Field>
          <Field label="Temperature" hint="Empty uses the provider default. Some models ignore or reject it.">
            <NumberInput value={reply.temperature} min={0} max={2} step={0.1} nullable placeholder="provider default" onChange={(value) => updateSettings('reply', { temperature: value })} />
          </Field>
          <Field label="Max output tokens">
            <NumberInput value={reply.maxOutputTokens} min={64} max={32000} onChange={(value) => updateSettings('reply', { maxOutputTokens: value ?? 2048 })} />
          </Field>
          <Field label="Reasoning effort" hint="Read by reasoning-capable models only.">
            <select
              value={reply.reasoningEffort ?? ''}
              onChange={(event) => updateSettings('reply', { reasoningEffort: (event.target.value || null) as typeof reply.reasoningEffort })}
            >
              <option value="">Provider default</option>
              <option value="low">Low — fastest</option>
              <option value="medium">Medium</option>
              <option value="high">High — most thorough</option>
            </select>
          </Field>
          <Field label="History turns sent with each request" hint="A turn is one batch of user messages plus the reply.">
            <NumberInput value={history.turns} min={0} max={50} onChange={(value) => updateSettings('history', { turns: value ?? 0 })} />
          </Field>
        </div>
      </Card>
    </>
  );
};

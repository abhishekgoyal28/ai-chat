import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { Card, Empty, ErrorAlert, formatDate, Loading, PageHeader, StatusBadge } from '../components/ui';
import { Agent, api, Persona, Provider } from '../lib/api';

const describeSession = (agent: Agent): string => {
  const duration = agent.settings.session.durationSec;
  if (duration === null) {
    return 'never ends on its own';
  }
  return duration % 60 === 0 ? `${duration / 60} min` : `${duration} s`;
};

export const AgentsPage = () => {
  const navigate = useNavigate();
  const agents = useQuery({ queryKey: ['agents'], queryFn: () => api.get<Agent[]>('/agents') });
  const personas = useQuery({ queryKey: ['personas'], queryFn: () => api.get<Persona[]>('/personas') });
  const providers = useQuery({ queryKey: ['providers'], queryFn: () => api.get<Provider[]>('/providers') });

  const personaName = (id: string) => personas.data?.find((persona) => persona.id === id)?.displayName ?? `#${id}`;
  const providerName = (id: string) => providers.data?.find((provider) => provider.id === id)?.name ?? `#${id}`;

  return (
    <>
      <PageHeader
        title="Agents"
        description="An agent is what your product talks to: a persona, a domain prompt, model routes, knowledge and behaviour, under a stable slug your backend passes to POST /v1/sessions."
        actions={
          <Link to="/agents/new">
            <button className="primary">New agent</button>
          </Link>
        }
      />
      <ErrorAlert error={agents.error} />
      {agents.isLoading ? (
        <Loading />
      ) : agents.data?.length === 0 ? (
        <Card>
          <Empty title="No agents yet" action={<Link to="/agents/new"><button className="primary">Create your first agent</button></Link>}>
            Start with a persona (one is included) and a model route.
          </Empty>
        </Card>
      ) : (
        <div className="card table-card">
          <table>
            <thead>
              <tr>
                <th>Agent</th>
                <th>Persona</th>
                <th>Model</th>
                <th>Session</th>
                <th>Status</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {agents.data?.map((agent) => (
                <tr key={agent.id} className="clickable" onClick={() => navigate(`/agents/${agent.id}`)}>
                  <td>
                    <strong>{agent.name}</strong>
                    <div className="mono muted">{agent.slug}</div>
                  </td>
                  <td>{personaName(agent.personaId)}</td>
                  <td>
                    {agent.modelRoutes.length === 0 ? (
                      <span className="badge warn">no model</span>
                    ) : (
                      agent.modelRoutes.map((route) => (
                        <div key={`${route.providerId}-${route.model}`} className="mono">
                          {providerName(route.providerId)} · {route.model}
                          {agent.modelRoutes.length > 1 && <span className="muted"> ({route.weight})</span>}
                        </div>
                      ))
                    )}
                  </td>
                  <td>{describeSession(agent)}</td>
                  <td>
                    <StatusBadge status={agent.status} />
                  </td>
                  <td className="muted">{formatDate(agent.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
};

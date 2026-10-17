import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Card, confirmAction, Empty, ErrorAlert, Field, fieldError, Loading, Modal, PageHeader, StatusBadge, useToast } from '../components/ui';
import { api, PreviewResult, Provider, ProviderKind } from '../lib/api';
import { useSession } from '../lib/session';

const KIND_INFO: Record<ProviderKind, { label: string; credential: string | null; baseUrl: 'none' | 'optional' | 'required'; modelHint: string }> = {
  OPENAI: { label: 'OpenAI', credential: 'API key', baseUrl: 'optional', modelHint: 'e.g. gpt-4o-mini' },
  ANTHROPIC: { label: 'Anthropic (Claude)', credential: 'API key', baseUrl: 'optional', modelHint: 'e.g. claude-opus-5-5' },
  GEMINI: { label: 'Google Gemini (AI Studio key)', credential: 'API key', baseUrl: 'none', modelHint: 'e.g. gemini-2.5-flash' },
  VERTEX_AI: { label: 'Google Vertex AI', credential: 'Service-account JSON', baseUrl: 'none', modelHint: 'e.g. gemini-2.5-flash' },
  OPENAI_COMPATIBLE: { label: 'OpenAI-compatible (Ollama, vLLM, LM Studio, gateways)', credential: 'API key (optional)', baseUrl: 'required', modelHint: 'e.g. llama3.1:8b' },
  MOCK: { label: 'Mock (offline testing)', credential: null, baseUrl: 'none', modelHint: 'mock-1' },
};

interface ProviderForm {
  id?: string;
  revision?: number;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  credentials: string;
  credentialsSet: boolean;
  defaultModel: string;
  location: string;
  refusalFallback: boolean;
  status: 'ACTIVE' | 'DISABLED';
}

const blank = (kind: ProviderKind = 'OPENAI'): ProviderForm => ({
  name: '',
  kind,
  baseUrl: '',
  credentials: '',
  credentialsSet: false,
  defaultModel: '',
  location: 'global',
  refusalFallback: true,
  status: 'ACTIVE',
});

export const ProvidersPage = () => {
  const { isAdmin } = useSession();
  const toast = useToast();
  const queryClient = useQueryClient();
  const providers = useQuery({ queryKey: ['providers'], queryFn: () => api.get<Provider[]>('/providers') });
  const [form, setForm] = useState<ProviderForm | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<Record<string, PreviewResult | Error>>({});

  const open = (provider?: Provider) => {
    setError(null);
    setForm(
      provider
        ? {
            id: provider.id,
            revision: provider.revision,
            name: provider.name,
            kind: provider.kind,
            baseUrl: provider.baseUrl ?? '',
            credentials: '',
            credentialsSet: provider.credentialsSet,
            defaultModel: provider.defaultModel ?? '',
            location: provider.settings.location ?? 'global',
            refusalFallback: provider.settings.refusalFallback !== false,
            status: provider.status,
          }
        : blank(),
    );
  };

  const save = async () => {
    if (!form) {
      return;
    }
    setError(null);
    const settings = {
      ...(form.kind === 'VERTEX_AI' && { location: form.location || 'global' }),
      ...(form.kind === 'ANTHROPIC' && { refusalFallback: form.refusalFallback }),
    };
    const body = {
      name: form.name,
      kind: form.kind,
      baseUrl: form.baseUrl.trim() || null,
      defaultModel: form.defaultModel.trim() || null,
      settings,
      status: form.status,
      // Omitted keeps the stored credential; the field is write-only.
      ...(form.credentials.trim() && { credentials: form.credentials.trim() }),
    };
    try {
      if (form.id) {
        await api.put(`/providers/${form.id}`, { ...body, expectedRevision: form.revision });
      } else {
        await api.post('/providers', body);
      }
      await queryClient.invalidateQueries({ queryKey: ['providers'] });
      setForm(null);
      toast('Provider saved');
    } catch (caught) {
      setError(caught);
    }
  };

  const test = async (provider: Provider) => {
    setTesting(provider.id);
    try {
      const result = await api.post<PreviewResult>(`/providers/${provider.id}/test`, {});
      setTestResult((current) => ({ ...current, [provider.id]: result }));
    } catch (caught) {
      setTestResult((current) => ({ ...current, [provider.id]: caught as Error }));
    } finally {
      setTesting(null);
    }
  };

  const remove = async (provider: Provider) => {
    if (!confirmAction(`Delete provider "${provider.name}"?`)) {
      return;
    }
    try {
      await api.del(`/providers/${provider.id}`);
      await queryClient.invalidateQueries({ queryKey: ['providers'] });
    } catch (caught) {
      toast((caught as Error).message, 'error');
    }
  };

  const info = form ? KIND_INFO[form.kind] : null;

  return (
    <>
      <PageHeader
        title="LLM providers"
        description="Where replies are generated. Credentials are encrypted with ENCRYPTION_KEY and never shown again. Agents route to a provider + model on their Model tab."
        actions={isAdmin && <button className="primary" onClick={() => open()}>Add provider</button>}
      />
      {!isAdmin && <div className="alert">Only admins can add or change providers, because they hold credentials.</div>}
      {providers.isLoading ? (
        <Loading />
      ) : providers.data?.length === 0 ? (
        <Card>
          <Empty title="No providers yet" action={isAdmin && <button className="primary" onClick={() => open()}>Add your first provider</button>}>
            For a fully self-hosted install, run Ollama or vLLM and add it as OpenAI-compatible.
          </Empty>
        </Card>
      ) : (
        <div className="card table-card">
          <table>
            <thead>
              <tr>
                <th>Provider</th>
                <th>Default model</th>
                <th>Credentials</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {providers.data?.map((provider) => {
                const result = testResult[provider.id];
                return (
                  <tr key={provider.id}>
                    <td>
                      <strong>{provider.name}</strong>
                      <div className="muted">{KIND_INFO[provider.kind].label}</div>
                      {provider.baseUrl && <div className="mono muted">{provider.baseUrl}</div>}
                      {result && (
                        <div style={{ marginTop: 6 }}>
                          {result instanceof Error ? (
                            <span className="badge danger">{result.message}</span>
                          ) : result.status === 'SUCCESS' ? (
                            <span className="badge ok">
                              works · {result.meta?.model} · {result.meta?.latencyMs} ms
                            </span>
                          ) : (
                            <span className="badge danger">
                              {result.failureReason}: {result.errorMessage}
                            </span>
                          )}
                        </div>
                      )}
                    </td>
                    <td className="mono">{provider.defaultModel ?? '—'}</td>
                    <td className="mono muted">{provider.credentialsSet ? provider.credentialsHint : 'none'}</td>
                    <td>
                      <StatusBadge status={provider.status} />
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <div className="row" style={{ justifyContent: 'flex-end' }}>
                        <button className="small" disabled={testing === provider.id} onClick={() => void test(provider)}>
                          {testing === provider.id ? 'Testing…' : 'Test'}
                        </button>
                        {isAdmin && (
                          <>
                            <button className="small" onClick={() => open(provider)}>
                              Edit
                            </button>
                            <button className="small danger" onClick={() => void remove(provider)}>
                              Delete
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {form && info && (
        <Modal
          title={form.id ? `Edit ${form.name}` : 'Add LLM provider'}
          onClose={() => setForm(null)}
          actions={
            <>
              <button onClick={() => setForm(null)}>Cancel</button>
              <button className="primary" onClick={() => void save()}>
                Save
              </button>
            </>
          }
        >
          <ErrorAlert error={error} />
          <div className="grid-2">
            <Field label="Type">
              <select value={form.kind} disabled={Boolean(form.id)} onChange={(event) => setForm({ ...blank(event.target.value as ProviderKind), name: form.name })}>
                {(Object.keys(KIND_INFO) as ProviderKind[]).map((kind) => (
                  <option key={kind} value={kind}>
                    {KIND_INFO[kind].label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Name" error={fieldError(error, 'name')}>
              <input type="text" placeholder="e.g. OpenAI production" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
            </Field>
          </div>
          {info.baseUrl !== 'none' && (
            <Field
              label={`Base URL${info.baseUrl === 'optional' ? ' (optional)' : ''}`}
              hint={form.kind === 'OPENAI_COMPATIBLE' ? 'Include /v1 — e.g. http://ollama:11434/v1 or http://vllm:8000/v1' : 'Only for a proxy or gateway in front of the official API.'}
              error={fieldError(error, 'baseUrl')}
            >
              <input type="url" className="mono" value={form.baseUrl} onChange={(event) => setForm({ ...form, baseUrl: event.target.value })} />
            </Field>
          )}
          {info.credential && (
            <Field label={info.credential} hint={form.credentialsSet ? 'A credential is stored. Leave empty to keep it.' : undefined}>
              {form.kind === 'VERTEX_AI' ? (
                <textarea className="code" rows={6} placeholder='{"type": "service_account", ...}' value={form.credentials} onChange={(event) => setForm({ ...form, credentials: event.target.value })} />
              ) : (
                <input type="password" className="mono" autoComplete="off" value={form.credentials} onChange={(event) => setForm({ ...form, credentials: event.target.value })} />
              )}
            </Field>
          )}
          <div className="grid-2">
            <Field label="Default model" hint={info.modelHint}>
              <input type="text" className="mono" value={form.defaultModel} onChange={(event) => setForm({ ...form, defaultModel: event.target.value })} />
            </Field>
            <Field label="Status">
              <select value={form.status} onChange={(event) => setForm({ ...form, status: event.target.value as ProviderForm['status'] })}>
                <option value="ACTIVE">Active</option>
                <option value="DISABLED">Disabled</option>
              </select>
            </Field>
          </div>
          {form.kind === 'VERTEX_AI' && (
            <Field label="Location" hint='"global" or a region such as us-central1.'>
              <input type="text" value={form.location} onChange={(event) => setForm({ ...form, location: event.target.value })} />
            </Field>
          )}
          {form.kind === 'ANTHROPIC' && (
            <label className="check">
              <input type="checkbox" checked={form.refusalFallback} onChange={(event) => setForm({ ...form, refusalFallback: event.target.checked })} />
              Retry declined requests on a fallback model (server-side, official API only)
            </label>
          )}
        </Modal>
      )}
    </>
  );
};

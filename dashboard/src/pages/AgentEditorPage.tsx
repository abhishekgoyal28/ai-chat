import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ActionsTab } from '../components/agent/ActionsTab';
import { ClientTab } from '../components/agent/ClientTab';
import { ConversationTab } from '../components/agent/ConversationTab';
import { GeneralTab } from '../components/agent/GeneralTab';
import { KnowledgeTab } from '../components/agent/KnowledgeTab';
import { ModelTab } from '../components/agent/ModelTab';
import { PlaygroundTab } from '../components/agent/PlaygroundTab';
import { TestChatTab } from '../components/agent/TestChatTab';
import { AgentDraft, TabProps } from '../components/agent/types';
import { RevisionHistory } from '../components/RevisionHistory';
import { confirmAction, ErrorAlert, Loading, PageHeader, ReadOnlyNotice, StatusBadge, Tabs, useToast } from '../components/ui';
import { Agent, AgentSettings, api, Persona } from '../lib/api';
import { useSession } from '../lib/session';

type TabId = 'general' | 'conversation' | 'model' | 'knowledge' | 'actions' | 'client' | 'playground' | 'test' | 'history';

const TABS: Array<{ id: TabId; label: string; savedOnly?: boolean }> = [
  { id: 'general', label: 'General' },
  { id: 'conversation', label: 'Conversation' },
  { id: 'model', label: 'Model' },
  { id: 'knowledge', label: 'Knowledge' },
  { id: 'actions', label: 'Actions' },
  { id: 'client', label: 'Client & pacing' },
  { id: 'playground', label: 'Playground' },
  { id: 'test', label: 'Test chat', savedOnly: true },
  { id: 'history', label: 'History', savedOnly: true },
];

const toDraft = (agent: Agent): AgentDraft => ({
  slug: agent.slug,
  name: agent.name,
  description: agent.description,
  status: agent.status,
  personaId: agent.personaId,
  domainPromptId: agent.domainPromptId,
  modelRoutes: agent.modelRoutes,
  settings: agent.settings,
});

export const AgentEditorPage = () => {
  const { id } = useParams<{ id: string }>();
  const isNew = !id;
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { meta, canModify } = useSession();
  const [tab, setTab] = useState<TabId>('general');
  const [draft, setDraft] = useState<AgentDraft | null>(null);
  const [saved, setSaved] = useState<string>('');
  const [error, setError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);

  const agent = useQuery({ queryKey: ['agent', id], queryFn: () => api.get<Agent>(`/agents/${id}`), enabled: !isNew });
  const personas = useQuery({ queryKey: ['personas'], queryFn: () => api.get<Persona[]>('/personas'), enabled: isNew });

  useEffect(() => {
    if (agent.data) {
      const next = toDraft(agent.data);
      setDraft(next);
      setSaved(JSON.stringify(next));
    }
  }, [agent.data]);

  useEffect(() => {
    if (isNew && meta && personas.data && !draft) {
      setDraft({
        slug: '',
        name: '',
        description: null,
        status: 'ACTIVE',
        personaId: personas.data[0]?.id ?? '',
        domainPromptId: null,
        modelRoutes: [],
        settings: meta.agentSettingsDefaults,
      });
    }
  }, [isNew, meta, personas.data, draft]);

  const dirty = useMemo(() => draft !== null && JSON.stringify(draft) !== saved, [draft, saved]);

  if ((!isNew && agent.isLoading) || !draft) {
    return agent.error ? <ErrorAlert error={agent.error} /> : <Loading />;
  }

  const update: TabProps['update'] = (patch) => setDraft((current) => (current ? { ...current, ...patch } : current));
  const updateSettings: TabProps['updateSettings'] = (section, patch) =>
    setDraft((current) => {
      if (!current) {
        return current;
      }
      const value = Array.isArray(patch) ? patch : { ...(current.settings[section] as object), ...(patch as object) };
      return { ...current, settings: { ...current.settings, [section]: value } as AgentSettings };
    });

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      if (isNew) {
        const created = await api.post<Agent>('/agents', draft);
        toast('Agent created');
        await queryClient.invalidateQueries({ queryKey: ['agents'] });
        navigate(`/agents/${created.id}`, { replace: true });
      } else {
        const updated = await api.put<Agent>(`/agents/${id}`, { ...draft, expectedRevision: agent.data?.revision });
        queryClient.setQueryData(['agent', id], updated);
        await queryClient.invalidateQueries({ queryKey: ['agents'] });
        toast('Saved — live for new turns within a few seconds');
      }
    } catch (caught) {
      setError(caught);
      toast((caught as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!confirmAction('Delete this agent? Only agents without conversations can be deleted — disable it otherwise.')) {
      return;
    }
    try {
      await api.del(`/agents/${id}`);
      await queryClient.invalidateQueries({ queryKey: ['agents'] });
      navigate('/agents');
    } catch (caught) {
      toast((caught as Error).message, 'error');
    }
  };

  const editable = isNew || (agent.data !== undefined && canModify(agent.data));
  const tabProps: TabProps = { draft, update, updateSettings, error };
  const visibleTabs = TABS.filter((entry) => !entry.savedOnly || !isNew);

  return (
    <>
      <PageHeader
        crumbs={<Link to="/agents">Agents</Link>}
        title={isNew ? 'New agent' : draft.name || 'Agent'}
        description={
          !isNew && (
            <span className="row">
              <code>{draft.slug}</code> <StatusBadge status={draft.status} /> <span className="muted">revision {agent.data?.revision}</span>
            </span>
          )
        }
        actions={
          <>
            {!isNew && editable && (
              <button className="danger" onClick={() => void remove()}>
                Delete
              </button>
            )}
            {editable && (
              <button className="primary" disabled={saving || (!isNew && !dirty)} onClick={() => void save()}>
                {saving ? 'Saving…' : isNew ? 'Create agent' : dirty ? 'Save changes' : 'Saved'}
              </button>
            )}
          </>
        }
      />
      {!editable && <ReadOnlyNotice what="agent" />}
      <ErrorAlert error={error} />
      <Tabs tabs={visibleTabs} active={tab} onChange={setTab} />
      {tab === 'general' && <GeneralTab {...tabProps} />}
      {tab === 'conversation' && <ConversationTab {...tabProps} />}
      {tab === 'model' && <ModelTab {...tabProps} />}
      {tab === 'knowledge' && <KnowledgeTab {...tabProps} />}
      {tab === 'actions' && <ActionsTab {...tabProps} />}
      {tab === 'client' && <ClientTab {...tabProps} />}
      {tab === 'playground' && <PlaygroundTab draft={draft} agentId={id ?? null} />}
      {tab === 'test' && agent.data && <TestChatTab agentSlug={agent.data.slug} dirty={dirty} />}
      {tab === 'history' && agent.data && (
        <RevisionHistory
          type="AGENT"
          resourceId={agent.data.id}
          restorePath={`/agents/${agent.data.id}/restore`}
          currentRevision={agent.data.revision}
          canRestore={editable}
          onRestored={() => void queryClient.invalidateQueries({ queryKey: ['agent', id] })}
        />
      )}
    </>
  );
};

import { useQueryClient } from '@tanstack/react-query';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { api } from './lib/api';
import { useSession } from './lib/session';
import { Loading } from './components/ui';
import { GuideChat } from './components/GuideChat';
import { AccountPage } from './pages/AccountPage';
import { AgentEditorPage } from './pages/AgentEditorPage';
import { AgentsPage } from './pages/AgentsPage';
import { ApiKeysPage } from './pages/ApiKeysPage';
import { ConversationDetailPage } from './pages/ConversationDetailPage';
import { ConversationsPage } from './pages/ConversationsPage';
import { KnowledgeBasePage } from './pages/KnowledgeBasePage';
import { KnowledgePage } from './pages/KnowledgePage';
import { LoginPage } from './pages/LoginPage';
import { OverviewPage } from './pages/OverviewPage';
import { PersonasPage } from './pages/PersonasPage';
import { PromptsPage } from './pages/PromptsPage';
import { ProvidersPage } from './pages/ProvidersPage';
import { SettingsPage } from './pages/SettingsPage';
import { TeamPage } from './pages/TeamPage';
import { ArchitecturePage } from './pages/ArchitecturePage';

const nav = [
  { section: 'Build', links: [['/agents', 'Agents'], ['/personas', 'Personas'], ['/prompts', 'Prompts'], ['/knowledge', 'Knowledge']] },
  { section: 'Operate', links: [['/conversations', 'Conversations'], ['/providers', 'LLM providers']] },
  { section: 'Learn', links: [['/architecture', 'Architecture']] },
  { section: 'Platform', links: [['/api-keys', 'API keys'], ['/team', 'Team'], ['/settings', 'Settings']], adminOnly: true },
] as const;

export const App = () => {
  const { me, loading, isAdmin, meta } = useSession();
  const queryClient = useQueryClient();

  if (loading) {
    return <Loading />;
  }
  if (!me) {
    return <LoginPage />;
  }

  const signOut = async () => {
    await api.post('/auth/logout');
    queryClient.clear();
    queryClient.setQueryData(['me'], null);
  };

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">◆</span> ai-chat
        </div>
        <NavLink to="/" end className="nav-link">
          Overview
        </NavLink>
        {nav
          .filter((group) => !('adminOnly' in group) || isAdmin)
          .map((group) => (
            <div key={group.section}>
              <div className="nav-section">{group.section}</div>
              {group.links.map(([to, label]) => (
                <NavLink key={to} to={to} className="nav-link">
                  {label}
                </NavLink>
              ))}
            </div>
          ))}
        <div className="sidebar-footer">
          <div style={{ color: 'var(--ink)' }}>{me.name}</div>
          <div>{me.email}</div>
          <div className="row" style={{ marginTop: 8 }}>
            <NavLink to="/account">Account</NavLink>
            <a href="#" onClick={(event) => { event.preventDefault(); void signOut(); }}>
              Sign out
            </a>
          </div>
          {meta && <div style={{ marginTop: 8 }}>v{meta.version}</div>}
        </div>
      </aside>
      <main className="main">
        <Routes>
          <Route path="/" element={<OverviewPage />} />
          <Route path="/agents" element={<AgentsPage />} />
          <Route path="/agents/new" element={<AgentEditorPage />} />
          <Route path="/agents/:id" element={<AgentEditorPage />} />
          <Route path="/personas" element={<PersonasPage />} />
          <Route path="/prompts" element={<PromptsPage />} />
          <Route path="/knowledge" element={<KnowledgePage />} />
          <Route path="/knowledge/:id" element={<KnowledgeBasePage />} />
          <Route path="/conversations" element={<ConversationsPage />} />
          <Route path="/conversations/:id" element={<ConversationDetailPage />} />
          <Route path="/providers" element={<ProvidersPage />} />
          <Route path="/account" element={<AccountPage />} />
          {isAdmin && <Route path="/api-keys" element={<ApiKeysPage />} />}
          {isAdmin && <Route path="/team" element={<TeamPage />} />}
          {isAdmin && <Route path="/settings" element={<SettingsPage />} />}
          <Route path="/architecture" element={<ArchitecturePage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
      <GuideChat />
    </div>
  );
};

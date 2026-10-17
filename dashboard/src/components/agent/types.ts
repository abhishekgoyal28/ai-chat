import type { AgentSettings, ModelRoute } from '../../lib/api';

/** The editable part of an agent — what POST/PUT /agents accept. */
export interface AgentDraft {
  slug: string;
  name: string;
  description: string | null;
  status: 'ACTIVE' | 'DISABLED';
  personaId: string;
  domainPromptId: string | null;
  modelRoutes: ModelRoute[];
  settings: AgentSettings;
}

export interface TabProps {
  draft: AgentDraft;
  update: (patch: Partial<AgentDraft>) => void;
  /** Merges into an object section; replaces an array section (actions). */
  updateSettings: <K extends keyof AgentSettings>(section: K, patch: Partial<AgentSettings[K]> | AgentSettings[K]) => void;
  error: unknown;
}

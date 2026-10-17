import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, KnowledgeBase } from '../../lib/api';
import { NumberInput } from '../inputs';
import { Card, Field, formatNumber } from '../ui';
import { TabProps } from './types';

export const KnowledgeTab = ({ draft, updateSettings }: TabProps) => {
  const bases = useQuery({ queryKey: ['knowledge-bases'], queryFn: () => api.get<KnowledgeBase[]>('/knowledge-bases') });
  const { knowledge } = draft.settings;
  const selected = new Set(knowledge.knowledgeBaseIds);
  const selectedChars = (bases.data ?? []).filter((base) => selected.has(base.id)).reduce((sum, base) => sum + (base.chars ?? 0), 0);

  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    updateSettings('knowledge', { knowledgeBaseIds: [...next] });
  };

  return (
    <>
      <Card
        title="Knowledge bases"
        description="Reference material placed into the prompt in document order, within the budget below. Good for FAQs, policies, product docs, manuals and guides."
        actions={<Link to="/knowledge">Manage knowledge</Link>}
      >
        {bases.data?.length === 0 ? (
          <p className="muted">No knowledge bases yet.</p>
        ) : (
          bases.data?.map((base) => (
            <label key={base.id} className="check" style={{ marginBottom: 8 }}>
              <input type="checkbox" checked={selected.has(base.id)} onChange={() => toggle(base.id)} />
              {base.name}
              <span className="hint" style={{ margin: 0 }}>
                {formatNumber(base.documents)} documents · {formatNumber(base.chars)} characters
              </span>
            </label>
          ))
        )}
        {selected.size > 0 && selectedChars > knowledge.maxTotalChars && (
          <div className="alert warn" style={{ marginTop: 12 }}>
            The selected bases hold {formatNumber(selectedChars)} characters but the budget is {formatNumber(knowledge.maxTotalChars)}. Documents later in order will be cut.
          </div>
        )}
      </Card>
      <Card title="Budget" description="Roughly 4 characters per token. Knowledge is static per agent, so providers with prompt caching charge full price only on the first turn of a conversation.">
        <div className="grid-2">
          <Field label="Max characters per document">
            <NumberInput value={knowledge.maxCharsPerDocument} min={500} onChange={(value) => updateSettings('knowledge', { maxCharsPerDocument: value ?? 20000 })} />
          </Field>
          <Field label="Max characters in total">
            <NumberInput value={knowledge.maxTotalChars} min={1000} onChange={(value) => updateSettings('knowledge', { maxTotalChars: value ?? 80000 })} />
          </Field>
        </div>
      </Card>
    </>
  );
};

import { GenerationKind, HistoryRole } from '../../shared/contracts/generation.contract';
import { parseAgentSettings } from '../../shared/domain/agent-settings';
import { LlmRole } from '../llm/llm-client';
import { PromptBuilder, PromptInputs } from './prompt-builder';

const baseInputs = (overrides: Partial<PromptInputs> = {}): PromptInputs => ({
  kind: GenerationKind.REPLY,
  agentName: 'Support',
  settings: parseAgentSettings({}),
  personaDisplayName: 'Ava',
  personaPrompt: 'Friendly and concise.',
  domainPromptText: 'You help with billing questions.',
  masterPromptText: 'MASTER at most {{MAX_REPLY_PARTS}} parts of {{MAX_PART_CHARS}} chars {{UNKNOWN}}',
  knowledge: [],
  user: { externalUserId: 'u1', name: 'Sam', attributes: { plan: 'pro' } },
  context: { title: 'Invoice 42', text: 'The user is looking at an overdue invoice.' },
  history: [],
  userMessages: [{ id: '1', body: 'Why was I charged twice?' }],
  availableActions: [],
  ...overrides,
});

describe('PromptBuilder', () => {
  const builder = new PromptBuilder();

  it('orders sections most-static first, so the provider cache prefix is as long as possible', () => {
    const { systemPrompt } = builder.build(baseInputs({ knowledge: [{ title: 'FAQ', content: 'x'.repeat(400) }] }));
    const order = ['MASTER', 'DOMAIN:', 'PERSONA:', 'LANGUAGE:', 'KNOWLEDGE', 'CONTEXT', 'USER'].map((marker) => systemPrompt.indexOf(marker));
    expect(order.every((position) => position >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('fills limits into the master prompt and leaves unknown placeholders visible', () => {
    const { systemPrompt } = builder.build(baseInputs());
    expect(systemPrompt).toContain('at most 4 parts of 600 chars {{UNKNOWN}}');
  });

  it('respects the knowledge budget and reports what was left out', () => {
    const settings = parseAgentSettings({ knowledge: { maxCharsPerDocument: 1000, maxTotalChars: 1500 } });
    const built = builder.build(
      baseInputs({
        settings,
        knowledge: [
          { title: 'A', content: 'a'.repeat(1200) },
          { title: 'B', content: 'b'.repeat(1200) },
          { title: 'C', content: 'c'.repeat(1200) },
        ],
      }),
    );
    // A: 1000 of 1200 chars. B: the remaining 500. C: nothing left above the minimum useful size.
    expect(built.knowledgeDocumentsUsed).toBe(2);
    expect(built.systemPrompt).toContain('[document truncated here]');
    expect(built.systemPrompt).toContain('[1 further document did not fit here.]');
  });

  it('describes actions only on reply turns', () => {
    const action = { name: 'create_ticket', description: 'When the user asks for a human.', parameters: [], maxPerConversation: 1, enabled: true };
    expect(builder.build(baseInputs({ availableActions: [action] })).systemPrompt).toContain('ACTIONS');
    const greeting = builder.build(baseInputs({ kind: GenerationKind.GREETING, availableActions: [action], userMessages: [] }));
    expect(greeting.systemPrompt).not.toContain('ACTIONS');
    expect(greeting.output.actions).toEqual([]);
  });

  it('starts the conversation with the user and quotes reply targets', () => {
    const built = builder.build(
      baseInputs({
        history: [
          { role: HistoryRole.AGENT, body: 'Hi Sam!' },
          { role: HistoryRole.USER, body: 'hello' },
        ],
        userMessages: [{ id: '9', body: 'this one', replyTo: { role: HistoryRole.AGENT, body: 'Hi Sam!' } }],
      }),
    );
    expect(built.conversation[0].role).toBe(LlmRole.USER);
    expect(built.conversation[built.conversation.length - 1].content).toContain('[Replying to your earlier message: "Hi Sam!"]');
  });

  it('gives farewell turns the end reason and a synthetic user turn', () => {
    const built = builder.build(baseInputs({ kind: GenerationKind.FAREWELL, userMessages: [], endReason: 'TIMER_EXPIRED' }));
    expect(built.systemPrompt).toContain('The session time is up.');
    expect(built.conversation[built.conversation.length - 1].content).toContain('closing message');
  });
});

import { LlmMalformedError, OutputSpec } from './llm-client';
import { buildReplyJsonSchema, normaliseParts, parseStructuredReply } from './structured-reply';

const spec: OutputSpec = { maxParts: 3, maxPartChars: 50, maxChipChars: 40, actions: [] };

describe('buildReplyJsonSchema', () => {
  it('asks only for parts on an ordinary turn', () => {
    const schema = buildReplyJsonSchema(spec) as { required: string[]; properties: Record<string, unknown> };
    expect(schema.required).toEqual(['parts']);
    expect(Object.keys(schema.properties)).toEqual(['parts']);
  });

  it('adds chips and an action enum that always allows "none"', () => {
    const schema = buildReplyJsonSchema({ ...spec, chipCount: 2, actions: [{ name: 'create_ticket', parameterNames: ['summary'] }] }) as {
      required: string[];
      properties: { action: { properties: { name: { enum: string[] } } } };
    };
    expect(schema.required).toEqual(['parts', 'chips', 'action']);
    expect(schema.properties.action.properties.name.enum).toEqual(['none', 'create_ticket']);
  });
});

describe('parseStructuredReply', () => {
  it('reads parts, trimming blanks', () => {
    expect(parseStructuredReply('{"parts":["Hi there", "  ", "Second"]}', spec).parts).toEqual(['Hi there', 'Second']);
  });

  it('extracts JSON wrapped in prose or code fences', () => {
    const raw = 'Sure! ```json\n{"parts":["Wrapped"]}\n```';
    expect(parseStructuredReply(raw, spec).parts).toEqual(['Wrapped']);
  });

  it('accepts plain text from a model that ignored the format', () => {
    expect(parseStructuredReply('Just a plain answer.', spec).parts).toEqual(['Just a plain answer.']);
  });

  it('rejects an empty reply and a reply without parts', () => {
    expect(() => parseStructuredReply('   ', spec)).toThrow(LlmMalformedError);
    expect(() => parseStructuredReply('{"parts":[]}', spec)).toThrow(LlmMalformedError);
  });

  it('keeps only offered actions and declared parameters', () => {
    const withAction = { ...spec, actions: [{ name: 'create_ticket', parameterNames: ['summary'] }] };
    const parsed = parseStructuredReply(
      JSON.stringify({ parts: ['ok'], action: { name: 'create_ticket', arguments: [{ name: 'summary', value: 'login' }, { name: 'injected', value: 'x' }] } }),
      withAction,
    );
    expect(parsed.action).toEqual({ name: 'create_ticket', arguments: { summary: 'login' } });
    expect(parseStructuredReply(JSON.stringify({ parts: ['ok'], action: { name: 'none', arguments: [] } }), withAction).action).toBeNull();
    expect(parseStructuredReply(JSON.stringify({ parts: ['ok'], action: { name: 'delete_all', arguments: [] } }), withAction).action).toBeNull();
  });
});

describe('normaliseParts', () => {
  it('splits an over-long part on a sentence boundary instead of truncating', () => {
    const parts = normaliseParts(['First sentence is here. Second sentence follows it nicely.'], { maxParts: 5, maxPartChars: 30 });
    expect(parts.every((part) => part.length <= 30)).toBe(true);
    expect(parts.join(' ')).toContain('Second sentence');
  });

  it('merges overflow into the last allowed part rather than dropping it', () => {
    const parts = normaliseParts(['a', 'b', 'c', 'd'], { maxParts: 2, maxPartChars: 100 });
    expect(parts).toEqual(['a', 'b c d']);
  });
});

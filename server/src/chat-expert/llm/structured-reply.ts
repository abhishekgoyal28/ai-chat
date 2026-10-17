import { LlmMalformedError, OutputSpec } from './llm-client';

/**
 * The structured reply every provider is asked for, and the one parser that
 * reads it back.
 *
 * The schema deliberately avoids `anyOf`, `null` and length keywords: those
 * are where providers' JSON-schema subsets disagree. "No action" is the enum
 * value `none` rather than a null object, and part counts and lengths are
 * enforced here in code, where they cannot be ignored.
 */

export const NO_ACTION = 'none';

export const buildReplyJsonSchema = (spec: OutputSpec): Record<string, unknown> => {
  const properties: Record<string, unknown> = {
    parts: {
      type: 'array',
      description: `The reply as chat bubbles, in order. Normally ONE bubble; more only when the answer has genuinely separate beats. At most ${spec.maxParts} bubbles of at most ${spec.maxPartChars} characters each.`,
      items: { type: 'string' },
    },
  };
  const required = ['parts'];

  if (spec.chipCount) {
    properties.chips = {
      type: 'array',
      description: `Exactly ${spec.chipCount} short suggestions written in the USER's voice — things the user is likely to ask next, each at most ${spec.maxChipChars} characters.`,
      items: { type: 'string' },
    };
    required.push('chips');
  }

  if (spec.actions.length > 0) {
    properties.action = {
      type: 'object',
      description: `An action to run alongside the reply. Use "${NO_ACTION}" unless the ACTIONS section says this exact turn triggers one.`,
      additionalProperties: false,
      required: ['name', 'arguments'],
      properties: {
        name: { type: 'string', enum: [NO_ACTION, ...spec.actions.map((action) => action.name)] },
        arguments: {
          type: 'array',
          description: 'The action parameters as name/value pairs. Empty when name is "none".',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['name', 'value'],
            properties: { name: { type: 'string' }, value: { type: 'string' } },
          },
        },
      },
    };
    required.push('action');
  }

  return { type: 'object', additionalProperties: false, required, properties };
};

const toStrings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.trim()).filter(Boolean)
    : [];

/**
 * Splits an over-long part on a sentence or word boundary instead of
 * truncating it: a provider that ignores the length rule still delivers the
 * whole answer.
 */
const splitLongPart = (part: string, maxChars: number): string[] => {
  const chunks: string[] = [];
  let remaining = part;
  while (remaining.length > maxChars) {
    const window = remaining.slice(0, maxChars);
    const sentenceEnd = Math.max(window.lastIndexOf('. '), window.lastIndexOf('? '), window.lastIndexOf('! '));
    const cut = sentenceEnd > maxChars * 0.5 ? sentenceEnd + 1 : window.lastIndexOf(' ') > maxChars * 0.5 ? window.lastIndexOf(' ') : maxChars;
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) {
    chunks.push(remaining);
  }
  return chunks;
};

/** Enforces the part limits: overflow parts are merged into the last allowed one, never dropped. */
export const normaliseParts = (parts: string[], spec: Pick<OutputSpec, 'maxParts' | 'maxPartChars'>): string[] => {
  const split = parts.flatMap((part) => splitLongPart(part, spec.maxPartChars));
  if (split.length <= spec.maxParts) {
    return split;
  }
  const kept = split.slice(0, spec.maxParts - 1);
  kept.push(split.slice(spec.maxParts - 1).join(' '));
  return kept;
};

/**
 * Pulls a JSON object out of text. Local models without schema-constrained
 * decoding often wrap their JSON in prose or markdown fences.
 */
const extractJsonObject = (raw: string): unknown => {
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start === -1 || end <= start) {
      return undefined;
    }
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return undefined;
    }
  }
};

export interface ParsedReply {
  parts: string[];
  chips?: string[];
  action: { name: string; arguments: Record<string, string> } | null;
}

/**
 * Reads a structured reply. When the text is not JSON at all but is a usable
 * plain answer, it is accepted as the reply — a small self-hosted model that
 * ignores the format should still produce a conversation, not an error.
 */
export const parseStructuredReply = (raw: string, spec: OutputSpec): ParsedReply => {
  const parsed = extractJsonObject(raw) as { parts?: unknown; chips?: unknown; action?: unknown } | undefined;

  if (!parsed || typeof parsed !== 'object') {
    const plain = raw.trim();
    if (!plain) {
      throw new LlmMalformedError('the model returned an empty reply');
    }
    return { parts: normaliseParts([plain], spec), action: null };
  }

  const parts = toStrings(parsed.parts);
  if (parts.length === 0) {
    throw new LlmMalformedError('the model reply contained no usable parts');
  }

  return {
    parts: normaliseParts(parts, spec),
    ...(spec.chipCount ? { chips: toStrings(parsed.chips).slice(0, spec.chipCount) } : {}),
    action: parseAction(parsed.action, spec),
  };
};

const parseAction = (raw: unknown, spec: OutputSpec): ParsedReply['action'] => {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const candidate = raw as { name?: unknown; arguments?: unknown };
  const definition = spec.actions.find((action) => action.name === candidate.name);
  if (!definition) {
    return null;
  }
  const args: Record<string, string> = {};
  if (Array.isArray(candidate.arguments)) {
    for (const entry of candidate.arguments) {
      const pair = entry as { name?: unknown; value?: unknown };
      if (typeof pair?.name === 'string' && definition.parameterNames.includes(pair.name) && typeof pair.value === 'string') {
        args[pair.name] = pair.value.slice(0, 2000);
      }
    }
  }
  return { name: definition.name, arguments: args };
};

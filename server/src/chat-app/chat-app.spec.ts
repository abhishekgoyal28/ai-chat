import { pickModelRoute } from './agents/agent-runtime.service';
import { sanitizeChips } from './conversation/serializers/message.serializer';
import { renderTemplate } from './conversation/services/greeting.service';
import { computeRevealOffsets } from './conversation/services/reveal-scheduler.service';
import { truncateForNotification } from './integrations/push.service';
import { normaliseDocumentText } from './admin/services/knowledge-admin.service';

describe('renderTemplate', () => {
  const vars = { userName: 'Sam', agentName: 'Ava', contextTitle: 'Invoice 42' };

  it('fills variables', () => {
    expect(renderTemplate('Hi {{user.name}}, I am {{agent.name}}. About {{context.title}}?', vars)).toBe('Hi Sam, I am Ava. About Invoice 42?');
  });

  it('removes a missing variable and the punctuation it leaves behind', () => {
    expect(renderTemplate('Hi {{user.name}}! How can I help?', { ...vars, userName: null })).toBe('Hi! How can I help?');
    expect(renderTemplate('{{user.name}}, welcome back', { ...vars, userName: '  ' })).toBe('Welcome back');
  });

  it('leaves unknown placeholders untouched', () => {
    expect(renderTemplate('Hello {{order.id}}', vars)).toBe('Hello {{order.id}}');
  });
});

describe('computeRevealOffsets', () => {
  it('reveals part 0 at once and paces later parts by length, capped', () => {
    expect(computeRevealOffsets(['a', 'xxxx', 'y'.repeat(1000)], { enabled: true, msPerChar: 10, maxDelayMs: 500 })).toEqual([0, 40, 540]);
  });

  it('collapses to zero when pacing is off', () => {
    expect(computeRevealOffsets(['a', 'b'], { enabled: false, msPerChar: 10, maxDelayMs: 500 })).toEqual([0, 0]);
  });
});

describe('pickModelRoute', () => {
  const routes = [
    { providerId: '1', model: 'a', weight: 75 },
    { providerId: '2', model: 'b', weight: 25 },
    { providerId: '3', model: 'c', weight: 0 },
  ];

  it('splits traffic by weight and never picks a zero-weight route', () => {
    expect(pickModelRoute(routes, () => 0.1)?.model).toBe('a');
    expect(pickModelRoute(routes, () => 0.9)?.model).toBe('b');
    expect(pickModelRoute(routes, () => 0.999999)?.model).toBe('b');
  });

  it('falls back to the first route when every weight is zero, and to null with none', () => {
    expect(pickModelRoute([{ providerId: '3', model: 'c', weight: 0 }])?.model).toBe('c');
    expect(pickModelRoute([])).toBeNull();
  });
});

describe('small helpers', () => {
  it('sanitizes chips: trims, dedupes, drops blanks and over-long entries', () => {
    expect(sanitizeChips([' A ', 'A', '', 42, 'x'.repeat(50), 'B'], 5, 40)).toEqual([
      { id: 1, text: 'A' },
      { id: 2, text: 'B' },
    ]);
  });

  it('truncates notifications on a word boundary', () => {
    expect(truncateForNotification('one two three four five', 14)).toBe('one two three…');
    expect(truncateForNotification('short', 14)).toBe('short');
  });

  it('normalises document text', () => {
    expect(normaliseDocumentText('a  \r\nb\u0000\n\n\n\n\nc  ')).toBe('a\nb\n\n\nc');
  });
});

import { LinesInput, NumberInput } from '../inputs';
import { Card, Field, fieldError } from '../ui';
import { TabProps } from './types';

export const ConversationTab = ({ draft, updateSettings, error }: TabProps) => {
  const { session, greeting, chips, farewell, language } = draft.settings;
  const timed = session.durationSec !== null;

  return (
    <>
      <Card
        title="Session length"
        description="The timer starts when the session opens and is never paused. A session that has not ended continues where it left off when reopened; an ended session reopens read-only."
      >
        <label className="check" style={{ marginBottom: 12 }}>
          <input type="radio" checked={!timed} onChange={() => updateSettings('session', { durationSec: null })} /> Never ends on its own
          <span className="hint" style={{ margin: 0 }}>— until the user, your backend or an operator ends it</span>
        </label>
        <label className="check" style={{ marginBottom: 12 }}>
          <input type="radio" checked={timed} onChange={() => updateSettings('session', { durationSec: session.durationSec ?? 600 })} /> Ends after a fixed time
        </label>
        {timed && (
          <Field label="Duration (seconds)" hint={`${Math.round((session.durationSec ?? 0) / 60)} minutes. Minimum 30 seconds.`} error={fieldError(error, 'settings.session.durationSec')}>
            <NumberInput value={session.durationSec} min={30} onChange={(value) => updateSettings('session', { durationSec: value ?? 30 })} />
          </Field>
        )}
      </Card>

      <Card title="Opening message">
        <Field label="Mode">
          <select value={greeting.mode} onChange={(event) => updateSettings('greeting', { mode: event.target.value as typeof greeting.mode })}>
            <option value="TEMPLATE">Template — instant, fixed text</option>
            <option value="LLM">Written by the model — tailored, arrives a moment later</option>
            <option value="NONE">None — the user speaks first</option>
          </select>
        </Field>
        {greeting.mode === 'TEMPLATE' && (
          <Field label="Template" hint={<>Variables: <code>{'{{user.name}}'}</code> <code>{'{{agent.name}}'}</code> <code>{'{{context.title}}'}</code>. Missing values are removed cleanly.</>}>
            <textarea rows={3} style={{ minHeight: 0 }} value={greeting.template} onChange={(event) => updateSettings('greeting', { template: event.target.value })} />
          </Field>
        )}
        {greeting.mode === 'LLM' && (
          <Field label="Instructions for the opening" hint="Falls back to the template if generation fails.">
            <textarea rows={3} style={{ minHeight: 0 }} value={greeting.instructions} onChange={(event) => updateSettings('greeting', { instructions: event.target.value })} />
          </Field>
        )}
      </Card>

      <Card title="Suggestions" description="Tap-to-send prompts shown under the opening message until the user writes something.">
        <div className="grid-2">
          <Field label="Source">
            <select value={chips.source} onChange={(event) => updateSettings('chips', { source: event.target.value as typeof chips.source })}>
              <option value="NONE">None</option>
              <option value="STATIC">Fixed list</option>
              <option value="LLM">Generated with the opening message (needs the model opening)</option>
            </select>
          </Field>
          <Field label="How many to show">
            <NumberInput value={chips.count} min={1} max={8} onChange={(value) => updateSettings('chips', { count: value ?? 3 })} />
          </Field>
        </div>
        {chips.source !== 'NONE' && (
          <Field label={chips.source === 'LLM' ? 'Fallback list' : 'Suggestions'} hint="One per line, at most 80 characters each.">
            <LinesInput value={chips.items} onChange={(items) => updateSettings('chips', { items })} placeholder={'What can you help me with?\nHow does pricing work?'} />
          </Field>
        )}
      </Card>

      <Card title="Closing message" description="Posted when the session ends — by its timer, the user, your backend or an operator.">
        <Field label="Mode">
          <select value={farewell.mode} onChange={(event) => updateSettings('farewell', { mode: event.target.value as typeof farewell.mode })}>
            <option value="LLM">Written by the model from the conversation</option>
            <option value="FIXED">Fixed text</option>
            <option value="NONE">None</option>
          </select>
        </Field>
        {farewell.mode === 'LLM' && (
          <Field label="Instructions for the goodbye">
            <textarea rows={3} style={{ minHeight: 0 }} value={farewell.instructions} onChange={(event) => updateSettings('farewell', { instructions: event.target.value })} />
          </Field>
        )}
        {farewell.mode !== 'NONE' && (
          <Field label={farewell.mode === 'LLM' ? 'Fallback text' : 'Closing text'} hint={farewell.mode === 'LLM' ? 'Used if generation fails or takes too long.' : undefined}>
            <textarea rows={2} style={{ minHeight: 0 }} value={farewell.fallbackText} onChange={(event) => updateSettings('farewell', { fallbackText: event.target.value })} />
          </Field>
        )}
        <Field label="Divider text" hint="The system line clients show where the conversation ended.">
          <input type="text" value={farewell.dividerText} onChange={(event) => updateSettings('farewell', { dividerText: event.target.value })} />
        </Field>
      </Card>

      <Card title="Language">
        <Field label="Instruction to the model" hint='E.g. "Always reply in Spanish." or "Reply in the same language the user writes in."'>
          <input type="text" value={language.instruction} onChange={(event) => updateSettings('language', { instruction: event.target.value })} />
        </Field>
      </Card>
    </>
  );
};

import { NumberInput } from '../inputs';
import { Card, Field } from '../ui';
import { TabProps } from './types';

export const ClientTab = ({ draft, updateSettings }: TabProps) => {
  const { client, pacing } = draft.settings;
  return (
    <>
      <Card
        title="Message batching"
        description="People often type a thought in several quick messages. The client SDK collects them into one turn so the agent answers once, with the whole thought."
      >
        <div className="grid-2">
          <Field label="Quiet period (ms)" hint="Wait this long after the last message before sending.">
            <NumberInput value={client.debounceMs} min={0} max={30000} onChange={(value) => updateSettings('client', { debounceMs: value ?? 0 })} />
          </Field>
          <Field label="Extra hold while typing (ms)">
            <NumberInput value={client.typingHoldMs} min={0} max={60000} onChange={(value) => updateSettings('client', { typingHoldMs: value ?? 0 })} />
          </Field>
          <Field label="Never wait longer than (ms)">
            <NumberInput value={client.maxTurnWaitMs} min={0} max={120000} onChange={(value) => updateSettings('client', { maxTurnWaitMs: value ?? 0 })} />
          </Field>
          <Field label="Max messages per turn">
            <NumberInput value={client.maxMessagesPerTurn} min={1} max={20} onChange={(value) => updateSettings('client', { maxMessagesPerTurn: value ?? 1 })} />
          </Field>
          <Field label="Max characters per message" hint="Enforced by the socket and again by chat-app.">
            <NumberInput value={client.maxBodyChars} min={1} max={8000} onChange={(value) => updateSettings('client', { maxBodyChars: value ?? 2000 })} />
          </Field>
        </div>
      </Card>
      <Card title="Reply pacing" description="Multi-bubble replies are revealed one at a time, like someone typing, instead of all at once.">
        <label className="check" style={{ marginBottom: 12 }}>
          <input type="checkbox" checked={pacing.enabled} onChange={(event) => updateSettings('pacing', { enabled: event.target.checked })} /> Pace multi-bubble replies
        </label>
        {pacing.enabled && (
          <div className="grid-2">
            <Field label="Milliseconds per character">
              <NumberInput value={pacing.msPerChar} min={0} max={200} onChange={(value) => updateSettings('pacing', { msPerChar: value ?? 0 })} />
            </Field>
            <Field label="Max delay between bubbles (ms)">
              <NumberInput value={pacing.maxDelayMs} min={0} max={10000} onChange={(value) => updateSettings('pacing', { maxDelayMs: value ?? 0 })} />
            </Field>
          </div>
        )}
      </Card>
    </>
  );
};

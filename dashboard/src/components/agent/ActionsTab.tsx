import { Link } from 'react-router-dom';
import { AgentAction } from '../../lib/api';
import { useSession } from '../../lib/session';
import { NumberInput } from '../inputs';
import { Card, Empty, Field } from '../ui';
import { TabProps } from './types';

const blankAction = (): AgentAction => ({
  name: 'create_ticket',
  description: 'Create a support ticket when the user explicitly asks to talk to a human or the issue cannot be solved in chat.',
  parameters: [{ name: 'summary', description: 'One sentence describing the issue', required: true }],
  maxPerConversation: 1,
  enabled: true,
});

export const ActionsTab = ({ draft, updateSettings }: TabProps) => {
  const { isAdmin } = useSession();
  const actions = draft.settings.actions;
  const setActions = (next: AgentAction[]) => updateSettings('actions', next);
  const setAction = (index: number, patch: Partial<AgentAction>) => setActions(actions.map((action, position) => (position === index ? { ...action, ...patch } : action)));

  return (
    <>
      <div className="alert">
        When the model triggers an action, ai-chat sends an <code>action.invoked</code> webhook to your backend with the arguments, and your backend does the work.
        Actions are only offered to the model while a webhook URL is set{isAdmin ? <> in <Link to="/settings">Settings</Link></> : ' in Settings'}.
      </div>
      {actions.length === 0 ? (
        <Card>
          <Empty title="No actions" action={<button className="primary" onClick={() => setActions([blankAction()])}>Add an action</button>}>
            Examples: create a ticket, hand off to a human, book a call, look up an order.
          </Empty>
        </Card>
      ) : (
        <>
          {actions.map((action, index) => (
            <Card
              key={index}
              title={action.name || 'Unnamed action'}
              actions={
                <div className="row">
                  <label className="check">
                    <input type="checkbox" checked={action.enabled} onChange={(event) => setAction(index, { enabled: event.target.checked })} /> Enabled
                  </label>
                  <button className="small danger" onClick={() => setActions(actions.filter((_, position) => position !== index))}>
                    Remove
                  </button>
                </div>
              }
            >
              <div className="grid-2">
                <Field label="Name" hint="lower_snake_case — the name your webhook receives.">
                  <input type="text" className="mono" value={action.name} onChange={(event) => setAction(index, { name: event.target.value })} />
                </Field>
                <Field label="Max per conversation" hint="Empty for unlimited.">
                  <NumberInput value={action.maxPerConversation} min={1} max={100} nullable onChange={(value) => setAction(index, { maxPerConversation: value })} />
                </Field>
              </div>
              <Field label="When to trigger it" hint="Told to the model verbatim. Be precise about the trigger, and say what to tell the user.">
                <textarea rows={3} style={{ minHeight: 0 }} value={action.description} onChange={(event) => setAction(index, { description: event.target.value })} />
              </Field>
              <Field label="Parameters">
                <div className="stack" style={{ gap: 8 }}>
                  {action.parameters.map((parameter, parameterIndex) => (
                    <div key={parameterIndex} className="row" style={{ flexWrap: 'nowrap' }}>
                      <input
                        type="text"
                        className="mono"
                        style={{ width: 180 }}
                        placeholder="name"
                        value={parameter.name}
                        onChange={(event) =>
                          setAction(index, { parameters: action.parameters.map((p, i) => (i === parameterIndex ? { ...p, name: event.target.value } : p)) })
                        }
                      />
                      <input
                        type="text"
                        placeholder="what the model should put here"
                        value={parameter.description}
                        onChange={(event) =>
                          setAction(index, { parameters: action.parameters.map((p, i) => (i === parameterIndex ? { ...p, description: event.target.value } : p)) })
                        }
                      />
                      <label className="check">
                        <input
                          type="checkbox"
                          checked={parameter.required}
                          onChange={(event) =>
                            setAction(index, { parameters: action.parameters.map((p, i) => (i === parameterIndex ? { ...p, required: event.target.checked } : p)) })
                          }
                        />
                        required
                      </label>
                      <button className="small" onClick={() => setAction(index, { parameters: action.parameters.filter((_, i) => i !== parameterIndex) })}>
                        ✕
                      </button>
                    </div>
                  ))}
                  <div>
                    <button className="small" onClick={() => setAction(index, { parameters: [...action.parameters, { name: '', description: '', required: true }] })}>
                      Add parameter
                    </button>
                  </div>
                </div>
              </Field>
            </Card>
          ))}
          <button onClick={() => setActions([...actions, { ...blankAction(), name: '' }])}>Add another action</button>
        </>
      )}
    </>
  );
};

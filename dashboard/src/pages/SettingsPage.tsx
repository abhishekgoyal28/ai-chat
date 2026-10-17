import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { NumberInput } from '../components/inputs';
import { Card, ErrorAlert, Field, Loading, PageHeader, useToast } from '../components/ui';
import { api } from '../lib/api';
import { useSession } from '../lib/session';

interface Settings {
  webhooks: { url: string | null; events: string[]; secretSet: boolean };
  push: { mode: 'NONE' | 'WEBHOOK' | 'FCM'; titleTemplate: string; fcmServiceAccountSet: boolean };
  retention: { endedConversationDays: number | null };
}

const EVENT_HELP: Record<string, string> = {
  'session.started': 'A conversation was created.',
  'session.ended': 'A conversation ended (timer, user, host or operator).',
  'action.invoked': 'The model triggered one of an agent’s actions — your backend performs it.',
  'message.undelivered': 'A reply was revealed while the user was offline (push mode “webhook”).',
};

export const SettingsPage = () => {
  const toast = useToast();
  const { meta } = useSession();
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api.get<Settings>('/settings') });
  const [webhookUrl, setWebhookUrl] = useState('');
  const [secret, setSecret] = useState('');
  const [events, setEvents] = useState<string[]>([]);
  const [pushMode, setPushMode] = useState<Settings['push']['mode']>('NONE');
  const [titleTemplate, setTitleTemplate] = useState('{{agent.name}}');
  const [fcmJson, setFcmJson] = useState('');
  const [retentionDays, setRetentionDays] = useState<number | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [testResult, setTestResult] = useState<string | null>(null);

  useEffect(() => {
    if (settings.data) {
      setWebhookUrl(settings.data.webhooks.url ?? '');
      setEvents(settings.data.webhooks.events);
      setPushMode(settings.data.push.mode);
      setTitleTemplate(settings.data.push.titleTemplate);
      setRetentionDays(settings.data.retention.endedConversationDays);
    }
  }, [settings.data]);

  if (!settings.data) {
    return settings.isLoading ? <Loading /> : <ErrorAlert error={settings.error} />;
  }

  const run = async (save: () => Promise<unknown>, message: string) => {
    setError(null);
    try {
      await save();
      await queryClient.invalidateQueries({ queryKey: ['settings'] });
      toast(message);
    } catch (caught) {
      setError(caught);
    }
  };

  const saveWebhooks = () =>
    run(
      () => api.put('/settings/webhooks', { url: webhookUrl.trim() || null, events, ...(secret && { secret }) }),
      'Webhook settings saved',
    ).then(() => setSecret(''));

  const testWebhook = async () => {
    const result = await api.post<{ delivered: boolean; status: number | null; error: string | null }>('/settings/webhooks/test');
    setTestResult(result.delivered ? `Delivered (HTTP ${result.status})` : `Failed: ${result.error}`);
  };

  return (
    <>
      <PageHeader title="Settings" description="Platform-wide settings. Secrets are encrypted at rest and never shown again after saving." />
      <ErrorAlert error={error} />

      <Card
        title="Webhooks"
        description={
          <>
            Events are POSTed to your backend as JSON and retried with backoff. Verify them with the <code>AIC-Signature</code> header: <code>t=&lt;unix&gt;,v1=HMAC_SHA256(secret, "&lt;t&gt;.&lt;body&gt;")</code>.
          </>
        }
      >
        <Field label="Endpoint URL">
          <input type="url" placeholder="https://api.yourproduct.com/ai-chat/webhooks" value={webhookUrl} onChange={(event) => setWebhookUrl(event.target.value)} />
        </Field>
        <Field label="Signing secret" hint={settings.data.webhooks.secretSet ? 'A secret is set. Enter a new one to rotate it.' : 'At least 16 characters. Strongly recommended.'}>
          <input type="password" autoComplete="off" value={secret} onChange={(event) => setSecret(event.target.value)} />
        </Field>
        <Field label="Events">
          <div className="stack" style={{ gap: 6 }}>
            {(meta?.webhookEvents ?? Object.keys(EVENT_HELP)).map((event) => (
              <label key={event} className="check">
                <input type="checkbox" checked={events.includes(event)} onChange={(change) => setEvents(change.target.checked ? [...events, event] : events.filter((item) => item !== event))} />
                <code>{event}</code>
                <span className="hint" style={{ margin: 0 }}>{EVENT_HELP[event]}</span>
              </label>
            ))}
          </div>
        </Field>
        <div className="row">
          <button className="primary" onClick={() => void saveWebhooks()}>
            Save webhooks
          </button>
          <button disabled={!settings.data.webhooks.url} onClick={() => void testWebhook()}>
            Send test event
          </button>
          {testResult && <span className="muted">{testResult}</span>}
        </div>
      </Card>

      <Card title="Offline delivery" description="What happens when a reply is revealed while nobody is connected to the conversation.">
        <Field label="Mode">
          <select value={pushMode} onChange={(event) => setPushMode(event.target.value as Settings['push']['mode'])}>
            <option value="NONE">Nothing — the user sees it next time they open the chat</option>
            <option value="WEBHOOK">Webhook — send message.undelivered; your backend sends its own notification</option>
            <option value="FCM">Firebase Cloud Messaging — data message to devices registered via PUT /v1/users/:id/devices</option>
          </select>
        </Field>
        {pushMode === 'FCM' && (
          <>
            <Field label="Notification title" hint="{{agent.name}} is replaced with the persona's display name.">
              <input type="text" value={titleTemplate} onChange={(event) => setTitleTemplate(event.target.value)} />
            </Field>
            <Field label="Firebase service-account JSON" hint={settings.data.push.fcmServiceAccountSet ? 'A service account is stored. Paste a new one to replace it.' : undefined}>
              <textarea className="code" rows={5} value={fcmJson} onChange={(event) => setFcmJson(event.target.value)} />
            </Field>
          </>
        )}
        <button
          className="primary"
          onClick={() =>
            void run(() => api.put('/settings/push', { mode: pushMode, titleTemplate, ...(fcmJson.trim() && { fcmServiceAccount: fcmJson.trim() }) }), 'Delivery settings saved').then(() => setFcmJson(''))
          }
        >
          Save delivery settings
        </button>
      </Card>

      <Card title="Data retention" description="Ended conversations older than this are deleted hourly, messages included. Empty keeps everything. Erase one user on request with DELETE /v1/users/:id.">
        <Field label="Delete ended conversations after (days)">
          <NumberInput value={retentionDays} nullable min={1} max={3650} placeholder="keep forever" onChange={setRetentionDays} />
        </Field>
        <button className="primary" onClick={() => void run(() => api.put('/settings/retention', { endedConversationDays: retentionDays }), 'Retention saved')}>
          Save retention
        </button>
      </Card>
    </>
  );
};

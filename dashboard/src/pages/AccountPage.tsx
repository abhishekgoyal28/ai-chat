import { FormEvent, useState } from 'react';
import { Card, ErrorAlert, Field, PageHeader, useToast } from '../components/ui';
import { api } from '../lib/api';
import { useSession } from '../lib/session';

export const AccountPage = () => {
  const { me } = useSession();
  const toast = useToast();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [error, setError] = useState<unknown>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    try {
      await api.post('/auth/password', { currentPassword, newPassword });
      setCurrentPassword('');
      setNewPassword('');
      toast('Password changed');
    } catch (caught) {
      setError(caught);
    }
  };

  return (
    <>
      <PageHeader title="Account" description={`${me?.name} · ${me?.email} · ${me?.role.toLowerCase()}`} />
      <Card title="Change password">
        <form onSubmit={submit} style={{ maxWidth: 420 }}>
          <ErrorAlert error={error} />
          <Field label="Current password">
            <input type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} required />
          </Field>
          <Field label="New password" hint="At least 10 characters.">
            <input type="password" autoComplete="new-password" minLength={10} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} required />
          </Field>
          <button className="primary" type="submit">
            Change password
          </button>
        </form>
      </Card>
    </>
  );
};

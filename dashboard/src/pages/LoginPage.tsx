import { FormEvent, useState } from 'react';
import { ErrorAlert, Field } from '../components/ui';
import { api } from '../lib/api';
import { useSession } from '../lib/session';

export const LoginPage = () => {
  const { refresh } = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/auth/login', { email, password });
      await refresh();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-page">
      <form className="card login-card" onSubmit={submit}>
        <div className="brand" style={{ paddingLeft: 0 }}>
          <span className="brand-mark">◆</span> ai-chat
        </div>
        <h2 style={{ marginBottom: 16 }}>Sign in to the dashboard</h2>
        <ErrorAlert error={error} />
        <Field label="Email">
          <input type="email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} required autoFocus />
        </Field>
        <Field label="Password" hint="The first admin is created from ADMIN_EMAIL and ADMIN_PASSWORD on first start.">
          <input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required />
        </Field>
        <button className="primary" type="submit" disabled={busy} style={{ width: '100%', justifyContent: 'center' }}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
};

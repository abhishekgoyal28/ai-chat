import { useQuery } from '@tanstack/react-query';
import { FormEvent, useState } from 'react';
import { ErrorAlert, Field } from '../components/ui';
import { api } from '../lib/api';
import { useSession } from '../lib/session';

const GOOGLE_SIGN_IN_PATH = '/admin/api/auth/google';
const SIGN_IN_ERROR_PARAM = 'signInError';

/** A failed Google sign-in comes back as ?signInError=…; read it once and tidy the address bar. */
const takeRedirectError = (): string | null => {
  const params = new URLSearchParams(window.location.search);
  const message = params.get(SIGN_IN_ERROR_PARAM);
  if (message) {
    params.delete(SIGN_IN_ERROR_PARAM);
    const query = params.toString();
    window.history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`);
  }
  return message;
};

export const LoginPage = () => {
  const { refresh } = useSession();
  const providers = useQuery({ queryKey: ['auth-providers'], queryFn: () => api.get<{ google: boolean }>('/auth/providers'), staleTime: Infinity });
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(() => takeRedirectError());
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
        {providers.data?.google && (
          <>
            <a className="button google-sign-in" href={GOOGLE_SIGN_IN_PATH}>
              Continue with Google
            </a>
            <p className="hint" style={{ margin: '8px 0 0' }}>
              New here? Signing in with Google creates a guest account: explore everything and build your own agents.
            </p>
            <div className="login-divider">or with email</div>
          </>
        )}
        <Field label="Email">
          <input type="email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} required autoFocus={!providers.data?.google} />
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

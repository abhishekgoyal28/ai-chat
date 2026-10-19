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
              <svg className="google-sign-in-mark" width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
                <path d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.875 2.684-6.615z" fill="#4285F4" />
                <path d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z" fill="#34A853" />
                <path d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z" fill="#FBBC05" />
                <path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z" fill="#EA4335" />
              </svg>
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
        <Field label="Password">
          <input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required />
        </Field>
        <button className="primary" type="submit" disabled={busy} style={{ width: '100%', justifyContent: 'center' }}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
};

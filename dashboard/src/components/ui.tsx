import { createContext, ReactNode, useCallback, useContext, useEffect, useState } from 'react';
import { ApiError } from '../lib/api';

export const PageHeader = ({ title, description, crumbs, actions }: { title: string; description?: ReactNode; crumbs?: ReactNode; actions?: ReactNode }) => (
  <div className="page-header">
    <div>
      {crumbs && <div className="crumbs">{crumbs}</div>}
      <h1>{title}</h1>
      {description && <p>{description}</p>}
    </div>
    {actions && <div className="row">{actions}</div>}
  </div>
);

export const Card = ({ title, description, children, actions }: { title?: string; description?: ReactNode; children: ReactNode; actions?: ReactNode }) => (
  <section className="card">
    {(title || actions) && (
      <div className="spread" style={{ marginBottom: description ? 0 : 14 }}>
        {title && <h2>{title}</h2>}
        {actions}
      </div>
    )}
    {description && <p className="hint" style={{ marginBottom: 14 }}>{description}</p>}
    {children}
  </section>
);

export const Field = ({ label, hint, error, children }: { label: string; hint?: ReactNode; error?: string; children: ReactNode }) => (
  <div className="field">
    <label>{label}</label>
    {children}
    {error ? <span className="error">{error}</span> : hint ? <span className="hint">{hint}</span> : null}
  </div>
);

export const Badge = ({ tone, children }: { tone?: 'ok' | 'warn' | 'danger' | 'accent'; children: ReactNode }) => (
  <span className={`badge ${tone ?? ''}`}>{children}</span>
);

export const StatusBadge = ({ status }: { status: string }) => (
  <Badge tone={status === 'ACTIVE' ? 'ok' : status === 'ENDED' || status === 'DISABLED' ? undefined : status === 'FAILED' ? 'danger' : 'accent'}>
    {status.toLowerCase()}
  </Badge>
);

export const Empty = ({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) => (
  <div className="empty">
    <h3>{title}</h3>
    {children && <p>{children}</p>}
    {action}
  </div>
);

export const Loading = () => <div className="empty">Loading…</div>;

export const ErrorAlert = ({ error }: { error: unknown }) =>
  error ? <div className="alert danger">{error instanceof Error ? error.message : String(error)}</div> : null;

export const Tabs = <T extends string>({ tabs, active, onChange }: { tabs: Array<{ id: T; label: string }>; active: T; onChange: (id: T) => void }) => (
  <div className="tabs" role="tablist">
    {tabs.map((tab) => (
      <button key={tab.id} role="tab" className={`tab ${tab.id === active ? 'active' : ''}`} onClick={() => onChange(tab.id)}>
        {tab.label}
      </button>
    ))}
  </div>
);

export const Modal = ({ title, onClose, children, actions }: { title: string; onClose: () => void; children: ReactNode; actions?: ReactNode }) => {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <h2>{title}</h2>
        {children}
        {actions && <div className="modal-actions">{actions}</div>}
      </div>
    </div>
  );
};

/** Field errors from a 400 response, keyed by field path. */
export const fieldError = (error: unknown, path: string): string | undefined =>
  error instanceof ApiError ? error.issues[path] : undefined;

export const formatDate = (value: string | null | undefined): string =>
  value ? new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—';

export const formatNumber = (value: number | null | undefined): string => (value === null || value === undefined ? '—' : value.toLocaleString());

// --- toasts -----------------------------------------------------------------

interface Toast {
  id: number;
  message: string;
  tone: 'info' | 'error';
}

const ToastContext = createContext<(message: string, tone?: 'info' | 'error') => void>(() => undefined);

export const ToastProvider = ({ children }: { children: ReactNode }) => {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((message: string, tone: 'info' | 'error' = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((current) => [...current, { id, message, tone }]);
    setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== id)), 4000);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast ${toast.tone === 'error' ? 'error' : ''}`}>
            {toast.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
};

export const useToast = () => useContext(ToastContext);

/** Asks once, natively — destructive actions only. */
export const confirmAction = (message: string): boolean => window.confirm(message);

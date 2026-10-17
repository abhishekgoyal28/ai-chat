import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, ReactNode, useContext, useEffect } from 'react';
import { api, Me, Meta } from './api';

interface SessionContextValue {
  me: Me | null;
  meta: Meta | undefined;
  loading: boolean;
  isAdmin: boolean;
  refresh: () => Promise<void>;
}

const SessionContext = createContext<SessionContextValue>({ me: null, meta: undefined, loading: true, isAdmin: false, refresh: async () => undefined });

export const SessionProvider = ({ children }: { children: ReactNode }) => {
  const queryClient = useQueryClient();
  const me = useQuery({ queryKey: ['me'], queryFn: () => api.get<Me>('/auth/me'), retry: false });
  const meta = useQuery({ queryKey: ['meta'], queryFn: () => api.get<Meta>('/meta'), enabled: Boolean(me.data), staleTime: Infinity });

  useEffect(() => {
    const onSignedOut = () => queryClient.setQueryData(['me'], null);
    window.addEventListener('aic:signed-out', onSignedOut);
    return () => window.removeEventListener('aic:signed-out', onSignedOut);
  }, [queryClient]);

  const value: SessionContextValue = {
    me: me.data ?? null,
    meta: meta.data,
    loading: me.isLoading,
    isAdmin: me.data?.role === 'ADMIN',
    refresh: async () => {
      await queryClient.invalidateQueries({ queryKey: ['me'] });
    },
  };
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
};

export const useSession = () => useContext(SessionContext);

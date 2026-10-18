import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, Revision } from '../lib/api';
import { Card, confirmAction, formatDate, Loading, useToast } from './ui';

/**
 * Every saved change, newest first. Restoring saves the old snapshot as a NEW
 * revision, so history is never rewritten and a restore can itself be undone.
 */
export const RevisionHistory = ({
  type,
  resourceId,
  restorePath,
  currentRevision,
  onRestored,
  canRestore = true,
}: {
  type: 'AGENT' | 'PERSONA' | 'PROMPT';
  resourceId: string;
  restorePath: string;
  currentRevision: number;
  onRestored: () => void;
  canRestore?: boolean;
}) => {
  const toast = useToast();
  const [open, setOpen] = useState<number | null>(null);
  const revisions = useQuery({ queryKey: ['revisions', type, resourceId, currentRevision], queryFn: () => api.get<Revision[]>(`/revisions/${type}/${resourceId}`) });

  const restore = async (revision: number) => {
    if (!confirmAction(`Restore revision ${revision}? It is saved as a new revision.`)) {
      return;
    }
    try {
      await api.post(restorePath, { revision });
      toast(`Revision ${revision} restored`);
      onRestored();
    } catch (error) {
      toast((error as Error).message, 'error');
    }
  };

  if (revisions.isLoading) {
    return <Loading />;
  }
  return (
    <Card title="History" description="Replies record which revision produced them, so a change in reply quality can be traced to the edit that caused it.">
      <table>
        <thead>
          <tr>
            <th>Revision</th>
            <th>Saved</th>
            <th>By</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {revisions.data?.map((revision) => (
            <tr key={revision.id}>
              <td className="mono">
                #{revision.revision} {revision.revision === currentRevision && <span className="badge accent">current</span>}
                {open === revision.revision && (
                  <pre className="block" style={{ marginTop: 8 }}>
                    {JSON.stringify(revision.snapshot, null, 2)}
                  </pre>
                )}
              </td>
              <td className="muted">{formatDate(revision.createdAt)}</td>
              <td>{revision.changedBy ?? '—'}</td>
              <td style={{ textAlign: 'right' }}>
                <div className="row" style={{ justifyContent: 'flex-end' }}>
                  <button className="small" onClick={() => setOpen(open === revision.revision ? null : revision.revision)}>
                    {open === revision.revision ? 'Hide' : 'View'}
                  </button>
                  {canRestore && revision.revision !== currentRevision && (
                    <button className="small" onClick={() => void restore(revision.revision)}>
                      Restore
                    </button>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
};

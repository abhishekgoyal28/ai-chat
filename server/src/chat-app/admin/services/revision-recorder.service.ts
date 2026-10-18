import { Injectable } from '@nestjs/common';
import { ConfigRevision } from '../../../shared/database/entities';
import { AdminRole, ConfigResourceType } from '../../../shared/domain/enums';
import { NotFoundError } from '../../../shared/errors/app-errors';
import { AdminPrincipal } from '../../auth/admin-auth.service';
import { ConfigRevisionRepository } from '../repositories/config.repositories';

const ANOTHER_MEMBER = 'another member';

/**
 * Every configuration change writes the full post-change row (secrets
 * excluded) to config_revisions. The dashboard's History tab reads it, and
 * restoring a revision is saving its snapshot again — as a new revision, so
 * history is never rewritten.
 */
@Injectable()
export class RevisionRecorder {
  constructor(private readonly revisions: ConfigRevisionRepository) {}

  record(type: ConfigResourceType, id: string, revision: number, snapshot: Record<string, unknown>, by: AdminPrincipal | null): Promise<void> {
    return this.revisions.record(type, id, revision, snapshot, by?.email ?? null);
  }

  /** Guests share a workspace with strangers, so they see their own email in history but not anyone else's. */
  async list(type: ConfigResourceType, id: string, viewer: AdminPrincipal): Promise<ConfigRevision[]> {
    const rows = await this.revisions.list(type, id, 100);
    if (viewer.role !== AdminRole.GUEST) {
      return rows;
    }
    return rows.map((row) => (row.changedBy === null || row.changedBy === viewer.email ? row : { ...row, changedBy: ANOTHER_MEMBER }));
  }

  async snapshot(type: ConfigResourceType, id: string, revision: number): Promise<Record<string, unknown>> {
    const row = await this.revisions.find(type, id, revision);
    if (!row) {
      throw new NotFoundError(`revision ${revision}`);
    }
    return row.snapshot;
  }
}

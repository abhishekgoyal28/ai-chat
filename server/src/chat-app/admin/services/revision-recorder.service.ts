import { Injectable } from '@nestjs/common';
import { ConfigRevision } from '../../../shared/database/entities';
import { ConfigResourceType } from '../../../shared/domain/enums';
import { NotFoundError } from '../../../shared/errors/app-errors';
import { AdminPrincipal } from '../../auth/admin-auth.service';
import { ConfigRevisionRepository } from '../repositories/config.repositories';

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

  list(type: ConfigResourceType, id: string): Promise<ConfigRevision[]> {
    return this.revisions.list(type, id, 100);
  }

  async snapshot(type: ConfigResourceType, id: string, revision: number): Promise<Record<string, unknown>> {
    const row = await this.revisions.find(type, id, revision);
    if (!row) {
      throw new NotFoundError(`revision ${revision}`);
    }
    return row.snapshot;
  }
}

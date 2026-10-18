import { AdminRole } from '../../shared/domain/enums';
import { ForbiddenError } from '../../shared/errors/app-errors';
import { AdminPrincipal } from './admin-auth.service';

export interface OwnedResource {
  createdById: string | null;
}

/**
 * ADMIN and EDITOR members may change any configuration item. GUEST members
 * may change only items they created, so a shared sandbox stays usable when
 * strangers sign in; items without an owner (seeded or pre-ownership) are
 * therefore read-only to guests.
 */
export const canModify = (principal: Pick<AdminPrincipal, 'id' | 'role'>, resource: OwnedResource): boolean =>
  principal.role !== AdminRole.GUEST || (resource.createdById !== null && resource.createdById === principal.id);

export const assertCanModify = (principal: Pick<AdminPrincipal, 'id' | 'role'>, resource: OwnedResource): void => {
  if (!canModify(principal, resource)) {
    throw new ForbiddenError('you can only change items you created');
  }
};

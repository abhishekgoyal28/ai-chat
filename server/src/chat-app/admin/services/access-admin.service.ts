import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AdminUser, ApiKey } from '../../../shared/database/entities';
import { AdminRole, RecordStatus } from '../../../shared/domain/enums';
import { ConflictError, NotFoundError, UnauthorizedError, ValidationError } from '../../../shared/errors/app-errors';
import { hashPassword, randomToken, sha256Hex, verifyPassword } from '../../../shared/security/crypto';
import { AdminAuthService, AdminPrincipal } from '../../auth/admin-auth.service';
import { AdminUserRepository } from '../../auth/admin-user.repository';
import { ApiKeyRepository } from '../../auth/api-key.repository';
import { API_KEY_PREFIX } from '../../auth/host-api-key.guard';
import { teamMemberCreateSchema, teamMemberUpdateSchema } from '../admin.schemas';

export interface TeamMemberView {
  id: string;
  email: string;
  name: string;
  role: AdminRole;
  status: RecordStatus;
  lastLoginAt: string | null;
  createdAt: string;
}

export interface ApiKeyView {
  id: string;
  name: string;
  keyPrefix: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

const toMember = (user: AdminUser): TeamMemberView => ({
  id: user.id,
  email: user.email,
  name: user.name,
  role: user.role,
  status: user.status,
  lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
  createdAt: user.createdAt.toISOString(),
});

const toKey = (key: ApiKey): ApiKeyView => ({
  id: key.id,
  name: key.name,
  keyPrefix: key.keyPrefix,
  lastUsedAt: key.lastUsedAt?.toISOString() ?? null,
  revokedAt: key.revokedAt?.toISOString() ?? null,
  createdAt: key.createdAt.toISOString(),
});

/** Dashboard team members and host API keys — the two kinds of access to the platform. */
@Injectable()
export class AccessAdminService {
  constructor(
    private readonly users: AdminUserRepository,
    private readonly apiKeys: ApiKeyRepository,
    private readonly auth: AdminAuthService,
  ) {}

  async listMembers(): Promise<TeamMemberView[]> {
    return (await this.users.list()).map(toMember);
  }

  async createMember(input: z.infer<typeof teamMemberCreateSchema>): Promise<TeamMemberView> {
    if (await this.users.findByEmail(input.email)) {
      throw new ConflictError('a member with this email already exists');
    }
    const user = await this.users.create({ email: input.email, name: input.name, role: input.role, passwordHash: await hashPassword(input.password) });
    return toMember(user);
  }

  async updateMember(id: string, input: z.infer<typeof teamMemberUpdateSchema>, actor: AdminPrincipal): Promise<TeamMemberView> {
    const user = await this.users.findById(id);
    if (!user) {
      throw new NotFoundError('team member');
    }
    const losesAdmin =
      user.role === AdminRole.ADMIN &&
      user.status === RecordStatus.ACTIVE &&
      ((input.role && input.role !== AdminRole.ADMIN) || input.status === RecordStatus.DISABLED);
    if (losesAdmin && (await this.users.countActiveAdmins()) <= 1) {
      throw new ValidationError('this is the last active admin — promote someone else first');
    }
    if (id === actor.id && input.status === RecordStatus.DISABLED) {
      throw new ValidationError('you cannot disable your own account');
    }
    await this.users.update(id, {
      ...(input.name && { name: input.name }),
      ...(input.role && { role: input.role }),
      ...(input.status && { status: input.status }),
      ...(input.password && { passwordHash: await hashPassword(input.password) }),
    });
    this.auth.invalidate(id);
    return toMember((await this.users.findById(id)) as AdminUser);
  }

  async changeOwnPassword(actor: AdminPrincipal, currentPassword: string, newPassword: string): Promise<void> {
    const user = await this.users.findById(actor.id);
    if (!user || !(await verifyPassword(currentPassword, user.passwordHash))) {
      throw new UnauthorizedError('current password is incorrect');
    }
    await this.users.update(actor.id, { passwordHash: await hashPassword(newPassword) });
  }

  async listKeys(): Promise<ApiKeyView[]> {
    return (await this.apiKeys.list()).map(toKey);
  }

  /** The only time the full key exists outside the caller: it is returned once and stored as a hash. */
  async createKey(name: string, actor: AdminPrincipal): Promise<ApiKeyView & { key: string }> {
    const key = `${API_KEY_PREFIX}${randomToken(32)}`;
    const created = await this.apiKeys.create({ name, keyPrefix: key.slice(0, 12), keyHash: sha256Hex(key), createdById: actor.id });
    return { ...toKey(created), key };
  }

  async revokeKey(id: string): Promise<void> {
    if (!(await this.apiKeys.findById(id))) {
      throw new NotFoundError('API key');
    }
    await this.apiKeys.revoke(id);
  }
}

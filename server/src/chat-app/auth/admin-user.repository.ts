import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AdminUser } from '../../shared/database/entities';
import { AdminRole, RecordStatus } from '../../shared/domain/enums';

@Injectable()
export class AdminUserRepository {
  constructor(@InjectRepository(AdminUser) private readonly repo: Repository<AdminUser>) {}

  findByEmail(email: string): Promise<AdminUser | null> {
    return this.repo.findOne({ where: { email: email.trim().toLowerCase() } });
  }

  findById(id: string): Promise<AdminUser | null> {
    return this.repo.findOne({ where: { id } });
  }

  list(): Promise<AdminUser[]> {
    return this.repo.find({ order: { id: 'ASC' } });
  }

  count(): Promise<number> {
    return this.repo.count();
  }

  countActiveAdmins(): Promise<number> {
    return this.repo.count({ where: { role: AdminRole.ADMIN, status: RecordStatus.ACTIVE } });
  }

  create(values: Pick<AdminUser, 'email' | 'name' | 'passwordHash' | 'role'>): Promise<AdminUser> {
    return this.repo.save(this.repo.create({ ...values, email: values.email.trim().toLowerCase(), status: RecordStatus.ACTIVE, lastLoginAt: null }));
  }

  async update(id: string, values: Partial<Pick<AdminUser, 'name' | 'passwordHash' | 'role' | 'status' | 'lastLoginAt'>>): Promise<void> {
    await this.repo.update({ id }, values);
  }
}

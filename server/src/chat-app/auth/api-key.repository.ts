import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { ApiKey } from '../../shared/database/entities';

@Injectable()
export class ApiKeyRepository {
  constructor(@InjectRepository(ApiKey) private readonly repo: Repository<ApiKey>) {}

  findActiveByHash(keyHash: string): Promise<ApiKey | null> {
    return this.repo.findOne({ where: { keyHash, revokedAt: IsNull() } });
  }

  list(): Promise<ApiKey[]> {
    return this.repo.find({ order: { id: 'DESC' } });
  }

  findById(id: string): Promise<ApiKey | null> {
    return this.repo.findOne({ where: { id } });
  }

  create(values: Pick<ApiKey, 'name' | 'keyPrefix' | 'keyHash' | 'createdById'>): Promise<ApiKey> {
    return this.repo.save(this.repo.create({ ...values, lastUsedAt: null, revokedAt: null }));
  }

  async revoke(id: string): Promise<void> {
    await this.repo.update({ id, revokedAt: IsNull() }, { revokedAt: new Date() });
  }

  async touch(id: string, at: Date): Promise<void> {
    await this.repo.update({ id }, { lastUsedAt: at });
  }
}

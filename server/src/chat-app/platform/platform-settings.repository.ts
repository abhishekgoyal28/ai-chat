import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PlatformSetting } from '../../shared/database/entities';

@Injectable()
export class PlatformSettingsRepository {
  constructor(@InjectRepository(PlatformSetting) private readonly repo: Repository<PlatformSetting>) {}

  find(key: string): Promise<PlatformSetting | null> {
    return this.repo.findOne({ where: { key } });
  }

  /** Insert or update, bumping the revision. Returns the new revision. */
  async upsert(key: string, value: Record<string, unknown>, updatedBy: string | null): Promise<number> {
    const existing = await this.find(key);
    const revision = (existing?.revision ?? 0) + 1;
    await this.repo.save(this.repo.create({ key, value, revision, updatedBy }));
    return revision;
  }
}

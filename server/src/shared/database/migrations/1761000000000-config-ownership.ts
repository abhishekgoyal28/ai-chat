import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Records which dashboard member created each editable configuration item, so
 * GUEST members can be limited to changing their own. Nullable: rows that
 * existed before this migration have no owner and stay editable by ADMIN and
 * EDITOR only. MySQL 8 adds a trailing nullable column in place (no copy).
 */
const TABLES = ['agents', 'personas', 'prompts', 'knowledge_bases'];

export class ConfigOwnership1761000000000 implements MigrationInterface {
  name = 'ConfigOwnership1761000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const table of TABLES) {
      await queryRunner.query(`ALTER TABLE ${table} ADD COLUMN created_by_id BIGINT NULL, ALGORITHM=INSTANT`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const table of TABLES) {
      await queryRunner.query(`ALTER TABLE ${table} DROP COLUMN created_by_id`);
    }
  }
}

import { DefaultNamingStrategy, NamingStrategyInterface } from 'typeorm';

const toSnakeCase = (value: string): string =>
  value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();

/** camelCase properties in TypeScript, snake_case columns in MySQL. */
export class SnakeNamingStrategy extends DefaultNamingStrategy implements NamingStrategyInterface {
  override columnName(propertyName: string, customName: string | undefined, embeddedPrefixes: string[]): string {
    return customName ?? toSnakeCase([...embeddedPrefixes, propertyName].join('_'));
  }
}

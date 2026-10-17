import { PipeTransform } from '@nestjs/common';
import { ZodError, ZodTypeAny, z } from 'zod';
import { ValidationError } from '../errors/app-errors';

/** Field-path messages a dashboard form can show next to the right input. */
export const formatZodIssues = (error: ZodError): Record<string, string> =>
  Object.fromEntries(error.issues.map((issue) => [issue.path.join('.') || '(root)', issue.message]));

/**
 * Request validation against a zod schema — the DTOs of this codebase. The
 * same schemas describe stored JSON (agent settings), so a request and a row
 * are validated by one definition.
 */
export class ZodValidationPipe<S extends ZodTypeAny> implements PipeTransform<unknown, z.infer<S>> {
  constructor(private readonly schema: S) {}

  transform(value: unknown): z.infer<S> {
    const parsed = this.schema.safeParse(value);
    if (!parsed.success) {
      const issues = formatZodIssues(parsed.error);
      const first = Object.entries(issues)[0];
      throw new ValidationError(first ? `${first[0]}: ${first[1]}` : 'invalid request', { issues });
    }
    return parsed.data;
  }
}

export const zodBody = <S extends ZodTypeAny>(schema: S) => new ZodValidationPipe(schema);

/** Ids in paths are BIGINTs. */
export const idParamSchema = z.string().regex(/^\d{1,20}$/, 'must be a numeric id');

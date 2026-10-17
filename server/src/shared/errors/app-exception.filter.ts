import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import type { Response } from 'express';
import { describeError, getLogger } from '../logger/logger';
import { AppError } from './app-errors';

interface ErrorBody {
  error: { code: string; message: string; details?: unknown };
}

const HTTP_STATUS_CODES: Record<number, string> = {
  [HttpStatus.BAD_REQUEST]: 'VALIDATION_FAILED',
  [HttpStatus.UNAUTHORIZED]: 'UNAUTHORIZED',
  [HttpStatus.FORBIDDEN]: 'FORBIDDEN',
  [HttpStatus.NOT_FOUND]: 'NOT_FOUND',
  [HttpStatus.CONFLICT]: 'CONFLICT',
  [HttpStatus.PAYLOAD_TOO_LARGE]: 'PAYLOAD_TOO_LARGE',
  [HttpStatus.TOO_MANY_REQUESTS]: 'RATE_LIMITED',
};

/**
 * One error shape for every HTTP API. Unknown errors are logged with their
 * stack and returned as a bare INTERNAL_ERROR — internal messages never reach
 * the response.
 */
@Catch()
export class AppExceptionFilter implements ExceptionFilter {
  private readonly log = getLogger(AppExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const { status, body } = this.toResponse(exception);
    response.status(status).json(body);
  }

  private toResponse(exception: unknown): { status: number; body: ErrorBody } {
    if (exception instanceof AppError) {
      return {
        status: exception.status,
        body: { error: { code: exception.code, message: exception.message, details: exception.details } },
      };
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const raw = exception.getResponse();
      const message =
        typeof raw === 'object' && raw !== null && 'message' in raw
          ? (raw as { message: string | string[] }).message
          : exception.message;
      return {
        status,
        body: {
          error: {
            code: HTTP_STATUS_CODES[status] ?? 'HTTP_ERROR',
            message: Array.isArray(message) ? message.join('; ') : message,
          },
        },
      };
    }
    this.log.error({ error: describeError(exception) }, 'unhandled error');
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: { error: { code: 'INTERNAL_ERROR', message: 'something went wrong' } },
    };
  }
}

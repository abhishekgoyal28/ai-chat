import { HttpStatus } from '@nestjs/common';

/**
 * Project exceptions. Every error that crosses an HTTP boundary is one of
 * these, so the response body is always `{ error: { code, message } }` with a
 * stable machine-readable code — see AppExceptionFilter.
 */
export class AppError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: HttpStatus = HttpStatus.INTERNAL_SERVER_ERROR,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string) {
    super('NOT_FOUND', `${resource} not found`, HttpStatus.NOT_FOUND);
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('VALIDATION_FAILED', message, HttpStatus.BAD_REQUEST, details);
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super('CONFLICT', message, HttpStatus.CONFLICT);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'authentication required') {
    super('UNAUTHORIZED', message, HttpStatus.UNAUTHORIZED);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'not allowed') {
    super('FORBIDDEN', message, HttpStatus.FORBIDDEN);
  }
}

export class RateLimitedError extends AppError {
  constructor() {
    super('RATE_LIMITED', 'too many requests, slow down', HttpStatus.TOO_MANY_REQUESTS);
  }
}

export class SessionEndedError extends AppError {
  constructor() {
    super('SESSION_ENDED', 'this session has ended', HttpStatus.CONFLICT);
  }
}

export class DependencyError extends AppError {
  constructor(message: string) {
    super('DEPENDENCY_FAILED', message, HttpStatus.BAD_GATEWAY);
  }
}

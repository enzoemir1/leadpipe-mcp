import { z } from 'zod/v4';

export class LeadPipeError extends Error {
  constructor(
    message: string,
    public readonly userMessage: string,
    public readonly code: string
  ) {
    super(message);
    this.name = 'LeadPipeError';
  }
}

export class NotFoundError extends LeadPipeError {
  constructor(entity: string, id: string) {
    super(`${entity} not found: ${id}`, `${entity} with id "${id}" was not found.`, 'NOT_FOUND');
    this.name = 'NotFoundError';
  }
}

export class DuplicateError extends LeadPipeError {
  constructor(field: string, value: string) {
    super(
      `Duplicate ${field}: ${value}`,
      `A lead with ${field} "${value}" already exists.`,
      'DUPLICATE'
    );
    this.name = 'DuplicateError';
  }
}

export class ValidationError extends LeadPipeError {
  constructor(details: string) {
    super(`Validation error: ${details}`, details, 'VALIDATION');
    this.name = 'ValidationError';
  }
}

export function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.join('.');
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join('; ');
}

export function handleToolError(error: unknown): { content: { type: 'text'; text: string }[]; isError: true } {
  if (error instanceof LeadPipeError) {
    return {
      content: [{ type: 'text' as const, text: error.userMessage }],
      isError: true,
    };
  }

  if (error instanceof z.ZodError) {
    return {
      content: [{ type: 'text' as const, text: `Validation failed: ${formatZodError(error)}` }],
      isError: true,
    };
  }

  console.error('[LeadPipe Error]', error);
  return {
    content: [{ type: 'text' as const, text: 'An unexpected error occurred. Please try again.' }],
    isError: true,
  };
}

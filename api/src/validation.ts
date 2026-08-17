import type { FastifySchemaValidationError } from 'fastify/types/schema.js';
import { validationFailed, type AppError, type ErrorDetail } from './errors.ts';

/**
 * The single request-validation entry point.
 *
 * Every route declares its query/params/body as a JSON schema on the route definition, so
 * Fastify validates input *before* the handler runs – a rejected request never reaches
 * handler logic and never issues a database query. This module is the one place that turns
 * those validation failures into the shared error envelope, so every route rejects input
 * identically and later stories get the behaviour by declaring a schema.
 */

/** `/verbose` → `verbose`; a body error at `/session/title` → `session.title`. */
function fieldNameOf(error: FastifySchemaValidationError): string {
  const path = error.instancePath.replace(/^\//, '').replace(/\//g, '.');
  if (path !== '') return path;

  // Missing-property errors report an empty instancePath and name the field in params.
  const missing = (error.params as { missingProperty?: unknown }).missingProperty;
  return typeof missing === 'string' ? missing : 'request';
}

function messageOf(error: FastifySchemaValidationError): string {
  const allowed = (error.params as { allowedValues?: unknown }).allowedValues;
  if (Array.isArray(allowed)) {
    return `Expected one of: ${allowed.join(', ')}.`;
  }
  const raw = error.message ?? 'is not valid';
  const sentence = raw.charAt(0).toUpperCase() + raw.slice(1);
  return sentence.endsWith('.') ? sentence : `${sentence}.`;
}

export function toValidationDetails(errors: FastifySchemaValidationError[]): ErrorDetail[] {
  return errors.map((error) => ({
    field: fieldNameOf(error),
    message: messageOf(error),
  }));
}

export function toValidationError(errors: FastifySchemaValidationError[]): AppError {
  return validationFailed(toValidationDetails(errors));
}

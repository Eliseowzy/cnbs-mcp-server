// src/services/boundary.ts
// Boundary-case utilities for safe data access.

/**
 * Safely access a nested property by dot-separated path.
 */
export function safePropertyAccess<T>(obj: unknown, path: string, defaultValue: T): T {
  if (!obj || typeof obj !== 'object') {
    return defaultValue;
  }

  const parts = path.split('.');
  let current: unknown = obj;

  for (const part of parts) {
    if (current === null || typeof current !== 'object' || (current as Record<string, unknown>)[part] === undefined) {
      return defaultValue;
    }
    current = (current as Record<string, unknown>)[part];
  }

  return current as T;
}

/**
 * Validate that required fields are present in a params object.
 */
export function validateParams(params: Record<string, unknown>, required: string[]): { valid: boolean; missing: string[] } {
  const missing: string[] = [];

  for (const field of required) {
    if (params[field] === null || params[field] === undefined) {
      missing.push(field);
    }
  }

  return {
    valid: missing.length === 0,
    missing,
  };
}



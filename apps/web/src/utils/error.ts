export function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Unknown error";
}

export function formatErrorWithContext(
  error: unknown,
  context: string,
): string {
  const message = formatError(error);
  return `${context}: ${message}`;
}

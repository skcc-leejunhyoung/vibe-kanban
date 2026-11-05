export class AuthError extends Error {
  constructor(
    readonly kind: 'required' | 'unavailable',
    message: string
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

export function getAuthErrorKind(
  error: unknown
): 'required' | 'forbidden' | 'unavailable' {
  if (error instanceof AuthError) return error.kind;
  const status =
    (error as { status?: number; statusCode?: number } | null)?.status ??
    (error as { statusCode?: number } | null)?.statusCode;
  if (status === 401) return 'required';
  if (status === 403) return 'forbidden';
  return 'unavailable';
}

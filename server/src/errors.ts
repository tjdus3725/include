export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
    public readonly extra?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export interface ErrorPayload {
  code: string;
  message: string;
  [k: string]: unknown;
}

export function toPayload(e: unknown): ErrorPayload {
  if (e instanceof AppError) return { code: e.code, message: e.message, ...(e.extra ?? {}) };
  return { code: 'INTERNAL', message: '서버에서 알 수 없는 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.' };
}

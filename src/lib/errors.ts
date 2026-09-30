/**
 * Kullanıcıya gösterilebilecek hata. `message` Türkçe ve anlaşılır olmalıdır.
 * Diğer tüm hatalar loglanır ve kullanıcıya genel bir mesaj gösterilir.
 */
export class AppError extends Error {
  constructor(
    public readonly code:
      | "UNAUTHENTICATED"
      | "FORBIDDEN"
      | "NOT_FOUND"
      | "VALIDATION"
      | "CONFLICT"
      | "INSUFFICIENT_CREDITS"
      | "RATE_LIMITED"
      | "AI_UNAVAILABLE"
      | "EXTERNAL_FETCH"
      | "TENANT_VIOLATION",
    message: string,
    public readonly fieldErrors?: Record<string, string>,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const isAppError = (e: unknown): e is AppError => e instanceof AppError;

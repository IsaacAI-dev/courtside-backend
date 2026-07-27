export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
    public details: unknown = null,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const notFound = (code: string, message: string) => new AppError(code, message, 404);
export const conflict = (code: string, message: string) => new AppError(code, message, 409);
export const upstream = (code: string, message: string) => new AppError(code, message, 503);

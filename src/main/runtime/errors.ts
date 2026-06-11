export type AppErrorSource = "model" | "tool" | "rag" | "storage" | "network" | "unknown";

export type AppError = {
  code: string;
  message: string;
  detail?: string;
  retryable?: boolean;
  source: AppErrorSource;
};

export function toAppError(
  error: unknown,
  source: AppErrorSource = "unknown",
  code = "UNKNOWN_ERROR",
): AppError {
  if (typeof error === "object" && error && "code" in error && "message" in error) {
    return error as AppError;
  }

  const message = error instanceof Error ? error.message : String(error || "Unknown error");
  return {
    code,
    message,
    source,
    retryable: source === "network" || source === "model",
  };
}

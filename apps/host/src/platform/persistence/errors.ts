export type PersistenceErrorCode =
  | "content_too_large"
  | "cross_device_rename"
  | "degraded"
  | "invalid_json"
  | "io_failure"
  | "unsafe_symbolic_link";

const ERROR_MESSAGES: Record<PersistenceErrorCode, string> = {
  content_too_large: "persistent content exceeds the safe read limit",
  cross_device_rename: "atomic replacement crossed a filesystem boundary",
  degraded: "durable journal is degraded and read-only",
  invalid_json: "persistent data is not valid JSON",
  io_failure: "persistent storage operation failed",
  unsafe_symbolic_link: "persistent data must not be a symbolic link",
};

export class PersistenceError extends Error {
  readonly code: PersistenceErrorCode;

  constructor(code: PersistenceErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "PersistenceError";
    this.code = code;
  }
}

export function persistenceError(error: unknown): PersistenceError {
  if (error instanceof PersistenceError) return error;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "EXDEV") return new PersistenceError("cross_device_rename");
  if (code === "ELOOP") return new PersistenceError("unsafe_symbolic_link");
  return new PersistenceError("io_failure");
}

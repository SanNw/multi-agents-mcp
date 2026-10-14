export type ErrorPhase = "connect" | "first_byte" | "generation" | "decode" | "unknown";

export class RouterError extends Error {
  readonly code: string;
  readonly phase: ErrorPhase;
  readonly retryable: boolean;
  readonly status?: number;
  readonly retryAfterMs?: number;
  readonly requestId?: string;
  attempts?: unknown[];

  constructor(message: string, options: {
    code: string;
    phase?: ErrorPhase;
    retryable?: boolean;
    status?: number;
    retryAfterMs?: number;
    requestId?: string;
    cause?: unknown;
  }) {
    super(message, { cause: options.cause });
    this.name = "RouterError";
    this.code = options.code;
    this.phase = options.phase ?? "unknown";
    this.retryable = options.retryable ?? false;
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
    this.requestId = options.requestId;
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: redact(this.message),
      phase: this.phase,
      retryable: this.retryable,
      status: this.status ?? null,
      retry_after_ms: this.retryAfterMs ?? null,
      request_id: this.requestId ?? null,
      attempts: this.attempts ?? [],
    };
  }
}

export function serializeError(error: unknown) {
  if (error instanceof RouterError) return error.toJSON();
  return {
    name: error instanceof Error ? error.name : "Error",
    code: "UNEXPECTED_ERROR",
    message: redact(error instanceof Error ? error.message : String(error)),
    phase: "unknown",
    retryable: false,
    status: null,
    retry_after_ms: null,
    request_id: null,
    attempts: [],
  };
}

function redact(message: string) {
  return message.replace(/\b(?:sk-[\w-]+|Bearer\s+\S+)\b/gi, "[REDACTED]")
    .replace(/((?:api[_-]?key|token|password|senha|authorization)\s*[=:]\s*)[^\s,;]+/gi, "$1[REDACTED]");
}

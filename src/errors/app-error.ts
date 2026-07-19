/**
 * Structured error model from `api-contracts.md` § Error contract.
 *
 * Every expected failure carries a code, a technical message for logs, a safe German customer
 * message, a retryable flag, and a fixed internal HTTP status. Upstream status codes and upstream
 * bodies are never forwarded.
 */

export const ERROR_CODES = [
  "INVALID_REQUEST",
  "UPSTREAM_AUTH_FAILED",
  "UPSTREAM_TIMEOUT",
  "UPSTREAM_INVALID_RESPONSE",
  "UPSTREAM_REJECTED_REQUEST",
  "UPSTREAM_UNAVAILABLE",
  "INTERNAL_ERROR",
  "NOT_FOUND",
  "RATE_LIMITED",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

type ErrorDefinition = {
  status: 400 | 404 | 429 | 500 | 502 | 504;
  retryable: boolean;
  safeCustomerMessage: string;
};

/**
 * The agreed table from `api-contracts.md`. `safeCustomerMessage` is German, short, speakable, and
 * carries no technical detail, URL, or parameter name.
 */
const ERROR_DEFINITIONS: Record<ErrorCode, ErrorDefinition> = {
  INVALID_REQUEST: {
    status: 400,
    retryable: false,
    safeCustomerMessage: "Ich habe die Anfrage leider nicht verstanden.",
  },
  UPSTREAM_AUTH_FAILED: {
    status: 502,
    retryable: false,
    safeCustomerMessage: "Ich kann das gerade nicht zuverlässig prüfen.",
  },
  UPSTREAM_TIMEOUT: {
    status: 504,
    retryable: true,
    safeCustomerMessage: "Ich kann das gerade nicht zuverlässig prüfen. Bitte einen Moment Geduld.",
  },
  UPSTREAM_INVALID_RESPONSE: {
    status: 502,
    retryable: false,
    safeCustomerMessage: "Ich kann das gerade nicht zuverlässig prüfen.",
  },
  UPSTREAM_REJECTED_REQUEST: {
    status: 502,
    retryable: false,
    safeCustomerMessage: "Ich kann das gerade nicht zuverlässig prüfen.",
  },
  UPSTREAM_UNAVAILABLE: {
    status: 502,
    retryable: true,
    safeCustomerMessage: "Ich kann das gerade nicht zuverlässig prüfen. Bitte einen Moment Geduld.",
  },
  INTERNAL_ERROR: {
    status: 500,
    retryable: false,
    safeCustomerMessage:
      "Da ist etwas schiefgegangen. Ich kann die Anfrage gerade nicht bearbeiten.",
  },
  NOT_FOUND: {
    status: 404,
    retryable: false,
    safeCustomerMessage: "Diese Funktion steht nicht zur Verfügung.",
  },
  RATE_LIMITED: {
    status: 429,
    // Retryable: unlike every other non-2xx code, waiting alone fixes this one.
    retryable: true,
    safeCustomerMessage: "Ich bin gerade sehr gefragt. Bitte einen Moment Geduld.",
  },
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: ErrorDefinition["status"];
  readonly retryable: boolean;
  readonly safeCustomerMessage: string;

  /**
   * @param code agreed error code
   * @param message technical message; logs only, never returned to a caller
   */
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "AppError";

    const definition = ERROR_DEFINITIONS[code];

    this.code = code;
    this.status = definition.status;
    this.retryable = definition.retryable;
    this.safeCustomerMessage = definition.safeCustomerMessage;
  }
}

export type ErrorEnvelope = {
  code: ErrorCode;
  safeCustomerMessage: string;
  retryable: boolean;
  correlationId: string;
};

export function toErrorEnvelope(error: AppError, correlationId: string): ErrorEnvelope {
  return {
    code: error.code,
    safeCustomerMessage: error.safeCustomerMessage,
    retryable: error.retryable,
    correlationId,
  };
}

import { randomUUID } from "node:crypto";

export type ToolErrorCode =
  | "AUTHENTICATION_FAILED"
  | "CONNECTION_FAILED"
  | "QUERY_TIMEOUT"
  | "QUERY_REJECTED"
  | "UPSTREAM_ERROR";

export type ToolOperation = "query" | "schema" | "status";

export interface SafeToolError {
  code: ToolErrorCode;
  message: string;
}

export function createRequestId(): string {
  return randomUUID();
}

export function errorCategory(error: unknown): string {
  const candidate =
    typeof error === "object" && error !== null
      ? String((error as { name?: unknown }).name || "Error")
      : "Error";
  const sanitized = candidate.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 80);
  return sanitized || "Error";
}

function errorText(error: unknown): string {
  if (typeof error !== "object" || error === null) {
    return String(error || "");
  }

  const candidate = error as {
    name?: unknown;
    code?: unknown;
    message?: unknown;
  };
  return [candidate.name, candidate.code, candidate.message]
    .filter((value) => value !== undefined && value !== null)
    .map(String)
    .join(" ")
    .toLowerCase();
}

export function toolErrorCode(error: unknown): ToolErrorCode {
  const candidate = errorText(error);

  if (
    /\b(authentication|unauthorized|forbidden|credentials?|security\.unauthorized)\b/.test(
      candidate,
    )
  ) {
    return "AUTHENTICATION_FAILED";
  }
  if (
    /\b(rejected|invalid|validation|syntax|parse|unsupported|does not start)\b/.test(
      candidate,
    )
  ) {
    return "QUERY_REJECTED";
  }
  if (
    /\b(etimedout|timeout|timeouterror|time-out|aborterror)\b/.test(
      candidate,
    )
  ) {
    return "QUERY_TIMEOUT";
  }
  if (
    /\b(econnrefused|econnreset|enotfound|ehostunreach|serviceunavailable|sessionexpired|not connected|connection)\b/.test(
      candidate,
    )
  ) {
    return "CONNECTION_FAILED";
  }

  return "UPSTREAM_ERROR";
}

export function safeToolError(
  error: unknown,
  operation: ToolOperation,
): SafeToolError {
  const classifiedCode = toolErrorCode(error);
  const code =
    operation !== "query" && classifiedCode === "QUERY_REJECTED"
      ? "UPSTREAM_ERROR"
      : classifiedCode;
  const standardMessages: Record<ToolErrorCode, string> = {
    AUTHENTICATION_FAILED: "PuppyGraph authentication failed",
    CONNECTION_FAILED: "Unable to connect to PuppyGraph",
    QUERY_TIMEOUT: "PuppyGraph operation timed out",
    QUERY_REJECTED: "PuppyGraph query was rejected",
    UPSTREAM_ERROR: {
      query: "Unable to execute PuppyGraph query",
      schema: "Unable to fetch PuppyGraph schema",
      status: "Unable to fetch PuppyGraph status",
    }[operation],
  };

  return { code, message: standardMessages[code] };
}

export function urlForLog(value: string): string {
  try {
    const parsed = new URL(value);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return "[invalid-url]";
  }
}

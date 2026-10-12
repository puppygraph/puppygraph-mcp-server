import {
  RestConnectionError,
  type PuppyGraphRestLike,
  type RestResponse,
} from "../clients/rest.js";
import { createRequestId, errorCategory } from "../utils/logging.js";
import { maskSecrets, scrubText } from "../utils/redact.js";
import { isStartingMessage, responseError, ServerStartingError, UpstreamHttpError } from "./validate.js";

/** Shared plumbing of the setup tools: errors, results and REST calls. */

export type SetupErrorCode =
  | "READ_ONLY"
  | "INVALID_INPUT"
  | "NOT_FOUND"
  | "ALREADY_EXISTS"
  | "VALIDATION_FAILED"
  | "REPLACE_REQUIRED"
  | "CONFLICT"
  | "AUTHENTICATION_FAILED"
  | "PERMISSION_DENIED"
  | "NOT_SUPPORTED"
  | "CONNECTION_FAILED"
  | "TIMEOUT"
  | "STARTING"
  | "HOST_UNREACHABLE_FROM_PUPPYGRAPH"
  | "UPSTREAM_ERROR";

export class SetupError extends Error {
  constructor(
    readonly code: SetupErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "SetupError";
  }
}

export function textResult(value: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

export function errorFromResponse(
  response: RestResponse,
  action: string,
  secrets: readonly string[],
): SetupError {
  const message = responseError(response.body, secrets);
  if (isStartingMessage(message)) {
    return startingError();
  }
  if (response.status === 401) {
    return new SetupError(
      "AUTHENTICATION_FAILED",
      `PuppyGraph rejected the HTTP API credentials while trying to ${action}. Check PUPPYGRAPH_SCHEMA_USERNAME / PUPPYGRAPH_SCHEMA_PASSWORD in the MCP server configuration.`,
    );
  }
  if (response.status === 403) {
    return new SetupError("PERMISSION_DENIED", `Not allowed to ${action}: ${message}`);
  }
  if (response.status === 404) {
    return new SetupError(
      "UPSTREAM_ERROR",
      `This PuppyGraph server has no endpoint to ${action} (HTTP 404). These tools need PuppyGraph 1.x.`,
    );
  }
  return new SetupError("UPSTREAM_ERROR", `Failed to ${action}: ${message}`);
}

export function startingError(): SetupError {
  return new SetupError(
    "STARTING",
    "PuppyGraph is still starting (no healthy leader yet), so it can't answer this yet. Nothing was changed. Wait about 30 seconds and call the tool again; don't change the request.",
  );
}

export async function call(
  rest: PuppyGraphRestLike,
  method: "GET" | "POST",
  path: string,
  action: string,
  options: { query?: Record<string, string>; body?: unknown; timeoutMs?: number } = {},
  secrets: readonly string[] = [],
): Promise<any> {
  const response = await rest.request(method, path, options);
  if (!response.ok) {
    throw errorFromResponse(response, action, secrets);
  }
  return response.body;
}

export async function listCatalogNames(rest: PuppyGraphRestLike): Promise<any[]> {
  const body = await call(rest, "GET", "/ui-api/catalog", "list catalogs");
  return Array.isArray(body?.catalogs) ? body.catalogs : [];
}

export async function requireCatalog(rest: PuppyGraphRestLike, name: string): Promise<void> {
  const catalogs = await listCatalogNames(rest);
  if (!catalogs.some((catalog) => catalog?.name === name)) {
    const known = catalogs.map((catalog) => catalog?.name).filter(Boolean);
    throw new SetupError(
      "NOT_FOUND",
      `Catalog '${name}' not found. Registered catalogs: ${known.length ? known.join(", ") : "none"}. Create it with puppygraph_create_catalog.`,
    );
  }
}

export async function liveVersion(rest: PuppyGraphRestLike): Promise<number | null> {
  const response = await rest.request("GET", "/ui-api/schema/versions", {
    query: { limit: "50" },
  });
  const versions = (response.body as any)?.versions;
  if (!response.ok || !Array.isArray(versions)) {
    return null;
  }
  const live = versions.find((version: any) => version?.isLive) || versions[0];
  return typeof live?.version === "number" ? live.version : null;
}

export type Handler<A> = (args: A, log: (message: string) => void) => Promise<unknown>;

export function runTool<A>(name: string, handler: Handler<A>, secretsOf: (args: A) => string[] = () => []) {
  return async (args: A) => {
    const requestId = createRequestId();
    const log = (message: string) =>
      console.error(`Tool ${name} request_id=${requestId} ${message}`);
    let secrets: string[] = [];
    try {
      secrets = secretsOf(args);
      log("started");
      const value = await handler(args, log);
      log("completed");
      return textResult(maskSecrets(value, secrets));
    } catch (error: any) {
      let code: SetupErrorCode = "UPSTREAM_ERROR";
      let message = "Unexpected error";
      let details: Record<string, unknown> = {};
      if (error instanceof ServerStartingError) {
        error = startingError();
      }
      if (error instanceof UpstreamHttpError) {
        error = errorFromResponse(error.response, error.action, secrets);
      }
      if (error instanceof SetupError) {
        ({ code, message, details } = error);
      } else if (error instanceof RestConnectionError) {
        code = error.timedOut ? "TIMEOUT" : "CONNECTION_FAILED";
        message = `${error.message}. Check that PuppyGraph is running and PUPPYGRAPH_HTTP_URL points at its web port (8081 by default).`;
      }
      log(`failed error_type=${code} error_category=${errorCategory(error)}`);
      return textResult(
        maskSecrets(
          { ok: false, error: scrubText(message, secrets), error_type: code, ...details },
          secrets,
        ),
        true,
      );
    }
  };
}


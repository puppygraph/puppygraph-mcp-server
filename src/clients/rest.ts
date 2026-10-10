import { urlForLog } from "../utils/logging.js";

/**
 * Configuration for PuppyGraph's HTTP API (catalogs, schema upload), served
 * by the web UI port, 8081 by default.
 */
export interface RestConfig {
  /** Base URL, e.g. http://localhost:8081 */
  url: string;
  username: string;
  password: string;
}

export interface RestResponse {
  status: number;
  ok: boolean;
  /** Parsed JSON body, or the raw text if the body is not JSON. */
  body: unknown;
}

export interface RestRequest {
  query?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
}

export interface PuppyGraphRestLike {
  readonly baseUrl: string;
  request(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    options?: RestRequest,
  ): Promise<RestResponse>;
}

const DEFAULT_TIMEOUT_MS = 60_000;

/** Error for a request that never got an HTTP response. */
export class RestConnectionError extends Error {
  constructor(message: string, readonly timedOut: boolean) {
    super(message);
    this.name = timedOut ? "TimeoutError" : "ConnectionError";
  }
}

export class PuppyGraphRestClient implements PuppyGraphRestLike {
  readonly baseUrl: string;
  private readonly authorization: string;

  constructor(config: RestConfig) {
    this.baseUrl = config.url.replace(/\/+$/, "");
    this.authorization = `Basic ${Buffer.from(
      `${config.username}:${config.password}`,
    ).toString("base64")}`;
  }

  async request(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    options: RestRequest = {},
  ): Promise<RestResponse> {
    let url: URL;
    try {
      url = new URL(this.baseUrl + path);
    } catch {
      throw new RestConnectionError(
        `PUPPYGRAPH_HTTP_URL (or PUPPYGRAPH_SCHEMA_URL) is not a valid URL: ${urlForLog(this.baseUrl)}`,
        false,
      );
    }
    for (const [key, value] of Object.entries(options.query || {})) {
      url.searchParams.set(key, value);
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          Authorization: this.authorization,
          Accept: "application/json",
          ...(options.body !== undefined
            ? { "Content-Type": "application/json" }
            : {}),
        },
        body:
          options.body !== undefined ? JSON.stringify(options.body) : undefined,
        signal: AbortSignal.timeout(options.timeoutMs || DEFAULT_TIMEOUT_MS),
      });
    } catch (error: any) {
      const timedOut =
        error?.name === "TimeoutError" || error?.name === "AbortError";
      throw new RestConnectionError(
        timedOut
          ? `PuppyGraph did not answer ${method} ${path} in time`
          : `Unable to connect to PuppyGraph at ${urlForLog(this.baseUrl)}`,
        timedOut,
      );
    }

    let text: string;
    try {
      text = await response.text();
    } catch (error: any) {
      const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
      throw new RestConnectionError(
        timedOut
          ? `PuppyGraph did not finish answering ${method} ${path} in time`
          : `The connection to PuppyGraph broke while reading the answer to ${method} ${path}`,
        timedOut,
      );
    }
    let body: unknown = text;
    if (text.trim() !== "") {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    return { status: response.status, ok: response.ok, body };
  }
}

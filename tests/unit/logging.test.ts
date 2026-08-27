import { describe, expect, it } from "vitest";
import {
  errorCategory,
  safeToolError,
  toolErrorCode,
  urlForLog,
} from "../../src/utils/logging.js";

describe("safe logging utilities", () => {
  it("removes credentials, query parameters, and fragments from URLs", () => {
    expect(
      urlForLog(
        "http://sensitive-user:sensitive-password@localhost:8081/schemajson?token=secret#fragment",
      ),
    ).toBe("http://localhost:8081/schemajson");
  });

  it("logs an error category without its message", () => {
    const error = new Error("query-secret parameter-secret password-secret");

    expect(errorCategory(error)).toBe("Error");
  });

  it.each([
    [
      "AUTHENTICATION_FAILED",
      Object.assign(new Error("secret authentication detail"), {
        code: "Neo.ClientError.Security.Unauthorized",
      }),
    ],
    [
      "CONNECTION_FAILED",
      Object.assign(new Error("secret endpoint detail"), {
        code: "ECONNREFUSED",
      }),
    ],
    [
      "QUERY_TIMEOUT",
      Object.assign(new Error("secret detail"), { name: "TimeoutError" }),
    ],
    ["QUERY_REJECTED", new Error("Gremlin syntax error contains secret detail")],
    ["UPSTREAM_ERROR", new Error("unclassified secret driver detail")],
  ] as const)(
    "maps driver failures to the stable %s category",
    (expected, error) => {
      expect(toolErrorCode(error)).toBe(expected);
    },
  );

  it("returns a stable message without upstream details", () => {
    const secret = "bolt://secret-user:secret-password@example.com:7687";
    const result = safeToolError(new Error(secret), "query");

    expect(result).toEqual({
      code: "UPSTREAM_ERROR",
      message: "Unable to execute PuppyGraph query",
    });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain("secret-password");
  });

  it("does not describe non-query failures as rejected queries", () => {
    expect(safeToolError(new SyntaxError("secret schema JSON"), "schema")).toEqual(
      {
        code: "UPSTREAM_ERROR",
        message: "Unable to fetch PuppyGraph schema",
      },
    );
  });
});

import { describe, expect, it } from "vitest";
import {
  dockerHostJdbcUri,
  isLoopbackJdbcUri,
  jdbcHost,
  looksUnreachable,
} from "../../src/utils/jdbc.js";

describe("jdbc host helpers", () => {
  it.each([
    ["jdbc:postgresql://localhost:5432/bank", "localhost"],
    ["jdbc:postgresql://127.0.0.1/bank?ssl=false", "127.0.0.1"],
    ["jdbc:mysql://user:pw@localhost:3306/db", "localhost"],
    ["jdbc:sqlserver://localhost:1433;databaseName=db", "localhost"],
    ["jdbc:sqlserver://localhost;databaseName=db", "localhost"],
    ["jdbc:oracle:thin:@localhost:1521/XE", "localhost"],
    ["jdbc:oracle:thin:@//localhost:1521/XE", "localhost"],
    ["jdbc:postgresql://[::1]:5432/bank", "[::1]"],
    ["jdbc:clickhouse://db.example.com:8123/default", "db.example.com"],
  ])("finds the host of %s", (uri, host) => {
    expect(jdbcHost(uri)).toBe(host);
  });

  it("returns null for URIs without a host", () => {
    expect(jdbcHost("jdbc:duckdb:/data/graph.duckdb")).toBeNull();
    expect(jdbcHost("postgresql://localhost/db")).toBeNull();
  });

  it("recognises loopback hosts only", () => {
    expect(isLoopbackJdbcUri("jdbc:postgresql://LOCALHOST:5432/bank")).toBe(true);
    expect(isLoopbackJdbcUri("jdbc:postgresql://[::1]:5432/bank")).toBe(true);
    expect(isLoopbackJdbcUri("jdbc:postgresql://localhost.example.com/bank")).toBe(false);
    expect(isLoopbackJdbcUri("jdbc:postgresql://host.docker.internal/bank")).toBe(false);
    expect(isLoopbackJdbcUri("jdbc:duckdb:/data/graph.duckdb")).toBe(false);
    expect(isLoopbackJdbcUri(undefined)).toBe(false);
  });

  it("swaps only the host for host.docker.internal", () => {
    expect(dockerHostJdbcUri("jdbc:postgresql://localhost:5432/bank?user=a")).toBe(
      "jdbc:postgresql://host.docker.internal:5432/bank?user=a",
    );
    expect(dockerHostJdbcUri("jdbc:mysql://u:p@127.0.0.1:3306/db")).toBe(
      "jdbc:mysql://u:p@host.docker.internal:3306/db",
    );
    expect(dockerHostJdbcUri("jdbc:oracle:thin:@localhost:1521/XE")).toBe(
      "jdbc:oracle:thin:@host.docker.internal:1521/XE",
    );
    expect(dockerHostJdbcUri("jdbc:postgresql://[::1]:5432/bank")).toBe(
      "jdbc:postgresql://host.docker.internal:5432/bank",
    );
  });

  it("recognises connection failures, not other errors", () => {
    expect(looksUnreachable("service (host:localhost port:5432) is not reachable")).toBe(true);
    expect(looksUnreachable("Connection to localhost:5432 refused.")).toBe(true);
    expect(looksUnreachable("Communications link failure")).toBe(true);
    expect(looksUnreachable('password authentication failed for user "analyst"')).toBe(false);
    expect(looksUnreachable('database "bank" does not exist')).toBe(false);
  });
});

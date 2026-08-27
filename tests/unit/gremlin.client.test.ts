import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GremlinClient } from "../../src/clients/gremlin";

const gremlinMocks = vi.hoisted(() => ({
  submit: vi.fn(),
  close: vi.fn(),
  Client: vi.fn(),
  PlainTextSaslAuthenticator: vi.fn(),
}));

vi.mock("gremlin", () => ({
  default: {
    driver: {
      Client: gremlinMocks.Client,
      auth: {
        PlainTextSaslAuthenticator: gremlinMocks.PlainTextSaslAuthenticator,
      },
    },
  },
}));

describe("GremlinClient", () => {
  let client: GremlinClient;
  const config = {
    url: "ws://localhost:8182/gremlin",
    username: "puppygraph",
    password: "puppygraph123",
    traversalSource: "g",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    gremlinMocks.close.mockResolvedValue(undefined);
    gremlinMocks.Client.mockImplementation(function MockGremlinClient() {
      return {
        submit: gremlinMocks.submit,
        close: gremlinMocks.close,
      };
    });
    gremlinMocks.PlainTextSaslAuthenticator.mockImplementation(
      function MockPlainTextSaslAuthenticator() {},
    );
    gremlinMocks.submit.mockImplementation((query: string) => ({
      toArray: vi
        .fn()
        .mockReturnValue(
          query === "g.V().limit(1).count()"
            ? [1]
            : [{ id: 1, label: "person" }],
        ),
    }));
    client = new GremlinClient(config);
  });

  afterEach(async () => {
    await client.close();
  });

  it("connects with the driver's remote script client", async () => {
    await expect(client.connect()).resolves.toBe(true);

    expect(gremlinMocks.Client).toHaveBeenCalledWith(
      config.url,
      expect.objectContaining({ traversalSource: "g" }),
    );
    expect(gremlinMocks.submit).toHaveBeenCalledWith(
      "g.V().limit(1).count()",
    );
    expect(client.isConnected()).toBe(true);
    expect(client.getConnectionError()).toBeNull();
  });

  it("reports connection failures", async () => {
    gremlinMocks.submit.mockRejectedValueOnce(new Error("Connection failed"));

    await expect(client.connect()).resolves.toBe(false);
    expect(client.isConnected()).toBe(false);
    expect(client.getConnectionError()).toBe("Connection failed");
  });

  it("submits query strings and bindings only to PuppyGraph", async () => {
    await client.connect();
    gremlinMocks.submit.mockClear();

    const result = await client.executeQuery("g.V().has('name', name)", {
      name: "alice",
    });

    expect(gremlinMocks.submit).toHaveBeenCalledWith(
      "g.V().has('name', name)",
      { name: "alice" },
    );
    expect(result).toEqual([{ id: 1, label: "person" }]);
  });

  it("never evaluates a Gremlin query in the Node.js process", async () => {
    await client.connect();
    gremlinMocks.submit.mockClear();
    const probeName = "__puppygraphGremlinLocalExecutionProbe";
    const globalRecord = globalThis as Record<string, unknown>;
    globalRecord[probeName] = "unchanged";
    const payload = `g.V(), (globalThis.${probeName} = g.V())`;

    try {
      await client.executeQuery(payload);
      expect(globalRecord[probeName]).toBe("unchanged");
      expect(gremlinMocks.submit).toHaveBeenCalledWith(payload, {});
    } finally {
      delete globalRecord[probeName];
    }
  });

  it("keeps the existing g. query requirement", async () => {
    await client.connect();

    await expect(client.executeQuery("1 + 1")).rejects.toThrow(
      "Query does not start with g.",
    );
  });

  it("throws when the client is not connected", async () => {
    await expect(client.executeQuery("g.V().count()")).rejects.toThrow(
      "Not connected to Gremlin endpoint",
    );
  });

  it("closes the remote client", async () => {
    await client.connect();
    await client.close();

    expect(gremlinMocks.close).toHaveBeenCalled();
    expect(client.isConnected()).toBe(false);
  });
});

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PuppyGraphRestLike, RestRequest, RestResponse } from "../../src/clients/rest.js";
import { createPuppyGraphServer, type PuppyGraphServiceLike } from "../../src/server.js";
import { isSecretKey } from "../../src/utils/redact.js";

/**
 * The tools and checks that bring the MCP server to parity with PuppyGraph
 * AI: catalog spec, schema navigation and per-element edits, the edge check,
 * the stricter validation, and the error handling around them.
 */

type Route = (options: RestRequest) => RestResponse | Promise<RestResponse>;

function json(status: number, body: unknown): RestResponse {
  return { status, ok: status >= 200 && status < 300, body };
}

class FakeRest implements PuppyGraphRestLike {
  readonly baseUrl = "http://puppygraph-test:8081";
  readonly calls: Array<{ method: string; path: string; options: RestRequest }> = [];
  constructor(private readonly routes: Record<string, Route>) {}

  async request(method: string, path: string, options: RestRequest = {}) {
    this.calls.push({ method, path, options });
    const route = this.routes[`${method} ${path}`];
    return route ? route(options) : json(404, "404 page not found");
  }

  called(method: string, path: string) {
    return this.calls.filter((call) => call.method === method && call.path === path);
  }
}

// Source tables of catalog 'shop', database 'shop', with PuppyGraph's types.
const tables: Record<string, Array<[string, string]>> = {
  customers: [["customer_id", "LONG"], ["name", "STRING"], ["score", "DECIMAL(12,2)"], ["mood", "UNKNOWN"], ["referred_by", "LONG"]],
  orders: [["order_id", "LONG"], ["customer_id", "LONG"], ["status", "STRING"]],
  order_lines: [["order_id", "LONG"], ["line_no", "INT"], ["qty", "INT"]],
};

const ext = (table: string, columns: string[]) => ({
  externalDataSource: {
    enabled: true,
    catalog: "shop",
    schema: "shop",
    table,
    mappedField: columns.map((column) => ({ sourceFieldName: column, targetFieldName: column })),
  },
});

const customer = {
  label: "Customer",
  dataSourceGroup: ext("customers", ["customer_id", "name"]),
  id: [{ name: "customer_id", type: "Long" }],
  attribute: [{ name: "name", type: "String" }],
};
const order = {
  label: "Order",
  dataSourceGroup: ext("orders", ["order_id", "status"]),
  id: [{ name: "order_id", type: "Long" }],
  attribute: [{ name: "status", type: "String" }],
};
const orderLine = {
  label: "OrderLine",
  dataSourceGroup: ext("order_lines", ["order_id", "line_no"]),
  id: [{ name: "order_id", type: "Long" }, { name: "line_no", type: "Int" }],
};

function edge(label: string, from: string, to: string, table: string, fromKeys: Array<[string, string]>, toKeys: Array<[string, string]>) {
  return {
    label,
    fromNodeLabel: from,
    toNodeLabel: to,
    dataSourceGroup: {
      externalDataSource: {
        enabled: true,
        catalog: "shop",
        schema: "shop",
        table,
        mappedField: [
          ...fromKeys.map(([column]) => ({ sourceFieldName: column, targetFieldName: `from_${column}` })),
          ...toKeys.map(([column]) => ({ sourceFieldName: column, targetFieldName: `to_${column}` })),
        ],
      },
    },
    fromKey: fromKeys.map(([column, type]) => ({ name: `from_${column}`, type })),
    toKey: toKeys.map(([column, type]) => ({ name: `to_${column}`, type })),
  };
}

const placed = edge("PLACED", "Customer", "Order", "orders", [["customer_id", "Long"]], [["order_id", "Long"]]);

/** A stateful fake PuppyGraph: POST /schema installs the schema and bumps the version. */
function puppygraph(options: { schema?: any; versionAfterRead?: number; overrides?: Record<string, Route> } = {}) {
  const state = { schema: options.schema ?? {}, version: 7, reads: 0 };
  const routes: Record<string, Route> = {
    "GET /ui-api/catalog": () => json(200, { catalogs: [{ name: "shop", type: "postgresql" }] }),
    "GET /ui-api/database": () => json(200, { database: ["crm", "public", "shop"] }),
    "GET /ui-api/table": ({ query }) => json(200, { table: query?.databaseName === "shop" ? Object.keys(tables) : [] }),
    "GET /ui-api/column": ({ query }) => {
      const table = query?.databaseName === "shop" ? tables[query?.tableName ?? ""] : undefined;
      return json(200, {
        ok: true,
        column: (table ?? []).map(([name, schemaType]) => ({ name, type: schemaType, schemaType })),
      });
    },
    "GET /schemajson": () => json(200, state.schema),
    "GET /ui-api/schema/versions": () => {
      state.reads += 1;
      const version = options.versionAfterRead !== undefined && state.reads > 1 ? options.versionAfterRead : state.version;
      return json(200, { versions: [{ version, isLive: true }] });
    },
    "POST /schema": ({ body }) => {
      state.schema = body;
      state.version += 1;
      return json(200, { ok: true, version: state.version, message: "Schema uploaded successfully" });
    },
    ...options.overrides,
  };
  return { rest: new FakeRest(routes), state };
}

let client: Client | undefined;
let server: McpServer | undefined;

function makeService(cypher?: (query: string) => Array<Record<string, unknown>>): PuppyGraphServiceLike {
  return {
    executeGremlin: vi.fn(),
    executeCypher: vi.fn(async ({ query }: { query: string }) => ({ data: cypher ? cypher(query) : [{ n: 1 }] })),
    getDataSources: vi.fn(),
    getConnectionStatus: vi.fn().mockReturnValue({
      connected: true,
      neo4jConnected: true,
      gremlinConnected: true,
      connectionError: null,
      fallbackMode: false,
    }),
  };
}

async function connect(rest: PuppyGraphRestLike, service = makeService(), environment: NodeJS.ProcessEnv = {}) {
  server = createPuppyGraphServer(service, environment, environment.PUPPYGRAPH_READ_ONLY === "true", rest);
  client = new Client({ name: "parity-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
}

async function callTool(name: string, args: Record<string, unknown> = {}) {
  const result = (await client!.callTool({ name, arguments: args })) as {
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  };
  return { raw: JSON.stringify(result), isError: result.isError === true, body: JSON.parse(result.content[0].text) };
}

afterEach(async () => {
  await client?.close();
  await server?.close();
  client = undefined;
  server = undefined;
  vi.restoreAllMocks();
});

describe("guide and catalog spec", () => {
  it("serves the guide as a tool, for clients that don't read resources", async () => {
    await connect(puppygraph().rest);
    const { body } = await callTool("puppygraph_guide");
    expect(body.guide).toContain("Never add an edge whose join you");
    expect(body.guide).toContain("puppygraph_check_edges");
    expect(body.guide).toContain("host.docker.internal");
  });

  it("lists the catalog types and gives a type's exact fields", async () => {
    await connect(puppygraph().rest);
    const types = await callTool("puppygraph_catalog_spec");
    expect(types.body.catalog_types.map((entry: any) => entry.type)).toEqual(
      expect.arrayContaining(["iceberg", "deltalake", "hive", "bigquery", "snowflake", "mysql8", "postgresql", "duckdb"]),
    );

    const iceberg = await callTool("puppygraph_catalog_spec", { type: "iceberg" });
    const names = iceberg.body.fields.map((field: any) => field.name);
    expect(names).toEqual(expect.arrayContaining(["icebergMetastoreType", "restUri", "restWarehouse", "storageType", "storageSecretKey"]));
    expect(iceberg.body.fields.find((field: any) => field.name === "storageSecretKey").sensitive).toBe(true);
    expect(iceberg.body.shown_when).toContainEqual(expect.objectContaining({ when: { icebergMetastoreType: "rest" } }));

    const unknown = await callTool("puppygraph_catalog_spec", { type: "parquet" });
    expect(unknown.isError).toBe(true);
    expect(unknown.body.error).toContain("Unknown catalog type 'parquet'");
  });
});

describe("create_catalog guidance", () => {
  it("asks for the MySQL driver before calling PuppyGraph", async () => {
    const { rest } = puppygraph();
    await connect(rest);
    const { body, isError } = await callTool("puppygraph_create_catalog", {
      name: "bank",
      type: "mysql8",
      jdbc_uri: "jdbc:mysql://my:3306/bank",
      username: "root",
    });
    expect(isError).toBe(true);
    expect(body.error_type).toBe("INVALID_INPUT");
    expect(body.suggested_driver_url).toContain("mysql-connector-j");
    expect(rest.called("POST", "/ui-api/catalog")).toHaveLength(0);
  });

  it("sends driver_url and suggests allowPublicKeyRetrieval on MySQL 8's RSA error", async () => {
    const { rest } = puppygraph({
      overrides: {
        "POST /ui-api/catalog": () =>
          json(500, { errorMessage: "Internal error while list databases. error: Failed to initialize pool: RSA public key is not available client side (option serverRsaPublicKeyFile not set)" }),
      },
    });
    await connect(rest);
    const { body } = await callTool("puppygraph_create_catalog", {
      name: "bank",
      type: "mysql8",
      jdbc_uri: "jdbc:mysql://my:3306/bank",
      username: "root",
      driver_url: "https://repo1.maven.org/maven2/com/mysql/mysql-connector-j/8.4.0/mysql-connector-j-8.4.0.jar",
    });
    expect((rest.called("POST", "/ui-api/catalog")[0].options.body as any).catalogs[0].driverUrl).toContain("mysql-connector-j");
    expect(body.suggested_jdbc_uri).toBe("jdbc:mysql://my:3306/bank?allowPublicKeyRetrieval=true&useSSL=false");
  });

  it("names the missing lake fields instead of sending guessed ones", async () => {
    const { rest } = puppygraph();
    await connect(rest);
    const { body } = await callTool("puppygraph_create_catalog", {
      name: "lake",
      type: "iceberg",
      options: { uri: "http://rest:8181", warehouse: "s3://lake/wh" },
    });
    expect(body.error_type).toBe("INVALID_INPUT");
    expect(body.error).toContain("missing icebergMetastoreType, storageType");
    expect(body.error).toContain("no field uri, warehouse");
    expect(body.error).toContain("puppygraph_catalog_spec");
    expect(rest.called("POST", "/ui-api/catalog")).toHaveLength(0);
  });

  it("accepts a complete Iceberg REST + S3 catalog and keeps the secret out of the result", async () => {
    const { rest } = puppygraph({
      overrides: { "POST /ui-api/catalog": ({ body }: any) => json(200, { catalogs: [{ name: "lake", type: "iceberg", storage: { secretKey: body.catalogs[0].storageSecretKey } }] }) },
    });
    await connect(rest, makeService(), { PUPPYGRAPH_SECRET_S3: "s3-secret-value" });
    const { body, raw } = await callTool("puppygraph_create_catalog", {
      name: "lake",
      type: "iceberg",
      options: {
        icebergMetastoreType: "rest",
        restUri: "http://rest:8181",
        restWarehouse: "s3://lake/wh",
        storageType: "s3",
        s3AuthType: "accessKeys",
        storageAccessKey: "AKIAEXAMPLE",
        storageRegion: "us-east-1",
        storageEndpoint: "http://s3:8333",
      },
      secret_env: { storageSecretKey: "PUPPYGRAPH_SECRET_S3" },
    });
    expect(body.ok).toBe(true);
    expect(raw).not.toContain("s3-secret-value");
  });

  it("points to the spec when PuppyGraph says the metastore type is unknown", async () => {
    const { rest } = puppygraph({ overrides: { "POST /ui-api/catalog": () => json(500, { errorMessage: "unknown metastoreType:" }) } });
    await connect(rest);
    // A type the bundled form doesn't know is passed through to PuppyGraph.
    const { body } = await callTool("puppygraph_create_catalog", { name: "x", type: "newlake", options: { a: "b" } });
    expect(body.hint).toContain("puppygraph_catalog_spec");
  });
});

describe("table lookups", () => {
  it("reports an unknown table as NOT_FOUND with the closest names", async () => {
    await connect(puppygraph().rest);
    const { body } = await callTool("puppygraph_describe_table", { catalog: "shop", database: "shop", table: "customer" });
    expect(body.error_type).toBe("NOT_FOUND");
    expect(body.error).toContain("customers");
  });

  it("reports an unknown database as NOT_FOUND", async () => {
    await connect(puppygraph().rest);
    const { body } = await callTool("puppygraph_list_tables", { catalog: "shop", database: "Shop" });
    expect(body.error_type).toBe("NOT_FOUND");
    expect(body.error).toContain("crm, public, shop".split(", ")[2]);
  });

  it("flags columns PuppyGraph can't map", async () => {
    await connect(puppygraph().rest);
    const { body } = await callTool("puppygraph_describe_table", { catalog: "shop", database: "shop", table: "customers" });
    expect(body.unsupported_columns).toEqual(["mood"]);
  });

  it("answers STARTING while PuppyGraph has no leader yet", async () => {
    const { rest } = puppygraph({
      overrides: { "GET /ui-api/catalog": () => json(503, { error: "no healthy leader available: no healthy leader available" }) },
    });
    await connect(rest);
    const tablesResult = await callTool("puppygraph_list_tables", { catalog: "shop" });
    expect(tablesResult.body.error_type).toBe("STARTING");
    const validation = await callTool("puppygraph_validate_schema", { schema: { node: [customer] } });
    expect(validation.body.error_type).toBe("STARTING");
  });
});

describe("validate_schema checks", () => {
  async function validate(schema: unknown) {
    await connect(puppygraph().rest);
    return (await callTool("puppygraph_validate_schema", { schema })).body;
  }

  it("accepts a schema whose types and keys line up", async () => {
    const body = await validate({ node: [customer, order], edge: [placed] });
    expect(body).toMatchObject({ valid: true, problems: [], warnings: [] });
  });

  it("rejects a type that differs from the source schemaType, and unmappable columns", async () => {
    const node = {
      ...customer,
      dataSourceGroup: ext("customers", ["customer_id", "name", "score", "mood"]),
      attribute: [{ name: "name", type: "String" }, { name: "score", type: "Double" }, { name: "mood", type: "String" }],
    };
    const body = await validate({ node: [node] });
    expect(body.valid).toBe(false);
    expect(body.problems).toEqual([
      expect.stringContaining("'score' is declared as Double, but column 'score' of 'shop.shop.customers' has schemaType DECIMAL(12,2)"),
      expect.stringContaining("column 'mood' of 'shop.shop.customers' has a source type PuppyGraph can't map"),
    ]);
  });

  it("treats type names case- and space-insensitively", async () => {
    const node = {
      ...customer,
      dataSourceGroup: ext("customers", ["customer_id", "score"]),
      id: [{ name: "customer_id", type: "LONG" }],
      attribute: [{ name: "score", type: "decimal(12, 2)" }],
    };
    expect((await validate({ node: [node] })).valid).toBe(true);
  });

  it("rejects edge keys whose count or type doesn't match the endpoint id", async () => {
    const wrongCount = edge("HAS_LINE", "Order", "OrderLine", "order_lines", [["order_id", "Long"]], [["line_no", "Int"]]);
    const wrongType = edge("BY_STATUS", "Order", "Customer", "orders", [["order_id", "Long"]], [["status", "String"]]);
    const nodes = [customer, order, orderLine];
    const body = await validate({ node: nodes, edge: [wrongCount, wrongType] });
    expect(body.problems).toEqual([
      expect.stringContaining("Edge 'HAS_LINE': toKey has 1 column(s) but node 'OrderLine' has an id of 2 column(s)"),
      expect.stringContaining("Edge 'BY_STATUS': toKey column 'to_status' is String but node 'Customer' id column 'customer_id' is Long"),
    ]);
  });

  it("warns when an edge read from a node's own table seems to point the wrong way", async () => {
    const swapped = edge("BY", "Order", "Customer", "orders", [["customer_id", "Long"]], [["order_id", "Long"]]);
    const body = await validate({ node: [customer, order], edge: [swapped] });
    expect(body.valid).toBe(true);
    expect(body.warnings).toEqual([expect.stringContaining("Edge 'BY': it reads the table of 'Order', but keys that node by a column other than its id")]);
  });

  it("doesn't warn for a self edge whose one side is the id", async () => {
    const referred = edge("REFERRED", "Customer", "Customer", "customers", [["referred_by", "Long"]], [["customer_id", "Long"]]);
    const body = await validate({ node: [customer], edge: [referred] });
    expect(body).toMatchObject({ valid: true, warnings: [] });
  });

  it("reports a table PuppyGraph doesn't know", async () => {
    const node = { ...customer, dataSourceGroup: ext("customer", ["customer_id", "name"]) };
    const body = await validate({ node: [node] });
    expect(body.problems).toEqual([expect.stringContaining("table 'shop.shop.customer' was not found")]);
  });
});

describe("schema navigation", () => {
  const schema = { node: [customer, order], edge: [{ ...placed, type: ["PLACED_ORDER"] }] };

  it("searches labels, relationship labels and attributes", async () => {
    await connect(puppygraph({ schema }).rest);
    const { body } = await callTool("puppygraph_search_schema", { query: "status" });
    expect(body.nodes.map((node: any) => node.label)).toEqual(["Order"]);
    const byRel = await callTool("puppygraph_search_schema", { query: "placed_order" });
    expect(byRel.body.edges[0]).toMatchObject({ label: "PLACED", cypher_labels: ["PLACED_ORDER"], pattern: "(:Customer)-[:PLACED_ORDER]->(:Order)" });
  });

  it("returns one element by node, edge or relationship label", async () => {
    await connect(puppygraph({ schema }).rest);
    expect((await callTool("puppygraph_get_schema_element", { label: "Order" })).body).toMatchObject({
      kind: "node",
      id: [{ name: "order_id", type: "Long" }],
      source: "shop.shop.orders",
    });
    expect((await callTool("puppygraph_get_schema_element", { label: "PLACED_ORDER" })).body.kind).toBe("relationship");
    const missing = await callTool("puppygraph_get_schema_element", { label: "order" });
    expect(missing.body.error_type).toBe("NOT_FOUND");
    expect(missing.body.error).toContain("Order");
  });

  it("returns a skeleton instead of a very large schema", async () => {
    const big = {
      node: Array.from({ length: 400 }, (_, index) => ({ ...customer, label: `Node${index}` })),
      edge: [placed],
    };
    const service = makeService();
    vi.mocked(service.getDataSources).mockResolvedValue({ summary: "PuppyGraph Schema Information", schema: big });
    await connect(puppygraph().rest, service);
    const { body } = await callTool("puppygraph_schema");
    expect(body.schema.node_labels).toHaveLength(400);
    expect(body.schema.relationships).toEqual(["(Customer)-[:PLACED]->(Order)"]);
    expect(body.schema.note).toContain("puppygraph_search_schema");
  });
});

describe("per-element schema edits", () => {
  it("adds the first node to an empty PuppyGraph", async () => {
    const { rest, state } = puppygraph();
    await connect(rest);
    const { body } = await callTool("puppygraph_add_node", { node: customer });
    expect(body).toMatchObject({ ok: true, version: 8, previous_version: 7, ready: true });
    expect(body.changes.nodes.added).toEqual(["Customer"]);
    expect(state.schema.node.map((node: any) => node.label)).toEqual(["Customer"]);
    expect(rest.called("POST", "/schema")[0].options.query).toEqual({ preflight: "true" });
  });

  it("adds an edge once both nodes exist, and keeps the other elements", async () => {
    const { rest, state } = puppygraph({ schema: { node: [customer, order], edge: [] } });
    await connect(rest);
    const { body } = await callTool("puppygraph_add_edge", { edge: placed });
    expect(body.ok).toBe(true);
    expect(state.schema.node).toHaveLength(2);
    expect(state.schema.edge.map((e: any) => e.label)).toEqual(["PLACED"]);
  });

  it("refuses an edge to a node that doesn't exist", async () => {
    const { rest } = puppygraph({ schema: { node: [customer], edge: [] } });
    await connect(rest);
    const { body } = await callTool("puppygraph_add_edge", { edge: placed });
    expect(body.error_type).toBe("INVALID_INPUT");
    expect(body.error).toContain("toNodeLabel 'Order' is not a node");
    expect(rest.called("POST", "/schema")).toHaveLength(0);
  });

  it("refuses an element with problems and changes nothing", async () => {
    const { rest } = puppygraph({ schema: { node: [customer], edge: [] } });
    await connect(rest);
    const bad = { ...order, attribute: [{ name: "status", type: "Long" }] };
    const { body } = await callTool("puppygraph_add_node", { node: bad });
    expect(body.error_type).toBe("VALIDATION_FAILED");
    expect(body.problems).toEqual([expect.stringContaining("Node 'Order': 'status' is declared as Long")]);
    expect(rest.called("POST", "/schema")).toHaveLength(0);
  });

  it("refuses when the schema changed while the change was prepared", async () => {
    const { rest } = puppygraph({ schema: { node: [customer], edge: [] }, versionAfterRead: 9 });
    await connect(rest);
    const { body } = await callTool("puppygraph_add_node", { node: order });
    expect(body.error_type).toBe("CONFLICT");
    expect(rest.called("POST", "/schema")).toHaveLength(0);
  });

  it("applies parallel edits one after another, so none is lost", async () => {
    const { rest, state } = puppygraph({ schema: { node: [customer], edge: [] } });
    await connect(rest);
    const [first, second] = await Promise.all([
      callTool("puppygraph_add_node", { node: order }),
      callTool("puppygraph_add_node", { node: orderLine }),
    ]);
    expect(first.body.ok).toBe(true);
    expect(second.body.ok).toBe(true);
    expect(state.schema.node.map((node: any) => node.label).sort()).toEqual(["Customer", "Order", "OrderLine"]);
  });

  it("refuses an edit when the installed schema's version can't be read", async () => {
    const { rest } = puppygraph({
      schema: { node: [customer], edge: [] },
      overrides: { "GET /ui-api/schema/versions": () => json(500, "boom") },
    });
    await connect(rest);
    const { body } = await callTool("puppygraph_add_node", { node: order });
    expect(body.error).toContain("Could not read the installed schema's version");
    expect(rest.called("POST", "/schema")).toHaveLength(0);
  });

  it("won't remove a node an edge still uses", async () => {
    const { rest } = puppygraph({ schema: { node: [customer, order], edge: [placed] } });
    await connect(rest);
    const { body } = await callTool("puppygraph_remove_node", { label: "Order" });
    expect(body.error).toContain("Edges still use 'Order': PLACED");
  });

  it("adds an attribute with its mapping", async () => {
    const { rest, state } = puppygraph({ schema: { node: [customer], edge: [] } });
    await connect(rest);
    const { body } = await callTool("puppygraph_add_node_attribute", { node_label: "Customer", name: "score", type: "DECIMAL(12,2)" });
    expect(body.ok).toBe(true);
    expect(state.schema.node[0].attribute).toContainEqual({ name: "score", type: "DECIMAL(12,2)" });
    expect(state.schema.node[0].dataSourceGroup.externalDataSource.mappedField).toContainEqual({ sourceFieldName: "score", targetFieldName: "score" });
  });

  it("drops catalogs whose credentials came back masked", async () => {
    const { rest, state } = puppygraph({
      schema: { catalog: [{ name: "shop", jdbc: { password: "******" } }], node: [customer], edge: [] },
    });
    await connect(rest);
    await callTool("puppygraph_add_node", { node: order });
    expect(state.schema.catalog).toBeUndefined();
  });

  it("isn't available in read-only mode", async () => {
    await connect(puppygraph().rest, makeService(), { PUPPYGRAPH_READ_ONLY: "true" });
    const names = (await client!.listTools()).tools.map((tool) => tool.name);
    expect(names).not.toContain("puppygraph_add_node");
    expect(names).toContain("puppygraph_check_edges");
    expect(names).toContain("puppygraph_search_schema");
  });
});

describe("check_edges", () => {
  const schema = {
    node: [customer, order],
    edge: [placed, edge("OPENED", "Customer", "Order", "orders", [["status", "String"]], [["order_id", "Long"]])],
  };

  it("tells edges that reach their nodes from ones that don't", async () => {
    const counts: Array<[RegExp, number]> = [
      [/^MATCH \(n:`Customer`\)/, 50],
      [/^MATCH \(n:`Order`\)/, 200],
      [/^MATCH \(\)-\[r:`PLACED`\]/, 200],
      [/^MATCH \(a:`Customer`\) WITH a MATCH \(a\)-\[r:`PLACED`\]/, 200],
      [/^MATCH \(b:`Order`\) WITH b MATCH \(\)-\[r:`PLACED`\]/, 200],
      [/^MATCH \(\)-\[r:`OPENED`\]/, 30],
      [/^MATCH \(a:`Customer`\) WITH a MATCH \(a\)-\[r:`OPENED`\]/, 0],
      [/^MATCH \(b:`Order`\) WITH b MATCH \(\)-\[r:`OPENED`\]/, 30],
    ];
    const service = makeService((query) => [{ n: counts.find(([pattern]) => pattern.test(query))?.[1] ?? 0 }]);
    await connect(puppygraph({ schema }).rest, service);
    const { body } = await callTool("puppygraph_check_edges");
    expect(body.edges).toEqual([
      expect.objectContaining({ label: "PLACED", rows: 200, reach_source: 200, reach_target: 200, status: "ok" }),
      expect.objectContaining({ label: "OPENED", rows: 30, reach_source: 0, reach_target: 30, status: "broken" }),
    ]);
    expect(body.nodes).toEqual([
      { label: "Customer", rows: 50, distinct_ids: 50 },
      { label: "Order", rows: 200, distinct_ids: 200 },
    ]);
    expect(body.summary).toContain("OPENED");
  });

  it("counts edge rows with Gremlin, where Cypher only returns edges whose nodes exist", async () => {
    // Newer PuppyGraph: Cypher drops edges whose endpoints don't exist, so a
    // wrong key looks like an empty table. g.E() still counts the rows.
    // Gremlin's g.V().outE()/inE() check one side each.
    const service = makeService((query) => [{ n: /OPENED/.test(query) ? 0 : 200, d: 200 }]);
    vi.mocked(service.executeGremlin).mockImplementation(async ({ query }: { query: string }) => ({
      data: [query.startsWith("g.E()") ? 30 : query.includes(".outE(") ? 0 : 30],
    }) as any);
    await connect(puppygraph({ schema }).rest, service);
    const { body } = await callTool("puppygraph_check_edges", { labels: ["OPENED"] });
    expect(body.edges[0]).toMatchObject({ label: "OPENED", rows: 30, reach_source: 0, reach_target: 30, status: "broken" });
    expect(body.edges[0].note).toContain("No edge row reaches a 'Customer' node");
    expect(vi.mocked(service.executeGremlin).mock.calls.map(([call]: any) => call.query)).toEqual([
      'g.E().hasLabel("OPENED").count()',
      'g.V().hasLabel("Customer").outE("OPENED").count()',
      'g.V().hasLabel("Order").inE("OPENED").count()',
    ]);
  });

  it("flags partly dangling edges as suspect below 95%", async () => {
    const service = makeService((query) => {
      if (/WITH a/.test(query)) return [{ n: 50 }];
      return [{ n: /^MATCH \(n:/.test(query) ? 10 : 200 }];
    });
    await connect(puppygraph({ schema: { node: [customer, order], edge: [placed] } }).rest, service);
    const { body } = await callTool("puppygraph_check_edges", { labels: ["PLACED"] });
    expect(body.edges[0]).toMatchObject({ status: "suspect", source_hit_rate: 0.25 });
  });

  it("flags nodes whose ids repeat, and the edges they multiply", async () => {
    const service = makeService((query) => {
      if (/^MATCH \(n:`Order`\)/.test(query)) return [{ n: 4, d: 3 }];
      if (/^MATCH \(n:/.test(query)) return [{ n: 50, d: 50 }];
      if (/WITH b/.test(query)) return [{ n: 6 }];
      return [{ n: 4 }];
    });
    await connect(puppygraph({ schema: { node: [customer, order], edge: [placed] } }).rest, service);
    const { body } = await callTool("puppygraph_check_edges");
    expect(body.nodes[1]).toMatchObject({ label: "Order", rows: 4, distinct_ids: 3 });
    expect(body.nodes[1].note).toContain("isn't unique");
    expect(body.edges[0]).toMatchObject({ status: "suspect", reach_target: 6 });
    expect(body.summary).toContain("nodes with duplicate ids: Order");
  });

  it("rejects unknown labels", async () => {
    await connect(puppygraph({ schema }).rest);
    const { body } = await callTool("puppygraph_check_edges", { labels: ["NOPE"] });
    expect(body.error_type).toBe("NOT_FOUND");
  });
});

describe("upload_schema", () => {
  it("reports the changes and waits until new labels answer", async () => {
    let calls = 0;
    // The first count after the upload answers 0, as PuppyGraph sometimes does.
    const service = makeService(() => [{ n: calls++ === 0 ? 0 : 5 }]);
    const { rest } = puppygraph({ schema: { node: [customer], edge: [] } });
    await connect(rest, service);
    const { body } = await callTool("puppygraph_upload_schema", { schema: { node: [customer, order], edge: [placed] }, replace: true });
    expect(body).toMatchObject({ ok: true, ready: true });
    expect(body.changes).toEqual({
      nodes: { added: ["Order"], removed: [], changed: [] },
      edges: { added: ["PLACED"], removed: [], changed: [] },
    });
    expect(calls).toBeGreaterThan(1);
  });
});

describe("secret field names", () => {
  it.each(["sharedKey", "snowflakeKeyFilePWD", "bigqueryAdbcKeyJson", "metastoreClientId", "storageSecretKey", "jdbcPassword"])(
    "masks %s",
    (key) => expect(isSecretKey(key)).toBe(true),
  );
  it.each(["restCatalogVendedCredentialsMode", "useDefaultCredentialsProviderChain", "snowflakeOAuthTokenRequestUrl", "restGcpAuthCredentialsPath", "tokenFile"])(
    "leaves %s readable",
    (key) => expect(isSecretKey(key)).toBe(false),
  );
});

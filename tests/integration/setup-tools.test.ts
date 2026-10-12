import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PuppyGraphRestClient,
  RestConnectionError,
  type PuppyGraphRestLike,
  type RestRequest,
  type RestResponse,
} from "../../src/clients/rest.js";
import {
  createPuppyGraphServer,
  type PuppyGraphServiceLike,
} from "../../src/server.js";
import { SCHEMA_TEMPLATE } from "../../src/setup/template.js";

const PASSWORD = "S3cret-Pg-Pw";

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
    if (!route) {
      return json(404, "404 page not found");
    }
    return route(options);
  }

  called(method: string, path: string) {
    return this.calls.filter((call) => call.method === method && call.path === path);
  }
}

const registeredCatalog = {
  name: "pg",
  type: "postgresql",
  jdbc: {
    username: "postgres",
    password: "******",
    jdbcUri: "jdbc:postgresql://pgdb:5432/postgres",
    driverClass: "org.postgresql.Driver",
  },
};

const columns: Record<string, string[]> = {
  accounts: ["account_id", "name"],
  devices: ["device_id"],
  account_devices: ["id", "account_id", "device_id", "first_seen"],
};

// A PuppyGraph with one catalog 'pg' whose tables match the schema template
// (with catalog renamed to 'pg').
function baseRoutes(overrides: Record<string, Route> = {}): Record<string, Route> {
  return {
    "GET /ui-api/catalog": () => json(200, { catalogs: [registeredCatalog] }),
    "GET /ui-api/column": ({ query }) => {
      const table = columns[query?.tableName || ""];
      return table && query?.catalogName === "pg" && query?.databaseName === "public"
        ? json(200, {
            ok: true,
            column: table.map((name) => ({ name, type: "BIGINT", schemaType: "LONG" })),
          })
        : json(500, "rpc error: code = Unknown desc = Application error processing RPC");
    },
    "GET /schemajson": () => json(200, {}),
    "GET /ui-api/schema/versions": () =>
      json(200, { versions: [{ version: 4, isLive: true }, { version: 3, isLive: false }] }),
    "POST /schema": () =>
      json(200, { ok: true, version: 5, message: "Schema uploaded successfully" }),
    ...overrides,
  };
}

function templateSchema(): any {
  return JSON.parse(JSON.stringify(SCHEMA_TEMPLATE).replaceAll("my_catalog", "pg"));
}

const service: PuppyGraphServiceLike = {
  executeGremlin: vi.fn(),
  executeCypher: vi.fn(),
  getDataSources: vi.fn(),
  getConnectionStatus: vi.fn().mockReturnValue({
    connected: true,
    neo4jConnected: true,
    gremlinConnected: true,
    connectionError: null,
    fallbackMode: false,
  }),
};

let client: Client | undefined;
let server: McpServer | undefined;

async function connect(
  rest: PuppyGraphRestLike,
  environment: NodeJS.ProcessEnv = {},
): Promise<Client> {
  const readOnly = environment.PUPPYGRAPH_READ_ONLY === "true";
  server = createPuppyGraphServer(service, environment, readOnly, rest);
  client = new Client({ name: "setup-tools-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
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

describe("catalog tools", () => {
  it("lists catalogs with credentials masked, even if the server sends them", async () => {
    const leaky = { ...registeredCatalog, jdbc: { ...registeredCatalog.jdbc, password: PASSWORD } };
    await connect(new FakeRest(baseRoutes({
      "GET /ui-api/catalog": () => json(200, { catalogs: [leaky] }),
    })));

    const { body, raw } = await callTool("puppygraph_list_catalogs");

    expect(body.catalogs[0]).toMatchObject({ name: "pg", type: "postgresql" });
    expect(body.catalogs[0].jdbc.password).toBe("******");
    expect(raw).not.toContain(PASSWORD);
  });

  it("creates a JDBC catalog with the form field names and never returns or logs the password", async () => {
    const logs = vi.spyOn(console, "error").mockImplementation(() => {});
    const rest = new FakeRest(baseRoutes({
      // Whatever the server sends back, the password must not reach the agent.
      "POST /ui-api/catalog": () =>
        json(200, { catalogs: [{ ...registeredCatalog, jdbc: { ...registeredCatalog.jdbc, password: PASSWORD } }] }),
    }));
    await connect(rest);

    const { body, raw, isError } = await callTool("puppygraph_create_catalog", {
      name: "pg",
      type: "postgresql",
      jdbc_uri: "jdbc:postgresql://pgdb:5432/postgres",
      username: "postgres",
      password: PASSWORD,
    });

    expect(isError).toBe(false);
    expect(rest.called("POST", "/ui-api/catalog")[0].options.body).toEqual({
      catalogs: [{
        catalogName: "pg",
        catalogType: "postgresql",
        jdbcUri: "jdbc:postgresql://pgdb:5432/postgres",
        jdbcUsername: "postgres",
        jdbcPassword: PASSWORD,
        driverClass: "org.postgresql.Driver",
      }],
    });
    expect(body.ok).toBe(true);
    expect(body.catalog.jdbc.password).toBe("******");
    expect(raw).not.toContain(PASSWORD);
    expect(logs.mock.calls.flat().join("\n")).not.toContain(PASSWORD);
  });

  it("reads the password from the server environment with password_env", async () => {
    const rest = new FakeRest(baseRoutes({
      "POST /ui-api/catalog": () => json(200, { catalogs: [registeredCatalog] }),
    }));
    await connect(rest, { PUPPYGRAPH_SECRET_PG_PASSWORD: PASSWORD });

    const { isError, raw } = await callTool("puppygraph_create_catalog", {
      name: "pg",
      type: "postgresql",
      jdbc_uri: "jdbc:postgresql://pgdb:5432/postgres",
      username: "postgres",
      password_env: "PUPPYGRAPH_SECRET_PG_PASSWORD",
    });

    expect(isError).toBe(false);
    expect((rest.called("POST", "/ui-api/catalog")[0].options.body as any).catalogs[0].jdbcPassword).toBe(PASSWORD);
    expect(raw).not.toContain(PASSWORD);
  });

  it("rejects an unset password_env variable without calling PuppyGraph", async () => {
    const rest = new FakeRest(baseRoutes());
    await connect(rest);

    const { body, isError } = await callTool("puppygraph_create_catalog", {
      name: "pg",
      type: "postgresql",
      jdbc_uri: "jdbc:postgresql://pgdb:5432/postgres",
      password_env: "PUPPYGRAPH_SECRET_MISSING",
    });

    expect(isError).toBe(true);
    expect(body.error_type).toBe("INVALID_INPUT");
    expect(body.error).toContain("PUPPYGRAPH_SECRET_MISSING");
    expect(rest.called("POST", "/ui-api/catalog")).toHaveLength(0);
  });

  it("reads other variables only when the operator allowlists them by exact name", async () => {
    const rest = new FakeRest(baseRoutes({
      "POST /ui-api/catalog": () => json(200, { catalogs: [registeredCatalog] }),
    }));
    await connect(rest, {
      DB_PASS: PASSWORD,
      DB_PASS_OTHER: "other-secret-1234",
      PUPPYGRAPH_MCP_SECRET_ENV_ALLOWLIST: " DB_PASS , OTHER ",
    });
    const base = { name: "pg", type: "postgresql", jdbc_uri: "jdbc:postgresql://pgdb:5432/postgres" };

    const allowed = await callTool("puppygraph_create_catalog", { ...base, password_env: "DB_PASS" });
    expect(allowed.isError).toBe(false);
    expect((rest.called("POST", "/ui-api/catalog")[0].options.body as any).catalogs[0].jdbcPassword).toBe(PASSWORD);

    const prefixOnly = await callTool("puppygraph_create_catalog", { ...base, password_env: "DB_PASS_OTHER" });
    expect(prefixOnly.body.error_type).toBe("INVALID_INPUT");
    expect(prefixOnly.raw).not.toContain("other-secret-1234");
  });

  it("refuses a disallowed variable the same way whether or not it exists", async () => {
    await connect(new FakeRest(baseRoutes()), { AWS_SECRET_ACCESS_KEY: "cloud-key-1234" });
    const base = { name: "x", type: "postgresql", jdbc_uri: "jdbc:postgresql://h/x" };

    const existing = await callTool("puppygraph_create_catalog", { ...base, password_env: "AWS_SECRET_ACCESS_KEY" });
    const missing = await callTool("puppygraph_create_catalog", { ...base, password_env: "AWS_SECRET_ACCESS_KEX" });

    expect(existing.body.error.replace("AWS_SECRET_ACCESS_KEY", "NAME")).toBe(
      missing.body.error.replace("AWS_SECRET_ACCESS_KEX", "NAME"),
    );
    expect(existing.raw).not.toContain("cloud-key-1234");
  });

  it("scrubs secrets sent in a JDBC URI or through secret_env from echoed errors", async () => {
    await connect(new FakeRest(baseRoutes({
      "POST /ui-api/catalog": ({ body }: any) => {
        const sent = body.catalogs[0];
        return json(500, { errorMessage: `login failed: '${sent.secretKey}' / '${sent.jdbcUri}' / uri-pw-9876` });
      },
    })), { PUPPYGRAPH_SECRET_S3: "s3-secret-5555" });

    const { raw } = await callTool("puppygraph_create_catalog", {
      name: "lake",
      type: "postgresql",
      jdbc_uri: "jdbc:postgresql://app:uri-pw-9876@db:5432/x",
      options: { metastore: {} },
      secret_env: { secretKey: "PUPPYGRAPH_SECRET_S3" },
    });

    expect(raw).toContain("login failed");
    expect(raw).not.toContain("uri-pw-9876");
    expect(raw).not.toContain("s3-secret-5555");
  });

  it.each([
    ["password_env", { password_env: "AWS_SECRET_ACCESS_KEY" }],
    ["secret_env", { options: { metastore: {} }, secret_env: { secretKey: "PUPPYGRAPH_PASSWORD" } }],
  ])("only reads %s variables with the PUPPYGRAPH_SECRET_ prefix", async (_name, extra) => {
    const rest = new FakeRest(baseRoutes());
    await connect(rest, { AWS_SECRET_ACCESS_KEY: "cloud-key-1234", PUPPYGRAPH_PASSWORD: "bolt-pw-1234" });

    const { body, raw } = await callTool("puppygraph_create_catalog", {
      name: "exfil",
      type: "postgresql",
      jdbc_uri: "jdbc:postgresql://attacker.example:5432/x",
      ...extra,
    });

    expect(body.error_type).toBe("INVALID_INPUT");
    expect(body.error).toContain("PUPPYGRAPH_SECRET_");
    expect(raw).not.toContain("cloud-key-1234");
    expect(raw).not.toContain("bolt-pw-1234");
    expect(rest.called("POST", "/ui-api/catalog")).toHaveLength(0);
  });

  it("passes connection errors through with the password scrubbed", async () => {
    await connect(new FakeRest(baseRoutes({
      "POST /ui-api/catalog": () =>
        json(500, {
          errorMessage: `Failed to initialize pool: password authentication failed (tried '${PASSWORD}')`,
          catalogSchema: "{}",
        }),
    })));

    const { body, raw, isError } = await callTool("puppygraph_create_catalog", {
      name: "pg2",
      type: "postgresql",
      jdbc_uri: `jdbc:postgresql://postgres:${PASSWORD}@pgdb:5432/postgres?password=${PASSWORD}`,
      password: PASSWORD,
    });

    expect(isError).toBe(true);
    expect(body.error_type).toBe("UPSTREAM_ERROR");
    expect(body.error).toContain("password authentication failed");
    expect(raw).not.toContain(PASSWORD);
  });

  it("scrubs account keys passed in options from echoed errors and results", async () => {
    await connect(new FakeRest(baseRoutes({
      "POST /ui-api/catalog": ({ body }: any) =>
        json(500, { errorMessage: `auth failed for key ${body.catalogs[0].accountKey}` }),
    })));

    const { body, raw } = await callTool("puppygraph_create_catalog", {
      name: "lake",
      type: "deltalake",
      options: { accountName: "acct", accountKey: "azure-key-1234" },
    });

    expect(body.error).toContain("auth failed for key");
    expect(raw).not.toContain("azure-key-1234");
  });

  it("reports a name clash as ALREADY_EXISTS", async () => {
    await connect(new FakeRest(baseRoutes({
      "POST /ui-api/catalog": () =>
        json(500, { errorMessage: "a catalog with this name already exists", catalogSchema: "{}" }),
    })));

    const { body } = await callTool("puppygraph_create_catalog", {
      name: "pg",
      type: "postgresql",
      jdbc_uri: "jdbc:postgresql://pgdb:5432/postgres",
    });

    expect(body.error_type).toBe("ALREADY_EXISTS");
  });

  it("returns NOT_FOUND for an unknown catalog instead of the server's RPC error", async () => {
    const rest = new FakeRest(baseRoutes());
    await connect(rest);

    const { body, isError } = await callTool("puppygraph_test_catalog", { catalog: "nope" });

    expect(isError).toBe(true);
    expect(body.error_type).toBe("NOT_FOUND");
    expect(body.error).toContain("Registered catalogs: pg");
    expect(rest.called("GET", "/ui-api/validateCatalog")).toHaveLength(0);
  });

  it("tests a catalog", async () => {
    await connect(new FakeRest(baseRoutes({
      "GET /ui-api/validateCatalog": () =>
        json(200, { ok: true, validate_message: "Successfully query data from `public`.`accounts`" }),
    })));

    const { body } = await callTool("puppygraph_test_catalog", { catalog: "pg" });

    expect(body).toMatchObject({ ok: true, catalog: "pg" });
  });

  it("lists databases, then tables, then columns", async () => {
    await connect(new FakeRest(baseRoutes({
      "GET /ui-api/database": () => json(200, { ok: true, database: ["public"] }),
      "GET /ui-api/table": () => json(200, { ok: true, table: ["accounts", "devices"] }),
    })));

    expect((await callTool("puppygraph_list_tables", { catalog: "pg" })).body.databases).toEqual(["public"]);
    expect(
      (await callTool("puppygraph_list_tables", { catalog: "pg", database: "public" })).body.tables,
    ).toEqual(["accounts", "devices"]);
    const described = await callTool("puppygraph_describe_table", {
      catalog: "pg",
      database: "public",
      table: "accounts",
    });
    expect(described.body.columns.map((column: any) => column.name)).toEqual(["account_id", "name"]);
  });

  it("reports an unreachable PuppyGraph as CONNECTION_FAILED", async () => {
    await connect(new FakeRest({
      "GET /ui-api/catalog": () => {
        throw new RestConnectionError("Unable to connect to PuppyGraph at http://puppygraph-test:8081/", false);
      },
    }));

    const { body } = await callTool("puppygraph_list_catalogs");

    expect(body.error_type).toBe("CONNECTION_FAILED");
    expect(body.error).toContain("PUPPYGRAPH_HTTP_URL");
  });

  it("reports a malformed HTTP URL as a configuration error", async () => {
    await connect(new PuppyGraphRestClient({ url: "http://[not-a-host", username: "u", password: "p" }));

    const { body } = await callTool("puppygraph_list_catalogs");

    expect(body.error_type).toBe("CONNECTION_FAILED");
    expect(body.error).toContain("is not a valid URL");
  });

  it("reports rejected credentials during validation as AUTHENTICATION_FAILED, not a schema problem", async () => {
    const rest = new FakeRest(baseRoutes({ "POST /ui-api/convertSchema": () => json(401, "Unauthorized") }));
    await connect(rest);

    const { body } = await callTool("puppygraph_upload_schema", {
      schema: { graph: { vertices: [], edges: [] } },
    });

    expect(body.error_type).toBe("AUTHENTICATION_FAILED");
    expect(rest.called("POST", "/schema")).toHaveLength(0);
  });

  it("reports rejected HTTP credentials as AUTHENTICATION_FAILED", async () => {
    await connect(new FakeRest({ "GET /ui-api/catalog": () => json(401, "Unauthorized") }));

    const { body } = await callTool("puppygraph_list_catalogs");

    expect(body.error_type).toBe("AUTHENTICATION_FAILED");
    expect(body.error).toContain("PUPPYGRAPH_SCHEMA_PASSWORD");
  });
});

describe("schema tools", () => {
  it("returns a template that passes validation", async () => {
    await connect(new FakeRest(baseRoutes()));

    const template = (await callTool("puppygraph_schema_template")).body;
    expect(template.notes.length).toBeGreaterThan(0);

    const { body } = await callTool("puppygraph_validate_schema", { schema: templateSchema() });
    expect(body).toMatchObject({ valid: true, problems: [], tables_checked: 3 });
  });

  it("finds bad columns, unknown nodes, unmapped columns and unknown catalogs", async () => {
    await connect(new FakeRest(baseRoutes()));
    const schema = templateSchema();
    schema.node[0].dataSourceGroup.externalDataSource.mappedField[1].sourceFieldName = "nme";
    schema.node[1].dataSourceGroup.externalDataSource.catalog = "missing";
    schema.edge[0].toNodeLabel = "Phone";
    schema.edge[0].attribute.push({ name: "last_seen", type: "DateTime" });

    const { body } = await callTool("puppygraph_validate_schema", { schema: JSON.stringify(schema) });

    expect(body.valid).toBe(false);
    expect(body.problems).toEqual(expect.arrayContaining([
      "Node 'Account': mapped source field 'nme' not found in remote table 'pg.public.accounts'. Available columns: account_id, name",
      expect.stringContaining("Node 'Device': catalog 'missing' is not registered"),
      "Edge 'USES': toNodeLabel 'Phone' is not a node label in this schema.",
      expect.stringContaining("Edge 'USES': declares column(s) last_seen but no mappedField targets them"),
    ]));
  });

  it("reports a missing table with the server's message", async () => {
    await connect(new FakeRest(baseRoutes()));
    const schema = templateSchema();
    schema.node[1].dataSourceGroup.externalDataSource.table = "gadgets";

    const { body } = await callTool("puppygraph_validate_schema", { schema });

    expect(body.problems).toEqual([
      expect.stringContaining("Node 'Device': cannot read table 'pg.public.gadgets'"),
    ]);
  });

  it("rejects conflicting mappings to one target and warns about identical ones", async () => {
    await connect(new FakeRest(baseRoutes()));
    const schema = templateSchema();
    const fields = schema.node[0].dataSourceGroup.externalDataSource.mappedField;
    fields.push({ sourceFieldName: "account_id", targetFieldName: "name" });
    fields.push({ sourceFieldName: "account_id", targetFieldName: "id" });

    const { body } = await callTool("puppygraph_validate_schema", { schema });

    expect(body.problems).toEqual([
      "Node 'Account': target field 'name' is mapped more than once (from 'name' and 'account_id'); map each target exactly once.",
    ]);
    expect(body.warnings).toEqual([
      "Node 'Account': target field 'id' is mapped twice from the same source; remove the duplicate.",
    ]);
  });

  it("reports entries that are not objects", async () => {
    await connect(new FakeRest(baseRoutes()));
    const schema = templateSchema();
    schema.node.push(123);

    const { body } = await callTool("puppygraph_validate_schema", { schema });

    expect(body.valid).toBe(false);
    expect(body.problems).toEqual(["node[2] must be an object."]);
  });

  it("converts a 0.x schema and masks the password in the converted schema", async () => {
    const converted = { catalog: [{ name: "pg", type: "postgresql", jdbc: { username: "postgres", password: PASSWORD } }], ...templateSchema() };
    const rest = new FakeRest(baseRoutes({
      "POST /ui-api/convertSchema": () => json(200, converted),
    }));
    await connect(rest);
    const legacy = {
      catalogs: [{ name: "pg", type: "postgresql", jdbc: { username: "postgres", password: PASSWORD } }],
      graph: { vertices: [], edges: [] },
    };

    const { body, raw } = await callTool("puppygraph_validate_schema", { schema: legacy });

    expect(rest.called("POST", "/ui-api/convertSchema")[0].options.body).toMatchObject({
      createLocalTable: false,
      defaultDataSource: "external",
    });
    expect(body.converted_from_0x).toBe(true);
    expect(body.converted_schema.catalog[0].jdbc.password).toBe("******");
    expect(raw).not.toContain(PASSWORD);
  });

  it("uploads to an empty PuppyGraph with preflight and without allowCatalogUpdate", async () => {
    const rest = new FakeRest(baseRoutes());
    await connect(rest);

    const { body, isError } = await callTool("puppygraph_upload_schema", { schema: templateSchema() });

    expect(isError).toBe(false);
    expect(body).toMatchObject({ ok: true, version: 5, previous_version: null });
    const upload = rest.called("POST", "/schema")[0];
    expect(upload.options.query).toEqual({ preflight: "true" });
    expect(upload.options.body).toEqual(templateSchema());
  });

  describe("0.x schemas", () => {
    const legacy = {
      catalogs: [{ name: "pg", type: "postgresql", jdbc: { username: "postgres", password: PASSWORD } }],
      graph: { vertices: [{ label: "Account" }], edges: [] },
    };
    const convertedWith = (password: string) => ({
      catalog: [{ name: "pg", type: "postgresql", jdbc: { username: "postgres", password } }],
      ...templateSchema(),
    });

    it("uploads the original 0.x schema, never the converted one with masked credentials", async () => {
      const rest = new FakeRest(baseRoutes({
        // Servers that mask credentials in convertSchema output.
        "POST /ui-api/convertSchema": () => json(200, convertedWith("******")),
      }));
      await connect(rest);

      const { body, isError } = await callTool("puppygraph_upload_schema", { schema: legacy });

      expect(isError).toBe(false);
      expect(body.ok).toBe(true);
      const uploads = rest.called("POST", "/schema");
      expect(uploads).toHaveLength(1);
      expect(uploads[0].options.body).toEqual(legacy);
    });

    it("falls back to the converted schema when the server can't convert 0.x on upload", async () => {
      let calls = 0;
      const rest = new FakeRest(baseRoutes({
        "POST /ui-api/convertSchema": () => json(200, convertedWith(PASSWORD)),
        "POST /schema": () =>
          ++calls === 1
            ? json(400, { ok: false, error: 'Failed to parse schema: proto: (line 1:2): unknown field "catalogs"' })
            : json(200, { ok: true, version: 2, message: "Schema uploaded successfully" }),
      }));
      await connect(rest);

      const { body, raw } = await callTool("puppygraph_upload_schema", { schema: legacy });

      expect(body).toMatchObject({ ok: true, version: 2 });
      expect(body.warnings).toEqual(expect.arrayContaining([
        expect.stringContaining("doesn't convert 0.x schemas on upload"),
      ]));
      const uploads = rest.called("POST", "/schema");
      expect(uploads.map((upload) => upload.options.body)).toEqual([legacy, convertedWith(PASSWORD)]);
      expect(raw).not.toContain(PASSWORD);
    });

    it("refuses the fallback when the converted schema has masked credentials", async () => {
      const rest = new FakeRest(baseRoutes({
        "POST /ui-api/convertSchema": () => json(200, convertedWith("******")),
        "POST /schema": () =>
          json(400, { ok: false, error: 'Failed to parse schema: proto: (line 1:2): unknown field "catalogs"' }),
      }));
      await connect(rest);

      const { body } = await callTool("puppygraph_upload_schema", { schema: legacy });

      expect(body.error_type).toBe("UPSTREAM_ERROR");
      expect(body.error).toContain("masked or missing catalog credentials");
      expect(rest.called("POST", "/schema")).toHaveLength(1);
    });

    it("refuses the fallback when conversion dropped one credential and duplicated another", async () => {
      const twoCatalogs = {
        catalogs: [
          { name: "a", type: "postgresql", jdbc: { username: "u", password: "pw-alpha-1" } },
          { name: "b", type: "postgresql", jdbc: { username: "u", password: "pw-bravo-2" } },
        ],
        graph: { vertices: [{ label: "Account" }], edges: [] },
      };
      const rest = new FakeRest(baseRoutes({
        "POST /ui-api/convertSchema": () =>
          json(200, {
            catalog: [
              { name: "a", type: "postgresql", jdbc: { username: "u", password: "pw-alpha-1" } },
              { name: "b", type: "postgresql", jdbc: { username: "u", password: "pw-alpha-1" } },
            ],
            ...templateSchema(),
          }),
        "POST /schema": () =>
          json(400, { ok: false, error: 'Failed to parse schema: proto: (line 1:2): unknown field "catalogs"' }),
      }));
      await connect(rest);

      const { body, raw } = await callTool("puppygraph_upload_schema", { schema: twoCatalogs });

      expect(body.error_type).toBe("UPSTREAM_ERROR");
      expect(body.error).toContain("masked or missing catalog credentials");
      expect(rest.called("POST", "/schema")).toHaveLength(1);
      expect(raw).not.toContain("pw-alpha-1");
      expect(raw).not.toContain("pw-bravo-2");
    });
  });

  it("refuses to upload an invalid schema without calling POST /schema", async () => {
    const rest = new FakeRest(baseRoutes());
    await connect(rest);
    const schema = templateSchema();
    schema.edge[0].fromNodeLabel = "Nobody";

    const { body, isError } = await callTool("puppygraph_upload_schema", { schema });

    expect(isError).toBe(true);
    expect(body.error_type).toBe("VALIDATION_FAILED");
    expect(body.problems).toEqual(["Edge 'USES': fromNodeLabel 'Nobody' is not a node label in this schema."]);
    expect(rest.called("POST", "/schema")).toHaveLength(0);
  });

  it("refuses to replace an installed schema unless replace is true", async () => {
    const rest = new FakeRest(baseRoutes({
      "GET /schemajson": () => json(200, { node: [{ label: "Person" }], edge: [{ label: "KNOWS" }] }),
    }));
    await connect(rest);

    const refused = await callTool("puppygraph_upload_schema", { schema: templateSchema() });
    expect(refused.body.error_type).toBe("REPLACE_REQUIRED");
    expect(refused.body.error).toContain("version 4");
    expect(refused.body.installed).toEqual({ nodes: ["Person"], edges: ["KNOWS"] });
    expect(rest.called("POST", "/schema")).toHaveLength(0);

    const replaced = await callTool("puppygraph_upload_schema", { schema: templateSchema(), replace: true });
    expect(replaced.body).toMatchObject({ ok: true, version: 5, previous_version: 4 });
    expect(rest.called("POST", "/schema")).toHaveLength(1);
  });

  it.each([
    ["a string", "<html>login</html>"],
    ["null", null],
    ["node that is not an array", { node: { label: "Person" } }],
  ])("refuses to upload when the installed schema can't be read (%s)", async (_name, live) => {
    const rest = new FakeRest(baseRoutes({ "GET /schemajson": () => json(200, live) }));
    await connect(rest);

    const { body } = await callTool("puppygraph_upload_schema", { schema: templateSchema() });

    expect(body.error_type).toBe("UPSTREAM_ERROR");
    expect(body.error).toContain("nothing was uploaded");
    expect(rest.called("POST", "/schema")).toHaveLength(0);
  });

  it("passes PuppyGraph's rejection through with credentials scrubbed", async () => {
    const schema = { catalog: [{ name: "pg", type: "postgresql", jdbc: { password: PASSWORD } }], ...templateSchema() };
    await connect(new FakeRest(baseRoutes({
      "POST /schema": () =>
        json(400, { ok: false, error: `Pre-flight validation failed: 1 schema problem(s) found (password ${PASSWORD})` }),
    })));

    const { body, raw } = await callTool("puppygraph_upload_schema", { schema });

    expect(body.error_type).toBe("UPSTREAM_ERROR");
    expect(body.error).toContain("installed schema is unchanged");
    expect(body.error).toContain("Pre-flight validation failed");
    expect(raw).not.toContain(PASSWORD);
  });
});

describe("setup tools in read-only mode", () => {
  it("does not register the write tools and keeps the read tools", async () => {
    await connect(new FakeRest(baseRoutes()), { PUPPYGRAPH_READ_ONLY: "true" });

    const names = (await client!.listTools()).tools.map((tool) => tool.name);

    expect(names).not.toContain("puppygraph_create_catalog");
    expect(names).not.toContain("puppygraph_upload_schema");
    expect(names).toEqual(expect.arrayContaining([
      "puppygraph_list_catalogs",
      "puppygraph_test_catalog",
      "puppygraph_list_tables",
      "puppygraph_describe_table",
      "puppygraph_schema_template",
      "puppygraph_validate_schema",
    ]));
    const status = (await client!.listTools()).tools.find((tool) => tool.name === "puppygraph_status");
    expect(status?.description).toContain("create catalogs and upload schemas are disabled");
  });

  it("rejects calls to the write tools without contacting PuppyGraph", async () => {
    const rest = new FakeRest(baseRoutes());
    await connect(rest, { PUPPYGRAPH_READ_ONLY: "true" });

    for (const [name, args] of [
      ["puppygraph_create_catalog", { name: "pg", type: "postgresql", jdbc_uri: "jdbc:postgresql://x/y" }],
      ["puppygraph_upload_schema", { schema: templateSchema() }],
    ] as const) {
      const result = (await client!.callTool({ name, arguments: args })) as { isError?: boolean };
      expect(result.isError).toBe(true);
    }
    expect(rest.calls).toHaveLength(0);
  });
});

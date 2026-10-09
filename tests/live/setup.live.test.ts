import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Goes from a PuppyGraph without the fixture catalog to a queried graph,
 * through the MCP tools only. It REPLACES the installed schema, so it only
 * runs with PUPPYGRAPH_LIVE_SETUP_TEST=true, against a throwaway PuppyGraph.
 *
 * Needs a PostgreSQL loaded with tests/live/fixtures/setup.sql and:
 *   PUPPYGRAPH_LIVE_JDBC_URI     JDBC URI as PuppyGraph reaches it
 *   PUPPYGRAPH_LIVE_JDBC_USER    database user
 *   PUPPYGRAPH_LIVE_JDBC_PASSWORD  database password (passed via password_env)
 */
const enabled = process.env.PUPPYGRAPH_LIVE_SETUP_TEST === "true";
const describeLive = enabled ? describe : describe.skip;

const jdbcUri = process.env.PUPPYGRAPH_LIVE_JDBC_URI || "";
const jdbcUser = process.env.PUPPYGRAPH_LIVE_JDBC_USER || "";
const jdbcPassword = process.env.PUPPYGRAPH_LIVE_JDBC_PASSWORD || "";
const catalog = `mcp_live_${Date.now()}`;

function stringEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

describeLive("live catalog and schema setup through MCP", () => {
  let client: Client;
  let stderrOutput = "";
  let rawResults = "";

  async function tool(name: string, args: Record<string, unknown> = {}) {
    const result = (await client.callTool({ name, arguments: args })) as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };
    rawResults += JSON.stringify(result);
    return { isError: result.isError === true, body: JSON.parse(result.content[0].text) };
  }

  beforeAll(async () => {
    expect(jdbcUri && jdbcUser && jdbcPassword).toBeTruthy();
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["build/index.js"],
      cwd: process.cwd(),
      env: stringEnvironment(),
      stderr: "pipe",
    });
    transport.stderr?.on("data", (chunk) => {
      stderrOutput += chunk.toString();
    });
    client = new Client({ name: "puppygraph-live-setup-test", version: "1.0.0" });
    await client.connect(transport);
  }, 30_000);

  afterAll(async () => {
    await client?.close();
  });

  it("creates a catalog, explores it, uploads a schema and queries the graph", async () => {
    const created = await tool("puppygraph_create_catalog", {
      name: catalog,
      type: "postgresql",
      jdbc_uri: jdbcUri,
      username: jdbcUser,
      password_env: "PUPPYGRAPH_LIVE_JDBC_PASSWORD",
    });
    expect(created).toMatchObject({ isError: false, body: { ok: true, catalog: { name: catalog } } });

    const again = await tool("puppygraph_create_catalog", {
      name: catalog,
      type: "postgresql",
      jdbc_uri: jdbcUri,
      username: jdbcUser,
      password: jdbcPassword,
    });
    expect(again.body.error_type).toBe("ALREADY_EXISTS");

    const listed = await tool("puppygraph_list_catalogs");
    const entry = listed.body.catalogs.find((item: any) => item.name === catalog);
    expect(entry.jdbc.password).toBe("******");

    expect((await tool("puppygraph_test_catalog", { catalog })).body.ok).toBe(true);
    expect((await tool("puppygraph_test_catalog", { catalog: `${catalog}_missing` })).body.error_type).toBe("NOT_FOUND");

    expect((await tool("puppygraph_list_tables", { catalog })).body.databases).toContain("public");
    expect((await tool("puppygraph_list_tables", { catalog, database: "public" })).body.tables).toEqual(
      expect.arrayContaining(["accounts", "devices", "account_devices"]),
    );
    const described = await tool("puppygraph_describe_table", { catalog, database: "public", table: "accounts" });
    expect(described.body.columns.map((column: any) => column.name)).toEqual(["account_id", "name"]);

    const template = (await tool("puppygraph_schema_template")).body.template;
    const schema = JSON.parse(JSON.stringify(template).replaceAll("my_catalog", catalog));

    const broken = JSON.parse(JSON.stringify(schema));
    broken.node[0].dataSourceGroup.externalDataSource.mappedField[1].sourceFieldName = "nme";
    const invalid = await tool("puppygraph_validate_schema", { schema: broken });
    expect(invalid.body.valid).toBe(false);
    expect(invalid.body.problems[0]).toContain("mapped source field 'nme' not found");
    expect((await tool("puppygraph_upload_schema", { schema: broken, replace: true })).body.error_type).toBe("VALIDATION_FAILED");

    const valid = await tool("puppygraph_validate_schema", { schema });
    expect(valid.body).toMatchObject({ valid: true, problems: [], tables_checked: 3 });

    const first = await tool("puppygraph_upload_schema", { schema });
    if (first.isError) {
      // A schema was already installed.
      expect(first.body.error_type).toBe("REPLACE_REQUIRED");
      expect((await tool("puppygraph_upload_schema", { schema, replace: true })).body.ok).toBe(true);
    } else {
      expect(first.body.ok).toBe(true);
    }
    const guarded = await tool("puppygraph_upload_schema", { schema });
    expect(guarded.body.error_type).toBe("REPLACE_REQUIRED");

    const shared = await tool("puppygraph_query", {
      language: "cypher",
      query:
        "MATCH (a:Account)-[:USES]->(d:Device)<-[:USES]-(b:Account) WHERE a.name < b.name RETURN a.name AS a, b.name AS b, id(d) AS device",
    });
    expect(shared.isError).toBe(false);
    expect(shared.body.data).toEqual([{ a: "alice", b: "bob", device: "Device[10]" }]);

    await new Promise((resolve) => setImmediate(resolve));
    expect(rawResults).not.toContain(jdbcPassword);
    expect(stderrOutput).not.toContain(jdbcPassword);
  }, 300_000);
});

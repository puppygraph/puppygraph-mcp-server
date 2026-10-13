# PuppyGraph MCP Server

[Model Context Protocol](https://modelcontextprotocol.io) (MCP) server for [PuppyGraph](https://puppygraph.com). It lets AI agents such as Claude Code, Claude Desktop and Cursor connect PuppyGraph to your data, build a graph schema, and query the graph with Cypher or Gremlin.

```bash
npx -y @puppygraph/mcp-server
```

## Tools

| Tool | What it does |
| --- | --- |
| `puppygraph_query` | Runs a Cypher or Gremlin query and returns the rows, PuppyGraph's query warnings, and on failure PuppyGraph's error message |
| `puppygraph_schema` | Returns the graph schema (node and edge labels, attributes); a large schema comes back as its structure only |
| `puppygraph_status` | Reports the connection status and whether read-only mode is on |

Each of these three tools is also available with an `mcp__` prefix (e.g. `mcp__puppygraph_query`) for compatibility with some LLM platforms.

Setup tools, to go from an empty PuppyGraph to a graph you can query. They match what the PuppyGraph web UI's AI assistant can do:

| Tool | What it does |
| --- | --- |
| `puppygraph_guide` | How to use these tools: the steps to query a graph or build one, and the rules for correct keys, types and edges |
| `puppygraph_catalog_spec` | The supported catalog types, and one type's connection fields with their exact names |
| `puppygraph_list_catalogs` | Lists the registered data sources (catalogs), credentials masked |
| `puppygraph_create_catalog` | Registers a data source (database, warehouse, lake or DuckDB file) as a catalog |
| `puppygraph_test_catalog` | Checks that PuppyGraph can read data through a catalog |
| `puppygraph_list_tables` | Lists a catalog's databases, or the tables in one of them |
| `puppygraph_describe_table` | Lists a table's columns and their PuppyGraph types |
| `puppygraph_sample_table` | Returns a few rows of a table |
| `puppygraph_profile_column` | Profiles a column: null and distinct counts, whether it can be an id or references another table |
| `puppygraph_table_row_count` | Counts the rows of a table |
| `puppygraph_check_join` | Checks from the data how many values of one column exist in another table's column |
| `puppygraph_schema_template` | Returns an annotated example of a 1.x graph schema |
| `puppygraph_validate_schema` | Dry-runs a schema without changing anything: its structure, that its tables and columns exist, that each type matches the source column, and that edge keys match the ids of the nodes they point at |
| `puppygraph_upload_schema` | Installs a whole schema; replacing an installed schema needs `replace: true` |
| `puppygraph_search_schema` | Finds node and edge types in the installed schema by keyword |
| `puppygraph_get_schema_element` | Shows one node or edge: ids, attributes, source table, keys, and the relationship label to use in Cypher |
| `puppygraph_add_node`, `puppygraph_update_node`, `puppygraph_remove_node` | Changes one node type of the installed schema |
| `puppygraph_add_edge`, `puppygraph_update_edge`, `puppygraph_remove_edge` | Changes one edge type of the installed schema |
| `puppygraph_add_node_attribute`, `puppygraph_add_edge_attribute` | Adds one attribute to a node or edge type |
| `puppygraph_check_edges` | Checks the installed graph against its data: for each edge type, how many rows reach an existing source and target node, and whether node ids are unique |

`puppygraph_create_catalog`, `puppygraph_upload_schema` and the add/update/remove tools change PuppyGraph and are not available in [read-only mode](#read-only-mode). The setup tools need PuppyGraph 1.x and use its HTTP API on port 8081.

### Building a schema one element at a time

The add/update/remove tools change one node or edge of the installed schema and leave the rest alone, like the AI assistant in the PuppyGraph web UI. PuppyGraph serves those changes only to its own UI, so the MCP server reads the installed schema, changes the element, checks it (columns, types, keys) and uploads the whole schema. It refuses if the installed schema changed in the meantime, and it changes nothing when the element has a problem.

### Checking the graph

A graph can be valid and still wrong: a join on the wrong column, an edge pointing the wrong way, or a non-unique node id all upload without error. `puppygraph_check_edges` counts, for each edge type, the edge rows and how many of them reach an existing source node and target node, and compares each node type's rows with its distinct ids. It works on every PuppyGraph 1.x and needs no data-probing permission. After an upload, the schema tools also wait a few seconds for new labels to answer, because PuppyGraph can answer the first queries after an upload with 0 rows.

When PuppyGraph can't be reached, the tools return an error. They never return made-up data.

### Data probing

`puppygraph_sample_table`, `puppygraph_profile_column`, `puppygraph_table_row_count` and `puppygraph_check_join` read the source tables, so the agent picks ids and edges from the data rather than from column names alone. They are the same probes the PuppyGraph web UI's AI assistant uses, and they need a PuppyGraph release newer than 1.14. On older versions they return `error_type: "NOT_SUPPORTED"`, and the agent falls back to column names and types and should say that its keys and joins are unverified.

- Sample rows, sample values and min/max values go into the conversation with the agent's model.
- The PuppyGraph user needs the `DATA:read` permission.
- On a catalog used by a graph with row-level security, only administrators can probe, because probes read the tables without the row filters.
- A PuppyGraph server can be set to return counts only: `puppygraph_sample_table` is then refused, and the other probes return counts without values.

They only read, so they stay available in read-only mode.

The same guide is available as the `puppygraph_guide` tool, as the read-only resource `puppygraph://guide` and, shortened, as the server's MCP `instructions`; `puppygraph://schema` is the current graph schema. Some clients never look at resources or instructions, so the tool descriptions point to `puppygraph_guide` too.

### Connecting data

- **Databases** (PostgreSQL, MySQL, SQL Server, Oracle, ...): `jdbc_uri`, `username` and `password_env`. PuppyGraph doesn't ship the MySQL driver: pass `driver_url` (the tool suggests the official connector on Maven Central). MySQL 8 usually also needs `?allowPublicKeyRetrieval=true&useSSL=false` in the URI.
- **Lakes and warehouses** (Iceberg, Delta Lake, Hive, Hudi, BigQuery, Snowflake key pair, Databricks, ...): the fields have the names of the PuppyGraph catalog form. `puppygraph_catalog_spec` lists them per type, and `puppygraph_create_catalog` checks `options` against them before connecting. The form definition is bundled from the PuppyGraph source; regenerate it with `node scripts/update-catalog-spec.mjs <puppygraph>/frontend/control/chat/catalogform/definition.json`.
- **CSV and Parquet files**: create tables or views over them in a DuckDB file, mount it into the PuppyGraph container, and register it as type `duckdb` with `jdbc:duckdb:/path/in/container.duckdb`. For files on S3, use an Iceberg, Delta Lake or Hive catalog: DuckDB's S3 settings aren't saved in the file, so queries through it fail.
- Common connection errors come back with a `hint` (and a `suggested_jdbc_uri` or `suggested_driver_url` where there is one). While PuppyGraph is still starting, the tools answer `error_type: "STARTING"`.

## Quick start

1. Start PuppyGraph (Docker):

   ```bash
   docker run -d --name puppy --pull=always \
     -p 8081:8081 -p 8182:8182 -p 7687:7687 \
     -e PUPPYGRAPH_PASSWORD=puppygraph123 \
     --add-host=host.docker.internal:host-gateway \
     puppygraph/puppygraph:latest
   ```

2. Add the MCP server to your client (below). With PuppyGraph on localhost and the default credentials, no configuration is needed.

3. Ask your agent to build a graph from your data, for example "Use PuppyGraph to connect to my Postgres at jdbc:postgresql://db:5432/shop and find customers who share a payment card", or, if a schema is already loaded, "What's in my PuppyGraph graph?".

   PuppyGraph connects to your database itself, so the JDBC URI must use an address that the PuppyGraph container can reach (e.g. `host.docker.internal` for a database on your machine, not `localhost`; the `--add-host` flag above makes that name work on Linux). If an agent uses `localhost` anyway, `puppygraph_create_catalog` fails with `error_type: HOST_UNREACHABLE_FROM_PUPPYGRAPH`, a hint and a `suggested_jdbc_uri` to retry with. You can also connect data and build the schema in the web UI at http://localhost:8081 (sign in as `puppygraph` / `puppygraph123`); see the [PuppyGraph docs](https://docs.puppygraph.com).

Requires Node.js 20 or later.

## Client setup

### Claude Code

```bash
claude mcp add puppygraph -- npx -y @puppygraph/mcp-server
```

With a remote PuppyGraph or other credentials, pass environment variables with `-e`:

```bash
claude mcp add puppygraph \
  -e PUPPYGRAPH_URL=bolt://puppygraph.example.com:7687 \
  -e PUPPYGRAPH_GREMLIN_URL=ws://puppygraph.example.com:8182/gremlin \
  -e PUPPYGRAPH_SCHEMA_URL=http://puppygraph.example.com:8081/schemajson \
  -e PUPPYGRAPH_PASSWORD=your-password \
  -e PUPPYGRAPH_GREMLIN_PASSWORD=your-password \
  -e PUPPYGRAPH_SCHEMA_PASSWORD=your-password \
  -- npx -y @puppygraph/mcp-server
```

Add `--scope user` to make it available in all your projects.

### Claude Desktop

Edit `claude_desktop_config.json` (Settings → Developer → Edit Config) and restart Claude Desktop:

```json
{
  "mcpServers": {
    "puppygraph": {
      "command": "npx",
      "args": ["-y", "@puppygraph/mcp-server"],
      "env": {
        "PUPPYGRAPH_URL": "bolt://localhost:7687"
      }
    }
  }
}
```

The `env` block is optional; add any of the [environment variables](#configuration) there.

### Cursor

Add the server to `~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` (one project):

```json
{
  "mcpServers": {
    "puppygraph": {
      "command": "npx",
      "args": ["-y", "@puppygraph/mcp-server"]
    }
  }
}
```

### VS Code (GitHub Copilot)

Add the server to `.vscode/mcp.json`:

```json
{
  "servers": {
    "puppygraph": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@puppygraph/mcp-server"]
    }
  }
}
```

### Other MCP clients

Any client that launches stdio MCP servers works: the command is `npx` with arguments `-y @puppygraph/mcp-server`, and settings go in environment variables. Windsurf, Cline and similar clients use the same `mcpServers` JSON shape as Claude Desktop.

## Configuration

All settings are environment variables. The defaults match a local PuppyGraph container.

| Variable | Default | Description |
| --- | --- | --- |
| `PUPPYGRAPH_URL` | `bolt://localhost:7687` | Bolt endpoint for Cypher |
| `PUPPYGRAPH_USERNAME` | `puppygraph` | Bolt username |
| `PUPPYGRAPH_PASSWORD` | `puppygraph123` | Bolt password |
| `PUPPYGRAPH_DATABASE` | (empty) | Bolt database name |
| `PUPPYGRAPH_GREMLIN_URL` | `ws://localhost:8182/gremlin` | Gremlin WebSocket endpoint |
| `PUPPYGRAPH_GREMLIN_USERNAME` | `puppygraph` | Gremlin username |
| `PUPPYGRAPH_GREMLIN_PASSWORD` | `puppygraph123` | Gremlin password |
| `PUPPYGRAPH_GREMLIN_TRAVERSAL_SOURCE` | `g` | Gremlin traversal source |
| `PUPPYGRAPH_SCHEMA_URL` | `http://localhost:8081/schemajson` | Schema endpoint |
| `PUPPYGRAPH_SCHEMA_USERNAME` | `puppygraph` | Schema endpoint username |
| `PUPPYGRAPH_SCHEMA_PASSWORD` | `puppygraph123` | Schema endpoint password, also used by the setup tools |
| `PUPPYGRAPH_HTTP_URL` | origin of `PUPPYGRAPH_SCHEMA_URL` | PuppyGraph HTTP API used by the setup tools |
| `PUPPYGRAPH_MCP_SECRET_ENV_ALLOWLIST` | (empty) | Extra variable names that `password_env` / `secret_env` may read (see [Data source credentials](#data-source-credentials)) |
| `PUPPYGRAPH_READ_ONLY` | `false` | Reject write queries (see below) |

If you changed the PuppyGraph password, set it for all three endpoints (`PUPPYGRAPH_PASSWORD`, `PUPPYGRAPH_GREMLIN_PASSWORD`, `PUPPYGRAPH_SCHEMA_PASSWORD`).

### Read-only mode

Writes are allowed by default. To stop an agent from changing data, for example on a production deployment, turn on read-only mode with `PUPPYGRAPH_READ_ONLY=true` or the `--read-only` flag:

```bash
claude mcp add puppygraph -- npx -y @puppygraph/mcp-server --read-only
```

In read-only mode, `puppygraph_query` rejects Cypher queries that use `CREATE`, `MERGE`, `DELETE`, `SET`, `REMOVE`, `DROP`, `LOAD CSV` or `FOREACH`, and Gremlin queries that use `addV`, `addE`, `mergeV`, `mergeE`, `property`, `drop`, `io`, `addVertex`, `addEdge` or `remove`, before they reach PuppyGraph. The agent gets an error with `error_type: "READ_ONLY"` that names the operation. Keywords inside strings and comments are ignored. The query tool description and `puppygraph_status` (`read_only: true`) tell the agent the mode is on.

In read-only mode, `puppygraph_create_catalog`, `puppygraph_upload_schema` and the add/update/remove schema tools are not offered to the agent at all (and refuse if called). The other setup tools only read and stay available.

Read-only mode is a guard for agents, not access control. To enforce read-only access, use PuppyGraph's access control and connect as a user without write permissions.

### Data source credentials

The setup tools never return or log data source passwords: responses mask credential fields as `******`, and error messages are scrubbed of the passwords that were sent. To keep a password out of the conversation entirely, put it in the MCP server's environment and have the agent pass the variable name instead (`password_env`, or `secret_env` for other secrets). The agent chooses the variable name, so to stop it from handing another of the server's secrets to a database, only these variables can be used: names starting with `PUPPYGRAPH_SECRET_`, and names you list in `PUPPYGRAPH_MCP_SECRET_ENV_ALLOWLIST` (comma-separated, exact names). Any other name is refused.

```bash
claude mcp add puppygraph -e PUPPYGRAPH_SECRET_PG_PASSWORD=... -- npx -y @puppygraph/mcp-server
```

Then: "Create a PuppyGraph catalog for jdbc:postgresql://db:5432/shop as user app, with the password in PUPPYGRAPH_SECRET_PG_PASSWORD."

### Replacing a schema

`puppygraph_upload_schema` validates the schema first, then asks PuppyGraph to check every mapped table and column before it changes anything, so a failed upload leaves the installed schema as it was. If a schema is already installed, the upload is refused unless the agent passes `replace: true`; the refusal names the installed version and labels. PuppyGraph keeps earlier versions in its schema history.

## Troubleshooting

- Ask the agent to call `puppygraph_status`: it shows whether the server is connected and, if not, whether the cause is authentication or the connection.
- The server logs to stderr (never stdout, which carries the MCP protocol). Claude Desktop writes them to its MCP log files.
- If PuppyGraph runs on another host or in a container the client can't reach as `localhost`, set the three URL variables to an address the client can reach.
- Gremlin URLs must start with `ws://` or `wss://`.
- Cypher and Gremlin connect separately: if one fails, the other language still works.

## Development

```bash
git clone https://github.com/puppygraph/puppygraph-mcp-server.git
cd puppygraph-mcp-server
npm install        # also builds build/ through the prepare script
npm test           # unit and integration tests (mocked, no PuppyGraph needed)
npm run build
node build/index.js
```

To use a local checkout in a client, replace `npx -y @puppygraph/mcp-server` with `node /path/to/puppygraph-mcp-server/build/index.js`.

Live tests run the built server against a real PuppyGraph:

```bash
PUPPYGRAPH_LIVE_TEST=true npm run test:live
```

The setup tools have their own live test. It creates a catalog and replaces the installed schema, so run it only against a throwaway PuppyGraph. Load `tests/live/fixtures/setup.sql` into a PostgreSQL database that PuppyGraph can reach, then:

```bash
PUPPYGRAPH_LIVE_SETUP_TEST=true \
PUPPYGRAPH_LIVE_JDBC_URI=jdbc:postgresql://<host>:5432/<db> \
PUPPYGRAPH_LIVE_JDBC_USER=<user> PUPPYGRAPH_LIVE_JDBC_PASSWORD=<password> \
npm run test:live
```

To test the package as users get it, run `npm pack` and install the tarball, or publish it to a local registry such as [Verdaccio](https://verdaccio.org) and run `npx -y @puppygraph/mcp-server` against it.

## Publishing

Maintainers publish to npm by hand; see [RELEASING.md](RELEASING.md).

## License

Apache 2.0

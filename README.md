# PuppyGraph MCP Server

[Model Context Protocol](https://modelcontextprotocol.io) (MCP) server for [PuppyGraph](https://puppygraph.com). It lets AI agents such as Claude Code, Claude Desktop and Cursor connect PuppyGraph to your data, build a graph schema, and query the graph with Cypher or Gremlin.

```bash
npx -y @puppygraph/mcp-server
```

## Tools

| Tool | What it does |
| --- | --- |
| `puppygraph_query` | Runs a Cypher or Gremlin query and returns the rows |
| `puppygraph_schema` | Returns the graph schema (node and edge labels, attributes) |
| `puppygraph_status` | Reports the connection status and whether read-only mode is on |

Each of these three tools is also available with an `mcp__` prefix (e.g. `mcp__puppygraph_query`) for compatibility with some LLM platforms.

Setup tools, to go from an empty PuppyGraph to a graph you can query:

| Tool | What it does |
| --- | --- |
| `puppygraph_list_catalogs` | Lists the registered data sources (catalogs), credentials masked |
| `puppygraph_create_catalog` | Registers a data source, e.g. a PostgreSQL database, as a catalog |
| `puppygraph_test_catalog` | Checks that PuppyGraph can read data through a catalog |
| `puppygraph_list_tables` | Lists a catalog's databases, or the tables in one of them |
| `puppygraph_describe_table` | Lists a table's columns and their PuppyGraph types |
| `puppygraph_schema_template` | Returns an annotated example of a 1.x graph schema |
| `puppygraph_validate_schema` | Dry-runs a schema: checks its structure and that its tables and columns exist, without changing anything |
| `puppygraph_upload_schema` | Installs a schema; replacing an installed schema needs `replace: true` |

`puppygraph_create_catalog` and `puppygraph_upload_schema` change PuppyGraph and are not available in [read-only mode](#read-only-mode). The setup tools need PuppyGraph 1.x and use its HTTP API on port 8081.

When PuppyGraph can't be reached, the tools return an error. They never return sample data.

## Quick start

1. Start PuppyGraph (Docker):

   ```bash
   docker run -d --name puppy --pull=always \
     -p 8081:8081 -p 8182:8182 -p 7687:7687 \
     -e PUPPYGRAPH_PASSWORD=puppygraph123 \
     puppygraph/puppygraph:latest
   ```

2. Add the MCP server to your client (below). With PuppyGraph on localhost and the default credentials, no configuration is needed.

3. Ask your agent to build a graph from your data, for example "Use PuppyGraph to connect to my Postgres at jdbc:postgresql://db:5432/shop and find customers who share a payment card", or, if a schema is already loaded, "What's in my PuppyGraph graph?".

   PuppyGraph connects to your database itself, so the JDBC URI must use an address that the PuppyGraph container can reach (e.g. `host.docker.internal` for a database on your machine, not `localhost`). You can also connect data and build the schema in the web UI at http://localhost:8081 (sign in as `puppygraph` / `puppygraph123`); see the [PuppyGraph docs](https://docs.puppygraph.com).

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

In read-only mode, `puppygraph_create_catalog` and `puppygraph_upload_schema` are not offered to the agent at all (and refuse if called). The other setup tools only read and stay available.

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

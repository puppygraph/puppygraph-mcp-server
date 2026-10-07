# PuppyGraph MCP Server

[Model Context Protocol](https://modelcontextprotocol.io) (MCP) server for [PuppyGraph](https://puppygraph.com). It lets AI agents such as Claude Code, Claude Desktop and Cursor inspect your graph schema and query it with Cypher or Gremlin.

```bash
npx -y @puppygraph/mcp-server
```

## Tools

| Tool | What it does |
| --- | --- |
| `puppygraph_query` | Runs a Cypher or Gremlin query and returns the rows |
| `puppygraph_schema` | Returns the graph schema (node and edge labels, attributes) |
| `puppygraph_status` | Reports the connection status and whether read-only mode is on |

Each tool is also available with an `mcp__` prefix (e.g. `mcp__puppygraph_query`) for compatibility with some LLM platforms.

When PuppyGraph can't be reached, the tools return an error. They never return sample data.

## Quick start

1. Start PuppyGraph (Docker):

   ```bash
   docker run -d --name puppy --pull=always \
     -p 8081:8081 -p 8182:8182 -p 7687:7687 \
     -e PUPPYGRAPH_PASSWORD=puppygraph123 \
     puppygraph/puppygraph:latest
   ```

   Open http://localhost:8081, sign in as `puppygraph` / `puppygraph123` and load a graph schema. See the [PuppyGraph docs](https://docs.puppygraph.com) for connecting your own data.

2. Add the MCP server to your client (below). With PuppyGraph on localhost and the default credentials, no configuration is needed.

3. Ask your agent something like "What's in my PuppyGraph graph?" or "Use PuppyGraph to count the nodes by label."

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
| `PUPPYGRAPH_SCHEMA_PASSWORD` | `puppygraph123` | Schema endpoint password |
| `PUPPYGRAPH_READ_ONLY` | `false` | Reject write queries (see below) |

If you changed the PuppyGraph password, set it for all three endpoints (`PUPPYGRAPH_PASSWORD`, `PUPPYGRAPH_GREMLIN_PASSWORD`, `PUPPYGRAPH_SCHEMA_PASSWORD`).

### Read-only mode

Writes are allowed by default. To stop an agent from changing data, for example on a production deployment, turn on read-only mode with `PUPPYGRAPH_READ_ONLY=true` or the `--read-only` flag:

```bash
claude mcp add puppygraph -- npx -y @puppygraph/mcp-server --read-only
```

In read-only mode, `puppygraph_query` rejects Cypher queries that use `CREATE`, `MERGE`, `DELETE`, `SET`, `REMOVE`, `DROP`, `LOAD CSV` or `FOREACH`, and Gremlin queries that use `addV`, `addE`, `mergeV`, `mergeE`, `property`, `drop`, `io`, `addVertex`, `addEdge` or `remove`, before they reach PuppyGraph. The agent gets an error with `error_type: "READ_ONLY"` that names the operation. Keywords inside strings and comments are ignored. The query tool description and `puppygraph_status` (`read_only: true`) tell the agent the mode is on.

Read-only mode is a guard for agents, not access control. To enforce read-only access, use PuppyGraph's access control and connect as a user without write permissions.

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

To test the package as users get it, run `npm pack` and install the tarball, or publish it to a local registry such as [Verdaccio](https://verdaccio.org) and run `npx -y @puppygraph/mcp-server` against it.

## Publishing

Maintainers publish to npm by hand from a clean checkout of `main`. The version to publish is the `version` in `package.json` (currently `1.2.0`); bump it in a PR before publishing again (`npm version minor --no-git-tag-version` updates `package.json` and `package-lock.json`).

```bash
git clone https://github.com/puppygraph/puppygraph-mcp-server.git
cd puppygraph-mcp-server

npm login                 # an account with publish rights on the @puppygraph org
npm whoami

npm ci                    # installs and builds build/ (prepare script)
npm test
npm pack --dry-run        # expect @puppygraph/mcp-server@<version>: build/, README.md, LICENSE, package.json

npm publish --access public   # add --otp=<code> if your account uses 2FA
```

`npm publish` rebuilds through the `prepare` script. Scoped packages are private by default; `--access public` (also set in `publishConfig`) makes this one public.

Check the release:

```bash
npm view @puppygraph/mcp-server version
npx -y @puppygraph/mcp-server   # starts and waits for an MCP client on stdin; Ctrl+C to exit
```

## License

Apache 2.0

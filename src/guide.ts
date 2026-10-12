/**
 * How-to text for agents: the server's initialize instructions and the
 * puppygraph://guide resource.
 *
 * Some clients (Codex CLI, for one) look at resources first and take an empty
 * list to mean the server has nothing to offer, so these say plainly that the
 * functionality is in the tools and which ones to call first.
 */

export const GUIDE_URI = "puppygraph://guide";
export const SCHEMA_URI = "puppygraph://schema";

export function serverInstructions(readOnly: boolean): string {
  const setup = readOnly
    ? "The server is in read-only mode: it can inspect catalogs and run read queries, but creating catalogs, uploading schemas and write queries are disabled."
    : "To build a graph from a database: puppygraph_list_catalogs, puppygraph_create_catalog, puppygraph_list_tables / puppygraph_describe_table, puppygraph_schema_template, puppygraph_validate_schema, then puppygraph_upload_schema.";
  return [
    "PuppyGraph MCP server. Everything it does is exposed as tools (named puppygraph_*), not as resources; call the tools directly.",
    "Start with puppygraph_status to check the connection, then puppygraph_schema to see the graph's labels and properties, then puppygraph_query to run Cypher or Gremlin.",
    setup,
    "PuppyGraph connects to databases from its own server: if PuppyGraph runs in Docker, a database on the Docker host is at host.docker.internal, not localhost.",
    `Resources: ${GUIDE_URI} (this guide, in more detail) and ${SCHEMA_URI} (the current graph schema).`,
  ].join("\n");
}

export function guideMarkdown(readOnly: boolean): string {
  const setupSection = readOnly
    ? `## Setup tools

The server is in read-only mode. These read tools are available:
\`puppygraph_list_catalogs\`, \`puppygraph_test_catalog\`, \`puppygraph_list_tables\`,
\`puppygraph_describe_table\`, \`puppygraph_schema_template\`, \`puppygraph_validate_schema\`.
Creating catalogs, uploading schemas and write queries are disabled; restart the
server without PUPPYGRAPH_READ_ONLY / --read-only to change them.
`
    : `## From a database to a graph

1. \`puppygraph_list_catalogs\`: the data sources PuppyGraph already knows.
2. \`puppygraph_create_catalog\`: register a database (e.g. type \`postgresql\`,
   \`jdbc_uri\` \`jdbc:postgresql://HOST:5432/DB\`). Then \`puppygraph_test_catalog\`.
3. \`puppygraph_list_tables\` and \`puppygraph_describe_table\`: find the tables and columns.
4. \`puppygraph_schema_template\`: an example schema to adapt.
5. \`puppygraph_validate_schema\`: check the schema against the real tables.
6. \`puppygraph_upload_schema\`: install it. Then query it with \`puppygraph_query\`.
`;
  return `# Using the PuppyGraph MCP server

Everything this server does is exposed as **tools** (named \`puppygraph_*\`).
Resources are only this guide and the current schema.

## Querying a graph

1. \`puppygraph_status\`: check that PuppyGraph is reachable.
2. \`puppygraph_schema\`: node and edge labels and their properties.
3. \`puppygraph_query\`: run Cypher (\`language: "cypher"\`) or Gremlin (\`language: "gremlin"\`).

${setupSection}
## Docker networking

PuppyGraph connects to databases from its own server. If PuppyGraph runs in Docker,
\`localhost\` in a JDBC URI is the PuppyGraph container itself. For a database on
the Docker host use \`host.docker.internal\` (on Linux the container needs
\`--add-host=host.docker.internal:host-gateway\`); for a database in another
container use its container name on a shared network.
`;
}

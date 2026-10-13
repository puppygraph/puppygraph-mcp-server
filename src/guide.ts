/**
 * How-to text for agents: the server's initialize instructions, the
 * puppygraph_guide tool and the puppygraph://guide resource.
 *
 * Agents learn this server only from what it returns, and some clients
 * (Codex CLI, for one) never see its resources or instructions, so the same
 * guide is also a tool. The rules follow PuppyGraph AI's own schema-building
 * prompt.
 */

export const GUIDE_URI = "puppygraph://guide";
export const SCHEMA_URI = "puppygraph://schema";

export function serverInstructions(readOnly: boolean): string {
  const setup = readOnly
    ? "The server is in read-only mode: it can inspect catalogs, tables and the schema, probe data and run read queries, but it can't create catalogs, change the schema or run write queries."
    : "To build a graph: puppygraph_list_catalogs / puppygraph_create_catalog (puppygraph_catalog_spec for a type's exact fields), puppygraph_list_tables and puppygraph_describe_table, puppygraph_profile_column and puppygraph_check_join to choose keys from the data, then puppygraph_add_node / puppygraph_add_edge (or puppygraph_validate_schema + puppygraph_upload_schema for a whole schema), and finally puppygraph_check_edges.";
  return [
    "PuppyGraph MCP server. Everything it does is a tool named puppygraph_*; call the tools directly. puppygraph_guide has the full how-to.",
    "To query: puppygraph_status, then puppygraph_schema (or puppygraph_search_schema for a large schema), then puppygraph_query.",
    setup,
    "Never present a join as verified unless puppygraph_check_join or puppygraph_check_edges checked it; declare each column with the schemaType puppygraph_describe_table reports.",
    "PuppyGraph connects to databases from its own server: if PuppyGraph runs in Docker, a database on the Docker host is at host.docker.internal, not localhost.",
  ].join("\n");
}

export function guideMarkdown(readOnly: boolean): string {
  const build = readOnly
    ? `## Building a graph

The server is in read-only mode: catalogs and the schema can be inspected and the
data probed, but creating catalogs, changing the schema and write queries are
disabled. Restart the server without PUPPYGRAPH_READ_ONLY / --read-only to build
a graph. You can still design one and present it to the user as "not yet applied".
`
    : `## Building a graph, step by step

1. **Survey.** \`puppygraph_list_catalogs\`; if the data source isn't there,
   \`puppygraph_create_catalog\` (see *Connecting data* below). Then
   \`puppygraph_list_tables\` (databases, then tables) and
   \`puppygraph_describe_table\` for each table in scope. Use the tools before
   asking the user anything. With one catalog or database, assume it's the target.
   About 30 tables or fewer: model all of them. More: ask the user which to start with.
2. **Classify each table** with \`puppygraph_profile_column\`,
   \`puppygraph_sample_table\` and \`puppygraph_table_row_count\`:
   - *entity* (a node): a unique, non-null key (\`pk_candidate\`), descriptive columns;
   - *junction / link* (an edge): two foreign keys, no key of its own;
   - *edge with payload*: a junction with its own attributes (time, amount, status);
   - *lookup / enum* (a handful of values): an attribute of a node, not a node;
   - *event* (many rows, foreign keys, a timestamp): usually edges between the entities it references.
3. **Map relationships.** Rank foreign-key candidates by name (\`<table>_id\`,
   the same name as another table's key), then by type, then check them with
   \`puppygraph_check_join\` (several in parallel when independent). A
   \`hit_rate\` near 1.0 is a foreign key; below about 0.95 it is a soft
   reference: tell the user the evidence. **Never add an edge whose join you
   didn't check, and never call an unchecked join verified.** If the probe tools
   answer \`NOT_SUPPORTED\` (PuppyGraph 1.14 and older) or \`PERMISSION_DENIED\`
   (no DATA:read), choose keys from names and types, say they are unverified,
   and rely on step 5.
4. **Build.** Add every node with \`puppygraph_add_node\` (independent calls can go
   in parallel), then every edge with \`puppygraph_add_edge\`. Each call is checked
   on its own (columns, types, keys) and changes nothing on a problem: fix that
   call and retry; other elements stay. Don't retry a permission error.
   For a whole schema at once, use \`puppygraph_validate_schema\` then
   \`puppygraph_upload_schema\` (\`replace: true\` only to replace a schema on purpose).
5. **Verify.** \`puppygraph_check_edges\`: every edge's rows should reach both
   endpoint nodes. Report edges that are \`broken\`, \`suspect\` or \`empty\` and
   node types with 0 rows to the user, with that evidence. A plain
   \`count(r)\` query can't show this: it doesn't look up the nodes.
`;
  return `# Using the PuppyGraph MCP server

Everything this server does is a **tool** named \`puppygraph_*\`; call them directly.

## Querying a graph

1. \`puppygraph_status\`: check that PuppyGraph is reachable.
2. \`puppygraph_schema\`: node and edge labels and their properties. For a large
   schema, \`puppygraph_search_schema\` finds elements by keyword and
   \`puppygraph_get_schema_element\` shows one element's attributes, source and keys.
3. \`puppygraph_query\`: Cypher (\`language: "cypher"\`) or Gremlin. Use LIMIT.
   - Node ids are not properties: \`id(n)\` or \`elementId(n)\` returns
     \`'Label[value]'\` (\`'OrderLine[1,2]'\` for a two-column id), so filter with
     \`WHERE id(n) = 'Account[42]'\`; \`n.<id column>\` is null.
   - Match relationships by the relationship label in the edge's \`pattern\`.
   - On an error or a warning about an unknown label or property, look the name up
     and retry instead of asking the user.

${build}
## Schema rules

- Nodes and edges read their table through \`dataSourceGroup.externalDataSource\`
  with \`enabled: true\`. Don't use \`localDataSource\`.
- **Types:** declare every column with the \`schemaType\` that
  \`puppygraph_describe_table\` reports, as is (\`LONG\`, \`INT\`, \`DECIMAL(12,2)\`,
  \`DATETIME\`, \`ARRAY<STRING>\`). PuppyGraph rejects any other type: Long for an
  INT column, Double for a DECIMAL. Leave out columns whose schemaType is \`UNKNOWN\`.
- An edge's \`fromKey\` / \`toKey\` hold the ids of its \`fromNodeLabel\` /
  \`toNodeLabel\` nodes: one column per id column, same types, in the same order.
- Naming: nodes PascalCase and singular (\`User\`, \`OrderLine\`); edges
  SCREAMING_SNAKE present-tense verbs (\`PLACED\`, \`CONTAINS\`). Labels are unique
  across nodes and edges.
- Leave out audit columns (created_by, updated_at, ...) unless asked. Don't turn
  enum or lookup tables into nodes. Don't ask the user to choose between minor
  design options: pick one and say why.
- \`puppygraph_schema_template\` has a complete example.

## Connecting data

- **Databases (PostgreSQL, MySQL, SQL Server, ...)**: \`jdbc_uri\`, \`username\`,
  and \`password_env\` (an MCP server environment variable starting with
  \`PUPPYGRAPH_SECRET_\`) so the password stays out of the conversation. Never ask
  the user to paste a password into the chat.
- **MySQL**: PuppyGraph doesn't ship the driver; pass \`driver_url\` (the tool
  suggests the official connector). MySQL 8 usually also needs
  \`?allowPublicKeyRetrieval=true&useSSL=false\` in the URI.
- **Lakes and warehouses (Iceberg, Delta Lake, Hive, Hudi, BigQuery, Snowflake key
  pair, Databricks, ...)**: \`puppygraph_catalog_spec\` with the type gives the exact
  field names; pass them in \`options\` and secrets in \`secret_env\`.
- **CSV or Parquet files**: put them in a DuckDB file as tables or views, mount it
  into the PuppyGraph container, and use type \`duckdb\` with
  \`jdbc:duckdb:/path/in/container.duckdb\`. Files on S3 need an Iceberg, Delta
  Lake or Hive catalog instead (DuckDB's S3 settings aren't saved in the file).
- **Docker networking**: PuppyGraph connects from its own server. If it runs in
  Docker, \`localhost\` is the PuppyGraph container: a database on the Docker host
  is \`host.docker.internal\` (on Linux the container needs
  \`--add-host=host.docker.internal:host-gateway\`); a database in another
  container is reached by its container name on a shared network.
- If a tool answers \`STARTING\`, PuppyGraph is still starting: wait about 30
  seconds and call it again.
`;
}

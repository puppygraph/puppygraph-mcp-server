/**
 * Read-only mode: an opt-in guard that rejects queries which would modify
 * the graph. It is off by default because new users start with an empty
 * graph and may need to write to it.
 *
 * The check is a keyword scan over the query text with string literals and
 * comments removed. It is a safety net for agents, not an access control
 * boundary: use a read-only PuppyGraph user for that.
 */

export type QueryLanguage = "gremlin" | "cypher";

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

/**
 * Whether read-only mode is on, from the `--read-only` command-line flag or
 * the PUPPYGRAPH_READ_ONLY environment variable (1/true/yes/on).
 */
export function isReadOnly(
  environment: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv.slice(2),
): boolean {
  if (argv.includes("--read-only")) {
    return true;
  }
  const value = environment.PUPPYGRAPH_READ_ONLY;
  return value !== undefined && TRUE_VALUES.has(value.trim().toLowerCase());
}

// Cypher clauses that create, change or delete data or schema.
const CYPHER_WRITE_PATTERNS: Array<[RegExp, string]> = [
  [/\bCREATE\b/i, "CREATE"],
  [/\bMERGE\b/i, "MERGE"],
  [/\bDELETE\b/i, "DELETE"],
  [/\bSET\b/i, "SET"],
  [/\bREMOVE\b/i, "REMOVE"],
  [/\bDROP\b/i, "DROP"],
  [/\bLOAD\s+CSV\b/i, "LOAD CSV"],
  [/\bFOREACH\b/i, "FOREACH"],
];

// Gremlin steps that create, change or delete elements.
const GREMLIN_WRITE_PATTERNS: Array<[RegExp, string]> = [
  [/\baddV\s*\(/, "addV()"],
  [/\baddE\s*\(/, "addE()"],
  [/\bmergeV\s*\(/, "mergeV()"],
  [/\bmergeE\s*\(/, "mergeE()"],
  [/\bproperty\s*\(/, "property()"],
  [/\bdrop\s*\(/, "drop()"],
  [/\baddVertex\s*\(/, "addVertex()"],
  [/\baddEdge\s*\(/, "addEdge()"],
  [/\bio\s*\(/, "io()"],
];

/**
 * Removes string literals, quoted identifiers and comments so that keywords
 * inside them (e.g. a property value 'CREATE') are not mistaken for clauses.
 */
function stripLiteralsAndComments(query: string): string {
  return query.replace(
    /'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:``|[^`])*`|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
    " ",
  );
}

/**
 * Returns the first write operation found in the query, or null if the query
 * only reads.
 */
export function findWriteOperation(
  query: string,
  language: QueryLanguage,
): string | null {
  const stripped = stripLiteralsAndComments(query);
  const patterns =
    language === "cypher" ? CYPHER_WRITE_PATTERNS : GREMLIN_WRITE_PATTERNS;
  for (const [pattern, name] of patterns) {
    if (pattern.test(stripped)) {
      return name;
    }
  }
  return null;
}

export function readOnlyErrorMessage(operation: string): string {
  return (
    `Write query rejected: the PuppyGraph MCP server is in read-only mode ` +
    `and the query contains ${operation}. Run read queries only, or restart ` +
    `the server without PUPPYGRAPH_READ_ONLY / --read-only to allow writes.`
  );
}

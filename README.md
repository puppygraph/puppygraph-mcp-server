# PuppyGraph MCP Server

Model Context Protocol (MCP) server for [PuppyGraph](https://puppygraph.com), allowing Claude to query graph databases using Gremlin and Cypher through Claude Desktop.

## Features

- Connect to PuppyGraph instances using both Neo4j Bolt protocol (for Cypher) and WebSocket (for Gremlin)
- Query graph data using both Gremlin and Cypher query languages
- Retrieve graph structure and schema information from multiple endpoints
- Works with Claude Desktop and other MCP-compatible interfaces
- Robust fallback mechanisms with multiple connection approaches
- Graceful degradation with sample data when connections fail

## Prerequisites

- Node.js 18+
- A running PuppyGraph instance (or fallback mode for testing)

## Installation

1. Clone this repository
2. Install dependencies:

```bash
npm install
```

3. Build the project:

```bash
npm run build
```

## Usage

Start the server:

```bash
npm start
```

Using environment variables:

```bash
# Connect to a specific PuppyGraph instance
PUPPYGRAPH_URL=bolt://your-puppygraph-server:7687 PUPPYGRAPH_USERNAME=neo4j PUPPYGRAPH_PASSWORD=your-password npm start

# Connect to both Neo4j and Gremlin endpoints
PUPPYGRAPH_URL=bolt://your-neo4j-server:7687 PUPPYGRAPH_GREMLIN_URL=ws://your-gremlin-server:8182/gremlin npm start
```

### Claude Desktop Configuration

You can set up the MCP server in your Claude Desktop configuration and include environment variables directly in the config:

```json
{
  "mcpServers": {
    "puppygraph": {
      "command": "node",
      "args": [
        "/path/to/puppygraph-mcp/build/index.js"
      ],
      "env": {
        "PUPPYGRAPH_URL": "bolt://your-neo4j-server:7687",
        "PUPPYGRAPH_USERNAME": "neo4j",
        "PUPPYGRAPH_PASSWORD": "your-password",
        "PUPPYGRAPH_DATABASE": "your-database",
        "PUPPYGRAPH_GREMLIN_URL": "ws://your-gremlin-server:8182/gremlin",
        "PUPPYGRAPH_GREMLIN_USERNAME": "your-username",
        "PUPPYGRAPH_GREMLIN_PASSWORD": "your-password"
      }
    }
  }
}
```

Replace the paths and connection details with your specific values. The `env` section allows you to specify all environment variables directly in the configuration file.

### Available Tools

- `puppygraph_query`: Execute Gremlin or Cypher queries against PuppyGraph
- `puppygraph_schema`: Get schema and structure information about the graph
- `puppygraph_status`: Check PuppyGraph connection status

Each tool is also available with an `mcp__` prefix (e.g., `mcp__puppygraph_query`) for compatibility with certain LLM platforms.

## Environment Variables

### Graph Database Connections

#### Neo4j Connection (Cypher queries)
- `PUPPYGRAPH_URL`: URL of the PuppyGraph Neo4j endpoint (default: `bolt://localhost:7687`)
- `PUPPYGRAPH_USERNAME`: Username for PuppyGraph Neo4j authentication (default: `neo4j`)
- `PUPPYGRAPH_PASSWORD`: Password for PuppyGraph Neo4j authentication (default: `password`)
- `PUPPYGRAPH_DATABASE`: Name of the database to connect to (default: `""`)

#### Gremlin Connection (Gremlin queries)
- `PUPPYGRAPH_GREMLIN_URL`: URL of the PuppyGraph Gremlin endpoint (default: `ws://localhost:8182/gremlin`)
- `PUPPYGRAPH_GREMLIN_USERNAME`: Username for PuppyGraph Gremlin authentication (default: `puppygraph`)
- `PUPPYGRAPH_GREMLIN_PASSWORD`: Password for PuppyGraph Gremlin authentication (default: `puppygraph123`)
- `PUPPYGRAPH_GREMLIN_TRAVERSAL_SOURCE`: Traversal source name (default: `g`)

#### Schema API Connection
- `PUPPYGRAPH_SCHEMA_URL`: URL of the PuppyGraph schema endpoint (default: `http://localhost:8081/schemajson`)
- `PUPPYGRAPH_SCHEMA_USERNAME`: Username for PuppyGraph schema API authentication (default: `puppygraph`)
- `PUPPYGRAPH_SCHEMA_PASSWORD`: Password for PuppyGraph schema API authentication (default: `puppygraph123`)

### General Settings
- Note: Fallback mode has been removed. The server will report actual connection errors to provide better transparency.

## Example Queries

### Cypher Queries

Basic node exploration:
```
MATCH (n) RETURN n LIMIT 10
```

Finding related nodes:
```
MATCH (n)-[r]->(m) WHERE n.name = 'Alice' RETURN n, r, m
```

Count nodes by label:
```
MATCH (n) RETURN labels(n) as label, count(*) as count
```

### Gremlin Queries

Basic vertex exploration:
```
g.V().limit(10)
```

Finding related vertices:
```
g.V().has('name', 'Alice').out().valueMap()
```

Count vertices by label:
```
g.V().groupCount().by(label)
```

## Connection Troubleshooting

This MCP server includes robust fallback mechanisms for handling various connection issues:

1. First attempts to connect to PuppyGraph via Neo4j Bolt protocol for Cypher queries
2. Separately tries to connect via WebSocket for Gremlin queries
3. For schema information, first attempts the schema endpoint, then falls back to Neo4j queries, then Gremlin queries
4. If all direct connections fail, clear error messages will be reported

Connection failures in one protocol won't prevent using another - for example, if Neo4j connection fails but Gremlin succeeds, you'll still be able to run Gremlin queries.

### Remote Connection Instructions

To connect to a remote PuppyGraph instance:

#### 1. Neo4j (Cypher) Connection

```bash
PUPPYGRAPH_URL=bolt://your-neo4j-server:7687 \
PUPPYGRAPH_USERNAME=neo4j \
PUPPYGRAPH_PASSWORD=your-password \
PUPPYGRAPH_DATABASE=your-database \
npm start
```

#### 2. Gremlin Connection

```bash
PUPPYGRAPH_GREMLIN_URL=ws://your-gremlin-server:8182/gremlin \
PUPPYGRAPH_GREMLIN_USERNAME=your-username \
PUPPYGRAPH_GREMLIN_PASSWORD=your-password \
PUPPYGRAPH_GREMLIN_TRAVERSAL_SOURCE=g \
npm start
```

#### 3. Complete Remote Configuration

```bash
PUPPYGRAPH_URL=bolt://your-neo4j-server:7687 \
PUPPYGRAPH_USERNAME=neo4j \
PUPPYGRAPH_PASSWORD=your-neo4j-password \
PUPPYGRAPH_DATABASE=your-database \
PUPPYGRAPH_GREMLIN_URL=ws://your-gremlin-server:8182/gremlin \
PUPPYGRAPH_GREMLIN_USERNAME=your-gremlin-username \
PUPPYGRAPH_GREMLIN_PASSWORD=your-gremlin-password \
npm start
```

### Connection Verification

You can verify connections using the following methods:

1. Check the server startup logs for connection status
2. Use the `puppygraph_status` tool in Claude
3. Test with a simple query:

```
Use the PuppyGraph tool to execute this Cypher query:
MATCH (n) RETURN count(n)
```

### Troubleshooting

If you're encountering issues with connections:

- Ensure the remote server is running and accessible from your network
- Check that firewall rules allow connections to the appropriate ports
- Verify your authentication credentials are correct
- Examine the server logs for detailed error information
- For Gremlin, ensure the WebSocket URL starts with `ws://` or `wss://`

You can check connection status using the `puppygraph_status` tool at any time.

## License

ISC
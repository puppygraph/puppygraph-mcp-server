/**
 * A minimal PuppyGraph 1.x graph schema, returned by
 * puppygraph_schema_template. Agents tend to write the deprecated 0.x format
 * (catalogs / graph.vertices / oneToOne) unless they see a 1.x example.
 */
export const SCHEMA_TEMPLATE = {
  node: [
    {
      label: "Account",
      dataSourceGroup: {
        externalDataSource: {
          enabled: true,
          catalog: "my_catalog",
          schema: "public",
          table: "accounts",
          mappedField: [
            { sourceFieldName: "account_id", targetFieldName: "id" },
            { sourceFieldName: "name", targetFieldName: "name" },
          ],
        },
      },
      id: [{ name: "id", type: "Long" }],
      attribute: [{ name: "name", type: "String" }],
    },
    {
      label: "Device",
      dataSourceGroup: {
        externalDataSource: {
          enabled: true,
          catalog: "my_catalog",
          schema: "public",
          table: "devices",
          mappedField: [
            { sourceFieldName: "device_id", targetFieldName: "id" },
          ],
        },
      },
      id: [{ name: "id", type: "Long" }],
    },
  ],
  edge: [
    {
      label: "USES",
      fromNodeLabel: "Account",
      toNodeLabel: "Device",
      dataSourceGroup: {
        externalDataSource: {
          enabled: true,
          catalog: "my_catalog",
          schema: "public",
          table: "account_devices",
          mappedField: [
            { sourceFieldName: "id", targetFieldName: "id" },
            { sourceFieldName: "account_id", targetFieldName: "from_id" },
            { sourceFieldName: "device_id", targetFieldName: "to_id" },
            { sourceFieldName: "first_seen", targetFieldName: "first_seen" },
          ],
        },
      },
      id: [{ name: "id", type: "Long" }],
      fromKey: [{ name: "from_id", type: "Long" }],
      toKey: [{ name: "to_id", type: "Long" }],
      attribute: [{ name: "first_seen", type: "DateTime" }],
    },
  ],
};

export const SCHEMA_TEMPLATE_NOTES = [
  "This is the PuppyGraph 1.x schema format. Don't use the 0.x format (top-level 'catalogs', 'graph.vertices', 'oneToOne'): it is deprecated.",
  "catalog is the name of a catalog registered with puppygraph_create_catalog; schema and table come from puppygraph_list_tables.",
  "Each mappedField maps a table column (sourceFieldName, exact name from puppygraph_describe_table) to a graph column (targetFieldName).",
  "Every name in id, attribute, fromKey and toKey must be the targetFieldName of exactly one mappedField, and every targetFieldName must be declared in one of them.",
  "A node needs at least one id column. An edge needs fromKey and toKey, holding the ids of its fromNodeLabel and toNodeLabel nodes: one column per id column of that node, of the same type, in the same order. Its id is optional when the table has no unique key column.",
  "Types: declare every column with the schemaType puppygraph_describe_table reports, as is (e.g. LONG, INT, SHORT, DOUBLE, FLOAT, DECIMAL(12,2), STRING, BOOLEAN, DATE, DATETIME, ARRAY<STRING>; case doesn't matter). PuppyGraph rejects any other type, e.g. Long for an INT column or Double for DECIMAL(12,2). Leave out columns whose schemaType is UNKNOWN.",
  "Use externalDataSource with enabled: true; don't use localDataSource.",
  "Labels must be unique across nodes and edges. Nodes: PascalCase, singular (User, OrderLine). Edges: SCREAMING_SNAKE present-tense verbs (PLACED, CONTAINS).",
  "Don't make enum or lookup tables (a handful of values) into nodes: keep the value as an attribute. Leave out audit columns (created_by, updated_at, ...) unless the user wants them.",
  "Choose ids and edges from the data, not from names alone: a node id should be a pk_candidate in puppygraph_profile_column, and an edge's fromKey/toKey columns should pass puppygraph_check_join (hit_rate near 1.0; below about 0.95 it is a soft reference, so tell the user). Never present an unchecked join as verified.",
  "In queries, id columns are not properties: id(n) or elementId(n) returns 'Label[value]' (e.g. 'Account[1]', or 'OrderLine[1,2]' for a two-column id), so filter with WHERE id(n) = 'Account[1]'; n.account_id is null. Attributes are properties (n.name).",
  "Add nodes and edges one at a time with puppygraph_add_node / puppygraph_add_edge, or check a whole schema with puppygraph_validate_schema and install it with puppygraph_upload_schema. Then run puppygraph_check_edges.",
  "Docs: https://docs.puppygraph.com/modeling/building-a-graph/ and, for 0.x schemas, https://docs.puppygraph.com/modeling/migrating-from-v0/",
];

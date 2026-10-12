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
  "A node needs at least one id column. An edge needs fromKey and toKey, holding the ids of its fromNodeLabel and toNodeLabel nodes; its id is optional when the table has no unique key column.",
  "Column types: String, Int, Long, Float, Double, Boolean, Date, DateTime. Use the schemaType that puppygraph_describe_table reports for the source column.",
  "Labels must be unique across nodes and edges.",
  "In queries, id columns are not properties: use id(n) in Cypher (it returns 'Label[value]', e.g. 'Account[1]'), not n.id. Attributes are properties (n.name).",
  "Check the schema with puppygraph_validate_schema, then install it with puppygraph_upload_schema.",
  "Docs: https://docs.puppygraph.com/modeling/building-a-graph/ and, for 0.x schemas, https://docs.puppygraph.com/modeling/migrating-from-v0/",
];

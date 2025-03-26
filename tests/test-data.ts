import { QueryResult } from '../src/utils/types';

export const SAMPLE_RESPONSES = {
  gremlin: {
    data: [
      { id: 1, label: "vertex", properties: { name: ["Alice"], type: ["user"], created_at: [1648756234] } },
      { id: 2, label: "vertex", properties: { name: ["Bob"], type: ["user"], created_at: [1648766543] } }
    ],
    metadata: {
      execution_time: 42,
      row_count: 2,
      note: "Sample data - actual schema may vary"
    }
  },
  cypher: {
    data: [
      { n: { id: 1, labels: ["Node"], properties: { uuid: "n-001", created_at: "2023-01-15T12:00:00Z" } } },
      { n: { id: 2, labels: ["Node"], properties: { uuid: "n-002", created_at: "2023-01-16T14:30:00Z" } } }
    ],
    metadata: {
      execution_time: 38,
      row_count: 2,
      note: "Sample data - actual schema may vary"
    }
  },
  dataSources: {
    summary: "Sample Graph Structure Information",
    source: "Test Data",
    totalNodes: 150,
    totalRelationships: 250,
    nodeTypes: [
      { type: "Node", count: 75, sample: "~75" },
      { type: "Entity", count: 75, sample: "~75" }
    ],
    relationshipTypes: [
      { type: "CONNECTS_TO", count: 125, sample: "~125" },
      { type: "REFERENCES", count: 125, sample: "~125" }
    ],
    graphType: "PuppyGraph SQL-to-Graph Bridge"
  }
};
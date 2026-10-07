import { describe, it, expect } from 'vitest';
import { findWriteOperation, isReadOnly } from '../../src/utils/readonly';

describe('isReadOnly', () => {
  it('is off by default', () => {
    expect(isReadOnly({}, [])).toBe(false);
  });

  it.each(['1', 'true', 'TRUE', 'yes', 'on', ' true '])(
    'is on when PUPPYGRAPH_READ_ONLY=%j',
    (value) => {
      expect(isReadOnly({ PUPPYGRAPH_READ_ONLY: value }, [])).toBe(true);
    },
  );

  it.each(['', '0', 'false', 'no', 'off'])(
    'is off when PUPPYGRAPH_READ_ONLY=%j',
    (value) => {
      expect(isReadOnly({ PUPPYGRAPH_READ_ONLY: value }, [])).toBe(false);
    },
  );

  it('is on with the --read-only flag', () => {
    expect(isReadOnly({}, ['--read-only'])).toBe(true);
  });
});

describe('findWriteOperation', () => {
  it.each([
    ['CREATE (n:Person {name: "a"})', 'CREATE'],
    ['merge (n:Person {id: 1})', 'MERGE'],
    ['MATCH (n) DETACH DELETE n', 'DELETE'],
    ['MATCH (n) SET n.age = 1', 'SET'],
    ['MATCH (n) REMOVE n.age', 'REMOVE'],
    ['DROP INDEX person_name', 'DROP'],
    ["LOAD CSV FROM 'file:///x.csv' AS row RETURN row", 'LOAD CSV'],
    ['MATCH p = (a)-->(b) FOREACH (n IN nodes(p) | SET n.seen = true)', 'SET'],
  ])('flags Cypher write %j', (query, operation) => {
    expect(findWriteOperation(query, 'cypher')).toBe(operation);
  });

  it.each([
    'MATCH (n) RETURN count(n)',
    'MATCH (n:Person) WHERE n.name = "CREATE" RETURN n',
    "MATCH (n) WHERE n.note = 'delete me' RETURN n.created_at",
    'MATCH (n:`Set`) RETURN n',
    '// CREATE (n)\nMATCH (n) RETURN n LIMIT 1',
    '/* MERGE */ MATCH (n) RETURN n',
    'CALL db.labels()',
  ])('allows Cypher read %j', (query) => {
    expect(findWriteOperation(query, 'cypher')).toBeNull();
  });

  it.each([
    ["g.addV('person')", 'addV()'],
    ["g.V(1).addE('knows').to(g.V(2))", 'addE()'],
    ["g.mergeV([(T.label): 'person'])", 'mergeV()'],
    ["g.V(1).property('age', 30)", 'property()'],
    ['g.V().drop()', 'drop()'],
    ["g.io('graph.json').write()", 'io()'],
    ["graph.addVertex('name', 'x')", 'addVertex()'],
    ['g.V(1).next().remove()', 'remove()'],
  ])('flags Gremlin write %j', (query, operation) => {
    expect(findWriteOperation(query, 'gremlin')).toBe(operation);
  });

  it.each([
    'g.V().count()',
    "g.V().has('name', 'drop()').properties('age')",
    "g.V().hasLabel('person').valueMap(true).limit(10)",
    'g.E().groupCount().by(label)',
  ])('allows Gremlin read %j', (query) => {
    expect(findWriteOperation(query, 'gremlin')).toBeNull();
  });
});

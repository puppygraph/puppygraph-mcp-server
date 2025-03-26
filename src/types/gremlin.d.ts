declare module 'gremlin' {
  interface Traversal {
    next(): Promise<{ value: any; done: boolean }>;
    toList(): Promise<any[]>;
    toString(): string;
    
    V(ids?: any[]): Traversal;
    E(ids?: any[]): Traversal;
    hasLabel(label: string): Traversal;
    has(property: string, value: any): Traversal;
    values(property: string): Traversal;
    count(): Traversal;
    limit(limit: number): Traversal;
    groupCount(): Traversal;
    label(): Traversal;
    properties(): Traversal;
  }
  
  interface TraversalSource {
    withRemote(connection: any): any;
    V(ids?: any[]): Traversal;
    E(ids?: any[]): Traversal;
  }
  
  interface ResultSet {
    all(): Promise<any[]>;
    first(): Promise<any>;
  }
  
  // PuppyGraph structure.Graph approach
  export namespace structure {
    class Graph {
      constructor();
      traversal(): TraversalSource;
    }
    
    class Vertex {
      constructor(id: any, label?: string);
      id(): any;
      label(): string;
    }
    
    class Edge {
      constructor(id: any, outV: Vertex, label: string, inV: Vertex);
      id(): any;
      label(): string;
    }
  }
  
  // Driver namespace
  export namespace driver {
    namespace auth {
      class PlainTextSaslAuthenticator {
        constructor(username: string, password: string);
      }
    }
    
    class DriverRemoteConnection {
      constructor(url: string, options?: any);
      close(): Promise<void>;
      _client: any;
    }
  }
  
  // Process namespace 
  export namespace process {
    function traversal(): TraversalSource;
  }
  
  // Top-level exports
  export class Client {
    constructor(url: string, options?: any);
    submit(script: string, bindings?: any): ResultSet;
    close(): Promise<void>;
  }
}
/**
 * Represents the result of a graph database query
 */
export interface QueryResult<T> {
  /** The data returned from the query */
  data: T[];
  /** Metadata about the query execution */
  metadata: {
    /** Time taken to execute the query in milliseconds */
    execution_time: number;
    /** Number of rows/records returned */
    row_count: number;
    /** Error message if there was an error */
    error?: string;
    /** Type of error that occurred */
    error_type?: string;
  };
}
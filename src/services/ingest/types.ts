/**
 * Connector contract for the ingest layer.
 *
 * Everything expensive and everything easy to get wrong — content-hash dedupe, chunking,
 * extraction, the transactional merge, failure isolation — lives in the shared pipeline
 * (ingestPipeline.ts), so a new connector is only the "how do I list documents" part.
 */

/** One unit of content to ingest. */
export interface IngestDocument {
  /**
   * Stable identity within its source — a file path, a URL, a caller-supplied id. Must be stable
   * across polls: if it changes, the same content re-ingests as a new document every tick.
   */
  externalId: string;
  content: string;
  /** Optional human label used in logs. Falls back to externalId. */
  title?: string;
}

export interface SourceConnector {
  /** Matches Source.type in the database. */
  type: string;
  /**
   * Lists everything currently visible from this source. Returns ALL documents, not just new
   * ones — the pipeline dedupes by content hash, so a connector never has to track state itself.
   *
   * Push-driven connectors (http) return an empty array: nothing to poll.
   */
  poll(config: Record<string, unknown>): Promise<IngestDocument[]>;
}

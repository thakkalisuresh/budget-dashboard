/**
 * BigQuery transport for the warehouse.
 *
 * Isolated in its own module for two reasons: the heavy clients load lazily, so
 * a cold start that never touches the warehouse pays nothing for it; and every
 * other warehouse module stays importable by unit tests without a BigQuery
 * dependency.
 *
 * ── The one thing that must never change ──────────────────────────────────
 *
 * Rows are written with the **Storage Write API** (default stream), never with
 * the legacy `insertAll` streaming API.
 *
 *   Storage Write API   2 TiB/month free tier.  At ~82 transactions/month this
 *                       is free by a factor of roughly ten million.
 *   insertAll           $0.05/GB with a 1 KB MINIMUM BILLED PER ROW, and no
 *                       free tier at all.
 *
 * They are different products with different pricing, they live in the same
 * client library, and `bigquery.dataset(d).table(t).insert(rows)` is the
 * ergonomic one. That is exactly how this design would accidentally start
 * costing money, so `insert()` is not called anywhere in this file and there is
 * an ESLint rule banning it repo-wide.
 *
 * Queries go through the ordinary jobs API (1 TiB/month free), which is a third
 * thing again and is fine.
 */

/* Per-warm-instance caches. WriterClient holds gRPC connections; rebuilding one
   per write would cost more than the write. */
let _bigquery = null;
const _writers = new Map(); // `${dataset}.${table}` -> Promise<{ writer, client }>

/** The project the functions run in. Platform-provided; no secret binding needed. */
export function projectId() {
  return process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || '';
}

/** Reset the caches. Tests and the scheduled jobs use this. */
export function __resetWarehouseClient() {
  _bigquery = null;
  _writers.clear();
}

async function bigquery() {
  if (!_bigquery) {
    const { BigQuery } = await import('@google-cloud/bigquery');
    _bigquery = new BigQuery({ projectId: projectId() });
  }
  return _bigquery;
}

async function writerFor(dataset, table) {
  const key = `${dataset}.${table}`;
  if (!_writers.has(key)) {
    _writers.set(key, (async () => {
      const { adapt, managedwriter } = await import('@google-cloud/bigquery-storage');
      const { WriterClient, JSONWriter } = managedwriter;

      const destinationTable = `projects/${projectId()}/datasets/${dataset}/tables/${table}`;
      const client = new WriterClient({ projectId: projectId() });

      // The proto descriptor has to match the live table, so read the schema
      // back rather than deriving it from our own definitions — a column added
      // by hand would otherwise make every write fail with a shape error.
      const stream = await client.getWriteStream({
        streamId: `${destinationTable}/streams/_default`,
        view: 'FULL',
      });
      const protoDescriptor = adapt.convertStorageSchemaToProto2Descriptor(stream.tableSchema, 'root');
      const connection = await client.createStreamConnection({
        streamId: managedwriter.DefaultStream,
        destinationTable,
      });

      return { writer: new JSONWriter({ connection, protoDescriptor }), client };
    })().catch((e) => {
      // Don't cache a failed handshake — the next attempt should retry it.
      _writers.delete(key);
      throw e;
    }));
  }
  return _writers.get(key);
}

/**
 * Append rows to a table via the default stream.
 *
 * Rows must already be encoded by `encodeRow()` from _warehouse-schema.mjs —
 * DATE as days-since-epoch, TIMESTAMP as epoch microseconds. Passing an ISO
 * string does not throw; it writes a wrong instant, which in an append-only
 * store cannot be corrected.
 *
 * Resolves when BigQuery has acknowledged the append, so the caller can report
 * honestly whether the row landed.
 */
export async function appendRows(dataset, table, rows) {
  if (!rows || rows.length === 0) return { appended: 0 };
  const { writer } = await writerFor(dataset, table);
  const pending = writer.appendRows(rows);
  const res = await pending.getResult();
  if (res?.error) throw new Error(res.error.message || 'Storage Write API rejected the append');
  return { appended: rows.length };
}

/**
 * Run a query. Parameterised — the reconciler and the backfill both interpolate
 * month names and spreadsheet ids that come from a spreadsheet the user edits
 * by hand.
 *
 * `maximumBytesBilled` is a per-job hard stop on top of the project-level
 * custom quota: a mistyped predicate against a partitioned table should fail
 * loudly rather than scan everything.
 */
export async function runQuery(sql, params = {}, { maximumBytesBilled = '1000000000' } = {}) {
  const bq = await bigquery();
  const [rows] = await bq.query({
    query: sql,
    params,
    location: 'US',
    maximumBytesBilled,
  });
  return rows;
}

/** Run DDL/DML that returns nothing (setup, staging truncate, staging INSERT). */
export async function runStatement(sql, params = {}) {
  const bq = await bigquery();
  const [job] = await bq.createQueryJob({ query: sql, params, location: 'US' });
  await job.getQueryResults();
  return job;
}

/**
 * Dataset options, so the monthly sweep can assert that no expiration timer is
 * set. `defaultTableExpirationMs` or `defaultPartitionExpirationMs` would
 * silently delete the archive on a schedule, with no error anywhere.
 */
export async function datasetMetadata(dataset) {
  const bq = await bigquery();
  const [metadata] = await bq.dataset(dataset).getMetadata();
  return metadata;
}

import duckdb from 'duckdb';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP_ROOT = process.env.APP_ROOT || '/app';

const MANIFEST_PATH =
  process.env.MANIFEST_PATH ||
  join(APP_ROOT, 'fixtures', 'build_manifest.csv');

const DB_PATH =
  process.env.DB_PATH ||
  join(APP_ROOT, 'releases.duckdb');

const CURRENT_KEY_PATH =
  process.env.CURRENT_KEY_PATH ||
  join(APP_ROOT, 'keys', 'current', 'current.key.pem');

const CURRENT_CERT_PATH =
  process.env.CURRENT_CERT_PATH ||
  join(APP_ROOT, 'keys', 'current', 'current.cert.pem');

const GATEWAY_URL = (
  process.env.GATEWAY_URL ||
  'http://127.0.0.1:7070'
).replace(/\/$/, '');


function openDatabase(file) {
  return new Promise((resolve, reject) => {
    const db = new duckdb.Database(file, (err) => {
      if (err) {
        reject(err);
      } else {
        resolve(db);
      }
    });
  });
}


function dbRun(db, sql, ...params) {
  return new Promise((resolve, reject) => {
    db.run(sql, ...params, (err) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
}


function dbAll(db, sql, ...params) {
  return new Promise((resolve, reject) => {
    db.all(sql, ...params, (err, rows) => {
      if (err) {
        reject(err);
      } else {
        resolve(rows);
      }
    });
  });
}


function closeDatabase(db) {
  return new Promise((resolve, reject) => {
    db.close((err) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
}


/*
 * The gateway uses:
 *
 * UTF-8 JSON
 * sorted object keys
 * no whitespace
 *
 * Example:
 *
 * {"artifact_count":4,"bundle_id":"BND-101","total_bytes":652525}
 */
function canonicalEncode(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalEncode).join(',')}]`;
  }

  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalEncode(value[key])}`
      )
      .join(',')}}`;
  }

  return JSON.stringify(value);
}


/*
 * Create a detached CMS signature using the CURRENT signing key.
 */
function signDetachedCms(descriptor) {
  const scratch = mkdtempSync(
    join(tmpdir(), 'fw-publisher-')
  );

  const descriptorFile = join(
    scratch,
    'descriptor.bin'
  );

  try {
    /*
     * Important:
     * Do not add a newline.
     *
     * These exact bytes are sent to the gateway.
     */
    writeFileSync(
      descriptorFile,
      descriptor,
      'utf8'
    );

    return execFileSync(
      'openssl',
      [
        'cms',
        '-sign',
        '-in',
        descriptorFile,
        '-signer',
        CURRENT_CERT_PATH,
        '-inkey',
        CURRENT_KEY_PATH,
        '-outform',
        'PEM',
        '-binary'
      ],
      {
        encoding: 'utf8'
      }
    );
  } finally {
    rmSync(
      scratch,
      {
        recursive: true,
        force: true
      }
    );
  }
}


/*
 * Ask the gateway which signing key is currently active.
 */
async function getCurrentSigningKey() {
  const response = await fetch(
    `${GATEWAY_URL}/v1/signing-key/current`
  );

  if (!response.ok) {
    throw new Error(
      `GET /v1/signing-key/current failed: ` +
      `HTTP ${response.status} ${await response.text()}`
    );
  }

  const body = await response.json();

  if (
    !body.key_id ||
    !body.algorithm ||
    body.status !== 'current'
  ) {
    throw new Error(
      'Gateway returned invalid signing-key metadata.'
    );
  }

  return body;
}


/*
 * Submit a signed descriptor to the gateway.
 */
async function publish(
  descriptor,
  signature,
  requestToken
) {
  const response = await fetch(
    `${GATEWAY_URL}/v1/publications`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        descriptor,
        signature,
        request_token: requestToken
      })
    }
  );

  const body = await response
    .json()
    .catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      `POST /v1/publications failed for ` +
      `${requestToken}: HTTP ${response.status} ` +
      `${JSON.stringify(body)}`
    );
  }

  if (
    typeof body.publication_id !== 'string' ||
    body.request_token !== requestToken ||
    body.status !== 'PUBLISHED'
  ) {
    throw new Error(
      `Invalid publication receipt for ` +
      `${requestToken}: ${JSON.stringify(body)}`
    );
  }

  return body;
}


/*
 * Load the CSV into DuckDB and reconcile it using SQL.
 *
 * Rules:
 *
 * 1. Remove exact duplicate rows.
 * 2. Find builds referenced by withdrawals.
 * 3. Remove withdrawn builds.
 * 4. Group surviving builds by bundle.
 */
async function reconcileManifest(db) {
  await dbRun(
    db,
    `
      CREATE OR REPLACE TABLE manifest AS
      SELECT *
      FROM read_csv_auto(
        ?,
        HEADER = TRUE,
        ALL_VARCHAR = TRUE
      )
    `,
    MANIFEST_PATH
  );

  return dbAll(
    db,
    `
      WITH distinct_rows AS (
        SELECT DISTINCT
          entry_id,
          bundle_id,
          component_id,
          version,
          TRY_CAST(size_bytes AS BIGINT) AS size_bytes,
          record_type,
          supersedes_id,
          recorded_at
        FROM manifest
      ),

      withdrawn_builds AS (
        SELECT DISTINCT
          supersedes_id AS entry_id
        FROM distinct_rows
        WHERE record_type = 'WITHDRAWAL'
          AND supersedes_id IS NOT NULL
          AND supersedes_id <> ''
      ),

      surviving_builds AS (
        SELECT
          entry_id,
          bundle_id,
          component_id,
          version,
          size_bytes,
          recorded_at
        FROM distinct_rows
        WHERE record_type = 'BUILD'
          AND entry_id NOT IN (
            SELECT entry_id
            FROM withdrawn_builds
          )
      )

      SELECT
        bundle_id,
        COUNT(*)::BIGINT AS artifact_count,
        SUM(size_bytes)::BIGINT AS total_bytes

      FROM surviving_builds

      GROUP BY bundle_id

      HAVING COUNT(*) > 0

      ORDER BY bundle_id
    `
  );
}


/*
 * Local publication table.
 *
 * This provides local idempotency.
 */
async function ensurePublicationTable(db) {
  await dbRun(
    db,
    `
      CREATE TABLE IF NOT EXISTS publications (
        bundle_id VARCHAR PRIMARY KEY,
        request_token VARCHAR NOT NULL,
        publication_id VARCHAR NOT NULL,
        status VARCHAR NOT NULL,
        key_id VARCHAR NOT NULL,
        descriptor VARCHAR NOT NULL
      )
    `
  );
}


async function getStoredPublication(
  db,
  bundleId
) {
  const rows = await dbAll(
    db,
    `
      SELECT
        bundle_id,
        request_token,
        publication_id,
        status,
        key_id,
        descriptor
      FROM publications
      WHERE bundle_id = ?
    `,
    bundleId
  );

  return rows.length
    ? rows[0]
    : null;
}


async function storePublication(
  db,
  bundle,
  receipt,
  keyId,
  descriptor
) {
  await dbRun(
    db,
    `
      INSERT INTO publications (
        bundle_id,
        request_token,
        publication_id,
        status,
        key_id,
        descriptor
      )
      VALUES (?, ?, ?, ?, ?, ?)
    `,
    bundle.bundle_id,
    receipt.request_token,
    receipt.publication_id,
    receipt.status,
    keyId,
    descriptor
  );
}


/*
 * Main publisher workflow.
 */
async function main() {
  const db = await openDatabase(DB_PATH);

  try {
    await ensurePublicationTable(db);

    /*
     * Step 1:
     * Reconcile the raw manifest using SQL.
     */
    const bundles = await reconcileManifest(db);

    /*
     * Step 2:
     * Discover the currently active signing key.
     */
    const signingKey =
      await getCurrentSigningKey();

    /*
     * Step 3:
     * Process bundles in deterministic order.
     */
    for (const bundle of bundles) {
      const requestToken =
        `token-${bundle.bundle_id}`;

      /*
       * If this bundle was already successfully
       * published locally, don't submit it again.
       */
      const stored =
        await getStoredPublication(
          db,
          bundle.bundle_id
        );

      if (stored) {
        console.log(
          `BUNDLE ${bundle.bundle_id} ` +
          `SIGNED KEY=${stored.key_id}`
        );

        console.log(
          `BUNDLE ${bundle.bundle_id} ` +
          `PUBLISHED ` +
          `RECEIPT=${stored.publication_id} ` +
          `TOKEN=${stored.request_token} ` +
          `STATUS=${stored.status}`
        );

        continue;
      }

      /*
       * Construct the descriptor.
       *
       * Keys are deliberately supplied in any order
       * because canonicalEncode() sorts them.
       */
      const descriptorObject = {
        artifact_count:
          Number(bundle.artifact_count),

        bundle_id:
          bundle.bundle_id,

        total_bytes:
          Number(bundle.total_bytes)
      };

      /*
       * Canonical descriptor.
       */
      const descriptor =
        canonicalEncode(
          descriptorObject
        );

      /*
       * Detached CMS signature.
       */
      const signature =
        signDetachedCms(
          descriptor
        );

      /*
       * Publish over HTTP.
       */
      const receipt =
        await publish(
          descriptor,
          signature,
          requestToken
        );

      /*
       * Persist receipt locally.
       */
      await storePublication(
        db,
        bundle,
        receipt,
        signingKey.key_id,
        descriptor
      );

      /*
       * Deterministic output.
       */
      console.log(
        `BUNDLE ${bundle.bundle_id} ` +
        `SIGNED KEY=${signingKey.key_id}`
      );

      console.log(
        `BUNDLE ${bundle.bundle_id} ` +
        `PUBLISHED ` +
        `RECEIPT=${receipt.publication_id} ` +
        `TOKEN=${receipt.request_token} ` +
        `STATUS=${receipt.status}`
      );
    }
  } finally {
    await closeDatabase(db);
  }
}


main().catch((error) => {
  console.error(
    error instanceof Error
      ? error.message
      : error
  );

  process.exitCode = 1;
});
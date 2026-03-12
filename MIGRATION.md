# D1 → PostgreSQL (Neon + Hyperdrive) Migration Plan

Branch: `claude/migrate-worker-postgresql-VR4ll`

## Status legend
- [ ] pending
- [x] done

---

## Tasks

- [ ] 1. Checkout/create branch `claude/migrate-worker-postgresql-VR4ll`
- [ ] 2. `worker/wrangler.toml` — remove `[[d1_databases]]`, add `[[hyperdrive]]` + `nodejs_compat`
- [ ] 3. `worker/package.json` — add `@neondatabase/serverless`, update `@cloudflare/workers-types`
- [ ] 4. `worker/src/types.ts` — replace `DB: D1Database` with `HYPERDRIVE: Hyperdrive`
- [ ] 5. `schema.sql` — full Postgres rewrite
- [ ] 6. `worker/src/index.ts` — full DB layer rewrite (16 sub-tasks below)
- [ ] 7. Commit + push

---

## Detailed notes per task

### Task 2 — wrangler.toml

Changes:
- Remove `[[d1_databases]]` block entirely
- Add `compatibility_flags = ["nodejs_compat"]` — required for `@neondatabase/serverless`
- Add `[[hyperdrive]]` binding:
  ```toml
  [[hyperdrive]]
  binding = "HYPERDRIVE"
  id = "<hyperdrive-config-id>"   # set after: wrangler hyperdrive create tg-reader-pg --connection-string="..."
  ```
- Keep `[[r2_buckets]]` and `[triggers]` unchanged

Local dev note: `wrangler dev --local` does NOT work with Hyperdrive.
Use `wrangler dev --remote` or add a `DATABASE_URL` secret pointing at a local Postgres.

### Task 3 — package.json

- Add runtime dependency: `@neondatabase/serverless` (latest)
- Update `@cloudflare/workers-types` to latest (needed for `Hyperdrive` type export)

### Task 4 — types.ts

```typescript
import type { Hyperdrive } from '@cloudflare/workers-types';

export interface Env {
  HYPERDRIVE: Hyperdrive;   // was: DB: D1Database
  BACKUP_BUCKET: R2Bucket;
  INGEST_TOKEN: string;
}
```

`Message.is_deleted` stays `number` (SMALLINT in schema) to avoid cascading TS changes.

### Task 5 — schema.sql (Postgres)

Key type changes:

| Old (SQLite) | New (Postgres) |
|---|---|
| `INTEGER PRIMARY KEY AUTOINCREMENT` | `BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY` |
| `DEFAULT (unixepoch())` | `DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT` |
| `INTEGER DEFAULT 0` (booleans) | `SMALLINT NOT NULL DEFAULT 0` |
| `INSERT OR IGNORE` | `INSERT ... ON CONFLICT DO NOTHING` |
| FTS5 virtual table + 3 triggers | Generated `tsvector` column + GIN index |

FTS replacement:
```sql
search_vector tsvector GENERATED ALWAYS AS (
  to_tsvector('simple',
    COALESCE(text, '') || ' ' ||
    COALESCE(sender_username, '') || ' ' ||
    COALESCE(sender_first_name, '') || ' ' ||
    COALESCE(chat_name, '')
  )
) STORED,

CREATE INDEX idx_messages_fts ON messages USING GIN (search_vector);
```

Use `'simple'` dictionary (not `'english'`) — multilingual messages.

Partial index syntax is identical in Postgres — no change.
`NULLS LAST` must be kept explicit — Postgres DESC defaults to NULLS FIRST.

### Task 6 — index.ts rewrite rules (apply everywhere)

#### A. Pool initialisation
```typescript
import { Pool } from '@neondatabase/serverless';
// Per-request, inside each handler:
const pool = new Pool({ connectionString: env.HYPERDRIVE.connectionString });
// Do NOT call pool.end() — runtime handles cleanup
```

#### B. Query execution
```typescript
// .prepare(SQL).bind(...).all()  →  pool.query(SQL, [...])
const { rows } = await pool.query<T>(SQL, [a, b, c]);

// .first<T>()  →
const { rows } = await pool.query<T>(SQL, [a]);
const row = rows[0] ?? null;

// .run()  →
await pool.query(SQL, [a]);
```

#### C. Placeholders
All `?` → `$1`, `$2`, `$N` (1-indexed, positional).

#### D. db.batch() — two patterns

**Parallel reads** (handleSearch, handleStats):
```typescript
const [r1, r2] = await Promise.all([pool.query(SQL1, [...]), pool.query(SQL2, [...])]);
```

**Atomic writes** (handleIngest, handlePostContacts, handleDeleted, handleBackfillSeed):
```typescript
const client = await pool.connect();
try {
  await client.query('BEGIN');
  for (const item of items) {
    const result = await client.query(SQL, [...]);
    if ((result.rowCount ?? 0) > 0) written++; else noop++;
  }
  await client.query('COMMIT');
} catch (err) {
  await client.query('ROLLBACK');
  throw err;
} finally {
  client.release();
}
```

#### E. rows_written → rowCount
```typescript
result.meta.rows_written > 0  →  (result.rowCount ?? 0) > 0
```

#### F. COUNT(*) returns string
```typescript
const total = parseInt((rows[0] as { total: string }).total, 10);
```

#### G. unixepoch() in SQL
Replace with `EXTRACT(EPOCH FROM NOW())::BIGINT` in SQL strings,
OR `Math.floor(Date.now() / 1000)` passed as a `$N` parameter (used in dynamic builders).

#### H. Dynamic query builder (handleBackfillProgress only)
Use a counter for `$N`:
```typescript
let p = 0;
const next = () => `$${++p}`;
// push `col = ${next()}` into sets[], push value into binds[]
// WHERE clause at the end also uses next()
```

#### I. FTS search
Query builder:
```typescript
// Old: '"token"*' joined with spaces
// New:
const q = qTokens.map(t => t.replace(/[^a-zA-Z0-9\u00C0-\u017F]/g, '') + ':*').join(' & ');
```

SQL:
```sql
-- Remove: JOIN messages_fts ON messages_fts.rowid = m.id
-- Remove: WHERE messages_fts MATCH $1
-- Add:
WHERE m.search_vector @@ to_tsquery('simple', $1)
```

Error handling: `'fts5'` → `'tsquery'` in error message check.

#### J. streamMessages
```typescript
async function* streamMessages(pool: Pool): AsyncGenerator<string> {
  const batchSize = 1000;
  let lastId = 0;
  while (true) {
    const { rows } = await pool.query(
      'SELECT * FROM messages WHERE id > $1 ORDER BY id LIMIT $2',
      [lastId, batchSize],
    );
    if (rows.length === 0) break;
    for (const row of rows) yield JSON.stringify(row) + '\n';
    lastId = (rows[rows.length - 1] as { id: number }).id;
    if (rows.length < batchSize) break;
  }
}
```

### Task 7 — Deploy sequence (correct order)

1. Scale Fly listener to 0 instances
2. Apply `schema.sql` to Neon: `psql $DATABASE_URL -f schema.sql`
3. Deploy Worker: `cd worker && wrangler deploy`
4. Smoke test: `GET /stats` should return zeros
5. Run `backfill-seed` then `backfill-run` from GramJS
6. Scale Fly listener back up
7. Confirm D1 can be deleted when stable

---

## 12 things that break if followed naively

1. `postgres` npm package — no TCP in Workers → use `@neondatabase/serverless`
2. Missing `nodejs_compat` flag → `@neondatabase/serverless` fails to load
3. `?` placeholders → throw at runtime, must be `$N`
4. `INSERT OR IGNORE` → not Postgres syntax
5. `unixepoch()` → doesn't exist in Postgres (8+ occurrences in index.ts SQL strings)
6. `result.meta.rows_written` → doesn't exist on Postgres results
7. `COUNT(*)` returned as string → must `parseInt`
8. `db.batch()` → doesn't exist; parallel reads need `Promise.all`, atomic writes need `BEGIN/COMMIT`
9. `handleBackfillProgress` dynamic builder → counter-based `$N` required
10. FTS5 `MATCH` + `messages_fts` virtual table → nonexistent in Postgres
11. `AUTOINCREMENT` → SQLite-only, use `GENERATED ALWAYS AS IDENTITY`
12. Deploy order → scale down listener BEFORE switching Worker to Neon

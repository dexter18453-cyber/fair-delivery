'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const clone = value => structuredClone(value);
const seed = () => ({
  version: 2,
  shops: [{ id: 'o-stelios', name: 'Ο Στέλιος', area: 'Κερατσίνι', active: false, deliveryFeeCents: 0, products: [], shopKeyHash: null }],
  orders: [],
  expenses: []
});

async function createStore(options = {}) {
  const databaseUrl = options.databaseUrl || process.env.DATABASE_URL;
  if (databaseUrl) {
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: databaseUrl, max: 5, connectionTimeoutMillis: 10000 });
    await pool.query(`CREATE TABLE IF NOT EXISTS fair_delivery_pilot_state (
      id integer PRIMARY KEY CHECK (id=1),
      data jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )`);
    await pool.query('INSERT INTO fair_delivery_pilot_state (id, data) VALUES (1, $1) ON CONFLICT (id) DO NOTHING', [JSON.stringify(seed())]);
    return {
      kind: 'postgres',
      async read() {
        const res = await pool.query('SELECT data FROM fair_delivery_pilot_state WHERE id=1');
        return clone(res.rows[0].data);
      },
      async transact(fn) {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const res = await client.query('SELECT data FROM fair_delivery_pilot_state WHERE id=1 FOR UPDATE');
          const state = res.rows[0].data;
          const value = await fn(state);
          await client.query('UPDATE fair_delivery_pilot_state SET data=$1, updated_at=now() WHERE id=1', [JSON.stringify(state)]);
          await client.query('COMMIT');
          return value;
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally { client.release(); }
      },
      async close() { await pool.end(); }
    };
  }
  if (options.production || process.env.NODE_ENV === 'production') {
    throw new Error('DATABASE_URL is mandatory in production; refusing ephemeral storage');
  }
  const file = options.file || process.env.DATA_FILE || path.join(process.cwd(), '.local', 'fair-delivery.json');
  await fs.mkdir(path.dirname(file), { recursive: true });
  let state;
  try { state = JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') throw e; state = seed(); }
  let queue = Promise.resolve();
  return {
    kind: 'local-json',
    async read() { await queue; return clone(state); },
    async transact(fn) {
      const job = queue.then(async () => {
        const next = clone(state);
        const result = await fn(next);
        const temp = file + '.' + crypto.randomUUID() + '.tmp';
        await fs.writeFile(temp, JSON.stringify(next, null, 2), { mode: 0o600, flag: 'wx' });
        await fs.rename(temp, file);
        state = next;
        return result;
      });
      queue = job.then(() => undefined, () => undefined);
      return job;
    },
    async close() { await queue; }
  };
}
module.exports = { createStore };

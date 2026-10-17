const { Pool } = require('pg');
require('dotenv').config();

const isCloud = !!process.env.DATABASE_URL;

let pool = null;
if (isCloud) {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
}

function convertSql(sql) {
  let idx = 1;
  return sql
    .replace(/\?/g, () => `$${idx++}`)
    .replace(/datetime\('now'\)/gi, 'NOW()')
    .replace(/datetime\("now"\)/gi, 'NOW()')
    .replace(/datetime\("now",\s*"-7 days"\)/gi, "NOW() - INTERVAL '7 days'");
}

const db = {
  isCloud,
  async query(sql, params = []) {
    const formattedSql = convertSql(sql);
    const res = await pool.query(formattedSql, params);
    return res.rows;
  },
  async get(sql, params = []) {
    const formattedSql = convertSql(sql);
    const res = await pool.query(formattedSql, params);
    return res.rows[0] || null;
  },
  async run(sql, params = []) {
    const formattedSql = convertSql(sql);
    return await pool.query(formattedSql, params);
  },
  async transaction(callback) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const txDb = {
        async query(sql, params = []) {
          return (await client.query(convertSql(sql), params)).rows;
        },
        async get(sql, params = []) {
          return (await client.query(convertSql(sql), params)).rows[0] || null;
        },
        async run(sql, params = []) {
          return await client.query(convertSql(sql), params);
        },
      };
      const result = await callback(txDb);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },
};

module.exports = { db, isCloud };

require('dotenv').config();
const pool = require('./db');
const fs   = require('fs');
const path = require('path');

async function migrate() {
  console.log('Running migrations…');
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  try {
    await pool.query(sql);
    console.log('✅ Database migrated successfully');
  } catch (err) {
    console.error('❌ Migration failed:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

migrate();

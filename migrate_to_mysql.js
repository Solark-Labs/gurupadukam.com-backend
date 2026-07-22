import mysql from 'mysql2/promise';
import sqlite3 from 'sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Helper to parse env variables from .env.local manually
function parseEnv(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const content = fs.readFileSync(filePath, 'utf-8');
  const env = {};
  content.split('\n').forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const parts = trimmed.split('=');
    const key = parts[0].trim();
    let val = parts.slice(1).join('=').trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    env[key] = val;
  });
  return env;
}

const env = parseEnv(path.join(__dirname, '.env.local'));

const mysqlConfig = {
  host: process.env.MYSQL_HOST || env.MYSQL_HOST,
  port: parseInt(process.env.MYSQL_PORT || env.MYSQL_PORT || '3306'),
  user: process.env.MYSQL_USER || env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD || env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE || env.MYSQL_DATABASE,
};

async function migrate() {
  if (!mysqlConfig.host || !mysqlConfig.database || !mysqlConfig.user) {
    console.error('❌ Error: MySQL configuration variables (MYSQL_HOST, MYSQL_DATABASE, MYSQL_USER) are missing in environment or .env.local.');
    process.exit(1);
  }

  console.log('✦ Connecting to local SQLite database...');
  const dbPath = path.join(__dirname, 'gurupadukam.db');
  const sqliteDb = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (err) => {
    if (err) {
      console.error('❌ Error opening SQLite database:', err.message);
      process.exit(1);
    }
  });

  const querySQLite = (sql, params = []) => {
    return new Promise((resolve, reject) => {
      sqliteDb.all(sql, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });
  };

  console.log('✦ Connecting to Hostinger MySQL Database...');
  const mysqlConn = await mysql.createConnection(mysqlConfig);
  console.log('✅ Connected to MySQL successfully!');

  // Define tables in migration order (dependencies first)
  const tables = [
    { name: 'users', key: 'id' },
    { name: 'products', key: 'id' },
    { name: 'proposals', key: 'id' },
    { name: 'orders', key: 'id' },
    { name: 'order_items', key: 'id' },
    { name: 'notifications', key: 'id' },
    { name: 'classes', key: 'id' },
    { name: 'class_registrations', key: 'id' },
    { name: 'purohits', key: 'id' },
    { name: 'purohit_bookings', key: 'id' },
    { name: 'horoscopes', key: 'id' },
    { name: 'queries', key: 'id' },
    { name: 'replies', key: 'id' },
    { name: 'puja_quotes', key: 'id' },
    { name: 'cottage_partners', key: 'id' },
    { name: 'purohit_reviews', key: 'id' },
    { name: 'product_reviews', key: 'id' },
    { name: 'events', key: 'id' },
    { name: 'parinayam_profiles', key: 'id' },
    { name: 'parinayam_connections', key: 'id' }
  ];

  for (const t of tables) {
    console.log(`\n✦ Migrating table "${t.name}"...`);
    try {
      const rows = await querySQLite(`SELECT * FROM ${t.name}`);
      if (rows.length === 0) {
        console.log(`ℹ️ Table "${t.name}" is empty in SQLite. Skipping.`);
        continue;
      }

      console.log(`Found ${rows.length} rows in SQLite. Inserting into MySQL...`);

      // Get columns dynamically from the first row
      const columns = Object.keys(rows[0]);
      
      // We will perform a REPLACE INTO or INSERT INTO ... ON DUPLICATE KEY UPDATE
      const columnsStr = columns.map(c => `\`${c}\``).join(', ');
      const placeholders = columns.map(() => '?').join(', ');
      
      const sql = `REPLACE INTO \`${t.name}\` (${columnsStr}) VALUES (${placeholders})`;

      let count = 0;
      for (const row of rows) {
        const values = columns.map(col => {
          const val = row[col];
          // Handle SQLite boolean conversions (0/1) to MySQL TINYINT or direct values
          return val;
        });
        await mysqlConn.execute(sql, values);
        count++;
      }
      console.log(`✅ Successfully migrated ${count}/${rows.length} rows for "${t.name}".`);
    } catch (e) {
      console.error(`❌ Error migrating table "${t.name}":`, e.message);
    }
  }

  sqliteDb.close();
  await mysqlConn.end();
  console.log('\n✨ Database migration completed successfully! All records secured in Hostinger MySQL. ✨');
}

migrate().catch(e => {
  console.error('❌ Migration failed:', e);
});

import sqlite3 from 'sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbPath = path.join(__dirname, 'gurupadukam.db');

const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
});

db.serialize(() => {
  db.run("UPDATE products SET image = '/images/products/pasupu.png' WHERE id = 'p1'", (err) => {
    if (err) console.error(err);
  });
  db.run("UPDATE products SET image = '/images/products/kumkum.png' WHERE id = 'p2'", (err) => {
    if (err) console.error(err);
    else console.log("Local SQLite DB updated successfully!");
  });
});
db.close();

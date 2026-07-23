import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import bcrypt from 'bcryptjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Env config: Automatically detect if we are using Hostinger MySQL or Local SQLite
const isMySQL = process.env.DB_TYPE === 'mysql' || !!process.env.MYSQL_HOST;

let db;
let mysqlPool;

let dbInitResolve;
export const dbInitPromise = new Promise((resolve) => {
  dbInitResolve = resolve;
});

if (isMySQL) {
  console.log('✦ Database Engine: Hostinger Remote MySQL Pool Active');
  try {
    const { default: mysql } = await import('mysql2/promise');
    const poolConfig = {
      host: process.env.MYSQL_HOST,
      port: parseInt(process.env.MYSQL_PORT || '3306'),
      user: process.env.MYSQL_USER,
      password: process.env.MYSQL_PASSWORD,
      database: process.env.MYSQL_DATABASE,
      waitForConnections: true,
      connectionLimit: parseInt(process.env.MYSQL_CONNECTION_LIMIT || '25'),
      queueLimit: 0,
      enableKeepAlive: true,
      keepAliveInitialDelay: 10000
    };
    mysqlPool = mysql.createPool(poolConfig);
    initializeDatabaseMySQL();
  } catch (err) {
    console.error('Failed initializing Remote MySQL Pool:', err.message);
    if (dbInitResolve) dbInitResolve();
  }
} else {
  console.log('✦ Database Engine: File-Based SQLite Active');
  const isVercel = !!process.env.VERCEL;
  let dbPath = process.env.DATABASE_URL || process.env.DB_PATH || path.join(__dirname, 'gurupadukam.db');
  
  if (isVercel) {
    dbPath = '/tmp/gurupadukam.db';
    try {
      if (!fs.existsSync(dbPath)) {
        const srcDb = path.join(__dirname, 'gurupadukam.db');
        if (fs.existsSync(srcDb)) {
          fs.copyFileSync(srcDb, dbPath);
          console.log('Copied database template to /tmp/gurupadukam.db');
        }
      }
    } catch (e) {
      console.error('Failed copying database template to /tmp:', e.message);
    }
  }

  try {
    const { default: sqlite3Module } = await import('sqlite3');
    db = new sqlite3Module.Database(dbPath, (err) => {
      if (err) {
        console.error('Error opening SQLite database:', err.message);
        if (dbInitResolve) dbInitResolve();
      } else {
        db.serialize(() => {
          try { db.run("PRAGMA journal_mode=WAL"); } catch (e) {}
          try { db.run("PRAGMA synchronous=NORMAL"); } catch (e) {}
          try { db.run("PRAGMA busy_timeout=10000"); } catch (e) {}
        });
        initializeDatabaseSQLite();
      }
    });
  } catch (err) {
    console.warn('SQLite native bindings not available on this serverless runtime:', err.message);
    if (dbInitResolve) dbInitResolve();
  }
}

// Unified Database Promise Wrapper Functions
export const dbQuery = (sql, params = []) => {
  if (isMySQL) {
    return new Promise(async (resolve, reject) => {
      try {
        if (!mysqlPool) return resolve([]);
        const [rows] = await mysqlPool.execute(sql, params);
        resolve(rows);
      } catch (err) {
        reject(err);
      }
    });
  } else {
    return new Promise((resolve, reject) => {
      if (!db) return resolve([]);
      db.all(sql, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });
  }
};

export const dbRun = (sql, params = []) => {
  if (isMySQL) {
    return new Promise(async (resolve, reject) => {
      try {
        if (!mysqlPool) return resolve({ id: Date.now(), changes: 1 });
        const [result] = await mysqlPool.execute(sql, params);
        resolve({ id: result.insertId, changes: result.affectedRows });
      } catch (err) {
        reject(err);
      }
    });
  } else {
    return new Promise((resolve, reject) => {
      if (!db) return resolve({ id: Date.now(), changes: 1 });
      db.run(sql, params, function (err) {
        if (err) reject(err);
        else resolve({ id: this ? this.lastID : Date.now(), changes: this ? this.changes : 1 });
      });
    });
  }
};

export const dbGet = (sql, params = []) => {
  if (isMySQL) {
    return new Promise(async (resolve, reject) => {
      try {
        if (!mysqlPool) return resolve(undefined);
        const [rows] = await mysqlPool.execute(sql, params);
        if (rows.length > 0) resolve(rows[0]);
        else resolve(undefined);
      } catch (err) {
        reject(err);
      }
    });
  } else {
    return new Promise((resolve, reject) => {
      if (!db) return resolve(undefined);
      db.get(sql, params, (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
  }
};

// 1. SQLite Schema Initialization
function initializeDatabaseSQLite() {
  db.serialize(async () => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      phone TEXT,
      role TEXT DEFAULT 'user',
      location TEXT,
      is_blocked INTEGER DEFAULT 0,
      totp_secret TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      name_te TEXT,
      price REAL NOT NULL,
      original_price REAL,
      category TEXT,
      image TEXT,
      description TEXT,
      stock INTEGER DEFAULT 0,
      badge TEXT,
      is_organic INTEGER DEFAULT 0
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS proposals (
      id TEXT PRIMARY KEY,
      proposer_id TEXT NOT NULL,
      proposer_name TEXT NOT NULL,
      proposer_location TEXT NOT NULL,
      action_type TEXT NOT NULL,
      product_id TEXT,
      details TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      customer_name TEXT NOT NULL,
      customer_email TEXT NOT NULL,
      customer_phone TEXT NOT NULL,
      shipping_address TEXT NOT NULL,
      total REAL NOT NULL,
      payment_method TEXT DEFAULT 'Razorpay',
      payment_status TEXT DEFAULT 'pending',
      razorpay_order_id TEXT,
      razorpay_payment_id TEXT,
      shiprocket_shipment_id TEXT,
      shiprocket_awb TEXT,
      status TEXT DEFAULT 'Processing',
      date DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id TEXT NOT NULL,
      product_id TEXT NOT NULL,
      product_name TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      price REAL NOT NULL
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      \`desc\` TEXT NOT NULL,
      \`read\` INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS classes (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  instructor_name TEXT NOT NULL,
  time TEXT NOT NULL,
  fee REAL NOT NULL,
  image TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT DEFAULT 'approved',
  proposer_name TEXT,
  proposer_location TEXT,
  video_url TEXT
)`);

    db.run(`CREATE TABLE IF NOT EXISTS class_registrations (
      id TEXT PRIMARY KEY,
      class_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      user_name TEXT NOT NULL,
      user_email TEXT NOT NULL,
      date DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS purohits (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      specialization TEXT NOT NULL,
      rating REAL DEFAULT 5.0,
      fee REAL NOT NULL,
      image TEXT NOT NULL,
      location TEXT NOT NULL,
      bookings_count INTEGER DEFAULT 0,
      bio TEXT,
      credentials TEXT,
      portfolio_images TEXT,
      email TEXT,
      phone TEXT,
      gov_id_type TEXT,
      gov_id_number TEXT,
      gov_id_image TEXT,
      experience_years INTEGER DEFAULT 5,
      languages TEXT DEFAULT 'Telugu, Sanskrit',
      is_verified INTEGER DEFAULT 0,
      banner_image TEXT,
      teaching_interest INTEGER DEFAULT 0,
      teaching_specialization TEXT,
      instructor_bio TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS purohit_bookings (
      id TEXT PRIMARY KEY,
      purohit_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      pooja_type TEXT NOT NULL,
      booking_date TEXT NOT NULL,
      time_slot TEXT NOT NULL,
      address TEXT NOT NULL,
      status TEXT DEFAULT 'Confirmed',
      items TEXT,
      items_purchased INTEGER DEFAULT 0,
      secure_deposit REAL DEFAULT 0,
      fixed_price REAL DEFAULT NULL,
      advance_amount REAL DEFAULT NULL,
      advance_paid INTEGER DEFAULT 0
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS purohit_posts (
      id TEXT PRIMARY KEY,
      purohit_id TEXT NOT NULL,
      image TEXT NOT NULL,
      caption TEXT,
      likes_count INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS horoscopes (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      dob TEXT NOT NULL,
      tob TEXT NOT NULL,
      pob TEXT NOT NULL,
      slot_date TEXT NOT NULL,
      slot_time TEXT NOT NULL,
      status TEXT DEFAULT 'Scheduled',
      priest_id TEXT DEFAULT NULL,
      google_meet_link TEXT DEFAULT NULL
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS queries (
      id TEXT PRIMARY KEY,
      user_name TEXT NOT NULL,
      question TEXT NOT NULL,
      category TEXT NOT NULL,
      date DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS replies (
      id TEXT PRIMARY KEY,
      query_id TEXT NOT NULL,
      replier_name TEXT NOT NULL,
      replier_role TEXT NOT NULL,
      reply_content TEXT NOT NULL,
      date DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS puja_quotes (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      user_name TEXT NOT NULL,
      purohit_id TEXT,
      purohit_name TEXT,
      puja_type TEXT NOT NULL,
      preferred_date TEXT NOT NULL,
      details TEXT NOT NULL,
      quote_amount REAL DEFAULT 0,
      status TEXT DEFAULT 'Pending Quote',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS cottage_partners (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      address TEXT NOT NULL,
      capacity TEXT NOT NULL,
      image TEXT,
      location TEXT NOT NULL
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS purohit_reviews (
      id TEXT PRIMARY KEY,
      booking_id TEXT NOT NULL,
      purohit_id TEXT NOT NULL,
      user_name TEXT NOT NULL,
      rating INTEGER NOT NULL,
      review_text TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS product_reviews (
      id TEXT PRIMARY KEY,
      product_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      user_name TEXT NOT NULL,
      rating INTEGER NOT NULL,
      review_text TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      category TEXT NOT NULL,
      description TEXT NOT NULL,
      date_time TEXT NOT NULL,
      location TEXT NOT NULL,
      organizer_name TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS parinayam_profiles (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      name TEXT NOT NULL,
      gender TEXT NOT NULL,
      dob TEXT NOT NULL,
      tob TEXT,
      pob TEXT,
      gothram TEXT,
      nakshatram TEXT,
      rasi TEXT,
      padam INTEGER,
      education TEXT,
      profession TEXT,
      income REAL,
      loans TEXT,
      about TEXT,
      photo TEXT,
      contact_phone TEXT,
      contact_email TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      is_active INTEGER DEFAULT 1,
      is_closed INTEGER DEFAULT 0
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS parinayam_connections (
      id TEXT PRIMARY KEY,
      from_profile_id TEXT NOT NULL,
      to_profile_id TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS hubs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      hours TEXT,
      coverage TEXT,
      license TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS registration_payments (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      user_name TEXT NOT NULL,
      user_email TEXT NOT NULL,
      amount REAL NOT NULL,
      transaction_id TEXT NOT NULL,
      payment_status TEXT DEFAULT 'success',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);



    // Schema updates (column modifications)
    db.run(`ALTER TABLE parinayam_profiles ADD COLUMN is_closed INTEGER DEFAULT 0`, (err) => {});
    db.run(`ALTER TABLE users ADD COLUMN is_blocked INTEGER DEFAULT 0`, (err) => {});
    db.run(`ALTER TABLE purohit_bookings ADD COLUMN items TEXT`, (err) => {});
    db.run(`ALTER TABLE purohit_bookings ADD COLUMN items_purchased INTEGER DEFAULT 0`, (err) => {});
    db.run(`ALTER TABLE purohit_bookings ADD COLUMN secure_deposit REAL DEFAULT 0`, (err) => {});
    db.run(`ALTER TABLE purohit_bookings ADD COLUMN ritual_mode TEXT DEFAULT 'Offline'`, (err) => {});
    db.run(`ALTER TABLE purohit_bookings ADD COLUMN google_meet_link TEXT`, (err) => {});
    db.run(`ALTER TABLE purohit_bookings ADD COLUMN fixed_price REAL DEFAULT NULL`, (err) => {});
    db.run(`ALTER TABLE purohit_bookings ADD COLUMN advance_amount REAL DEFAULT NULL`, (err) => {});
    db.run(`ALTER TABLE purohit_bookings ADD COLUMN advance_paid INTEGER DEFAULT 0`, (err) => {});
    db.run(`ALTER TABLE queries ADD COLUMN is_private INTEGER DEFAULT 0`, (err) => {});
    db.run(`ALTER TABLE queries ADD COLUMN is_deleted INTEGER DEFAULT 0`, (err) => {});
    db.run(`ALTER TABLE queries ADD COLUMN deleted_by TEXT`, (err) => {});
    db.run(`ALTER TABLE replies ADD COLUMN original_content TEXT`, (err) => {});
    db.run(`ALTER TABLE replies ADD COLUMN is_edited INTEGER DEFAULT 0`, (err) => {});
    db.run(`ALTER TABLE users ADD COLUMN totp_secret TEXT`, (err) => {});
    db.run(`ALTER TABLE class_registrations ADD COLUMN student_name TEXT`, (err) => {});
    db.run(`ALTER TABLE class_registrations ADD COLUMN student_age INTEGER`, (err) => {});
    db.run(`ALTER TABLE class_registrations ADD COLUMN parent_phone TEXT`, (err) => {});
    db.run(`ALTER TABLE class_registrations ADD COLUMN experience_level TEXT`, (err) => {});
    db.run(`ALTER TABLE class_registrations ADD COLUMN google_meet_link TEXT`, (err) => {});
    db.run(`ALTER TABLE classes ADD COLUMN status TEXT DEFAULT 'approved'`, (err) => {});
    db.run(`ALTER TABLE classes ADD COLUMN proposer_name TEXT`, (err) => {});
    db.run(`ALTER TABLE classes ADD COLUMN proposer_location TEXT`, (err) => {});
    db.run(`ALTER TABLE users ADD COLUMN communication_preferences TEXT DEFAULT '{"sms":true,"whatsapp":true,"email":true}'`, (err) => {});
    db.run(`ALTER TABLE purohits ADD COLUMN bio TEXT`, (err) => {});
    db.run(`ALTER TABLE purohits ADD COLUMN credentials TEXT`, (err) => {});
    db.run(`ALTER TABLE purohits ADD COLUMN portfolio_images TEXT`, (err) => {});
    db.run(`ALTER TABLE purohits ADD COLUMN email TEXT`, (err) => {});
    db.run(`ALTER TABLE purohits ADD COLUMN phone TEXT`, (err) => {});
    db.run(`ALTER TABLE purohits ADD COLUMN gov_id_type TEXT`, (err) => {});
    db.run(`ALTER TABLE purohits ADD COLUMN gov_id_number TEXT`, (err) => {});
    db.run(`ALTER TABLE purohits ADD COLUMN gov_id_image TEXT`, (err) => {});
    db.run(`ALTER TABLE events ADD COLUMN image TEXT`, (err) => {});
    db.run(`ALTER TABLE classes ADD COLUMN video_url TEXT`, (err) => {});
    db.run(`ALTER TABLE horoscopes ADD COLUMN priest_id TEXT`, (err) => {});
    db.run(`ALTER TABLE horoscopes ADD COLUMN google_meet_link TEXT`, (err) => {});
    db.run(`ALTER TABLE purohits ADD COLUMN experience_years INTEGER DEFAULT 5`, (err) => {});
    db.run(`ALTER TABLE purohits ADD COLUMN languages TEXT DEFAULT 'Telugu, Sanskrit'`, (err) => {});
    db.run(`ALTER TABLE purohits ADD COLUMN is_verified INTEGER DEFAULT 0`, (err) => {});
    db.run(`ALTER TABLE purohits ADD COLUMN banner_image TEXT`, (err) => {});
    db.run(`ALTER TABLE purohits ADD COLUMN teaching_interest INTEGER DEFAULT 0`, (err) => {});
    db.run(`ALTER TABLE purohits ADD COLUMN teaching_specialization TEXT`, (err) => {});
    db.run(`ALTER TABLE purohits ADD COLUMN instructor_bio TEXT`, (err) => {});
    db.run(`ALTER TABLE purohit_bookings ADD COLUMN muhurtham TEXT`, (err) => {});
    db.run(`ALTER TABLE purohit_bookings ADD COLUMN convenience_fee REAL`, (err) => {});
    db.run(`ALTER TABLE purohit_bookings ADD COLUMN convenience_fee_paid INTEGER DEFAULT 0`, (err) => {});
    db.run(`ALTER TABLE purohit_bookings ADD COLUMN samagri_list TEXT`, (err) => {});
    db.run(`ALTER TABLE purohit_bookings ADD COLUMN venue TEXT`, (err) => {});
    db.run(`ALTER TABLE purohit_bookings ADD COLUMN child_samagri_id TEXT`, (err) => {});
    db.run(`ALTER TABLE purohit_bookings ADD COLUMN parent_booking_id TEXT`, (err) => {});
    db.run(`ALTER TABLE purohit_bookings ADD COLUMN delay_minutes INTEGER DEFAULT 0`, (err) => {});
    db.run(`ALTER TABLE purohit_bookings ADD COLUMN emergency_handover INTEGER DEFAULT 0`, (err) => {});

    // SQLite Index creations for High-Concurrence Scalability
    db.run(`CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_users_role_blocked ON users(role, is_blocked)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_purohits_location ON purohits(location)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_purohit_bookings_purohit ON purohit_bookings(purohit_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_purohit_posts_purohit ON purohit_posts(purohit_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_proposals_status ON proposals(status)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_purohit_reviews_purohit ON purohit_reviews(purohit_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_classes_status ON classes(status)`);

    console.log('✦ SQLite database tables verified successfully.');
    await runSeeds();
    dbInitResolve();
  });
}

// 2. MySQL Schema Initialization
async function initializeDatabaseMySQL() {
  try {
    // Users Table
    await mysqlPool.query(`CREATE TABLE IF NOT EXISTS users (
      id VARCHAR(255) PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      email VARCHAR(255) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      phone VARCHAR(50),
      role VARCHAR(50) DEFAULT 'user',
      location VARCHAR(255),
      is_blocked INT DEFAULT 0,
      totp_secret VARCHAR(255),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);

    // Products Table
    await mysqlPool.query(`CREATE TABLE IF NOT EXISTS products (
      id VARCHAR(255) PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      name_te VARCHAR(255),
      price DECIMAL(10,2) NOT NULL,
      original_price DECIMAL(10,2),
      category VARCHAR(100),
      image VARCHAR(500),
      description TEXT,
      stock INT DEFAULT 0,
      badge VARCHAR(100),
      is_organic INT DEFAULT 0
    )`);

    // Proposals Table
    await mysqlPool.query(`CREATE TABLE IF NOT EXISTS proposals (
      id VARCHAR(255) PRIMARY KEY,
      proposer_id VARCHAR(255) NOT NULL,
      proposer_name VARCHAR(255) NOT NULL,
      proposer_location VARCHAR(255) NOT NULL,
      action_type VARCHAR(100) NOT NULL,
      product_id VARCHAR(255),
      details TEXT NOT NULL,
      status VARCHAR(50) DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);

    // Orders Table
    await mysqlPool.query(`CREATE TABLE IF NOT EXISTS orders (
      id VARCHAR(255) PRIMARY KEY,
      user_id VARCHAR(255) NOT NULL,
      customer_name VARCHAR(255) NOT NULL,
      customer_email VARCHAR(255) NOT NULL,
      customer_phone VARCHAR(50) NOT NULL,
      shipping_address TEXT NOT NULL,
      total DECIMAL(10,2) NOT NULL,
      payment_method VARCHAR(100) DEFAULT 'Razorpay',
      payment_status VARCHAR(50) DEFAULT 'pending',
      razorpay_order_id VARCHAR(255),
      razorpay_payment_id VARCHAR(255),
      shiprocket_shipment_id VARCHAR(255),
      shiprocket_awb VARCHAR(255),
      status VARCHAR(50) DEFAULT 'Processing',
      date TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);

    // Order Items Table
    await mysqlPool.query(`CREATE TABLE IF NOT EXISTS order_items (
      id INT AUTO_INCREMENT PRIMARY KEY,
      order_id VARCHAR(255) NOT NULL,
      product_id VARCHAR(255) NOT NULL,
      product_name VARCHAR(255) NOT NULL,
      quantity INT NOT NULL,
      price DECIMAL(10,2) NOT NULL
    )`);

    // Notifications Table (wrapping desc and read keywords in backticks)
    await mysqlPool.query(`CREATE TABLE IF NOT EXISTS notifications (
      id VARCHAR(255) PRIMARY KEY,
      title VARCHAR(255) NOT NULL,
      \`desc\` TEXT NOT NULL,
      \`read\` INT DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);

    // Classes Table
    await mysqlPool.query(`CREATE TABLE IF NOT EXISTS classes (
  id VARCHAR(255) PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  instructor_name VARCHAR(255) NOT NULL,
  time VARCHAR(255) NOT NULL,
  fee DECIMAL(10,2) NOT NULL,
  image VARCHAR(500) NOT NULL,
  description TEXT NOT NULL,
  status VARCHAR(100) DEFAULT 'approved',
  proposer_name VARCHAR(255),
  proposer_location VARCHAR(255),
  video_url VARCHAR(1000)
)`);

    // Class Registrations Table
    await mysqlPool.query(`CREATE TABLE IF NOT EXISTS class_registrations (
      id VARCHAR(255) PRIMARY KEY,
      class_id VARCHAR(255) NOT NULL,
      user_id VARCHAR(255) NOT NULL,
      user_name VARCHAR(255) NOT NULL,
      user_email VARCHAR(255) NOT NULL,
      date TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);

    await mysqlPool.query(`CREATE TABLE IF NOT EXISTS purohits (
      id VARCHAR(255) PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      specialization VARCHAR(255) NOT NULL,
      rating DECIMAL(3,1) DEFAULT 5.0,
      fee DECIMAL(10,2) NOT NULL,
      image VARCHAR(500) NOT NULL,
      location VARCHAR(255) NOT NULL,
      bookings_count INT DEFAULT 0,
      bio TEXT,
      credentials TEXT,
      portfolio_images TEXT,
      email TEXT,
      phone TEXT,
      gov_id_type TEXT,
      gov_id_number TEXT,
      gov_id_image TEXT,
      experience_years INT DEFAULT 5,
      languages VARCHAR(255) DEFAULT 'Telugu, Sanskrit',
      is_verified INT DEFAULT 0,
      banner_image VARCHAR(255),
      teaching_interest INT DEFAULT 0,
      teaching_specialization VARCHAR(255),
      instructor_bio TEXT
    )`);

    // Purohit Bookings Table
    await mysqlPool.query(`CREATE TABLE IF NOT EXISTS purohit_bookings (
      id VARCHAR(255) PRIMARY KEY,
      purohit_id VARCHAR(255) NOT NULL,
      user_id VARCHAR(255) NOT NULL,
      pooja_type VARCHAR(255) NOT NULL,
      booking_date VARCHAR(100) NOT NULL,
      time_slot VARCHAR(100) NOT NULL,
      address TEXT NOT NULL,
      status VARCHAR(50) DEFAULT 'Confirmed',
      items TEXT,
      items_purchased INT DEFAULT 0,
      secure_deposit DECIMAL(10,2) DEFAULT 0
    )`);

    // Purohit Posts Table
    await mysqlPool.query(`CREATE TABLE IF NOT EXISTS purohit_posts (
      id VARCHAR(255) PRIMARY KEY,
      purohit_id VARCHAR(255) NOT NULL,
      image LONGTEXT NOT NULL,
      caption TEXT,
      likes_count INT DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_purohit_posts_purohit (purohit_id)
    )`);

    // Horoscopes Table
    await mysqlPool.query(`CREATE TABLE IF NOT EXISTS horoscopes (
      id VARCHAR(255) PRIMARY KEY,
      user_id VARCHAR(255) NOT NULL,
      name VARCHAR(255) NOT NULL,
      dob VARCHAR(100) NOT NULL,
      tob VARCHAR(100) NOT NULL,
      pob VARCHAR(100) NOT NULL,
      slot_date VARCHAR(100) NOT NULL,
      slot_time VARCHAR(100) NOT NULL,
      status VARCHAR(50) DEFAULT 'Scheduled',
      priest_id VARCHAR(255) DEFAULT NULL,
      google_meet_link VARCHAR(500) DEFAULT NULL
    )`);

    // Spiritual Queries Table
    await mysqlPool.query(`CREATE TABLE IF NOT EXISTS queries (
      id VARCHAR(255) PRIMARY KEY,
      user_name VARCHAR(255) NOT NULL,
      question TEXT NOT NULL,
      category VARCHAR(100) NOT NULL,
      date TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);

    // Spiritual Replies Table
    await mysqlPool.query(`CREATE TABLE IF NOT EXISTS replies (
      id VARCHAR(255) PRIMARY KEY,
      query_id VARCHAR(255) NOT NULL,
      replier_name VARCHAR(255) NOT NULL,
      replier_role VARCHAR(100) NOT NULL,
      reply_content TEXT NOT NULL,
      date TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);

    // Puja Quotes Table
    await mysqlPool.query(`CREATE TABLE IF NOT EXISTS puja_quotes (
      id VARCHAR(255) PRIMARY KEY,
      user_id VARCHAR(255) NOT NULL,
      user_name VARCHAR(255) NOT NULL,
      purohit_id VARCHAR(255),
      purohit_name VARCHAR(255),
      puja_type VARCHAR(255) NOT NULL,
      preferred_date VARCHAR(100) NOT NULL,
      details TEXT NOT NULL,
      quote_amount DECIMAL(10,2) DEFAULT 0,
      status VARCHAR(100) DEFAULT 'Pending Quote',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);

    // Cottage Partners Table
    await mysqlPool.query(`CREATE TABLE IF NOT EXISTS cottage_partners (
      id VARCHAR(255) PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      category VARCHAR(100) NOT NULL,
      address TEXT NOT NULL,
      capacity VARCHAR(100) NOT NULL,
      image VARCHAR(500),
      location VARCHAR(255) NOT NULL
    )`);

    // Purohit Reviews Table
    await mysqlPool.query(`CREATE TABLE IF NOT EXISTS purohit_reviews (
      id VARCHAR(255) PRIMARY KEY,
      booking_id VARCHAR(255) NOT NULL,
      purohit_id VARCHAR(255) NOT NULL,
      user_name VARCHAR(255) NOT NULL,
      rating INT NOT NULL,
      review_text TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);

    // Product Reviews Table
    await mysqlPool.query(`CREATE TABLE IF NOT EXISTS product_reviews (
      id VARCHAR(255) PRIMARY KEY,
      product_id VARCHAR(255) NOT NULL,
      user_id VARCHAR(255) NOT NULL,
      user_name VARCHAR(255) NOT NULL,
      rating INT NOT NULL,
      review_text TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);

    await mysqlPool.query(`CREATE TABLE IF NOT EXISTS events (
      id VARCHAR(255) PRIMARY KEY,
      title VARCHAR(255) NOT NULL,
      category VARCHAR(255) NOT NULL,
      description TEXT NOT NULL,
      date_time VARCHAR(255) NOT NULL,
      location VARCHAR(255) NOT NULL,
      organizer_name VARCHAR(255) NOT NULL,
      status VARCHAR(100) DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);


    try {
      await mysqlPool.query(`ALTER TABLE users ADD COLUMN totp_secret VARCHAR(255)`);
    } catch (e) {
      // Ignore error if column already exists
    }

    try {
      await mysqlPool.query(`ALTER TABLE purohit_bookings ADD COLUMN ritual_mode VARCHAR(100) DEFAULT 'Offline'`);
    } catch (e) {}

    try {
      await mysqlPool.query(`ALTER TABLE purohit_bookings ADD COLUMN google_meet_link VARCHAR(500)`);
    } catch (e) {}

    try {
      await mysqlPool.query(`ALTER TABLE class_registrations ADD COLUMN student_name VARCHAR(255)`);
    } catch (e) {}
    try {
      await mysqlPool.query(`ALTER TABLE class_registrations ADD COLUMN student_age INT`);
    } catch (e) {}
    try {
      await mysqlPool.query(`ALTER TABLE class_registrations ADD COLUMN parent_phone VARCHAR(255)`);
    } catch (e) {}
    try {
      await mysqlPool.query(`ALTER TABLE class_registrations ADD COLUMN experience_level VARCHAR(255)`);
    } catch (e) {}
    try {
      await mysqlPool.query(`ALTER TABLE class_registrations ADD COLUMN google_meet_link VARCHAR(500)`);
    } catch (e) {}
    try {
      await mysqlPool.query(`ALTER TABLE classes ADD COLUMN status VARCHAR(100) DEFAULT 'approved'`);
    } catch (e) {}
    try {
      await mysqlPool.query(`ALTER TABLE classes ADD COLUMN proposer_name VARCHAR(255)`);
    } catch (e) {}
    try {
      await mysqlPool.query(`ALTER TABLE classes ADD COLUMN proposer_location VARCHAR(255)`);
    } catch (e) {}
    try {
      await mysqlPool.query(`ALTER TABLE users ADD COLUMN communication_preferences TEXT`);
    } catch (e) {}

    try { await mysqlPool.query(`ALTER TABLE purohit_bookings ADD COLUMN muhurtham VARCHAR(255)`); } catch (e) {}
    try { await mysqlPool.query(`ALTER TABLE purohit_bookings ADD COLUMN convenience_fee DOUBLE`); } catch (e) {}
    try { await mysqlPool.query(`ALTER TABLE purohit_bookings ADD COLUMN convenience_fee_paid INT DEFAULT 0`); } catch (e) {}
    try { await mysqlPool.query(`ALTER TABLE purohit_bookings ADD COLUMN samagri_list TEXT`); } catch (e) {}
    try { await mysqlPool.query(`ALTER TABLE purohit_bookings ADD COLUMN venue TEXT`); } catch (e) {}
    try { await mysqlPool.query(`ALTER TABLE purohit_bookings ADD COLUMN child_samagri_id VARCHAR(255)`); } catch (e) {}
    try { await mysqlPool.query(`ALTER TABLE purohit_bookings ADD COLUMN parent_booking_id VARCHAR(255)`); } catch (e) {}
    try { await mysqlPool.query(`ALTER TABLE purohit_bookings ADD COLUMN delay_minutes INT DEFAULT 0`); } catch (e) {}
    try { await mysqlPool.query(`ALTER TABLE purohit_bookings ADD COLUMN emergency_handover INT DEFAULT 0`); } catch (e) {}

    try { await mysqlPool.query(`ALTER TABLE purohits ADD COLUMN bio TEXT`); } catch (e) {}
    try { await mysqlPool.query(`ALTER TABLE purohits ADD COLUMN credentials TEXT`); } catch (e) {}
    try { await mysqlPool.query(`ALTER TABLE purohits ADD COLUMN portfolio_images TEXT`); } catch (e) {}
    try { await mysqlPool.query(`ALTER TABLE purohits ADD COLUMN email TEXT`); } catch (e) {}
    try { await mysqlPool.query(`ALTER TABLE purohits ADD COLUMN phone TEXT`); } catch (e) {}
    try { await mysqlPool.query(`ALTER TABLE purohits ADD COLUMN gov_id_type TEXT`); } catch (e) {}
    try { await mysqlPool.query(`ALTER TABLE purohits ADD COLUMN gov_id_number TEXT`); } catch (e) {}
    try { await mysqlPool.query(`ALTER TABLE purohits ADD COLUMN gov_id_image TEXT`); } catch (e) {}
    try { await mysqlPool.query(`ALTER TABLE events ADD COLUMN image TEXT`); } catch (e) {}
    try { await mysqlPool.query(`ALTER TABLE horoscopes ADD COLUMN priest_id VARCHAR(255) DEFAULT NULL`); } catch (e) {}
    try { await mysqlPool.query(`ALTER TABLE horoscopes ADD COLUMN google_meet_link VARCHAR(500) DEFAULT NULL`); } catch (e) {}

    try {
      await mysqlPool.query(`CREATE TABLE IF NOT EXISTS parinayam_profiles (
        id VARCHAR(255) PRIMARY KEY,
        user_id VARCHAR(255),
        name VARCHAR(255) NOT NULL,
        gender VARCHAR(50) NOT NULL,
        dob VARCHAR(100) NOT NULL,
        tob VARCHAR(100),
        pob VARCHAR(255),
        gothram VARCHAR(255),
        nakshatram VARCHAR(255),
        rasi VARCHAR(255),
        padam INT,
        education VARCHAR(255),
        profession VARCHAR(255),
        income DOUBLE,
        loans TEXT,
        about TEXT,
        photo TEXT,
        contact_phone VARCHAR(50),
        contact_email VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        is_active INT DEFAULT 1,
        is_closed INT DEFAULT 0
      )`);
    } catch (e) {}

    try {
      await mysqlPool.query(`CREATE TABLE IF NOT EXISTS parinayam_connections (
        id VARCHAR(255) PRIMARY KEY,
        from_profile_id VARCHAR(255) NOT NULL,
        to_profile_id VARCHAR(255) NOT NULL,
        status VARCHAR(50) DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`);
    } catch (e) {}

    try {
      await mysqlPool.query(`CREATE TABLE IF NOT EXISTS settings (
        \`key\` VARCHAR(255) PRIMARY KEY,
        value TEXT
      )`);
    } catch (e) {}

    try {
      await mysqlPool.query(`CREATE TABLE IF NOT EXISTS hubs (
        id VARCHAR(255) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        hours VARCHAR(255),
        coverage VARCHAR(255),
        license TEXT
      )`);
    } catch (e) {}

    try {
      await mysqlPool.query(`CREATE TABLE IF NOT EXISTS registration_payments (
        id VARCHAR(255) PRIMARY KEY,
        user_id VARCHAR(255) NOT NULL,
        user_name VARCHAR(255) NOT NULL,
        user_email VARCHAR(255) NOT NULL,
        amount DECIMAL(10,2) NOT NULL,
        transaction_id VARCHAR(255) NOT NULL,
        payment_status VARCHAR(50) DEFAULT 'success',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`);
    } catch (e) {}

    try {
      await mysqlPool.query(`ALTER TABLE parinayam_profiles ADD COLUMN is_closed INT DEFAULT 0`);
    } catch (e) {}

    try {
      await mysqlPool.query(`ALTER TABLE classes ADD COLUMN video_url VARCHAR(1000)`);
    } catch (e) {}

    try {
      await mysqlPool.query(`ALTER TABLE purohits ADD COLUMN experience_years INT DEFAULT 5`);
    } catch (e) {}
    try {
      await mysqlPool.query(`ALTER TABLE purohits ADD COLUMN languages VARCHAR(255) DEFAULT 'Telugu, Sanskrit'`);
    } catch (e) {}
    try {
      await mysqlPool.query(`ALTER TABLE purohits ADD COLUMN is_verified INT DEFAULT 0`);
    } catch (e) {}
    try {
      await mysqlPool.query(`ALTER TABLE purohits ADD COLUMN banner_image VARCHAR(255)`);
    } catch (e) {}
    try {
      await mysqlPool.query(`ALTER TABLE purohits ADD COLUMN teaching_interest INT DEFAULT 0`);
    } catch (e) {}
    try {
      await mysqlPool.query(`ALTER TABLE purohits ADD COLUMN teaching_specialization VARCHAR(255)`);
    } catch (e) {}
    try {
      await mysqlPool.query(`ALTER TABLE purohits ADD COLUMN instructor_bio TEXT`);
    } catch (e) {}

    // MySQL Index creations for High-Concurrence Scalability
    try {
      await mysqlPool.query(`CREATE INDEX idx_users_email ON users(email)`);
    } catch (e) {}
    try {
      await mysqlPool.query(`CREATE INDEX idx_users_phone ON users(phone)`);
    } catch (e) {}
    try {
      await mysqlPool.query(`CREATE INDEX idx_users_role_blocked ON users(role, is_blocked)`);
    } catch (e) {}
    try {
      await mysqlPool.query(`CREATE INDEX idx_purohits_location ON purohits(location)`);
    } catch (e) {}
    try {
      await mysqlPool.query(`CREATE INDEX idx_purohit_bookings_purohit ON purohit_bookings(purohit_id)`);
    } catch (e) {}
    try {
      await mysqlPool.query(`CREATE INDEX idx_proposals_status ON proposals(status)`);
    } catch (e) {}
    try {
      await mysqlPool.query(`CREATE INDEX idx_purohit_reviews_purohit ON purohit_reviews(purohit_id)`);
    } catch (e) {}
    try {
      await mysqlPool.query(`CREATE INDEX idx_classes_status ON classes(status)`);
    } catch (e) {}

    console.log('✦ Hostinger MySQL database tables verified successfully.');
    await runSeeds();
  } catch (err) {
    console.error('MySQL database initialization failed:', err);
  } finally {
    dbInitResolve();
  }
}

// Combined seeding logic
async function migrateProductImages() {
  try {
    // 1. Delete extra products that are not part of the 7 products
    await dbRun("DELETE FROM products WHERE id NOT IN ('p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7')");

    // 2. Exact 7 products
    const productsToUpsert = [
      {
        id: 'p1',
        name: 'Organic Pasupu',
        name_te: 'పసుపు (పచ్చ పసుపు)',
        price: 149,
        original_price: 199,
        category: 'powder',
        image: '/images/products/pasupu.png?v=2',
        description: 'Awaiting for FSSAI license, post which we will be back. Pure turmeric powder, hand-ground using traditional stone grinding.',
        stock: 0,
        badge: 'ORGANIC',
        is_organic: 1
      },
      {
        id: 'p2',
        name: 'Organic Kumkum (200g)',
        name_te: 'కుంకుమ',
        price: 189,
        original_price: 220,
        category: 'powder',
        image: '/images/products/kumkum.png?v=2',
        description: 'This is purely made from turmeric sticks and Kumkum Stone grounded together, forming a natural kumkuma which is also good for the skin. 100% pure and best quality.',
        stock: 30,
        badge: 'NEW BATCH',
        is_organic: 1
      },
      {
        id: 'p3',
        name: 'Gandham (Chandanam)',
        name_te: 'గంధం / చందనం',
        price: 249,
        original_price: 320,
        category: 'powder',
        image: '/images/products/gandham.png?v=2',
        description: 'Pure sandalwood paste & powder for deity abhishekam and tilak. Rich authentic fragrance.',
        stock: 15,
        badge: 'LIMITED',
        is_organic: 0
      },
      {
        id: 'p4',
        name: 'Sacred Vibhuti',
        name_te: 'విభూతి (భస్మం)',
        price: 99,
        original_price: 129,
        category: 'powder',
        image: '/images/products/vibhuti.png?v=2',
        description: 'Sacred vibhuti (holy ash) prepared by burning dried cow dung with specific herbs in a traditional homa fire.',
        stock: 100,
        badge: null,
        is_organic: 1
      },
      {
        id: 'p5',
        name: 'Yagnopavitam',
        name_te: 'యజ్ఞోపవీతం (జంధ్యాలు)',
        price: 199,
        original_price: 259,
        category: 'thread',
        image: '/images/products/yagnopavitam.png?v=2',
        description: 'Handspun cotton sacred thread (janeu) made the traditional way with 9 strands.',
        stock: 40,
        badge: null,
        is_organic: 0
      },
      {
        id: 'p6',
        name: 'Complete Puja Combo Kit',
        name_te: 'పూజా కిట్ (5-in-1)',
        price: 699,
        original_price: 825,
        category: 'combo',
        image: '/images/products/combo_kit.png?v=2',
        description: 'All 5 sacred products beautifully packed in a traditional gift box. Perfect for festivals.',
        stock: 20,
        badge: 'BEST VALUE',
        is_organic: 0
      },
      {
        id: 'p7',
        name: 'Hand-Rolled Organic Agarbatti',
        name_te: 'చేతితో చేసిన అగర్బత్తి',
        price: 99,
        original_price: 149,
        category: 'incense',
        image: '/images/products/agarbatti.png?v=2',
        description: 'Premium pure incense sticks hand-rolled by remote village artisans using natural gums and flower dust.',
        stock: 60,
        badge: 'COTTAGE CRAFT',
        is_organic: 1
      }
    ];

    for (const p of productsToUpsert) {
      const existing = await dbGet("SELECT id FROM products WHERE id = ?", [p.id]);
      if (existing) {
        await dbRun(
          `UPDATE products SET name = ?, name_te = ?, price = ?, original_price = ?, category = ?, image = ?, description = ?, stock = ?, badge = ?, is_organic = ?
           WHERE id = ?`,
          [p.name, p.name_te, p.price, p.original_price, p.category, p.image, p.description, p.stock, p.badge, p.is_organic, p.id]
        );
      } else {
        await dbRun(
          `INSERT INTO products (id, name, name_te, price, original_price, category, image, description, stock, badge, is_organic) 
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [p.id, p.name, p.name_te, p.price, p.original_price, p.category, p.image, p.description, p.stock, p.badge, p.is_organic]
        );
      }
    }
    console.log('✅ Product catalog verified: 7 sacred products with correct images.');
  } catch (err) {
    console.error('Error running product image migration:', err.message);
  }
}
async function seedSettings() {
  try {
    const defaults = [
      { key: 'mfa_enforced', value: 'true' },
      { key: 'session_timeout', value: '24' },
      { key: 'max_login_attempts', value: '5' },
      { key: 'featured_occasion', value: 'Navaratri Special' },
      { key: 'featured_priest_id', value: 'acharya_1' },
      { key: 'featured_alert_message', value: 'Acharya Shri Ramakrishna Sharma is filling up fast for Maha Chandi Homas during Navaratri! Only 2 dates remaining. Book your auspicious slots now.' }
    ];
    for (const d of defaults) {
      const existing = await dbGet("SELECT * FROM settings WHERE `key` = ?", [d.key]);
      if (!existing) {
        await dbRun("INSERT INTO settings (`key`, value) VALUES (?, ?)", [d.key, d.value]);
      }
    }
    console.log('✦ Seeded security settings.');
  } catch (err) {
    console.error('Error seeding settings:', err.message);
  }
}

async function seedHubs() {
  try {
    const count = await dbGet("SELECT COUNT(*) as count FROM hubs");
    if (!count || count.count === 0) {
      const initialHubs = [
        { id: 'hub-1', name: 'Nizampet Main Hub, Hyderabad', hours: '09:00 AM - 06:00 PM', coverage: 'Telangana & Andhra Pradesh', license: '/images/auth/aadhaar_mock.png' },
        { id: 'hub-2', name: 'Malleshwaram Hub, Bengaluru', hours: '09:00 AM - 07:00 PM', coverage: 'Karnataka', license: '/images/auth/aadhaar_mock.png' },
        { id: 'hub-3', name: 'Mylapore Hub, Chennai', hours: '08:00 AM - 06:00 PM', coverage: 'Tamil Nadu', license: '/images/auth/aadhaar_mock.png' }
      ];
      for (const h of initialHubs) {
        await dbRun("INSERT INTO hubs (id, name, hours, coverage, license) VALUES (?, ?, ?, ?, ?)", [h.id, h.name, h.hours, h.coverage, h.license]);
      }
      console.log('✦ Seeded initial hub offices.');
    }
  } catch (err) {
    console.error('Error seeding hubs:', err.message);
  }
}

async function runSeeds() {
  await seedUsers();
  await seedProducts();
  await seedVedicSystem();
  await seedParinayamProfiles();
  await migrateProductImages();
  await seedSettings();
  await seedHubs();
}

async function seedUsers() {
  try {
    // Delete any old super admin using the incorrect email
    await dbRun("DELETE FROM users WHERE email = 'superadmin@gurupadukam.com'");

    const existingSuperAdmin = await dbGet("SELECT * FROM users WHERE id = 'admin_1'");
    if (!existingSuperAdmin) {
      const superAdminId = 'admin_1';
      const passwordHash = await bcrypt.hash('admin123', 10);
      await dbRun(
        "INSERT INTO users (id, name, email, password_hash, role, phone) VALUES (?, ?, ?, ?, ?, ?)",
        [superAdminId, 'Super Admin', 'reach@gurupadukam.com', passwordHash, 'super_admin', '+919949730175']
      );
      console.log('✦ Super Admin user seeded. Email: reach@gurupadukam.com');
    } else if (existingSuperAdmin.email !== 'reach@gurupadukam.com') {
      await dbRun("UPDATE users SET email = ? WHERE id = 'admin_1'", ['reach@gurupadukam.com']);
      console.log('✦ Super Admin email updated to reach@gurupadukam.com');
    }

    const existingAdmins = await dbGet("SELECT * FROM users WHERE role = 'admin'");
    if (!existingAdmins) {
      const locations = [
        { id: 'admin_2', name: 'Hyderabad Admin', email: 'hyd@gurupadukam.com', loc: 'Hyderabad' },
        { id: 'admin_3', name: 'Bengaluru Admin', email: 'blr@gurupadukam.com', loc: 'Bengaluru' },
        { id: 'admin_4', name: 'Chennai Admin', email: 'maa@gurupadukam.com', loc: 'Chennai' }
      ];

      for (const admin of locations) {
        const passwordHash = await bcrypt.hash('admin123', 10);
        await dbRun(
          "INSERT INTO users (id, name, email, password_hash, role, location, phone) VALUES (?, ?, ?, ?, ?, ?, ?)",
          [admin.id, admin.name, admin.email, passwordHash, 'admin', admin.loc, '+919999999999']
        );
      }
      console.log('✦ 3 Location-based Admins seeded (Hyderabad, Bengaluru, Chennai).');
    }

    const passwordHash = await bcrypt.hash('admin123', 10);
    
    const purohitUsers = [
      { id: 'acharya_1', name: 'Shri Ramakrishna Sharma', email: 'priest@gurupadukam.com', phone: '+919876543210', location: 'Hyderabad' },
      { id: 'acharya_2', name: 'Shri Dwivedi Shastri Acharya', email: 'dwivedi@gurupadukam.com', phone: '+919876543211', location: 'Hyderabad' },
      { id: 'acharya_3', name: 'Shri Sharma Shastri', email: 'shastri@gurupadukam.com', phone: '+919876543212', location: 'Bengaluru' },
      { id: 'acharya_4', name: 'Shri Acharya Ramulu', email: 'ramulu@gurupadukam.com', phone: '+919876543213', location: 'Chennai' },
      { id: 'acharya_5', name: 'Shri Srinivasa Acharya', email: 'srinivasa@gurupadukam.com', phone: '+919876543214', location: 'Hyderabad' }
    ];

    for (const p of purohitUsers) {
      const existingUser = await dbGet("SELECT id FROM users WHERE id = ?", [p.id]);
      if (!existingUser) {
        try {
          await dbRun(
            "INSERT INTO users (id, name, email, password_hash, role, phone, location) VALUES (?, ?, ?, ?, ?, ?, ?)",
            [p.id, p.name, p.email, passwordHash, 'purohit', p.phone, p.location]
          );
        } catch (insertErr) {
          if (!insertErr.message.includes('Duplicate entry') && !insertErr.message.includes('UNIQUE constraint failed')) {
            throw insertErr;
          }
        }
      }
    }
    console.log('✦ Seeded 5 Vetted Priests in users table.');
  } catch (err) {
    console.error('Error seeding users:', err.message);
  }
}

async function seedProducts() {
  try {
    const count = await dbGet("SELECT COUNT(*) as count FROM products");
    if (!count || count.count === 0) {
      const initialProducts = [
        {
          id: 'p1',
          name: 'Organic Pasupu',
          name_te: 'పసుపు (పచ్చ పసుపు)',
          price: 149,
          original_price: 199,
          category: 'powder',
          image: '/images/products/pasupu.png',
          description: '✦ Consecrated Scripture Shloka\n"హరిద్రాం ధారయేద్దేవీం సంపదం సౌభాగ్య దాయినీమ్।సర్వ దారిద్ర్య నాశినీం గౌరీం త్వాం నమామ్యహమ్॥"\n\nతాత్పర్యము (Telugu Meaning):\n• హరిద్రాం ధారయేద్దేవీం: ఐశ్వర్యప్రదాత, దేవి స్వరూపమైన ఈ పసుపును ధరిస్తున్నాను. • సంపదం సౌభాగ్య దాయినీమ్: సంపదలను, దీర్ఘసుమంగళీత్వాన్ని (సౌభాగ్యాన్ని) ప్రసాదించే తల్లి. • సర్వ దారిద్ర్య నాశినీం: సమస్త ఆర్థిక, మానసిక దారిద్ర్యాలను/కష్టాలను నశింపజేసేది. • గౌరీం త్వాం నమామ్యహమ్: అటువంటి మంగళప్రదరాలైన గౌరీ దేవికి నేను నమస్కరిస్తున్నాను.\n\nScriptural Significance of Keeping It:\nAwaiting for FSSAI license, post which we will be back. Traditionally hand-ground with stone cylinders to retain all natural oils and colors, safe and highly sacred for home thresholds and pujas.',
          stock: 0,
          badge: 'ORGANIC',
          is_organic: 1
        },
        {
          id: 'p2',
          name: 'Organic Kumkum (200g)',
          name_te: 'కుంకుమ',
          price: 189,
          original_price: 220,
          category: 'powder',
          image: '/images/products/kumkum.png',
          description: '✦ Consecrated Scripture Shloka\n"లక్ష్మీ శ్రేష్ఠాం సతీం దేవీం సర్వ మంగళ దాయినీమ్।కుంకుమేనార్చయామ్యద్య త్వాం నమామి హరిప్రియే॥"\n\nతాత్పర్యము (Telugu Meaning):\n• లక్ష్మీ శ్రేష్ఠాం సతీం దేవీం: దేవేరులలో శ్రేష్ఠురాలైన, పరమ పతివ్రత అయిన ఓ లక్ష్మీదేవి! • సర్వ మంగళ దాయినీమ్: సమస్త శుభాలను, మంగళాలను ప్రసాదించే తల్లి! •కుంకుమేనార్చయామ్యద్య: ఈ పవిత్రమైన కుంకుమతో నిన్ను పూజిస్తూ (నా నుదుట) ధరిస్తున్నాను. • త్వాం నమామి హరిప్రియే: శ్రీమహావిష్ణువుకు అత్యంత ప్రియమైన ఓ జననీ! నీకు నమస్కరిస్తున్నాను.\n\nScriptural Significance of Keeping It:\nSourced from Telangana. Handcrafted using the original ancient process: 100% pure premium Kumkum stones are stone-ground along with yellow horns (turmeric horns) for a highly divine, chemical-free red powder. Priced at ₹189 per 200g of peerless purity. Applied on the Ajna Chakra, it balances energies and wards off negative vibrations.',
          stock: 30,
          badge: 'NEW BATCH',
          is_organic: 1
        },
        {
          id: 'p3',
          name: 'Gandham (Chandanam)',
          name_te: 'గంధం / చందనం',
          price: 249,
          original_price: 320,
          category: 'powder',
          image: '/images/products/gandham.png',
          description: '✦ Consecrated Scripture Shloka\n"చందనస్య మహత్పుణ్యం పవిత్రం పాపనాశనమ్ । తాప-త్రయ-హరం నిత్యం శాంతి-సౌఖ్య-ప్రదాయకమ్ ॥"\n\nతాత్పర్యము (Telugu Meaning):\nచందన లేపనం నుదుట ధరించడం వల్ల మెదడు ప్రశాంతతను పొందుతుంది. ఇది తీవ్రమైన తాపాన్ని, కోపాన్ని అణచివేసే అత్యుత్తమ ద్రవ్యం.\n\nScriptural Significance of Keeping It:\nApplied to the third eye center or chest during prayers. Authentic sandalwood paste possesses powerful cooling and anti-inflammatory properties, physically subduing blood pressure, pacifying irritability, and providing profound mental clarity and spiritual tranquility.',
          stock: 15,
          badge: 'LIMITED',
          is_organic: 0
        },
        {
          id: 'p4',
          name: 'Sacred Vibhuti',
          name_te: 'విభూతి (భస్మం)',
          price: 99,
          original_price: 129,
          category: 'powder',
          image: '/images/products/vibhuti.png',
          description: '✦ Consecrated Scripture Shloka\n"ఐశ్వర్యమస్తు భయనాశనమస్తు నిత్యంఆరోగ్యమస్తు సకలార్థ లాభమస్తు।జ్ఞానాభివృద్దిరస్తు శత్రుక్షయమస్తు నిత్యంభస్మధారణాత్ సర్వసౌఖ్యమస్తు॥"\n\nతాత్పర్యము (Telugu Meaning):\n• ఐశ్వర్యమస్తు భయనాశనమస్తు నిత్యం: ఈ భస్మాన్ని ధరించడం వల్ల నాకు నిరంతరం ఐశ్వర్యం లభించుగాక, సమస్త భయాలు నశించుగాక. • आरोग्यమస్తు సకలార్థ లాభమస్తు: నిండు ఆరోగ్యం చేకూరుగాక, నేను చేసే పనులన్నింటిలో లాభం (విజయం) కలుగుగాక. • జ్ఞానాభివృద్దిరస్తు శత్రుక్షయమస్తు నిత్యం: నాలో జ్ఞానం వృద్ధి చెందుగాక, నాలోని అంతర్గత శత్రువులు (కామ, క్రోధ, లోభాలు) మరియు బాహ్య శత్రువులు నశించుగాక. • భస్మధారణాత్ సర్వసౌఖ్యమస్తు: ఈ పవిత్ర భస్మ ధారణ వల్ల నాకు సర్వసౌఖ్యాలు, ప్రశాంతత లభించుగాక.\n\nScriptural Significance of Keeping It:\nApplied as three horizontal lines (Tripundra) on the forehead. Burning pure cow dung with herbs creates a sacred ash that physically cools the forehead and sinuses, subdues hyper-activity, settles the nervous system, and symbolizes absolute surrender to the formless Divine.',
          stock: 100,
          badge: null,
          is_organic: 1
        },
        {
          id: 'p5',
          name: 'Yagnopavitam',
          name_te: 'యజ్ఞోపవీతం (జంధ్యాలు)',
          price: 199,
          original_price: 259,
          category: 'thread',
          image: '/images/products/yagnopavitam.png',
          description: 'Handspun cotton sacred thread (janeu) made the traditional way with 9 strands.',
          stock: 40,
          badge: null,
          is_organic: 0
        },
        {
          id: 'p6',
          name: 'Complete Puja Combo Kit',
          name_te: 'పూజా కిట్ (5-in-1)',
          price: 699,
          original_price: 825,
          category: 'combo',
          image: '/images/products/combo_kit.png',
          description: 'All 5 sacred products beautifully packed in a traditional gift box. Perfect for festivals.',
          stock: 20,
          badge: 'BEST VALUE',
          is_organic: 0
        },
        {
          id: 'p7',
          name: 'Hand-Rolled Organic Agarbatti',
          name_te: 'చేతితో చేసిన అగర్బత్తి',
          price: 99,
          original_price: 149,
          category: 'incense',
          image: '/images/products/agarbatti.png',
          description: 'Premium pure incense sticks hand-rolled by remote village artisans using natural gums and flower dust.',
          stock: 60,
          badge: 'COTTAGE CRAFT',
          is_organic: 1
        }
      ];

      for (const p of initialProducts) {
        await dbRun(
          `INSERT INTO products (id, name, name_te, price, original_price, category, image, description, stock, badge, is_organic) 
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [p.id, p.name, p.name_te, p.price, p.original_price, p.category, p.image, p.description, p.stock, p.badge, p.is_organic]
        );
      }
      console.log('✦ Seeded initial products including custom remote cottage industry crafts.');
    }

    // Ensure all existing product images are updated to local paths on startup
    const updates = [
      { id: 'p1', image: '/images/products/pasupu.png' },
      { id: 'p2', image: '/images/products/kumkum.png' },
      { id: 'p3', image: '/images/products/gandham.png' },
      { id: 'p4', image: '/images/products/vibhuti.png' },
      { id: 'p5', image: '/images/products/yagnopavitam.png' },
      { id: 'p6', image: '/images/products/combo_kit.png' },
      { id: 'p7', image: '/images/products/agarbatti.png' }
    ];
    for (const u of updates) {
      await dbRun("UPDATE products SET image = ? WHERE id = ?", [u.image, u.id]);
    }
  } catch (err) {
    console.error('Error seeding products:', err.message);
  }
}

async function seedVedicSystem() {
  try {
    const initialClasses = [
      {
        id: 'cls-1',
        title: 'Epic Ramayana & Vedic Values',
        instructor_name: 'Shri Dwivedi Shastri Acharya',
        time: 'Every Saturday, 6:00 PM IST',
        fee: 0,
        image: '/images/ramayana_family.png',
        description: 'A divine immersion into the Valmiki Ramayana. Learn shloka recitation, Telugu meanings, and timeless moral values from the life of Maryada Purushottama Sri Rama.',
        video_url: 'https://www.youtube.com/embed/dQw4w9WgXcQ'
      },
      {
        id: 'cls-2',
        title: 'Bhagavad Gita Sloka Chanting',
        instructor_name: 'Shri Sharma Shastri',
        time: 'Every Sunday, 5:00 PM IST',
        fee: 0,
        image: 'https://images.unsplash.com/photo-1545205597-3d9d02c29597?auto=format&fit=crop&q=80&w=800',
        description: 'Master the accurate Sanskrit pronunciation, sandhi rules, and absolute word-by-word meanings of the 700 Bhagavad Gita shlokas to align your actions with Dharma.',
        video_url: 'https://www.youtube.com/embed/dQw4w9WgXcQ'
      },
      {
        id: 'cls-3',
        title: 'Mahabharata (Bharatham) Epic Study',
        instructor_name: 'Shri Acharya Ramulu',
        time: 'Mon - Wed, 6:30 AM IST',
        fee: 0,
        image: 'https://t4.ftcdn.net/jpg/04/83/67/61/360_F_483676144_8XDkDIhdzlCkwrMGKquArnzrTgJRixh3.jpg',
        description: 'Explore the grandeur of Vyasa Mahabharata (Bharatham). Dive deep into the philosophical discourses, the stories of ancient kings, and the lessons of truth and karma.',
        video_url: null
      },
      {
        id: 'cls-4',
        title: 'Soundarya Lahari Hymns Recitation',
        instructor_name: 'Shri Srinivasa Acharya',
        time: 'Every Thursday, 6:30 PM IST',
        fee: 0,
        image: 'https://images.unsplash.com/photo-1509316975850-ff9c5deb0cd9?auto=format&fit=crop&q=80&w=800',
        description: 'Learn to recite Adi Shankaracharyas Soundarya Lahari. Experience the acoustic beauty and spiritual power of these 100 hymns glorifying the Divine Mother.',
        video_url: 'https://www.youtube.com/embed/dQw4w9WgXcQ'
      },
      {
        id: 'cls-5',
        title: 'Rigveda Samhita Chanting & Phonetics',
        instructor_name: 'Shri Ramakrishna Sharma',
        time: 'Mon & Fri, 7:00 AM IST',
        fee: 0,
        image: 'https://images.unsplash.com/photo-1545128485-c400e7702796?q=80&w=800',
        description: 'An introductory course to the Rigvedic Samhita. Master the accurate swaras (udatta, anudatta, svarita), phonetics, and traditional sandhi rules of the oldest Vedic mantras.',
        video_url: 'https://www.youtube.com/embed/dQw4w9WgXcQ'
      }
    ];
    for (const c of initialClasses) {
      const existingClass = await dbGet("SELECT id FROM classes WHERE id = ?", [c.id]);
      if (!existingClass) {
        try {
          await dbRun(
            "INSERT INTO classes (id, title, instructor_name, time, fee, image, description, video_url, status, proposer_name, proposer_location) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [c.id, c.title, c.instructor_name, c.time, c.fee, c.image, c.description, c.video_url || null, 'approved', c.instructor_name, 'Hyderabad']
          );
        } catch (insertErr) {
          if (!insertErr.message.includes('Duplicate entry') && !insertErr.message.includes('UNIQUE constraint failed')) {
            throw insertErr;
          }
        }
      }
    }
    console.log('✦ Gurukulam Classes seeded successfully.');

    const seededPurohits = [
      {
        id: 'acharya_1',
        name: 'Shri Ramakrishna Sharma',
        specialization: 'Maha Chandi Homam, Rigveda Recitation, Griha Pravesham, Vivaha Mahotsavam',
        rating: 5.0,
        fee: 2500,
        image: '/images/vedic_acharya.png',
        location: 'Hyderabad',
        bookings_count: 42,
        bio: 'Reverend Rigvedic Acharya Shri Ramakrishna Sharma has over 25 years of experience in performing sacred Vedic rituals, homams, and educational classes. Trained at the traditional Veda Pathashala in Tirupati, he specializes in Griha Pravesham, Maha Chandi Homas, and Vedic Weddings.',
        credentials: 'Gold Medalist in Rigvedic Studies, Tirumala Veda Pathashala; Certified Purohit by Vaidika Acharya Peetham.',
        portfolio_images: JSON.stringify(['/images/vedic_acharya.png', '/images/products/pasupu.png', '/images/products/vibhuti.png']),
        email: 'priest@gurupadukam.com',
        phone: '+919876543210',
        gov_id_type: 'Aadhaar Card',
        gov_id_number: '1234-5678-9012',
        gov_id_image: '/images/auth/aadhaar_mock.png'
      },
      {
        id: 'acharya_2',
        name: 'Shri Dwivedi Shastri Acharya',
        specialization: 'Yajurveda, Rigveda Recitation & Karma Kanda',
        rating: 4.9,
        fee: 3000,
        image: '/images/vedic_acharya.png',
        location: 'Hyderabad',
        bookings_count: 145,
        bio: 'Shri Dwivedi Shastri is a revered Vedic scholar with over 20 years of experience teaching recitation at traditional Veda Pathashalas. He specializes in Upanishad chanting and temple worship protocols.',
        credentials: 'M.A. in Sanskrit, Gold Medalist, Varanasi Veda Sabha',
        portfolio_images: JSON.stringify([]),
        email: 'dwivedi@gurupadukam.com',
        phone: '+919876543211',
        gov_id_type: 'Aadhaar Card',
        gov_id_number: '1234-5678-9013',
        gov_id_image: '/images/auth/aadhaar_mock.png'
      },
      {
        id: 'acharya_3',
        name: 'Shri Sharma Shastri',
        specialization: 'Vyakarna, Sanskrit Literature & Upanishads',
        rating: 4.8,
        fee: 3500,
        image: '/images/vedic_acharya.png',
        location: 'Bengaluru',
        bookings_count: 98,
        bio: 'Shri Sharma Shastri is an expert in Sanskrit grammar and classical Upanishadic commentaries. He has trained hundreds of students in the traditional Gurukulam method.',
        credentials: 'Sanskrit Shiromani, Tirupati Sanskrit Vidyapeeth',
        portfolio_images: JSON.stringify([]),
        email: 'shastri@gurupadukam.com',
        phone: '+919876543212',
        gov_id_type: 'Aadhaar Card',
        gov_id_number: '1234-5678-9014',
        gov_id_image: '/images/auth/aadhaar_mock.png'
      },
      {
        id: 'acharya_4',
        name: 'Shri Acharya Ramulu',
        specialization: 'Sanskrit Chanting, Bhagavad Gita & Astro-sciences',
        rating: 5.0,
        fee: 2800,
        image: '/images/vedic_acharya.png',
        location: 'Chennai',
        bookings_count: 210,
        bio: 'Shri Acharya Ramulu teaches Sanskrit chanting and Gita application in daily life. His sessions focus on precise pronunciation and phonetics.',
        credentials: 'Veda Vibhushana, Andhra Pradesh Veda Peetam',
        portfolio_images: JSON.stringify([]),
        email: 'ramulu@gurupadukam.com',
        phone: '+919876543213',
        gov_id_type: 'Aadhaar Card',
        gov_id_number: '1234-5678-9015',
        gov_id_image: '/images/auth/aadhaar_mock.png'
      },
      {
        id: 'acharya_5',
        name: 'Shri Srinivasa Acharya',
        specialization: 'Agama Shastras, Temple Pujas & Prabandha Chanting',
        rating: 4.9,
        fee: 3200,
        image: '/images/vedic_acharya.png',
        location: 'Hyderabad',
        bookings_count: 167,
        bio: 'Shri Srinivasa Acharya is an expert in temple liturgy and Dravida Veda chanting. He specializes in Vaishnava rituals and festival coordination.',
        credentials: 'Pancharatra Agama Praveena, Srirangam Pathashala',
        portfolio_images: JSON.stringify([]),
        email: 'srinivasa@gurupadukam.com',
        phone: '+919876543214',
        gov_id_type: 'Aadhaar Card',
        gov_id_number: '1234-5678-9016',
        gov_id_image: '/images/auth/aadhaar_mock.png'
      }
    ];

    for (const p of seededPurohits) {
      const existingPurohit = await dbGet("SELECT id FROM purohits WHERE id = ?", [p.id]);
      if (!existingPurohit) {
        try {
          await dbRun(
            `INSERT INTO purohits (id, name, specialization, rating, fee, image, location, bookings_count, bio, credentials, portfolio_images, email, phone, gov_id_type, gov_id_number, gov_id_image, is_verified, teaching_interest)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [p.id, p.name, p.specialization, p.rating, p.fee, p.image, p.location, p.bookings_count, p.bio, p.credentials, p.portfolio_images, p.email, p.phone, p.gov_id_type, p.gov_id_number, p.gov_id_image, 1, 1]
          );
        } catch (insertErr) {
          if (!insertErr.message.includes('Duplicate entry') && !insertErr.message.includes('UNIQUE constraint failed')) {
            throw insertErr;
          }
        }
      }
    }
    console.log('✦ Seeded 5 Vetted Priests in purohits table.');
    await seedPurohitBookingsAndReviews();

    // Seeding Satsang Queries
    const queryCount = await dbGet("SELECT COUNT(*) as count FROM queries");
    if (!queryCount || queryCount.count === 0) {
      const qId = 'query-1';
      await dbRun(
        "INSERT INTO queries (id, user_name, question, category) VALUES (?, ?, ?, ?)",
        [qId, 'Ramesh Rao', 'What is the dynamic spiritual benefit of using stone-ground Kumkum on the third eye?', 'Ritual Purity']
      );

      const rId = 'reply-1';
      await dbRun(
        "INSERT INTO replies (id, query_id, replier_name, replier_role, reply_content) VALUES (?, ?, ?, ?, ?)",
        [rId, qId, 'Shri Shastri Acharya', 'Purohit', 'Stone-ground Kumkum made with pure turmeric and lime acts as a natural disinfectant. It physically cools the space between the brows (Ajna Chakra), grounding our sensory coordinates and aligning the mind for deep mantra recitation (Japa).']
      );
      console.log('✦ Satsang Q&A seeded successfully.');
    }
  } catch (err) {
    console.error('Error seeding Vedic systems:', err.message);
  }
}

async function seedParinayamProfiles() {
  try {
    await dbRun("DELETE FROM parinayam_profiles");
    const seeds = [
      {
        id: 'prn-1',
        name: 'Smt. L. P.',
        gender: 'bride',
        dob: '1998-05-12',
        tob: '08:45 AM',
        pob: 'Hyderabad',
        gothram: 'Srivatsa',
        nakshatram: 'Anuradha',
        rasi: 'Vrishchika',
        padam: 2,
        education: 'M.Tech in Computer Science',
        profession: 'Software Engineer at Tech Mahindra',
        income: 950000,
        loans: 'None',
        about: 'Vedic values practicing vegetarian. Looking for an alliance who values family, dharma, and is settled in Hyderabad or Bangalore.',
        photo: 'https://images.unsplash.com/photo-1573496359142-b8d87734a5a2?auto=format&fit=crop&q=80&w=400',
        contact_phone: '+919988776655',
        contact_email: 'pranathi@gmail.com'
      },
      {
        id: 'prn-2',
        name: 'Smt. V. S.',
        gender: 'bride',
        dob: '2000-09-21',
        tob: '02:15 PM',
        pob: 'Bengaluru',
        gothram: 'Bharadwaja',
        nakshatram: 'Rohini',
        rasi: 'Vrishabha',
        padam: 4,
        education: 'B.A. in Sanskrit Literature & Carnatic Music',
        profession: 'Vocalist and Sanskrit Tutor',
        income: 480000,
        loans: 'None',
        about: 'Deeply passionate about Vedic chanting, classical music, and traditional home keeping. Looking for an Acharya or professional who respects culture and spiritual lifestyle.',
        photo: 'https://images.unsplash.com/photo-1594744803329-e58b31de215f?auto=format&fit=crop&q=80&w=400',
        contact_phone: '+919888877777',
        contact_email: 'vaishnavi.music@gmail.com'
      },
      {
        id: 'prn-3',
        name: 'Sri V. S.',
        gender: 'bridegroom',
        dob: '1995-11-03',
        tob: '06:30 AM',
        pob: 'Chennai',
        gothram: 'Kashyapa',
        nakshatram: 'Uttara Phalguni',
        rasi: 'Kanya',
        padam: 1,
        education: 'Ph.D. in Vedic Studies & Astrological Sciences',
        profession: 'Astrologer & Professor at Sanskrit University',
        income: 850000,
        loans: 'Education Loan: ₹2,00,000',
        about: 'Vedic scholar with modern insights. Looking for a partner who is culturally grounded and enjoys traditional customs.',
        photo: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?auto=format&fit=crop&q=80&w=400',
        contact_phone: '+919900998877',
        contact_email: 'subbiah.vedas@gmail.com'
      },
      {
        id: 'prn-4',
        name: 'Sri R. S.',
        gender: 'bridegroom',
        dob: '1996-03-15',
        tob: '11:10 PM',
        pob: 'Hyderabad',
        gothram: 'Harithasa',
        nakshatram: 'Punarvasu',
        rasi: 'Mithuna',
        padam: 3,
        education: 'MBA from IIM Bangalore',
        profession: 'Senior Manager at Deloitte',
        income: 2400000,
        loans: 'Home Loan: ₹3,500,000',
        about: 'Traditional South Indian Brahmin, working in corporate but deeply connected to daily sandhyavandanam and temple visits. Looking for an educated, career-oriented bride.',
        photo: 'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?auto=format&fit=crop&q=80&w=400',
        contact_phone: '+919444455555',
        contact_email: 'ram.deloitte@gmail.com'
      }
    ];

    for (const s of seeds) {
      await dbRun(
        `INSERT INTO parinayam_profiles (id, name, gender, dob, tob, pob, gothram, nakshatram, rasi, padam, education, profession, income, loans, about, photo, contact_phone, contact_email)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [s.id, s.name, s.gender, s.dob, s.tob, s.pob, s.gothram, s.nakshatram, s.rasi, s.padam, s.education, s.profession, s.income, s.loans, s.about, s.photo, s.contact_phone, s.contact_email]
      );
    }
    console.log('✦ Parinayam Matrimony Profiles seeded successfully.');
  } catch (err) {
    console.error('Error seeding Parinayam Profiles:', err.message);
  }
}

async function seedPurohitBookingsAndReviews() {
  try {
    const acharyaIds = ['acharya_1', 'acharya_2', 'acharya_3', 'acharya_4', 'acharya_5'];
    for (const aid of acharyaIds) {
      await dbRun("DELETE FROM purohit_bookings WHERE purohit_id = ?", [aid]);
      await dbRun("DELETE FROM purohit_reviews WHERE purohit_id = ?", [aid]);
    }

    const seeds = [
      { id: 'acharya_1', bookings: 42, rating: 5.0 },
      { id: 'acharya_2', bookings: 145, rating: 4.9 },
      { id: 'acharya_3', bookings: 98, rating: 4.8 },
      { id: 'acharya_4', bookings: 210, rating: 5.0 },
      { id: 'acharya_5', bookings: 260, rating: 4.9 }
    ];

    const devoteeNames = ['Srinivas Rao', 'Kalyan Chakravarthy', 'Venkatesh K.', 'Ramesh Kumar', 'Anitha Devi', 'Manning P.', 'Lakshmi Pranati'];

    for (const s of seeds) {
      // Seed bookings
      for (let i = 0; i < s.bookings; i++) {
        const bookingId = `seed-bk-${s.id}-${i}`;
        await dbRun(
          `INSERT INTO purohit_bookings (id, purohit_id, user_id, pooja_type, booking_date, time_slot, address, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [bookingId, s.id, `devotee_${(i % 5) + 1}`, 'Satyanarayana Vratam', '2026-06-25', '09:00 AM - 12:00 PM', 'Hyderabad Venue', 'Confirmed']
        );
      }

      // Seed reviews (5 reviews for each to calculate rating correctly)
      const reviewCount = 5;
      for (let i = 0; i < reviewCount; i++) {
        const reviewId = `seed-rev-${s.id}-${i}`;
        const devoteeName = devoteeNames[i % devoteeNames.length];
        
        let ratingValue = 5;
        if (s.rating === 4.9) {
          ratingValue = i === 0 ? 4 : 5;
        } else if (s.rating === 4.8) {
          ratingValue = (i === 0 || i === 1) ? 4 : 5;
        } else {
          ratingValue = s.rating;
        }

        await dbRun(
          `INSERT INTO purohit_reviews (id, booking_id, purohit_id, user_name, rating, review_text)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [reviewId, `seed-bk-${s.id}-${i}`, s.id, devoteeName, ratingValue, 'Very divine and traditional ceremony conducted. Highly satisfied.']
        );
      }
    }
    console.log('✦ Seeded actual bookings and reviews in database for priests successfully.');
  } catch (e) {
    console.error('Error seeding bookings and reviews:', e.message);
  }
}

export default db;

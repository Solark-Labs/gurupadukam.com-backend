import sqlite3 from 'sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import bcrypt from 'bcryptjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Env config: Automatically detect if we are using Hostinger MySQL or Local SQLite
const isMySQL = process.env.DB_TYPE === 'mysql' || !!process.env.MYSQL_HOST;

let db;
let mysqlPool;

if (isMySQL) {
  console.log('✦ Database Engine: Hostinger Remote MySQL Pool Active');
  
  // Dynamic import to prevent crash on local SQLite development if mysql2 is not installed yet
  const { default: mysql } = await import('mysql2/promise');
  
  const poolConfig = {
    host: process.env.MYSQL_HOST,
    port: parseInt(process.env.MYSQL_PORT || '3306'),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000
  };
  
  mysqlPool = mysql.createPool(poolConfig);
  initializeDatabaseMySQL();
} else {
  console.log('✦ Database Engine: Local File-Based SQLite Active');
  const dbPath = process.env.DATABASE_URL || process.env.DB_PATH || path.join(__dirname, 'gurupadukam.db');
  db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
      console.error('Error opening SQLite database:', err.message);
    } else {
      initializeDatabaseSQLite();
    }
  });
}

// Unified Database Promise Wrapper Functions
export const dbQuery = (sql, params = []) => {
  if (isMySQL) {
    return new Promise(async (resolve, reject) => {
      try {
        const [rows] = await mysqlPool.execute(sql, params);
        resolve(rows);
      } catch (err) {
        reject(err);
      }
    });
  } else {
    return new Promise((resolve, reject) => {
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
        const [result] = await mysqlPool.execute(sql, params);
        resolve({ id: result.insertId, changes: result.affectedRows });
      } catch (err) {
        reject(err);
      }
    });
  } else {
    return new Promise((resolve, reject) => {
      db.run(sql, params, function (err) {
        if (err) reject(err);
        else resolve({ id: this.lastID, changes: this.changes });
      });
    });
  }
};

export const dbGet = (sql, params = []) => {
  if (isMySQL) {
    return new Promise(async (resolve, reject) => {
      try {
        const [rows] = await mysqlPool.execute(sql, params);
        if (rows.length > 0) resolve(rows[0]);
        else resolve(undefined);
      } catch (err) {
        reject(err);
      }
    });
  } else {
    return new Promise((resolve, reject) => {
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
      description TEXT NOT NULL
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
      bookings_count INTEGER DEFAULT 0
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
      secure_deposit REAL DEFAULT 0
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
      status TEXT DEFAULT 'Scheduled'
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

    // Schema updates (column modifications)
    db.run(`ALTER TABLE users ADD COLUMN is_blocked INTEGER DEFAULT 0`, (err) => {});
    db.run(`ALTER TABLE purohit_bookings ADD COLUMN items TEXT`, (err) => {});
    db.run(`ALTER TABLE purohit_bookings ADD COLUMN items_purchased INTEGER DEFAULT 0`, (err) => {});
    db.run(`ALTER TABLE purohit_bookings ADD COLUMN secure_deposit REAL DEFAULT 0`, (err) => {});
    db.run(`ALTER TABLE purohit_bookings ADD COLUMN ritual_mode TEXT DEFAULT 'Offline'`, (err) => {});
    db.run(`ALTER TABLE purohit_bookings ADD COLUMN google_meet_link TEXT`, (err) => {});
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

    console.log('✦ SQLite database tables verified successfully.');
    await runSeeds();
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
      description TEXT NOT NULL
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

    // Purohits Table
    await mysqlPool.query(`CREATE TABLE IF NOT EXISTS purohits (
      id VARCHAR(255) PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      specialization VARCHAR(255) NOT NULL,
      rating DECIMAL(3,1) DEFAULT 5.0,
      fee DECIMAL(10,2) NOT NULL,
      image VARCHAR(500) NOT NULL,
      location VARCHAR(255) NOT NULL,
      bookings_count INT DEFAULT 0
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
      status VARCHAR(50) DEFAULT 'Scheduled'
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

    console.log('✦ Hostinger MySQL database tables verified successfully.');
    await runSeeds();
  } catch (err) {
    console.error('MySQL database initialization failed:', err);
  }
}

// Combined seeding logic
async function runSeeds() {
  await seedUsers();
  await seedProducts();
  await seedVedicSystem();
}

async function seedUsers() {
  try {
    // Delete any old super admin using the incorrect email
    await dbRun("DELETE FROM users WHERE email = 'superadmin@gurupadukam.com'");

    const existingSuperAdmin = await dbGet("SELECT * FROM users WHERE email = 'care.gurupadukam@gmail.com'");
    if (!existingSuperAdmin) {
      const superAdminId = 'usr-superadmin';
      const passwordHash = await bcrypt.hash('admin123', 10);
      await dbRun(
        "INSERT INTO users (id, name, email, password_hash, role, phone) VALUES (?, ?, ?, ?, ?, ?)",
        [superAdminId, 'Super Admin', 'care.gurupadukam@gmail.com', passwordHash, 'super_admin', '+919949730175']
      );
      console.log('✦ Super Admin user seeded. Email: care.gurupadukam@gmail.com');
    }

    const existingAdmins = await dbGet("SELECT * FROM users WHERE role = 'admin'");
    if (!existingAdmins) {
      const locations = [
        { name: 'Hyderabad Admin', email: 'hyd@gurupadukam.com', loc: 'Hyderabad' },
        { name: 'Bengaluru Admin', email: 'blr@gurupadukam.com', loc: 'Bengaluru' },
        { name: 'Chennai Admin', email: 'maa@gurupadukam.com', loc: 'Chennai' }
      ];

      for (const admin of locations) {
        const adminId = `usr-admin-${admin.loc.toLowerCase()}`;
        const passwordHash = await bcrypt.hash('admin123', 10);
        await dbRun(
          "INSERT INTO users (id, name, email, password_hash, role, location, phone) VALUES (?, ?, ?, ?, ?, ?, ?)",
          [adminId, admin.name, admin.email, passwordHash, 'admin', admin.loc, '+919999999999']
        );
      }
      console.log('✦ 3 Location-based Admins seeded (Hyderabad, Bengaluru, Chennai).');
    }

    const existingPriests = await dbGet("SELECT * FROM users WHERE role = 'purohit'");
    if (!existingPriests) {
      const priestId = 'purohit-1';
      const passwordHash = await bcrypt.hash('admin123', 10);
      await dbRun(
        "INSERT INTO users (id, name, email, password_hash, role, phone) VALUES (?, ?, ?, ?, ?, ?)",
        [priestId, 'Shri Dwivedi Shastri Acharya', 'priest@gurupadukam.com', passwordHash, 'purohit', '+919876543210']
      );
      console.log('✦ Demo Vetted Priest user seeded. Email: priest@gurupadukam.com');
    }
  } catch (err) {
    console.error('Error seeding users:', err.message);
  }
}

async function seedProducts() {
  try {
    // Force-sync p1 and p2 specifications in case database is already seeded
    try {
      await dbRun("UPDATE products SET description = 'Awaiting for FSSAI license, post which we will be back. Pure organic turmeric powder, hand-ground using traditional stone grinding.', stock = 0 WHERE id = 'p1'");
      await dbRun("UPDATE products SET name = 'Organic Kumkum (200g)', price = 189, original_price = 220, description = 'Made of pure Kumkum stones ground along with yellow horns (turmeric horns), which is an ancient and original process. 100% pure and best quality.' WHERE id = 'p2'");
    } catch (e) {
      console.warn("Product sync warning:", e.message);
    }

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
          image: 'https://assets.zyrosite.com/cdn-cgi/image/format=auto,w=600,h=600,fit=crop/tNrOkFJHrQGKzMyG/gemini_generated_image_az55qzaz55qzaz55-1-qoE2sOBnb4lPbbYH.png',
          description: 'Awaiting for FSSAI license, post which we will be back. Pure organic turmeric powder, hand-ground using traditional stone grinding.',
          stock: 0,
          badge: 'Organic',
          is_organic: 1
        },
        {
          id: 'p2',
          name: 'Organic Kumkum (200g)',
          name_te: 'కుంకుమ',
          price: 189,
          original_price: 220,
          category: 'powder',
          image: 'https://assets.zyrosite.com/cdn-cgi/image/format=auto,w=600,h=600,fit=crop/tNrOkFJHrQGKzMyG/untitled-SK4UYSC4sReRxpcn.png',
          description: 'Made of pure Kumkum stones ground along with yellow horns (turmeric horns), which is an ancient and original process. 100% pure and best quality.',
          stock: 30,
          badge: 'New Batch',
          is_organic: 1
        },
        {
          id: 'p3',
          name: 'Gandham (Chandanam)',
          name_te: 'గంధం / చందనం',
          price: 249,
          original_price: 320,
          category: 'powder',
          image: 'https://assets.zyrosite.com/cdn-cgi/image/format=auto,w=600,h=600,fit=crop/tNrOkFJHrQGKzMyG/untitled-1-TUTGlNXT3cCVQ1l3.png',
          description: 'Pure sandalwood paste & powder for deity abhishekam and tilak. Rich authentic fragrance.',
          stock: 15,
          badge: 'Limited',
          is_organic: 0
        },
        {
          id: 'p4',
          name: 'Sacred Vibhuti',
          name_te: 'విభూతి (భస్మం)',
          price: 99,
          original_price: 129,
          category: 'powder',
          image: 'https://assets.zyrosite.com/cdn-cgi/image/format=auto,w=600,h=600,fit=crop/tNrOkFJHrQGKzMyG/adobe-express---file-NZhQM6x7At5Ugsy6.png',
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
          image: 'https://assets.zyrosite.com/cdn-cgi/image/format=auto,w=600,h=656,fit=crop/tNrOkFJHrQGKzMyG/whatsapp-image-2026-03-21-at-1.53.16-pm-qoX3irLG4E6YGnPU.jpeg',
          description: 'Handspun cotton sacred thread (janeu) made the traditional way with 9 strands.',
          stock: 40,
          badge: null,
          is_organic: 0
        },
        {
          id: 'p6',
          name: 'Complete Puja Combo Kit',
          name_te: 'పూజా కిట్ (5-in-1)',
          price: 599,
          original_price: 825,
          category: 'combo',
          image: 'https://assets.zyrosite.com/cdn-cgi/image/format=auto,w=600,h=500,fit=crop/tNrOkFJHrQGKzMyG/chatgpt-image-mar-24-2026-10_27_29-pm-uy3PQQ9sZQ3cAUb8.png',
          description: 'All 5 sacred products beautifully packed in a traditional gift box. Perfect for festivals.',
          stock: 20,
          badge: 'Best Value',
          is_organic: 0
        },
        {
          id: 'p7',
          name: 'Hand-Rolled Organic Agarbatti',
          name_te: 'చేతితో చేసిన అగర్బత్తి',
          price: 99,
          original_price: 149,
          category: 'incense',
          image: '/images/cottage_artisan.png',
          description: 'Premium organic incense sticks hand-rolled by remote village artisans using natural gums and flower dust.',
          stock: 60,
          badge: 'Cottage Craft',
          is_organic: 1
        },
        {
          id: 'p8',
          name: 'Pure Cow-Dung Dhoop Sticks',
          name_te: 'దేశీ ఆవు పేడ ధూప్ స్టిక్స్',
          price: 119,
          original_price: 179,
          category: 'incense',
          image: 'https://images.unsplash.com/photo-1533038590840-1cde6b66b72d?auto=format&fit=crop&q=80&w=600',
          description: 'Traditional charcoal-free dhoop sticks made with pure dry cow dung, ghee, and sacred herbs.',
          stock: 45,
          badge: 'Empowerment Product',
          is_organic: 1
        },
        {
          id: 'p9',
          name: 'Sacred Handwoven Cotton Dhoti Set',
          name_te: 'చేనేత పట్టు జరీ పంచె కట్టు',
          price: 799,
          original_price: 1199,
          category: 'clothing',
          image: 'https://images.unsplash.com/photo-1617042375876-a13e36732a04?auto=format&fit=crop&q=80&w=600',
          description: '100% fine cotton traditional Dhoti and Kanduva set, hand-woven by household loom weavers.',
          stock: 25,
          badge: 'Handloom',
          is_organic: 0
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
  } catch (err) {
    console.error('Error seeding products:', err.message);
  }
}

async function seedVedicSystem() {
  try {
    // FORCE UPDATE GURUKULAM CLASSES TO ENSURE PREMIUM TRADITIONAL EPICS
    await dbRun("DELETE FROM classes");
    const initialClasses = [
      {
        id: 'cls-1',
        title: 'Epic Ramayana & Vedic Values',
        instructor_name: 'Shri Dwivedi Shastri Acharya',
        time: 'Every Saturday, 6:00 PM IST',
        fee: 0,
        image: '/images/ramayana_family.png',
        description: 'A divine immersion into the Valmiki Ramayana. Learn shloka recitation, Telugu meanings, and timeless moral values from the life of Maryada Purushottama Sri Rama.'
      },
      {
        id: 'cls-2',
        title: 'Bhagavad Gita Sloka Chanting',
        instructor_name: 'Shri Sharma Shastri',
        time: 'Every Sunday, 5:00 PM IST',
        fee: 0,
        image: 'https://images.unsplash.com/photo-1545205597-3d9d02c29597?auto=format&fit=crop&q=80&w=800',
        description: 'Master the accurate Sanskrit pronunciation, sandhi rules, and absolute word-by-word meanings of the 700 Bhagavad Gita shlokas to align your actions with Dharma.'
      },
      {
        id: 'cls-3',
        title: 'Mahabharata (Bharatham) Epic Study',
        instructor_name: 'Shri Acharya Ramulu',
        time: 'Mon - Wed, 6:30 AM IST',
        fee: 0,
        image: 'https://t4.ftcdn.net/jpg/04/83/67/61/360_F_483676144_8XDkDIhdzlCkwrMGKquArnzrTgJRixh3.jpg',
        description: 'Explore the grandeur of Vyasa Mahabharata (Bharatham). Dive deep into the philosophical discourses, the stories of ancient kings, and the lessons of truth and karma.'
      },
      {
        id: 'cls-4',
        title: 'Soundarya Lahari Hymns Recitation',
        instructor_name: 'Shri Srinivasa Acharya',
        time: 'Every Thursday, 6:30 PM IST',
        fee: 0,
        image: 'https://images.unsplash.com/photo-1509316975850-ff9c5deb0cd9?auto=format&fit=crop&q=80&w=800',
        description: 'Learn to recite Adi Shankaracharyas Soundarya Lahari. Experience the acoustic beauty and spiritual power of these 100 hymns glorifying the Divine Mother.'
      }
    ];
    for (const c of initialClasses) {
      await dbRun(
        "INSERT INTO classes (id, title, instructor_name, time, fee, image, description) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [c.id, c.title, c.instructor_name, c.time, c.fee, c.image, c.description]
      );
    }
    console.log('✦ Gurukulam Classes seeded successfully.');

    // Seeding Purohits
    const purohitCount = await dbGet("SELECT COUNT(*) as count FROM purohits");
    if (!purohitCount || purohitCount.count === 0) {
      const initialPurohits = [
        {
          id: 'purohit-1',
          name: 'Shri Dwivedi Shastri Acharya',
          specialization: 'Satyanarayana Vratam, Griha Pravesham, Upanayanam',
          rating: 4.9,
          fee: 2500,
          image: '/images/vedic_acharya.png',
          location: 'Hyderabad',
          bookings_count: 24
        },
        {
          id: 'purohit-2',
          name: 'Shri Dwivedi Shastri Acharya',
          specialization: 'Griha Pravesham, Maha Ganapathy Homam, Chandi Homam',
          rating: 4.8,
          fee: 3500,
          image: 'https://images.unsplash.com/photo-1506126613408-eca07ce68773?auto=format&fit=crop&q=80&w=300',
          location: 'Bengaluru',
          bookings_count: 14
        },
        {
          id: 'purohit-3',
          name: 'Shri Dwivedi Shastri Acharya',
          specialization: 'Vivaha Mahotsavam (Marriages), Upanayanam, Vastu Puja',
          rating: 5.0,
          fee: 6500,
          image: 'https://images.unsplash.com/photo-1609137144814-6d9b43343469?auto=format&fit=crop&q=80&w=300',
          location: 'Chennai',
          bookings_count: 38
        },
        {
          id: 'purohit-4',
          name: 'Shri Dwivedi Shastri Acharya',
          specialization: 'Navagraha Homam, Rudrabhishekam, Sudarshana Homam',
          rating: 4.7,
          fee: 3000,
          image: 'https://images.unsplash.com/photo-1566737236500-c8ac43014a67?auto=format&fit=crop&q=80&w=300',
          location: 'Hyderabad',
          bookings_count: 9
        }
      ];
      for (const p of initialPurohits) {
        await dbRun(
          "INSERT INTO purohits (id, name, specialization, rating, fee, image, location, bookings_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          [p.id, p.name, p.specialization, p.rating, p.fee, p.image, p.location, p.bookings_count]
        );
      }
      console.log('✦ Vetted Purohits directory seeded successfully.');
    }

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
        [rId, qId, 'Shri Shastri Acharya', 'Purohit', 'Stone-ground Kumkum made with organic turmeric and lime acts as a natural disinfectant. It physically cools the space between the brows (Ajna Chakra), grounding our sensory coordinates and aligning the mind for deep mantra recitation (Japa).']
      );
      console.log('✦ Satsang Q&A seeded successfully.');
    }
  } catch (err) {
    console.error('Error seeding Vedic systems:', err.message);
  }
}

export default db;

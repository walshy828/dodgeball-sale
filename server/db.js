// db.js
import mysql from "mysql2/promise";
import dotenv from "dotenv";
import crypto from "crypto";
dotenv.config();

const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 3000; // 3 seconds

export const pool = mysql.createPool({
  host: process.env.DB_HOST || "localhost",
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

/**
 * Attempt to connect to the database with retries.
 */
async function testConnection() {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const conn = await pool.getConnection();
      await conn.ping();
      conn.release();
      console.log("✅ Successfully connected to MariaDB");
      return true;
    } catch (err) {
      console.error(
        `⚠️  Database connection failed (attempt ${attempt}/${MAX_RETRIES}):`,
        err.message
      );
      if (attempt < MAX_RETRIES) {
        console.log(`⏳ Retrying in ${RETRY_DELAY_MS / 1000} seconds...`);
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      } else {
        console.error("❌ Could not connect to database after several attempts.");
        throw err;
      }
    }
  }
}

/**
 * Initialize database schema and seed initial data.
 */
export async function initializeDatabase() {
  await testConnection(); // Wait until DB is reachable

  const conn = await pool.getConnection();
  try {
    console.log("🔧 Initializing database schema...");

    // Create meta table
    await conn.query(`
      CREATE TABLE IF NOT EXISTS meta (
        id VARCHAR(50) PRIMARY KEY,
        count INT DEFAULT 0
      )
    `);

    // Seed counter row
    await conn.query(`
      INSERT INTO meta (id, count)
      VALUES ('counter', 0)
      ON DUPLICATE KEY UPDATE count = count
    `);

    // Create orders table
    await conn.query(`
      CREATE TABLE IF NOT EXISTS orders (
        id INT AUTO_INCREMENT PRIMARY KEY,
        orderId VARCHAR(10) NOT NULL UNIQUE,
        totalAmount DECIMAL(10,2),
        paymentType VARCHAR(50),
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        status VARCHAR(50)
      )
    `);

    // Create transactions table
    await conn.query(`
      CREATE TABLE IF NOT EXISTS transactions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        orderId VARCHAR(10),
        item VARCHAR(100),
        quantity INT,
        total DECIMAL(10,2),
        FOREIGN KEY (orderId) REFERENCES orders(orderId)
      )
    `);

    // Create items table (for admin-managed sale items)
    await conn.query(`
      CREATE TABLE IF NOT EXISTS items (
        id INT AUTO_INCREMENT PRIMARY KEY,
        tab VARCHAR(50) NOT NULL,
        category VARCHAR(100) NOT NULL,
        name VARCHAR(200) NOT NULL,
        dataName VARCHAR(200),
        price DECIMAL(10,2) DEFAULT 0,
        color VARCHAR(50),
        orderIndex INT DEFAULT 0
      )
    `);

    // Seed items table if empty with sensible defaults
    const [itemCountRows] = await conn.query(`SELECT COUNT(*) as c FROM items`);
    const itemCount = itemCountRows[0].c;
    if (itemCount === 0) {
      console.log('🔧 Seeding initial items...');
      const seedItems = [
        // raffles
        ['raffles','Raffles 🎟️','Single Ticket','single_ticket',1,'gray-600',1],
        ['raffles','Raffles 🎟️','6 Pack Ticket','6pack_ticket',5,'gray-600',2],
        ['raffles','Raffles 🎟️','14 Pack Ticket','14pack_ticket',10,'gray-600',3],
        ['raffles','Raffles 🎟️','30 Pack Ticket','30pack_ticket',20,'gray-600',4],
        // concessions - snacks
        ['concessions','Snacks','Pizza Slice 🍕','pizza',3,'gray-600',1],
        ['concessions','Snacks','Donuts 🍩','donuts',2,'gray-600',2],
        ['concessions','Snacks','Muffins 🧁','muffins',3,'gray-600',3],
        ['concessions','Snacks','Chips 🍟','chips',2,'gray-600',4],
        // candy
        ['concessions','Candy','Candy Bar 🍫','candy_bar',3,'gray-600',1],
        ['concessions','Candy','Nerds','nerds',2,'gray-600',2],
        ['concessions','Candy','Ring Pop 💍','ring_pop',2,'gray-600',3],
        ['concessions','Candy','Sour Patch Kids 🍋','sour_patch',2,'gray-600',4],
        ['concessions','Candy','Skittles/Starburst 🌟','skittles_starburst',2,'gray-600',5],
        ['concessions','Candy','Air Head Extremes 🌈','air_heads',2,'gray-600',6],
        ['concessions','Candy','Other','candy_other',2,'gray-600',7],
        // drinks
        ['concessions','Drinks 🥤','Gatorade','gatorade',3,'gray-600',1],
        ['concessions','Drinks 🥤','Water 💧','water',2,'gray-600',2],
        ['concessions','Drinks 🥤','Coffee ☕','coffee',3,'gray-600',3],
        ['concessions','Drinks 🥤','Other Drink','drink_other',2,'gray-600',4],
      ];

      const insertSQL = `INSERT INTO items (tab, category, name, dataName, price, color, orderIndex) VALUES ?`;
      await conn.query(insertSQL, [seedItems]);
      console.log('✅ Seeded items table');
    }

    // Set up admin credentials in meta table if provided via env
    // We store admin_hash and admin_salt in meta rows
    if (process.env.ADMIN_PASSWORD && process.env.ADMIN_SALT) {
      const salt = process.env.ADMIN_SALT;
      const hash = crypto.pbkdf2Sync(process.env.ADMIN_PASSWORD, salt, 100000, 64, 'sha512').toString('hex');
      await conn.query(`INSERT INTO meta (id, count) VALUES ('admin_hash', 0) ON DUPLICATE KEY UPDATE id=id`);
      await conn.query(`INSERT INTO meta (id, count) VALUES ('admin_salt', 0) ON DUPLICATE KEY UPDATE id=id`);
      // store hash and salt in a simple key/value format using a separate table would be better,
      // but to avoid schema changes we'll store them in meta by abusing the id and count columns.
      await conn.query(`UPDATE meta SET count = ? WHERE id = 'admin_hash'`, [0]);
      await conn.query(`UPDATE meta SET count = ? WHERE id = 'admin_salt'`, [0]);
      // store actual values in a helper table 'meta_text' to keep types correct
      await conn.query(`CREATE TABLE IF NOT EXISTS meta_text (id VARCHAR(50) PRIMARY KEY, value TEXT)`);
      await conn.query(`INSERT INTO meta_text (id, value) VALUES ('admin_hash', ?) ON DUPLICATE KEY UPDATE value = VALUES(value)`, [hash]);
      await conn.query(`INSERT INTO meta_text (id, value) VALUES ('admin_salt', ?) ON DUPLICATE KEY UPDATE value = VALUES(value)`, [salt]);
      console.log('🔧 Admin credentials seeded from environment');
    }

    console.log("✅ Database initialized successfully");
  } catch (err) {
    console.error("❌ Database initialization failed:", err);
    throw err;
  } finally {
    conn.release();
  }
}

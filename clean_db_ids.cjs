const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('gurupadukam.db');

db.serialize(() => {
  console.log("Starting DB migration to sequential IDs...");

  // 1. Delete old admin/super_admin records with legacy IDs
  db.run("DELETE FROM users WHERE id IN ('usr-superadmin', 'usr-admin-hyderabad', 'usr-admin-bengaluru', 'usr-admin-chennai')", (err) => {
    if (err) console.error("Error deleting old admins:", err.message);
    else console.log("Deleted old admins.");
  });

  // 2. Select remaining legacy users (devotees)
  db.all("SELECT id, name FROM users WHERE id LIKE 'usr-%'", [], (err, rows) => {
    if (err) {
      console.error("Error selecting users:", err.message);
      return;
    }

    console.log(`Found ${rows.length} legacy users to migrate.`);
    rows.forEach((row, index) => {
      const oldId = row.id;
      const newId = `devotee_${index + 1}`;
      console.log(`Migrating ${oldId} (${row.name}) -> ${newId}`);

      // Update users table
      db.run("UPDATE users SET id = ? WHERE id = ?", [newId, oldId], (err) => {
        if (err) console.error(`Error updating user ${oldId}:`, err.message);
      });

      // Update parinayam_profiles table
      db.run("UPDATE parinayam_profiles SET id = ? WHERE id = ?", [newId, oldId], (err) => {
        if (err) console.error(`Error updating parinayam_profiles ${oldId}:`, err.message);
      });

      // Update orders table
      db.run("UPDATE orders SET user_id = ? WHERE user_id = ?", [newId, oldId], (err) => {
        if (err) console.error(`Error updating orders ${oldId}:`, err.message);
      });

      // Update class_registrations table
      db.run("UPDATE class_registrations SET user_id = ? WHERE user_id = ?", [newId, oldId], (err) => {
        if (err) console.error(`Error updating class_registrations ${oldId}:`, err.message);
      });

      // Update purohit_bookings table
      db.run("UPDATE purohit_bookings SET user_id = ? WHERE user_id = ?", [newId, oldId], (err) => {
        if (err) console.error(`Error updating purohit_bookings ${oldId}:`, err.message);
      });

      // Update registration_payments table
      db.run("UPDATE registration_payments SET user_id = ? WHERE user_id = ?", [newId, oldId], (err) => {
        if (err) console.error(`Error updating registration_payments ${oldId}:`, err.message);
      });
    });
  });
});

setTimeout(() => {
  db.close(() => {
    console.log("Migration finished. Database closed.");
  });
}, 5000);

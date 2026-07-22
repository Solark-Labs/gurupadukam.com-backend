const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, 'gurupadukam.db');
console.log(`Connecting to database at: ${dbPath}`);
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
  // 1. Fetch all orders ordered chronologically
  db.all("SELECT id, date, customer_name FROM orders ORDER BY date ASC", [], (err, rows) => {
    if (err) {
      console.error("Error reading orders:", err);
      db.close();
      process.exit(1);
    }

    console.log(`Found ${rows.length} orders to re-index.`);
    
    let completedCount = 0;
    
    if (rows.length === 0) {
      console.log("No orders found. Nothing to migrate.");
      db.close();
      return;
    }

    // Wrap the entire set of updates in a series of steps to prevent lock issues
    db.run("BEGIN TRANSACTION", (beginErr) => {
      if (beginErr) {
        console.error("Failed to begin transaction:", beginErr);
        db.close();
        return;
      }

      let hasError = false;

      rows.forEach((row, index) => {
        const oldId = row.id;
        const newId = `INV-${index + 1}`;
        console.log(`Queued migration: ${oldId} -> ${newId} (Date: ${row.date}, Name: ${row.customer_name})`);

        // Update orders table
        db.run("UPDATE orders SET id = ? WHERE id = ?", [newId, oldId], function (err1) {
          if (err1 && !hasError) {
            console.error(`Error updating order ${oldId}:`, err1);
            hasError = true;
            db.run("ROLLBACK");
            db.close();
            return;
          }

          // Update order_items table
          db.run("UPDATE order_items SET order_id = ? WHERE order_id = ?", [newId, oldId], function (err2) {
            if (err2 && !hasError) {
              console.error(`Error updating order_items for ${oldId}:`, err2);
              hasError = true;
              db.run("ROLLBACK");
              db.close();
              return;
            }

            // Update notifications table
            db.run(
              "UPDATE notifications SET `desc` = REPLACE(`desc`, ?, ?) WHERE `desc` LIKE ?",
              [oldId, newId, `%${oldId}%`],
              function (err3) {
                if (err3 && !hasError) {
                  console.error(`Error updating notifications for ${oldId}:`, err3);
                  hasError = true;
                  db.run("ROLLBACK");
                  db.close();
                  return;
                }

                completedCount++;
                if (completedCount === rows.length && !hasError) {
                  db.run("COMMIT", (commitErr) => {
                    if (commitErr) {
                      console.error("Commit error:", commitErr);
                      db.run("ROLLBACK");
                    } else {
                      console.log("Database re-indexing completed successfully!");
                      verifyMigration();
                    }
                  });
                }
              }
            );
          });
        });
      });
    });
  });
});

function verifyMigration() {
  console.log("--- Verifying Migrated Orders ---");
  db.all("SELECT id, customer_name, total, date FROM orders ORDER BY date ASC", [], (err, rows) => {
    if (err) {
      console.error("Verification query failed:", err);
    } else {
      console.log(rows);
    }
    db.close();
  });
}

import { migrate, pool } from "./db.js";
try {
  await migrate();
  console.log("Database tables are ready.");
} catch (e) {
  console.error("Migration failed:", e.code || e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}

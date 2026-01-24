require("dotenv").config();
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

(async () => {
  try {
    const res = await pool.query("SELECT NOW()");
    console.log("✅ Database Connected!");
    console.log("Server Time:", res.rows[0].now);
    process.exit(0);
  } catch (err) {
    console.error("❌ Database Connection Failed");
    console.error(err.message);
    process.exit(1);
  }
})();

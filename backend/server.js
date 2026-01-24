require("dotenv").config();
const express = require("express");
const multer = require("multer");
const cors = require("cors");
const path = require("path");
const XLSX = require("xlsx");

const { parseAndSave, setProgressRef } = require("./excelParser");
const pool = require("./db");

const app = express();
app.use(express.static(path.join(__dirname, "../frontend")));
const upload = multer({ dest: "uploads/" });

// =======================
// Upload Progress Store
// =======================
let uploadProgress = {
  active: false,
  total: 0,
  processed: 0,
  currentFile: "",
  done: false
};

// =======================
// Middleware
// =======================
app.use(cors());
app.use(express.json());

// =======================
// Serve Frontend
// =======================

// Serve frontend folder
app.use(express.static(path.join(__dirname, "../frontend")));

// Home page
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "../frontend", "index.html"));
});

// Admin upload page
app.get("/admin-upload", (req, res) => {
  res.sendFile(path.join(__dirname, "../frontend", "upload.html"));
});
app.get("/speed", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "speed.html"));
});

// =======================
// Progress API
// =======================
app.get("/progress", (req, res) => {
  res.json(uploadProgress);
});

// =======================
// Upload API (MULTI FILE)
// =======================
app.post("/upload", upload.array("files"), async (req, res) => {
  try {
    if (!req.files || !req.files.length) {
      return res.status(400).json({ error: "No files uploaded" });
    }

    uploadProgress.active = true;
    uploadProgress.done = false;
    uploadProgress.processed = 0;
    uploadProgress.total = 0;

    // Estimate total rows
    for (const file of req.files) {
      const wb = XLSX.readFile(file.path);
      for (const sheetName of wb.SheetNames) {
        const sheet = wb.Sheets[sheetName];
        const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
        uploadProgress.total += rows.length;
      }
    }

    setProgressRef(uploadProgress);

    // Parse files
    for (const file of req.files) {
      uploadProgress.currentFile = file.originalname;
      console.log("Processing:", file.originalname);
      await parseAndSave(file.path, file.originalname);
    }

    uploadProgress.done = true;
    uploadProgress.active = false;

    res.json({
      success: true,
      message: `${req.files.length} Excel files processed successfully`
    });
  } catch (err) {
    console.error("UPLOAD ERROR:", err);
    uploadProgress.active = false;
    res.status(500).json({
      success: false,
      error: "Failed to process Excel files"
    });
  }
});

// =======================
// SUGGEST API (FAST + RULE-BASED FILTERING)
// RULES:
// - Division = TEXT PART of CLI ID (HWH3463 → HWH)
// - Lobby   = TEXT PART of CREW ID (RPH3020 → RPH)
// =======================
app.get("/suggest", async (req, res) => {
  try {
    const q = req.query.q || "";
    const lobby = req.query.lobby || "";
    const desig = req.query.desig || "";
    const division = req.query.division || "";

    if (!q) return res.json([]);

    const param = `%${q}%`;
    const prefixParam = `${q}%`;

    let filters = [];
    let values = [param, prefixParam];
    let idx = 3;

    // DESIGNATION FILTER
    if (desig) {
      filters.push(`designation = $${idx}`);
      values.push(desig);
      idx++;
    }

    // LOBBY FILTER
    // Crew ID TEXT PART (RPH3020 -> RPH)
    if (lobby) {
      filters.push(`SUBSTRING(crew_id FROM '^[A-Z]+') = $${idx}`);
      values.push(lobby);
      idx++;
    }

    // DIVISION FILTER
    // CLI ID TEXT PART (HWH3463 -> HWH)
    if (division) {
      filters.push(`SUBSTRING(cli_id FROM '^[A-Z]+') = $${idx}`);
      values.push(division);
      idx++;
    }

    const whereExtra = filters.length
      ? "AND " + filters.join(" AND ")
      : "";

    const sql = `
      SELECT
        crew_id,
        crew_name,
        designation,
        mobile
      FROM crew_master
      WHERE
        (
          crew_id ILIKE $1
          OR crew_name ILIKE $1
          OR designation ILIKE $1
          OR mobile ILIKE $1
        )
        ${whereExtra}
      ORDER BY
        CASE
          WHEN crew_id ILIKE $2 THEN 1
          WHEN crew_name ILIKE $2 THEN 2
          WHEN designation ILIKE $2 THEN 3
          WHEN mobile ILIKE $2 THEN 4
          ELSE 5
        END,
        crew_name
      LIMIT 12
    `;

    const result = await pool.query(sql, values);
    res.json(result.rows);
  } catch (err) {
    console.error("SUGGEST ERROR:", err);
    res.status(500).json([]);
  }
});

// =======================
// DYNAMIC LOBBY API (FIXED)
// =======================
app.get("/lobbies", async (req, res) => {
  try {
    const division = req.query.division || "";

    let sql = `
      SELECT DISTINCT
        SUBSTRING(crew_id FROM '^[A-Z]+') AS lobby
      FROM crew_master
      WHERE crew_id IS NOT NULL
    `;

    const values = [];

    // Filter by division using CLI ID
    if (division) {
      sql += ` AND cli_id ILIKE $1`;
      values.push(`%${division}%`);
    }

    sql += ` ORDER BY lobby`;

    const result = await pool.query(sql, values);

    res.json(
      result.rows
        .map(r => r.lobby)
        .filter(l => l && l.length >= 2) // removes AZ1, junk
    );
  } catch (err) {
    console.error("LOBBY API ERROR:", err);
    res.status(500).json([]);
  }
});

// =======================
// DYNAMIC DESIGNATION API
// =======================
app.get("/designations", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT DISTINCT designation
      FROM crew_master
      WHERE designation IS NOT NULL
        AND designation <> ''
      ORDER BY designation
    `);

    res.json(result.rows.map(r => r.designation));
  } catch (err) {
    console.error("DESIGNATION API ERROR:", err);
    res.status(500).json([]);
  }
});


// =======================
// META API (Dropdown Data)
// =======================
// Returns:
// - Lobbies   = TEXT PART of CREW ID
// - Designations = DISTINCT designation
// - Divisions = TEXT PART of CLI ID
// =======================
app.get("/meta", async (req, res) => {
  try {
    // DESIGNATIONS
    const desigResult = await pool.query(`
      SELECT DISTINCT designation
      FROM crew_master
      WHERE designation IS NOT NULL AND designation <> ''
      ORDER BY designation
    `);

    // LOBBIES (TEXT PART OF CREW_ID)
    const lobbyResult = await pool.query(`
      SELECT DISTINCT
        REGEXP_REPLACE(crew_id, '\\d{4}$', '') AS lobby
      FROM crew_master
      WHERE crew_id ~ '\\d{4}$'
      ORDER BY lobby
    `);

    res.json({
      designations: desigResult.rows.map(r => r.designation),
      lobbies: lobbyResult.rows.map(r => r.lobby)
    });

  } catch (err) {
    console.error("META ERROR:", err);
    res.status(500).json({
      designations: [],
      lobbies: []
    });
  }
});


// =======================
// Full Profile API
// =======================
app.get("/search", async (req, res) => {
  try {
    const crewId = req.query.q;
    if (!crewId) return res.json(null);

    // Crew master
    const crew = await pool.query(
      `SELECT * FROM crew_master WHERE crew_id = $1`,
      [crewId]
    );

    if (!crew.rows.length) return res.json(null);

    // Route learning
    const routes = await pool.query(
      `
      SELECT
        section_code,
        route_no,
        valid_till,
        status
      FROM crew_route_learning
      WHERE crew_id = $1
      ORDER BY valid_till DESC NULLS LAST
      `,
      [crewId]
    );

    res.json({
      ...crew.rows[0],
      routes: routes.rows
    });
  } catch (err) {
    console.error("SEARCH ERROR:", err);
    res.status(500).json(null);
  }
});

// =======================
// Start Server
// =======================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("=================================");
  console.log("Crew System Server Running");
  console.log("Search UI: http://localhost:" + PORT);
  console.log("Upload UI: http://localhost:" + PORT + "/admin-upload");
  console.log("=================================");
});

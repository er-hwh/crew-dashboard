const XLSX = require("xlsx");
const pool = require("./db");

let progressRef = null;
function setProgressRef(ref) {
  progressRef = ref;
}

// ======================
// HELPERS
// ======================
function normalize(str) {
  return String(str || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function parseDateDMY(str) {
  try {
    if (!str) return null;
    const s = String(str).trim().replace(/\//g, "-");
    const parts = s.split("-");
    if (parts.length !== 3) return null;
    return `${parts[2]}-${parts[1]}-${parts[0]}`; // YYYY-MM-DD
  } catch {
    return null;
  }
}

function getStatus(validTill) {
  if (!validTill) return "UNKNOWN";
  const today = new Date().toISOString().slice(0, 10);
  return validTill >= today ? "VALID" : "EXPIRED";
}

// ======================
// FIND COLUMN
// ======================
function findCol(headers, keys) {
  for (let i = 0; i < headers.length; i++) {
    const h = normalize(headers[i]);
    for (const k of keys) {
      if (h.includes(normalize(k))) return headers[i];
    }
  }
  return null;
}

// ======================
// FILE TYPE DETECT
// ======================
function detectType(headers) {
  const h = headers.map(h => normalize(h));

  if (h.some(x => x.includes("CURRENTGRADE") || x.includes("CLIID")))
    return "LI";

  if (h.some(x => x.includes("PRESENTPAY") || x.includes("RETIREMENT")))
    return "SERVICE";

  if (h.some(x => x.includes("CALLSERVE") || x.includes("PERMANENT")))
    return "CALLSERVE";

  if (h.some(x => x.includes("-") && x.match(/\d{3,5}$/)))
    return "LR";

  return "UNKNOWN";
}

// ======================
// UPSERT CREW
// ======================
async function upsertCrew(client, data) {
  const cols = [];
  const vals = [];
  const updates = [];

  for (const k in data) {
    if (data[k] === undefined || data[k] === null || data[k] === "") continue;
    cols.push(k);
    vals.push(data[k]);
    updates.push(`${k}=EXCLUDED.${k}`);
  }

  if (!cols.length) return;

  const sql = `
    INSERT INTO crew_master (${cols.join(",")})
    VALUES (${vals.map((_, i) => `$${i + 1}`).join(",")})
    ON CONFLICT (crew_id)
    DO UPDATE SET
      ${updates.join(",")},
      last_updated = CURRENT_TIMESTAMP
  `;

  await client.query(sql, vals);
}

// ======================
// LR BATCH INSERT
// ======================
async function flushLRBatch(client, batch) {
  if (!batch.length) return;

  const values = [];
  const placeholders = [];

  batch.forEach((r, i) => {
    const base = i * 6;
    placeholders.push(
      `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6})`
    );
    values.push(...r);
  });

  const sql = `
    INSERT INTO crew_route_learning
      (crew_id, section_code, route_no, valid_till, status, source_file)
    VALUES
      ${placeholders.join(",")}
    ON CONFLICT (crew_id, section_code, route_no)
    DO UPDATE SET
      valid_till = EXCLUDED.valid_till,
      status = EXCLUDED.status,
      source_file = EXCLUDED.source_file
  `;

  await client.query(sql, values);
}

// ======================
// MAIN PARSER
// ======================
async function parseAndSave(filePath, filename) {
  const wb = XLSX.readFile(filePath);
  const client = await pool.connect();

  try {
    for (const sheetName of wb.SheetNames) {
      console.log("Processing:", filename, "->", sheetName);
      const sheet = wb.Sheets[sheetName];

      const rawRows = XLSX.utils.sheet_to_json(sheet, {
        defval: "",
        header: 1
      });

      if (!rawRows.length) continue;

      let headers = null;
      let headerMap = null;
      let fileType = "UNKNOWN";
      let lrBatch = [];

      await client.query("BEGIN");

      for (const row of rawRows) {
        const normRow = row.map(c => String(c || "").trim());

        // ======================
        // HEADER DETECT ANYTIME
        // ======================
        const foundCrewId = normRow.find(c =>
          normalize(c).includes("CREWID")
        );

        if (foundCrewId) {
          headers = normRow;
          fileType = detectType(headers);

          headerMap = {
            crewId: findCol(headers, ["CREWID"]),
            crewName: findCol(headers, ["CREWNAME", "NAME"]),
            designation: findCol(headers, ["CREWDESG", "DESIG"]),
            level: findCol(headers, ["LEVEL"]),
            cadre: findCol(headers, ["CADRE"]),
            empNo: findCol(headers, ["EMPNO"]),
            presentPay: findCol(headers, ["PRESENTPAY"]),
            birthDate: findCol(headers, ["BIRTH"]),
            appointDate: findCol(headers, ["APPOINT"]),
            promotionDate: findCol(headers, ["PROMOTION"]),
            incrmntDue: findCol(headers, ["INCRMNT"]),
            retirementDate: findCol(headers, ["RETIREMENT"]),

            cliId: findCol(headers, ["CLIID"]),
            cliName: findCol(headers, ["CLINAME"]),
            currentGrade: findCol(headers, ["CURRENTGRADE"]),

            mobile: findCol(headers, ["MOBILE"]),
            callServe: findCol(headers, ["CALLSERVE"]),
            permanentAddr: findCol(headers, ["PERMANENT"])
          };

          console.log("Header Detected | Type:", fileType);
          continue;
        }

        if (!headers || !headerMap) continue;

        const get = col => {
          if (!col) return "";
          const idx = headers.indexOf(col);
          return idx >= 0 ? normRow[idx] : "";
        };

        const crewId = get(headerMap.crewId);
        if (!crewId) continue;

        // ======================
        // SERVICE FILE
        // ======================
        if (fileType === "SERVICE") {
          await upsertCrew(client, {
            crew_id: crewId,
            crew_name: get(headerMap.crewName),
            designation: get(headerMap.designation),
            level: get(headerMap.level),
            cadre: get(headerMap.cadre),
            emp_no: get(headerMap.empNo),
            present_pay: get(headerMap.presentPay),
            birth_date: parseDateDMY(get(headerMap.birthDate)),
            appoint_date: parseDateDMY(get(headerMap.appointDate)),
            promotion_date: parseDateDMY(get(headerMap.promotionDate)),
            incrmnt_due_date: parseDateDMY(get(headerMap.incrmntDue)),
            retirement_date: parseDateDMY(get(headerMap.retirementDate))
          });
        }

        // ======================
        // LI GRADING
        // ======================
        if (fileType === "LI") {
          await upsertCrew(client, {
            crew_id: crewId,
            cli_id: get(headerMap.cliId),
            cli_name: get(headerMap.cliName),
            current_grade: get(headerMap.currentGrade)
          });
        }

        // ======================
        // CALL SERVE
        // ======================
        if (fileType === "CALLSERVE") {
          await upsertCrew(client, {
            crew_id: crewId,
            mobile: get(headerMap.mobile),
            call_serve_address: get(headerMap.callServe),
            permanent_address: get(headerMap.permanentAddr)
          });
        }

        // ======================
        // LR MATRIX (VALID ONLY, BATCHED)
        // ======================
        if (fileType === "LR") {
          for (let i = 0; i < headers.length; i++) {
            const colName = headers[i];
            if (!colName.includes("-")) continue;

            const cell = normRow[i];
            if (!cell || cell === "N") continue;

            const match = cell.match(/Y\*?\/(\d{2}-\d{2}-\d{4})/);
            if (!match) continue;

            const validTill = parseDateDMY(match[1]);
            const status = getStatus(validTill);
            if (status !== "VALID") continue;

            const parts = colName.split(" ");
            const section = parts[0];
            const routeNo = parts[1] || "";

            lrBatch.push([
              crewId,
              section,
              routeNo,
              validTill,
              status,
              filename
            ]);

            if (lrBatch.length >= 500) {
              await flushLRBatch(client, lrBatch);
              lrBatch = [];
            }
          }
        }

        if (progressRef) progressRef.processed++;
      }

      if (lrBatch.length) {
        await flushLRBatch(client, lrBatch);
      }

      await client.query("COMMIT");
      console.log("Sheet complete:", sheetName);
    }
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("PARSER ERROR:", err.message || err);
    throw err;
  } finally {
    client.release();
  }
}

// ======================
// EXPORTS
// ======================
module.exports = {
  parseAndSave,
  setProgressRef
};

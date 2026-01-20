import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import fetch from "node-fetch";
import Papa from "papaparse";

const app = express();
app.use(cors());

const DATA_DIR = "./data";
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

const IPEDS_FILES = {
  A: "HD",
  B: "IC",
  C: "C"
};

function getNum(v) {
  if (v === null || v === undefined || v === "") return 0;
  const n = Number(v);
  return isNaN(n) ? 0 : n;
}

async function downloadAndParseIPEDS(fileCode, year) {
  const filePath = path.join(DATA_DIR, `${fileCode}_${year}.csv`);
  if (!fs.existsSync(filePath)) {
    const url = `https://nces.ed.gov/ipeds/datacenter/data/${fileCode}${year}.zip`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to download ${fileCode}`);
    const buffer = await res.buffer();
    fs.writeFileSync(filePath.replace(".csv", ".zip"), buffer);
    throw new Error(
      "ZIP extraction not implemented – ensure CSVs are preloaded"
    );
  }

  const csv = fs.readFileSync(filePath, "utf8");
  const parsed = Papa.parse(csv, { header: true });
  return parsed.data;
}

function buildCompleteProfile(unitid, year, hdData, icData, compData) {
  const hd = hdData.find(r => r.UNITID === unitid) || {};
  const ic = icData.find(r => r.UNITID === unitid) || {};
  const comp = compData.filter(r => r.UNITID === unitid);

  // ---- EXISTING COMPLETIONS (UNCHANGED) ----
  const completions = comp
    .map(c => ({
      cipCode: c.CIPCODE,
      major: c.CIPTITLE,
      awardLevel: c.AWLEVEL,
      count: getNum(c.CTOTALT)
    }))
    .filter(c => c.count > 0);

  // ---- NEW: PROGRAM CATALOG (DERIVED FROM COMPLETIONS) ----
  const programCatalogPrograms = comp
    .map(c => ({
      cipCode: c.CIPCODE,
      cipTitle: c.CIPTITLE,
      credentialLevel: c.AWLEVEL,
      completions: getNum(c.CTOTALT)
    }))
    .filter(p => p.completions > 0);

  const topProgramsByCompletions = [...programCatalogPrograms]
    .sort((a, b) => b.completions - a.completions)
    .slice(0, 15)
    .map((p, index) => ({
      ...p,
      rank: index + 1
    }));

  return {
    unitid,
    year,

    // ---- EXISTING PROFILE FIELDS ----
    institutionName: hd.INSTNM,
    city: hd.CITY,
    state: hd.STABBR,
    control: hd.CONTROL,
    sector: hd.SECTOR,
    accreditation: ic.ACCREDAGENCY,

    completions, // keep existing behavior

    // ---- NEW FIELD (WHAT YOUR UI EXPECTS) ----
    programCatalog: {
      source: "IPEDS Completions",
      year,
      programs: programCatalogPrograms,
      topProgramsByCompletions
    }
  };
}

app.get("/api/ipeds", async (req, res) => {
  try {
    const unitid = req.query.unitid;
    const year = req.query.year || "2023";
    if (!unitid) {
      res.status(400).json({ error: "Missing unitid" });
      return;
    }

    const [hdData, icData, compData] = await Promise.all([
      downloadAndParseIPEDS(IPEDS_FILES.A, year),
      downloadAndParseIPEDS(IPEDS_FILES.B, year),
      downloadAndParseIPEDS(IPEDS_FILES.C, year)
    ]);

    const profile = buildCompleteProfile(
      unitid,
      year,
      hdData,
      icData,
      compData
    );

    res.json(profile);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`IPEDS service running on port ${PORT}`);
});

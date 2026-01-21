const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const AdmZip = require('adm-zip');
const Papa = require('papaparse');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

let fileCache = {};
let dataCache = {};

const IPEDS_FILES = {
  2023: {
    HD: 'HD2023', EFFY: 'EFFY2023', DRVGR: 'DRVGR2023',
    IC: 'IC2023_AY', SFA: 'SFA2223', DRVEF: 'DRVEF2023',
    ADM: 'ADM2023', C: 'C2023_A', SAL: 'SAL2223_IS', FIN: 'F2223_F1A'
  }
};

const AVAILABLE_YEARS = [2023];

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    cachedFiles: Object.keys(fileCache).length,
    cachedInstitutions: Object.keys(dataCache).length
  });
});

// ---------------- SEARCH ----------------
app.get('/api/ipeds/search', async (req, res) => {
  try {
    const { name, limit = 10, year = '2023' } = req.query;
    if (!name) return res.status(400).json({ error: 'name required' });

    const hd = await downloadAndParseIPEDS(IPEDS_FILES[year].HD, year);
    const term = name.toLowerCase();

    const results = hd
      .filter(r => (r.INSTNM || '').toLowerCase().includes(term))
      .slice(0, Number(limit))
      .map(r => ({
        unitid: r.UNITID,
        name: r.INSTNM,
        city: r.CITY,
        state: r.STABBR,
        url: r.WEBADDR || r.WEBADM || ''
      }));

    res.json({ results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------------- PROFILE ----------------
app.get('/api/ipeds', async (req, res) => {
  try {
    const { unitid, year = '2023' } = req.query;
    if (!unitid) return res.status(400).json({ error: 'unitid required' });

    const key = `${year}-${unitid}`;
    if (dataCache[key]) return res.json({ ...dataCache[key], cached: true });

    const profile = await fetchCompleteProfile(unitid, year);
    if (!profile) return res.status(404).json({ error: 'Not found' });

    dataCache[key] = profile;
    res.json(profile);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/clear-cache', (req, res) => {
  fileCache = {};
  dataCache = {};
  res.json({ ok: true });
});

// ---------------- CORE ----------------
async function fetchCompleteProfile(unitid, year) {
  const f = IPEDS_FILES[year];

  const [hd, effy, comp] = await Promise.all([
    downloadAndParseIPEDS(f.HD, year),
    downloadAndParseIPEDS(f.EFFY, year),
    downloadAndParseIPEDS(f.C, year)
  ]);

  const inst = hd.find(r => r.UNITID === unitid);
  if (!inst) return null;

  const completionsRaw = comp
    .filter(r => r.UNITID === unitid && r.CTOTALT && r.CTOTALT !== '.')
    .map(r => ({
      cipCode: r.CIPCODE,
      cipTitle: r.CIPTITLE,
      awardLevel: r.AWLEVEL,
      completions: Number(r.CTOTALT)
    }));

  const topPrograms = [...completionsRaw]
    .sort((a, b) => b.completions - a.completions)
    .slice(0, 15)
    .map((p, i) => ({ ...p, rank: i + 1 }));

  const cipIndex = {};
  completionsRaw.forEach(p => {
    cipIndex[p.cipCode] = p;
  });

  return {
    unitid: inst.UNITID,
    institutionName: inst.INSTNM,
    city: inst.CITY,
    state: inst.STABBR,
    website: inst.WEBADDR || inst.WEBADM,
    carnegieClassification: inst.C18BASIC || inst.C21BASIC,
    religiousAffiliation: inst.RELAFFIL,
    regionalAccreditor: inst.ACCREDAGENCY,

    enrollment: {
      total: effy?.EFYTOTLT ? Number(effy.EFYTOTLT) : null
    },

    // 🔑 THIS IS THE KEY OBJECT
    programCatalog: {
      source: 'IPEDS Completions',
      year,
      fullCatalog: completionsRaw,
      topPrograms,
      cipIndex
    }
  };
}

// ---------------- UTIL ----------------
async function downloadAndParseIPEDS(fileName, year) {
  const key = `${fileName}-${year}`;
  if (fileCache[key]) return fileCache[key];

  const res = await fetch(`https://nces.ed.gov/ipeds/datacenter/data/${fileName}.zip`);
  if (!res.ok) return [];

  const zip = new AdmZip(await res.buffer());
  const csv = zip.getEntries().find(e => e.entryName.endsWith('.csv'));
  if (!csv) return [];

  const parsed = Papa.parse(csv.getData().toString('utf8'), {
    header: true,
    skipEmptyLines: true
  });

  fileCache[key] = parsed.data;
  return parsed.data;
}

app.listen(PORT, () => {
  console.log(`🚀 IPEDS API running on port ${PORT}`);
});

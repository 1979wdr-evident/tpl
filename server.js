
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
  },
  2022: {
    HD: 'HD2022', EFFY: 'EFFY2022', DRVGR: 'DRVGR2022',
    IC: 'IC2022_AY', SFA: 'SFA2122', DRVEF: 'DRVEF2022',
    ADM: 'ADM2022', C: 'C2022_A', SAL: 'SAL2122_IS', FIN: 'F2122_F1A'
  },
  2021: {
    HD: 'HD2021', EFFY: 'EFFY2021', DRVGR: 'DRVGR2021',
    IC: 'IC2021_AY', SFA: 'SFA2021', DRVEF: 'DRVEF2021',
    ADM: 'ADM2021', C: 'C2021_A', SAL: 'SAL2021_IS', FIN: 'F2021_F1A'
  },
  2020: {
    HD: 'HD2020', EFFY: 'EFFY2020', DRVGR: 'DRVGR2020',
    IC: 'IC2020_AY', SFA: 'SFA1920', DRVEF: 'DRVEF2020',
    ADM: 'ADM2020', C: 'C2020_A', SAL: 'SAL1920_IS', FIN: 'F1920_F1A'
  }
};

const AVAILABLE_YEARS = Object.keys(IPEDS_FILES).map(Number).sort((a, b) => b - a);

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    memoryUsage: process.memoryUsage(),
    cachedFiles: Object.keys(fileCache).length,
    cachedInstitutions: Object.keys(dataCache).length
  });
});

// SEARCH
app.get('/api/ipeds/search', async (req, res) => {
  try {
    const { name, limit = 10, year = '2023' } = req.query;
    if (!name) return res.status(400).json({ error: 'name parameter required' });

    const yearInt = parseInt(year);
    if (!IPEDS_FILES[yearInt]) {
      return res.status(400).json({ error: `Year ${year} not available`, availableYears: AVAILABLE_YEARS });
    }

    const hdData = await downloadAndParseIPEDS(IPEDS_FILES[yearInt].HD, yearInt);
    const searchTerm = name.toLowerCase();

    const matches = hdData
      .filter(r => (r.INSTNM || '').toLowerCase().includes(searchTerm))
      .sort((a, b) => a.INSTNM.localeCompare(b.INSTNM))
      .slice(0, parseInt(limit))
      .map(r => ({
        unitid: r.UNITID,
        name: r.INSTNM,
        city: r.CITY,
        state: r.STABBR,
        url: r.WEBADDR || r.WEBADM || ''
      }));

    res.json({ results: matches });
  } catch (e) {
    res.status(500).json({ error: 'Search failed', message: e.message });
  }
});

app.get('/api/ipeds', async (req, res) => {
  try {
    const { unitid, year = '2023' } = req.query;
    if (!unitid) return res.status(400).json({ error: 'unitid parameter required' });

    const yearInt = parseInt(year);
    const cacheKey = `${yearInt}-${unitid}`;
    if (dataCache[cacheKey]) return res.json({ ...dataCache[cacheKey], cached: true });

    const profile = await fetchCompleteProfile(unitid, yearInt);
    if (!profile) return res.status(404).json({ error: 'Institution not found' });

    dataCache[cacheKey] = profile;
    res.json(profile);
  } catch (e) {
    res.status(500).json({ error: 'Internal server error', message: e.message });
  }
});

app.post('/api/clear-cache', (req, res) => {
  fileCache = {};
  dataCache = {};
  res.json({ message: 'Cache cleared' });
});

async function fetchCompleteProfile(unitid, year) {
  const f = IPEDS_FILES[year];

  const [hd, effy, drvgr, ic, sfa, drvef, adm, comp, sal, fin] = await Promise.all([
    downloadAndParseIPEDS(f.HD, year),
    downloadAndParseIPEDS(f.EFFY, year),
    downloadAndParseIPEDS(f.DRVGR, year),
    downloadAndParseIPEDS(f.IC, year),
    downloadAndParseIPEDS(f.SFA, year),
    downloadAndParseIPEDS(f.DRVEF, year),
    downloadAndParseIPEDS(f.ADM, year),
    downloadAndParseIPEDS(f.C, year),
    downloadAndParseIPEDS(f.SAL, year),
    downloadAndParseIPEDS(f.FIN, year)
  ]);

  const inst = hd.find(r => r.UNITID === unitid);
  if (!inst) return null;

  return buildCompleteProfile(
    inst,
    effy.find(r => r.UNITID === unitid),
    drvgr.find(r => r.UNITID === unitid),
    ic.find(r => r.UNITID === unitid),
    sfa.find(r => r.UNITID === unitid),
    drvef.find(r => r.UNITID === unitid),
    adm.find(r => r.UNITID === unitid),
    comp.filter(r => r.UNITID === unitid),
    sal.find(r => r.UNITID === unitid),
    fin.find(r => r.UNITID === unitid),
    year
  );
}

async function downloadAndParseIPEDS(fileName, year) {
  const key = `${fileName}-${year}`;
  if (fileCache[key]) return fileCache[key];

  const res = await fetch(`https://nces.ed.gov/ipeds/datacenter/data/${fileName}.zip`);
  if (!res.ok) return [];

  const zip = new AdmZip(await res.buffer());
  const csv = zip.getEntries().find(e => e.entryName.endsWith('.csv'));
  if (!csv) return [];

  const parsed = Papa.parse(csv.getData().toString('utf8'), { header: true, skipEmptyLines: true });
  fileCache[key] = parsed.data;
  return parsed.data;
}

function buildCompleteProfile(hd, effy, drvgr, ic, sfa, drvef, adm, comp, sal, fin, year) {
  const num = v => (v && v !== '.' ? Number(v) : null);

  const completions = comp
    .map(c => ({
      cipCode: c.CIPCODE,
      cipTitle: c.CIPTITLE,
      awardLevel: c.AWLEVEL,
      completions: num(c.CTOTALT)
    }))
    .filter(p => p.completions > 0);

  const topProgramsByCompletions = [...completions]
    .sort((a, b) => b.completions - a.completions)
    .slice(0, 15)
    .map((p, i) => ({ ...p, rank: i + 1 }));

  return {
    unitid: hd.UNITID,
    year,
    institutionName: hd.INSTNM,
    city: hd.CITY,
    state: hd.STABBR,
    website: hd.WEBADDR || hd.WEBADM,
    carnegieClassification: hd.C18BASIC || hd.C21BASIC,
    religiousAffiliation: hd.RELAFFIL,
    regionalAccreditor: hd.ACCREDAGENCY,

    enrollment: {
      total: num(effy?.EFYTOTLT),
      undergraduate: num(effy?.EFUG),
      graduate: num(effy?.EFGRAD)
    },

    completions,

    programCatalog: {
      source: 'IPEDS Completions',
      year,
      programs: completions,
      topProgramsByCompletions
    }
  };
}

app.listen(PORT, () => {
  console.log(`🚀 IPEDS API running on port ${PORT}`);
});

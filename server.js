const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const AdmZip = require('adm-zip');
const Papa = require('papaparse');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

/** Cap parsed “wide” IPEDS tables kept in RAM (HD, EFFY, …). Completions (C*) are NOT stored whole. */
const MAX_FILE_CACHE_ENTRIES = parseInt(process.env.IPEDS_MAX_FILE_CACHE || '14', 10);
/** Per–(file,year,UNITID) completion rows only — small arrays. */
const MAX_COMP_UNIT_ENTRIES = parseInt(process.env.IPEDS_MAX_COMP_UNIT_CACHE || '400', 10);
const MAX_DATA_CACHE_ENTRIES = parseInt(process.env.IPEDS_MAX_INST_CACHE || '100', 10);
const MAX_CONCURRENT_PROFILES = parseInt(process.env.IPEDS_MAX_CONCURRENT_PROFILES || '2', 10);

const fileCache = Object.create(null);
const fileCacheOrder = [];
const compUnitCache = Object.create(null);
const compUnitOrder = [];
const dataCache = Object.create(null);
const dataCacheOrder = [];

const inflightParse = new Map();
const inflightComp = new Map();

let profileSlots = 0;
const profileWaiters = [];

function touchLru(orderArr, key) {
  const i = orderArr.indexOf(key);
  if (i >= 0) orderArr.splice(i, 1);
  orderArr.push(key);
}

function evictLru(cacheObj, orderArr, maxEntries) {
  while (orderArr.length > maxEntries) {
    const k = orderArr.shift();
    if (k != null) delete cacheObj[k];
  }
}

function getFileCache(key) {
  if (!Object.prototype.hasOwnProperty.call(fileCache, key)) return undefined;
  touchLru(fileCacheOrder, key);
  evictLru(fileCache, fileCacheOrder, MAX_FILE_CACHE_ENTRIES);
  return fileCache[key];
}

function setFileCache(key, val) {
  fileCache[key] = val;
  touchLru(fileCacheOrder, key);
  evictLru(fileCache, fileCacheOrder, MAX_FILE_CACHE_ENTRIES);
}

function getCompUnitCache(ck) {
  if (!Object.prototype.hasOwnProperty.call(compUnitCache, ck)) return undefined;
  touchLru(compUnitOrder, ck);
  evictLru(compUnitCache, compUnitOrder, MAX_COMP_UNIT_ENTRIES);
  return compUnitCache[ck];
}

function setCompUnitCache(ck, rows) {
  compUnitCache[ck] = rows;
  touchLru(compUnitOrder, ck);
  evictLru(compUnitCache, compUnitOrder, MAX_COMP_UNIT_ENTRIES);
}

function touchDataCache(key) {
  touchLru(dataCacheOrder, key);
  evictLru(dataCache, dataCacheOrder, MAX_DATA_CACHE_ENTRIES);
}

function setDataCache(key, val) {
  dataCache[key] = val;
  touchLru(dataCacheOrder, key);
  evictLru(dataCache, dataCacheOrder, MAX_DATA_CACHE_ENTRIES);
}

async function withProfileLimit(fn) {
  while (profileSlots >= MAX_CONCURRENT_PROFILES) {
    await new Promise((r) => profileWaiters.push(r));
  }
  profileSlots++;
  try {
    return await fn();
  } finally {
    profileSlots--;
    const next = profileWaiters.shift();
    if (next) next();
  }
}

const IPEDS_FILES = {
  // Completions CYYYY_A = awards Jul 1 (Y-1) – Jun 30 Y (collection Y/(Y+1) Fall).
  // Newer NCES zips often live under /complete-data-files/ before /datacenter/data/.
  2025: {
    HD: 'HD2025', EFFY: 'EFFY2025', DRVGR: 'DRVGR2025',
    IC: 'IC2025', SFA: 'SFA2425', DRVEF: 'DRVEF2025',
    ADM: 'ADM2025', C: 'C2025_A', SAL: 'SAL2425_IS', FIN: 'F2425_F1A'
  },
  2024: {
    HD: 'HD2024', EFFY: 'EFFY2024', DRVGR: 'DRVGR2024',
    IC: 'IC2024_AY', SFA: 'SFA2324', DRVEF: 'DRVEF2024',
    ADM: 'ADM2024', C: 'C2024_A', SAL: 'SAL2324_IS', FIN: 'F2324_F1A'
  },
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
    availableYears: AVAILABLE_YEARS,
    preferredYear: AVAILABLE_YEARS[0] || null,
    cachedFiles: Object.keys(fileCache).length,
    cachedCompletionSlices: Object.keys(compUnitCache).length,
    cachedInstitutions: Object.keys(dataCache).length,
    limits: {
      fileCache: MAX_FILE_CACHE_ENTRIES,
      compUnit: MAX_COMP_UNIT_ENTRIES,
      dataCache: MAX_DATA_CACHE_ENTRIES,
      concurrentProfiles: MAX_CONCURRENT_PROFILES
    }
  });
});

/** NCES zip URL candidates (newer releases often only on complete-data-files first). */
function ipedsZipUrlCandidates(fileName) {
  const name = String(fileName || '').replace(/\.zip$/i, '');
  return [
    `https://nces.ed.gov/ipeds/datacenter/data/${name}.zip`,
    `https://nces.ed.gov/ipeds/complete-data-files/${name}.zip`
  ];
}

async function fetchIpedsZipBuffer(fileName) {
  let lastStatus = null;
  for (const url of ipedsZipUrlCandidates(fileName)) {
    const response = await fetch(url);
    if (response.ok) {
      return { buffer: await response.buffer(), url };
    }
    lastStatus = response.status;
    console.log(`  ⚠️  ${fileName} miss ${response.status} @ ${url}`);
  }
  return { buffer: null, url: null, status: lastStatus };
}

// NEW: Search institutions by name using real IPEDS HD file
app.get('/api/ipeds/search', async (req, res) => {
  try {
    const { name, limit = 10, year = String(AVAILABLE_YEARS[0] || 2025) } = req.query;

    if (!name) {
      return res.status(400).json({ error: 'name parameter required' });
    }

    const yearInt = parseInt(year);
    if (!IPEDS_FILES[yearInt]) {
      return res.status(400).json({
        error: `Year ${year} not available`,
        availableYears: AVAILABLE_YEARS
      });
    }

    console.log(`\n🔍 Searching IPEDS for: "${name}" (${yearInt})`);

    const hdFile = IPEDS_FILES[yearInt].HD;
    const hdData = await downloadAndParseIPEDS(hdFile, yearInt);

    if (!hdData || hdData.length === 0) {
      return res.status(500).json({ error: 'Failed to load IPEDS directory data' });
    }

    const searchTerm = name.toLowerCase();
    const matches = hdData.filter(row => {
      const instName = (row.INSTNM || '').toLowerCase();
      return instName.includes(searchTerm);
    });

    matches.sort((a, b) => {
      const aName = (a.INSTNM || '').toLowerCase();
      const bName = (b.INSTNM || '').toLowerCase();

      const aExact = aName === searchTerm;
      const bExact = bName === searchTerm;
      if (aExact && !bExact) return -1;
      if (!aExact && bExact) return 1;

      const aStarts = aName.startsWith(searchTerm);
      const bStarts = bName.startsWith(searchTerm);
      if (aStarts && !bStarts) return -1;
      if (!aStarts && bStarts) return 1;

      return aName.localeCompare(bName);
    });

    const limitedMatches = matches.slice(0, parseInt(limit));

    const results = limitedMatches.map(row => ({
      unitid: row.UNITID,
      name: row.INSTNM,
      city: row.CITY,
      state: row.STABBR,
      url: row.WEBADDR || row.WEBADM || ''
    }));

    console.log(`✅ Found ${results.length} matches (from ${matches.length} total)`);

    res.json({ results });

  } catch (error) {
    console.error('❌ Search error:', error);
    res.status(500).json({
      error: 'Search failed',
      message: error.message
    });
  }
});

app.get('/api/ipeds', async (req, res) => {
  try {
    const { unitid, year = String(AVAILABLE_YEARS[0] || 2025) } = req.query;
    const yearInt = parseInt(year);

    if (!IPEDS_FILES[yearInt]) {
      return res.status(400).json({
        error: `Year ${year} not available`,
        availableYears: AVAILABLE_YEARS
      });
    }

    if (!unitid) {
      return res.status(400).json({ error: 'unitid parameter required' });
    }

    console.log(`\n=== Request for UNITID: ${unitid}, Year: ${yearInt} ===`);

    const cacheKey = `${yearInt}-${String(unitid).trim()}`;
    if (Object.prototype.hasOwnProperty.call(dataCache, cacheKey)) {
      console.log('✅ Returning cached data');
      touchDataCache(cacheKey);
      return res.json({ ...dataCache[cacheKey], cached: true });
    }

    const startTime = Date.now();
    const institutionData = await withProfileLimit(() => fetchCompleteProfile(unitid, yearInt));

    if (!institutionData) {
      return res.status(404).json({ error: 'Institution not found' });
    }

    setDataCache(cacheKey, institutionData);

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`✅ Response generated in ${duration}s`);

    res.json(institutionData);

  } catch (error) {
    console.error('❌ Error:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

app.post('/api/clear-cache', (req, res) => {
  for (const k of Object.keys(fileCache)) delete fileCache[k];
  fileCacheOrder.length = 0;
  for (const k of Object.keys(compUnitCache)) delete compUnitCache[k];
  compUnitOrder.length = 0;
  for (const k of Object.keys(dataCache)) delete dataCache[k];
  dataCacheOrder.length = 0;
  inflightParse.clear();
  inflightComp.clear();
  res.json({ message: 'Cache cleared' });
});

/**
 * Completions (C*) files are huge. Stream-parse and keep only rows for this UNITID.
 * Never store the full national table in memory or fileCache.
 */
async function downloadCompletionsForUnitId(fileName, year, unitid) {
  const uid = String(unitid).trim();
  const ck = `${fileName}-${year}-${uid}`;
  const hit = getCompUnitCache(ck);
  if (hit !== undefined) {
    console.log(`  📦 Cached completions slice ${fileName} (${hit.length} rows)`);
    return hit;
  }
  if (inflightComp.has(ck)) {
    return inflightComp.get(ck);
  }

  const promise = (async () => {
    console.log(`  ⬇️  ${fileName} (completions, UNITID ${uid} only)…`);
    const { buffer, status } = await fetchIpedsZipBuffer(fileName);

    if (!buffer) {
      console.log(`  ⚠️  ${fileName} unavailable (${status || 'no mirror'})`);
      setCompUnitCache(ck, []);
      return [];
    }

    const zip = new AdmZip(buffer);
    const csvEntry = zip.getEntries().find(e => e.entryName.endsWith('.csv'));

    if (!csvEntry) {
      setCompUnitCache(ck, []);
      return [];
    }

    const csvData = csvEntry.getData().toString('utf8');
    const rowMatch = (row) => row && String(row.UNITID ?? '').trim() === uid;
    const rows = [];
    Papa.parse(csvData, {
      header: true,
      skipEmptyLines: true,
      step: (result) => {
        if (rowMatch(result.data)) rows.push(result.data);
      }
    });

    console.log(`  ✅ ${fileName} — kept ${rows.length} row(s) for UNITID ${uid} (streamed)`);
    setCompUnitCache(ck, rows);
    return rows;
  })();

  inflightComp.set(ck, promise);
  try {
    return await promise;
  } finally {
    inflightComp.delete(ck);
  }
}

async function fetchCompleteProfile(unitid, year) {
  const files = IPEDS_FILES[year];

  console.log(`\n📥 Loading IPEDS for ${year - 1}-${year} (sequential + bounded RAM)…`);

  const hdData = await downloadAndParseIPEDS(files.HD, year);
  const effyData = await downloadAndParseIPEDS(files.EFFY, year);
  const drvgrData = await downloadAndParseIPEDS(files.DRVGR, year);
  const icData = await downloadAndParseIPEDS(files.IC, year);
  const sfaData = await downloadAndParseIPEDS(files.SFA, year);
  const drvefData = await downloadAndParseIPEDS(files.DRVEF, year);
  const admData = await downloadAndParseIPEDS(files.ADM, year);
  const compData = await downloadCompletionsForUnitId(files.C, year, unitid);
  const salData = await downloadAndParseIPEDS(files.SAL, year);
  const finData = await downloadAndParseIPEDS(files.FIN, year);

  console.log('✅ All files loaded');

  const uid = String(unitid).trim();
  const rowMatch = (row) => row && String(row.UNITID ?? '').trim() === uid;

  const hd = hdData.find(rowMatch);
  const effy = effyData.find(rowMatch);
  const drvgr = drvgrData.find(rowMatch);
  const ic = icData.find(rowMatch);
  const sfa = sfaData.find(rowMatch);
  const drvef = drvefData.find(rowMatch);
  const adm = admData.find(rowMatch);
  const sal = salData.find(rowMatch);
  const fin = finData.find(rowMatch);
  const comp = compData;

  if (!hd) {
    console.log(`❌ UNITID ${unitid} not found`);
    return null;
  }

  console.log(`✅ Found: ${hd.INSTNM} (${comp.length} program records)`);

  return buildCompleteProfile(hd, effy, drvgr, ic, sfa, drvef, adm, comp, sal, fin, year);
}

async function downloadAndParseIPEDS(fileName, year) {
  const cacheKey = `${fileName}-${year}`;

  const cached = getFileCache(cacheKey);
  if (cached !== undefined) {
    console.log(`  📦 Cached ${fileName}`);
    return cached;
  }

  if (inflightParse.has(cacheKey)) {
    return inflightParse.get(cacheKey);
  }

  const promise = (async () => {
    console.log(`  ⬇️  ${fileName}…`);
    const { buffer, status } = await fetchIpedsZipBuffer(fileName);

    if (!buffer) {
      console.log(`  ⚠️  ${fileName} unavailable (${status || 'no mirror'})`);
      setFileCache(cacheKey, []);
      return [];
    }

    const zip = new AdmZip(buffer);
    const csvEntry = zip.getEntries().find(e => e.entryName.endsWith('.csv'));

    if (!csvEntry) {
      setFileCache(cacheKey, []);
      return [];
    }

    const csvData = csvEntry.getData().toString('utf8');
    const parsed = Papa.parse(csvData, { header: true, skipEmptyLines: true });

    console.log(`  ✅ ${fileName} (${parsed.data.length.toLocaleString()} rows)`);

    setFileCache(cacheKey, parsed.data);
    return parsed.data;
  })();

  inflightParse.set(cacheKey, promise);
  try {
    return await promise;
  } finally {
    inflightParse.delete(cacheKey);
  }
}

function buildCompleteProfile(hd, effy, drvgr, ic, sfa, drvef, adm, comp, sal, fin, year) {

  const getNum = (val) => {
    if (!val || val === '.' || val === '') return null;
    const num = parseFloat(val);
    return isNaN(num) ? null : num;
  };

  const getPct = (val) => {
    const num = getNum(val);
    return num !== null ? Math.round(num) : null;
  };

  const getField = (obj, fieldNames) => {
    if (!obj) return null;
    for (const field of fieldNames) {
      if (obj[field] !== undefined && obj[field] !== null && obj[field] !== '.' && obj[field] !== '') {
        return obj[field];
      }
    }
    return null;
  };

  return {
    unitid: hd.UNITID,
    year,

    institutionName: hd.INSTNM,
    city: hd.CITY,
    state: hd.STABBR,
    location: `${hd.CITY}, ${hd.STABBR}`,
    zipCode: hd.ZIP,
    website: hd.WEBADDR || hd.WEBADM,

    institutionType: hd.ICLEVEL === '1' ? 'Four or more years' :
                     hd.ICLEVEL === '2' ? 'At least 2 but less than 4 years' :
                     hd.ICLEVEL === '3' ? 'Less than 2 years' : 'Unknown',

    control: hd.CONTROL === '1' ? 'Public' :
             hd.CONTROL === '2' ? 'Private nonprofit' :
             hd.CONTROL === '3' ? 'Private for-profit' : 'Unknown',

    carnegieClassification: hd.C18BASIC || hd.C21BASIC,
    yearFounded: getNum(hd.FOUNDDATE),
    religiousAffiliation: hd.RELAFFIL,
    locale: hd.LOCALE,

    regionalAccreditor: hd.ACCREDAGENCY,

    enrollment: {
      total: getNum(getField(effy, ['EFYTOTLT', 'EFYTOTLM', 'EFYTOTLW'])),
      undergraduate: getNum(getField(effy, ['EFUG'])),
      graduate: getNum(getField(effy, ['EFGRAD'])),
      fullTime: getNum(getField(effy, ['EFYFT'])),
      partTime: getNum(getField(effy, ['EFYPT'])),
      undergraduateFTE: getNum(getField(drvef, ['UGENRL', 'UGENRLT'])),
      graduateFTE: getNum(getField(drvef, ['GRENRL', 'GRENRLT']))
    },

    retentionRate: getPct(getField(drvef, ['RET_PCF', 'RET_PTF'])),
    graduationRate: getPct(getField(drvgr, ['GRTYPE4', 'GRTYPE6'])),

    tuition: {
      inState: getNum(getField(ic, ['TUITION2', 'TUITION3', 'CHG2AY3'])),
      outOfState: getNum(getField(ic, ['TUITION3', 'TUITION2', 'CHG3AY3'])),
      books: getNum(ic?.CHG4AY3),
      roomBoard: getNum(ic?.CHG5AY3)
    },

    financialAid: {
      undergradReceivingAid: getPct(sfa?.UAGRNTP),
      avgAmountGrant: getNum(sfa?.UAGRNTA),
      avgAmountLoan: getNum(sfa?.UFLOANA)
    },

    admissions: {
      applicants: getNum(adm?.APPLCN),
      admitted: getNum(adm?.ADMSSN),
      enrolled: getNum(adm?.ENRLT),
      acceptanceRate: getPct(adm?.ADMCON),
      yieldRate: getPct(adm?.ENRLRAT),
      satMath25: getNum(adm?.SATMT25),
      satMath75: getNum(adm?.SATMT75),
      satRead25: getNum(adm?.SATVR25),
      satRead75: getNum(adm?.SATVR75),
      actComposite25: getNum(adm?.ACTCM25),
      actComposite75: getNum(adm?.ACTCM75)
    },

    completions: comp.map(c => ({
      cipCode: c.CIPCODE,
      major: c.CIPTITLE,
      awardLevel: c.AWLEVEL,
      count: getNum(c.CTOTALT)
    })).filter(c => c.count > 0),

    faculty: {
      totalFTE: getNum(getField(sal, ['HRTOTLT', 'HRTOTLM'])),
      averageSalary: getNum(getField(sal, ['SASTOT', 'SASTOTM'])),
      instructionalFTE: getNum(getField(sal, ['HRINST', 'HRINSTM']))
    },

    finances: {
      revenue: {
        total: getNum(getField(fin, ['F1C01', 'F1TOTREV'])),
        tuitionFees: getNum(getField(fin, ['F1C02', 'F1TUIFEE'])),
        governmentGrants: getNum(getField(fin, ['F1C05', 'F1FEDGR', 'F1C06', 'F1STGR', 'F1C07', 'F1LOCGR'])),
        privateGifts: getNum(getField(fin, ['F1C08', 'F1PRIV'])),
        investmentReturn: getNum(getField(fin, ['F1C09', 'F1INVEST'])),
        auxiliaryEnterprises: getNum(getField(fin, ['F1C14', 'F1AUX']))
      },
      expenses: {
        total: getNum(getField(fin, ['F1C19', 'F1TOTEXP'])),
        instruction: getNum(getField(fin, ['F1C20', 'F1INSTR'])),
        research: getNum(getField(fin, ['F1C193', 'F1CRES'])),
        publicService: getNum(getField(fin, ['F1C21', 'F1PUBSV'])),
        academicSupport: getNum(getField(fin, ['F1C22', 'F1ACADM'])),
        studentServices: getNum(getField(fin, ['F1C23', 'F1STUSER'])),
        institutionalSupport: getNum(getField(fin, ['F1C24', 'F1INSUPT'])),
        auxiliaryEnterprises: getNum(getField(fin, ['F1C28', 'F1AUX']))
      }
    }
  };
}

app.listen(PORT, () => {
  console.log(`\n🚀 IPEDS API Server`);
  console.log(`   Port: ${PORT}`);
  console.log(`   Available years: ${AVAILABLE_YEARS.join(', ')}`);
  console.log(`\nEndpoints:`);
  console.log(`   GET  /health`);
  console.log(`   GET  /api/ipeds/search?name={name}&limit=10&year=2023`);
  console.log(`   GET  /api/ipeds?unitid={unitid}&year=2023`);
  console.log(`   POST /api/clear-cache`);
  console.log();
});

module.exports = app;

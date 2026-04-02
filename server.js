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
    cachedFiles: Object.keys(fileCache).length,
    cachedInstitutions: Object.keys(dataCache).length
  });
});

// NEW: Search institutions by name using real IPEDS HD file
app.get('/api/ipeds/search', async (req, res) => {
  try {
    const { name, limit = 10, year = '2023' } = req.query;
    
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
    
    // Download/cache HD (Directory) file
    const hdFile = IPEDS_FILES[yearInt].HD;
    const hdData = await downloadAndParseIPEDS(hdFile, yearInt);
    
    if (!hdData || hdData.length === 0) {
      return res.status(500).json({ error: 'Failed to load IPEDS directory data' });
    }
    
    // Search by institution name (case-insensitive)
    const searchTerm = name.toLowerCase();
    const matches = hdData.filter(row => {
      const instName = (row.INSTNM || '').toLowerCase();
      return instName.includes(searchTerm);
    });
    
    // Sort by relevance (exact matches first, then starts-with, then contains)
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
    
    // Limit results
    const limitedMatches = matches.slice(0, parseInt(limit));
    
    // Transform to expected format
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
    const { unitid, year = '2023' } = req.query;
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
    if (dataCache[cacheKey]) {
      console.log('✅ Returning cached data');
      return res.json({ ...dataCache[cacheKey], cached: true });
    }

    const startTime = Date.now();
    const institutionData = await fetchCompleteProfile(unitid, yearInt);

    if (!institutionData) {
      return res.status(404).json({ error: 'Institution not found' });
    }

    dataCache[cacheKey] = institutionData;

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
  fileCache = {};
  dataCache = {};
  res.json({ message: 'Cache cleared' });
});

async function fetchCompleteProfile(unitid, year) {
  const files = IPEDS_FILES[year];
  
  console.log(`\n📥 Downloading ALL 10 IPEDS files for ${year-1}-${year}...`);

  const [hdData, effyData, drvgrData, icData, sfaData, drvefData, admData, compData, salData, finData] = await Promise.all([
    downloadAndParseIPEDS(files.HD, year),
    downloadAndParseIPEDS(files.EFFY, year),
    downloadAndParseIPEDS(files.DRVGR, year),
    downloadAndParseIPEDS(files.IC, year),
    downloadAndParseIPEDS(files.SFA, year),
    downloadAndParseIPEDS(files.DRVEF, year),
    downloadAndParseIPEDS(files.ADM, year),
    downloadAndParseIPEDS(files.C, year),
    downloadAndParseIPEDS(files.SAL, year),
    downloadAndParseIPEDS(files.FIN, year)
  ]);

  console.log('✅ All files downloaded');

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
  const comp = compData.filter(rowMatch);

  if (!hd) {
    console.log(`❌ UNITID ${unitid} not found`);
    return null;
  }

  console.log(`✅ Found: ${hd.INSTNM} (${comp.length} program records)`);

  return buildCompleteProfile(hd, effy, drvgr, ic, sfa, drvef, adm, comp, sal, fin, year);
}

async function downloadAndParseIPEDS(fileName, year) {
  const cacheKey = `${fileName}-${year}`;
  
  if (fileCache[cacheKey]) {
    console.log(`  📦 Cached ${fileName}`);
    return fileCache[cacheKey];
  }

  const url = `https://nces.ed.gov/ipeds/datacenter/data/${fileName}.zip`;
  console.log(`  ⬇️  ${fileName}...`);
  
  const response = await fetch(url);
  
  if (!response.ok) {
    console.log(`  ⚠️  ${fileName} unavailable (${response.status})`);
    fileCache[cacheKey] = [];
    return [];
  }

  const buffer = await response.buffer();
  const zip = new AdmZip(buffer);
  const csvEntry = zip.getEntries().find(e => e.entryName.endsWith('.csv'));
  
  if (!csvEntry) {
    fileCache[cacheKey] = [];
    return [];
  }
  
  const csvData = csvEntry.getData().toString('utf8');
  const parsed = Papa.parse(csvData, { header: true, skipEmptyLines: true });
  
  console.log(`  ✅ ${fileName} (${parsed.data.length.toLocaleString()} rows)`);
  
  fileCache[cacheKey] = parsed.data;
  return parsed.data;
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

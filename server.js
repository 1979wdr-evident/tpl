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

// Search endpoint - uses College Scorecard for institution search
app.get("/api/ipeds/search", async (req, res) => {
  try {
    const { name, limit = 10 } = req.query;
    
    if (!name) {
      return res.status(400).json({ error: "name parameter required" });
    }
    
    console.log(`Searching for: "${name}"`);
    
    // Use College Scorecard API for search
    const apiKey = "wvO1UtAGFz7RQXxj3lRfbaIu9ed2USO39n82A8zL";
    const url = \`https://api.data.gov/ed/collegescorecard/v1/schools.json?\` +
      \`school.name=\${encodeURIComponent(name)}\` +
      \`&api_key=\${apiKey}\` +
      \`&_fields=id,school.name,school.city,school.state,school.school_url\` +
      \`&_per_page=\${limit}\`;
    
    const response = await fetch(url);
    
    if (!response.ok) {
      throw new Error(\`College Scorecard API error: \${response.status}\`);
    }
    
    const data = await response.json();
    
    // Transform to expected format
    const results = (data.results || []).map(school => ({
      unitid: school.id,
      name: school["school.name"],
      city: school["school.city"],
      state: school["school.state"],
      url: school["school.school_url"] || ""
    }));
    
    res.json({ results });
    
  } catch (error) {
    console.error("Search error:", error);
    res.status(500).json({ error: error.message });
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

    const cacheKey = `${yearInt}-${unitid}`;
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

  const hd = hdData.find(row => row.UNITID === unitid);
  const effy = effyData.find(row => row.UNITID === unitid);
  const drvgr = drvgrData.find(row => row.UNITID === unitid);
  const ic = icData.find(row => row.UNITID === unitid);
  const sfa = sfaData.find(row => row.UNITID === unitid);
  const drvef = drvefData.find(row => row.UNITID === unitid);
  const adm = admData.find(row => row.UNITID === unitid);
  const sal = salData.find(row => row.UNITID === unitid);
  const fin = finData.find(row => row.UNITID === unitid);
  const comp = compData.filter(row => row.UNITID === unitid);

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
  console.log(` ⬇️  ${fileName}...`);
  
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
    name: hd.INSTNM,
    city: hd.CITY,
    state: hd.STABBR,
    zip: hd.ZIP,
    county: hd.COUNTYCD,
    website: hd.WEBADDR,
    
    control: getControlLabel(hd.CONTROL),
    controlCode: hd.CONTROL,
    level: getLevelLabel(hd.ICLEVEL),
    carnegieBasic: hd.C18BASIC,
    carnegieUndergrad: hd.C18UGPRF,
    carnegieGrad: hd.C18ENPRF,
    carnegieSize: hd.C18SZSET,
    
    hbcu: hd.HBCU === '1',
    tribal: hd.TRIBAL === '1',
    hsi: hd.HSI === '1',
    medicalDegree: hd.MEDICAL === '1',
    landGrant: hd.LANDGRNT === '1',
    religiousAffiliation: getReligiousAffiliation(hd.RELAFFIL),
    
    enrollment: {
      total: effy ? getNum(effy.EFYTOTLT) : null,
      undergraduate: drvef ? getNum(drvef.EFUG) : null,
      graduate: drvef ? getNum(drvef.EFGRAD) : null,
      firstTime: effy ? getNum(getField(effy, ['EFFTUG', 'EFFTTOT'])) : null,
      
      demographics: effy ? {
        men: getNum(effy.EFYTOTLM),
        women: getNum(effy.EFYTOTLW),
        percentWomen: getPct(effy.EFYTOTLW && effy.EFYTOTLT ? (effy.EFYTOTLW / effy.EFYTOTLT * 100) : null),
        americanIndian: getNum(effy.EFYAIANT),
        asian: getNum(getField(effy, ['EFYASIAT', 'EFYASIAN', 'EFYASI'])),
        black: getNum(getField(effy, ['EFYBKAAT', 'EFYBKAA'])),
        hispanic: getNum(getField(effy, ['EFYHISPT', 'EFYHISP'])),
        pacificIslander: getNum(getField(effy, ['EFYNHPIT', 'EFYNHPI'])),
        white: getNum(getField(effy, ['EFYWHITT', 'EFYWHIT'])),
        twoOrMore: getNum(getField(effy, ['EFY2MORT', 'EFY2MOR'])),
        nonresidentAlien: getNum(getField(effy, ['EFYNRALT', 'EFYNRAL'])),
        unknown: getNum(getField(effy, ['EFYUNKNT', 'EFYUNKN'])),
        percentMinority: effy ? getPct(calculateMinorityPercent(effy)) : null
      } : null,
      
      partTime: drvef ? {
        undergraduate: getNum(getField(drvef, ['EFUGPT', 'EFTOTLP', 'EFPTUG'])),
        percentPartTime: getPct(getField(drvef, ['PCUENRLT', 'PCTENR']))
      } : null
    },
    
    admissions: adm ? {
      applicants: getNum(getField(adm, ['APPLCN', 'APPLCNM', 'APPLCNW'])),
      admitted: getNum(getField(adm, ['ADMSSN', 'ADMSSNM', 'ADMSSNW'])),
      enrolled: getNum(getField(adm, ['ENRLT', 'ENRLM', 'ENRLW'])),
      
      acceptanceRate: getPct(adm.ADMSSN && adm.APPLCN ? (adm.ADMSSN / adm.APPLCN * 100) : null),
      yieldRate: getPct(adm.ENRLT && adm.ADMSSN ? (adm.ENRLT / adm.ADMSSN * 100) : null),
      
      testScores: {
        satReading25: getNum(getField(adm, ['SATVR25', 'SATRD25'])),
        satReading75: getNum(getField(adm, ['SATVR75', 'SATRD75'])),
        satMath25: getNum(getField(adm, ['SATMT25', 'SATMTH25'])),
        satMath75: getNum(getField(adm, ['SATMT75', 'SATMTH75'])),
        satWriting25: getNum(getField(adm, ['SATWR25', 'SATWT25'])),
        satWriting75: getNum(getField(adm, ['SATWR75', 'SATWT75'])),
        actComposite25: getNum(getField(adm, ['ACTCM25', 'ACTCOMP25'])),
        actComposite75: getNum(getField(adm, ['ACTCM75', 'ACTCOMP75'])),
        actEnglish25: getNum(getField(adm, ['ACTEN25', 'ACTENG25'])),
        actEnglish75: getNum(getField(adm, ['ACTEN75', 'ACTENG75'])),
        actMath25: getNum(getField(adm, ['ACTMT25', 'ACTMTH25'])),
        actMath75: getNum(getField(adm, ['ACTMT75', 'ACTMTH75']))
      },
      
      percentSubmittingSAT: getPct(getField(adm, ['SATPCT', 'PCTSAT'])),
      percentSubmittingACT: getPct(getField(adm, ['ACTPCT', 'PCTACT']))
    } : null,
    
    outcomes: {
      retentionRate: drvef ? getPct(getField(drvef, ['RET_PCF', 'RET_PCP', 'RETENTFT', 'RET_NMF'])) : null,
      
      graduation: drvgr ? {
        rate4Year: getPct(getField(drvgr, ['GBA4RTT', 'GRRATE4', 'BAGR100', 'L4GR100'])),
        rate5Year: getPct(getField(drvgr, ['GBA5RTT', 'GRRATE5', 'BAGR125'])),
        rate6Year: getPct(getField(drvgr, ['GBA6RTT', 'GRRTTOT', 'BAGR150', 'L4GR150'])),
        cohortSize: getNum(getField(drvgr, ['GRCOHRT', 'COHORTFT', 'GRCOHTOT']))
      } : null
    },
    
    // FIXED: Now using correct tuition field names from IC_AY files
    costs: ic ? {
      tuition: {
        inDistrictTuition: getNum(getField(ic, ['chg1at3', 'chg1at2', 'chg1at1', 'chg1at0', 'TUITION1'])),
        inDistrictFees: getNum(getField(ic, ['chg1af3', 'chg1af2', 'chg1af1', 'chg1af0'])),
        inDistrictTotal: getNum(getField(ic, ['chg1ay3', 'chg1ay2', 'chg1ay1', 'chg1ay0'])),
        
        inStateTuition: getNum(getField(ic, ['chg2at3', 'chg2at2', 'chg2at1', 'chg2at0', 'TUITION2'])),
        inStateFees: getNum(getField(ic, ['chg2af3', 'chg2af2', 'chg2af1', 'chg2af0'])),
        inStateTotal: getNum(getField(ic, ['chg2ay3', 'chg2ay2', 'chg2ay1', 'chg2ay0'])),
        
        outOfStateTuition: getNum(getField(ic, ['chg3at3', 'chg3at2', 'chg3at1', 'chg3at0', 'TUITION3'])),
        outOfStateFees: getNum(getField(ic, ['chg3af3', 'chg3af2', 'chg3af1', 'chg3af0'])),
        outOfStateTotal: getNum(getField(ic, ['chg3ay3', 'chg3ay2', 'chg3ay1', 'chg3ay0'])),
        
        tuitionVaries: ic.TUITVARY === '1'
      },
      booksAndSupplies: getNum(getField(ic, ['chg4ay3', 'chg4ay2', 'chg4ay1', 'chg4ay0'])),
      roomAndBoardOnCampus: getNum(getField(ic, ['chg5ay3', 'chg5ay2', 'chg5ay1', 'chg5ay0'])),
      roomAndBoard: {
        room: getNum(ic.ROOMAMT),
        board: getNum(ic.BOARDAMT),
        combined: getNum(ic.RMBRDAMT),
        roomCapacity: getNum(ic.ROOMCAP),
        mealsPerWeek: getNum(ic.MEALSWK)
      },
      fees: {
        applicationUG: getNum(ic.APPLFEEU),
        applicationGrad: getNum(ic.APPLFEEG)
      }
    } : null,
    
    financialAid: sfa ? {
      percentReceivingAid: getPct(getField(sfa, ['UAGRNTP', 'UAGRNTT'])),
      percentPellGrant: getPct(getField(sfa, ['UPGRNTP', 'UPGRNTT'])),
      percentFederalLoan: getPct(getField(sfa, ['UFLOAMP', 'UFLOANT'])),
      averageNetPrice: getNum(getField(sfa, ['NPIST2', 'NPGRN2'])),
      averageNetPriceByIncome: {
        under30k: getNum(getField(sfa, ['NPT412', 'NPT41'])),
        from30to48k: getNum(getField(sfa, ['NPT422', 'NPT42'])),
        from48to75k: getNum(getField(sfa, ['NPT432', 'NPT43'])),
        from75to110k: getNum(getField(sfa, ['NPT442', 'NPT44'])),
        over110k: getNum(getField(sfa, ['NPT452', 'NPT45']))
      }
    } : null,
    
    programs: comp && comp.length > 0 ? analyzePrograms(comp) : null,
    
    faculty: {
      studentFacultyRatio: drvef ? getNum(getField(drvef, ['STUFACR', 'SFR'])) : null,
      
      salaries: sal ? {
        averageAll: getNum(getField(sal, ['SAOUTLT', 'SAOUTL', 'SATOTAL'])),
        
        byRank: {
          professor: getNum(getField(sal, ['SAPROF', 'SAPRF'])),
          associateProfessor: getNum(getField(sal, ['SAASCP', 'SAASC'])),
          assistantProfessor: getNum(getField(sal, ['SAASP', 'SAAST'])),
          instructor: getNum(getField(sal, ['SAINST', 'SAINS'])),
          lecturer: getNum(getField(sal, ['SALECT', 'SALEC']))
        },
        
        byGender: {
          menAverage: getNum(getField(sal, ['SAOUTLM', 'SAOUTM'])),
          womenAverage: getNum(getField(sal, ['SAOUTLW', 'SAOUTW']))
        }
      } : null
    },
    
    finance: fin ? {
      revenues: {
        total: getNum(getField(fin, ['F1C011', 'F1CREV', 'TOTALREV'])),
        tuitionFees: getNum(getField(fin, ['F1C012', 'F1CTUIT'])),
        federalGrants: getNum(getField(fin, ['F1C013', 'F1CFED'])),
        stateGrants: getNum(getField(fin, ['F1C014', 'F1CSTATE'])),
        localGrants: getNum(getField(fin, ['F1C015', 'F1CLOCAL'])),
        privateGifts: getNum(getField(fin, ['F1C016', 'F1CGIFT'])),
        investmentReturn: getNum(getField(fin, ['F1C017', 'F1CINV'])),
        otherRevenues: getNum(getField(fin, ['F1C018', 'F1COTHER']))
      },
      
      expenditures: {
        total: getNum(getField(fin, ['F1C191', 'F1CEXP', 'TOTALEXP'])),
        instruction: getNum(getField(fin, ['F1C192', 'F1CINST'])),
        research: getNum(getField(fin, ['F1C193', 'F1CRES'])),
        publicService: getNum(getField(fin, ['F1C194', 'F1CPUB'])),
        academicSupport: getNum(getField(fin, ['F1C195', 'F1CACAD'])),
        studentServices: getNum(getField(fin, ['F1C196', 'F1CSTUD'])),
        institutional: getNum(getField(fin, ['F1C197', 'F1CINSTIT'])),
        operations: getNum(getField(fin, ['F1C198', 'F1COPER'])),
        scholarships: getNum(getField(fin, ['F1C199', 'F1CSCHOL']))
      },
      
      assets: {
        endowment: getNum(getField(fin, ['F1H01', 'F1ENDOW', 'ENDOWMENT']))
      }
    } : null,
    
    dataSource: {
      year: `${year-1}-${year.toString().slice(2)}`,
      yearRequested: year,
      filesIncluded: Object.values(IPEDS_FILES[year]),
      fetchedAt: new Date().toISOString(),
      platform: 'Railway.app',
      note: 'Complete IPEDS profile - all 10 data files'
    }
  };
}

function analyzePrograms(completions) {
  const getNum = (val) => {
    if (!val || val === '.' || val === '') return 0;
    return parseFloat(val) || 0;
  };

  let totalAssociate = 0, totalBachelor = 0, totalMaster = 0, totalDoctoral = 0, totalCertificate = 0;
  const programsByCategory = {};

  completions.forEach(row => {
    const cipcode = row.CIPCODE;
    const awlevel = row.AWLEVEL;
    const total = getNum(row.CTOTALT);
    if (total === 0) return;

    if (awlevel === '3') totalAssociate += total;
    if (awlevel === '5') totalBachelor += total;
    if (awlevel === '7') totalMaster += total;
    if (awlevel === '17') totalDoctoral += total;
    if (awlevel === '1' || awlevel === '2') totalCertificate += total;

    if (cipcode && cipcode.length >= 2) {
      const category = cipcode.substring(0, 2);
      if (!programsByCategory[category]) {
        programsByCategory[category] = {
          cipCode: category,
          name: getCIPCategoryName(category),
          totalCompletions: 0
        };
      }
      programsByCategory[category].totalCompletions += total;
    }
  });

  const topPrograms = Object.values(programsByCategory)
    .sort((a, b) => b.totalCompletions - a.totalCompletions)
    .slice(0, 10);

  return {
    totalCompletions: totalAssociate + totalBachelor + totalMaster + totalDoctoral + totalCertificate,
    byLevel: {
      associate: totalAssociate,
      bachelor: totalBachelor,
      master: totalMaster,
      doctoral: totalDoctoral,
      certificate: totalCertificate
    },
    topPrograms: topPrograms,
    totalProgramCategories: Object.keys(programsByCategory).length
  };
}

function getCIPCategoryName(code) {
  const categories = {
    '01': 'Agriculture', '03': 'Natural Resources', '04': 'Architecture',
    '09': 'Communication', '11': 'Computer/Information Sciences', '13': 'Education',
    '14': 'Engineering', '16': 'Foreign Languages', '22': 'Legal Professions',
    '23': 'English Language/Literature', '26': 'Biological/Biomedical Sciences',
    '27': 'Mathematics/Statistics', '30': 'Multi/Interdisciplinary Studies',
    '31': 'Parks/Recreation/Fitness', '40': 'Physical Sciences', '42': 'Psychology',
    '43': 'Homeland Security/Law Enforcement', '45': 'Social Sciences',
    '50': 'Visual/Performing Arts', '51': 'Health Professions',
    '52': 'Business/Management/Marketing', '54': 'History', '99': 'Unclassified'
  };
  return categories[code] || `CIP ${code}`;
}

function calculateMinorityPercent(effy) {
  const getNum = (val) => {
    if (!val || val === '.' || val === '') return 0;
    return parseFloat(val) || 0;
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

  const total = getNum(effy.EFYTOTLT);
  if (!total) return null;
  
  const minority = getNum(effy.EFYAIANT) + getNum(getField(effy, ['EFYASIAT', 'EFYASIAN'])) + 
    getNum(getField(effy, ['EFYBKAAT', 'EFYBKAA'])) + getNum(getField(effy, ['EFYHISPT', 'EFYHISP'])) +
    getNum(getField(effy, ['EFYNHPIT', 'EFYNHPI'])) + getNum(getField(effy, ['EFY2MORT', 'EFY2MOR']));
  
  return Math.round((minority / total) * 100);
}

function getControlLabel(code) {
  const labels = { '1': 'Public', '2': 'Private nonprofit', '3': 'Private for-profit' };
  return labels[code] || 'Unknown';
}

function getLevelLabel(code) {
  const labels = {
    '1': 'Four or more years',
    '2': 'At least 2 but less than 4 years',
    '3': 'Less than 2 years'
  };
  return labels[code] || 'Unknown';
}

function getReligiousAffiliation(code) {
  const affiliations = {
    '47': 'Pentecostal Holiness Church', '30': 'Roman Catholic', '54': 'Baptist',
    '71': 'United Methodist', '75': 'Southern Baptist', '80': 'Jewish',
    '-1': 'Not reported', '-2': 'Not applicable'
  };
  return affiliations[code] || null;
}

app.listen(PORT, () => {
  console.log(`
🚂 IPEDS Railway API Server
✅ Server running on port ${PORT}
🌐 Endpoints:
   GET  /health
   GET  /api/ipeds?unitid=198136&year=2023
   POST /api/clear-cache
  `);
});

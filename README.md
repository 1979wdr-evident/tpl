# IPEDS Railway API

Complete IPEDS institutional data API that downloads and parses actual IPEDS data files from NCES.

## Features

- ✅ Search institutions by name (via College Scorecard)
- ✅ Get complete IPEDS data (from NCES data files)
- ✅ Multiple years supported (2020-2023)
- ✅ Automatic caching for performance
- ✅ Comprehensive institutional profiles

## Endpoints

### 1. Search Institutions

```
GET /api/ipeds/search?name={institution_name}&limit=10
```

**Example:**
```bash
curl "https://your-api.railway.app/api/ipeds/search?name=campbell&limit=5"
```

**Response:**
```json
{
  "results": [
    {
      "unitid": "198136",
      "name": "Campbell University",
      "city": "Buies Creek",
      "state": "NC",
      "url": "https://www.campbell.edu"
    }
  ]
}
```

### 2. Get Institution Details

```
GET /api/ipeds?unitid={unitid}&year={year}
```

**Example:**
```bash
curl "https://your-api.railway.app/api/ipeds?unitid=198136&year=2023"
```

**Response:**
Full IPEDS data including enrollment, finances, completions, admissions, etc.

### 3. Health Check

```
GET /health
```

Returns server status, uptime, and cache statistics.

### 4. Clear Cache

```
POST /api/clear-cache
```

Clears the file and data cache.

## Deployment on Railway

### Step 1: Push to GitHub

```bash
git init
git add .
git commit -m "IPEDS API with search endpoint"
git remote add origin https://github.com/1979wdr-evident/tpl.git
git branch -M main
git push -u origin main
```

### Step 2: Connect Railway

1. Go to Railway Dashboard
2. Select your project
3. Settings → Source
4. Connect to GitHub: `1979wdr-evident/tpl`

### Step 3: Enable Public Networking

1. Settings → Networking
2. Generate Domain / Enable Public
3. Copy domain (e.g., `tpl-production.up.railway.app`)

### Step 4: Update Frontend

Edit `src/config/api.js`:
```javascript
IPEDS_API_BASE: 'https://YOUR-DOMAIN.up.railway.app/api'
```

## Local Development

```bash
npm install
npm start
```

Server runs on http://localhost:3000

## Available Years

- 2023 (default)
- 2022
- 2021
- 2020

## Data Sources

- **Search**: College Scorecard API
- **Details**: IPEDS Data Center (NCES) - downloads and parses actual data files

## Performance

- First request: ~2-5 seconds (downloads and parses data files)
- Cached requests: ~10-50ms
- File cache persists across requests
- Data cache persists per institution/year

# Financial MCP Server

Connects Claude to **FRED** (Federal Reserve Economic Data) and **Polygon.io** (stock & index prices) via the Model Context Protocol.

---

## 🛠️ Tools Available

### FRED (Economic Data)
| Tool | What it does |
|---|---|
| `fred_get_series` | Fetch time-series data (GDP, inflation, unemployment, etc.) |
| `fred_search_series` | Search for any economic indicator by keyword |
| `fred_get_series_info` | Get metadata for a FRED series |
| `fred_get_release` | List all series in a data release |

### Polygon.io (Market Data)
| Tool | What it does |
|---|---|
| `polygon_stock_price` | End-of-day OHLCV history for any stock |
| `polygon_ticker_details` | Company info: market cap, sector, description |
| `polygon_index_price` | Historical prices for SPX, NDX, DJI, RUT, VIX |
| `polygon_search_tickers` | Search tickers by company name |
| `polygon_dividends` | Dividend history for any stock |

---

## 🚀 Deploy to Railway (Recommended)

### Step 1 — Push to GitHub
1. Create a new repo at [github.com/new](https://github.com/new) named `financial-mcp`
2. In your terminal (in this folder):
```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/financial-mcp.git
git push -u origin main
```

### Step 2 — Deploy on Railway
1. Go to [railway.app](https://railway.app) and sign in with GitHub
2. Click **New Project → Deploy from GitHub repo**
3. Select your `financial-mcp` repo
4. Railway will auto-detect Node.js and start building

### Step 3 — Add Environment Variables
In your Railway project dashboard:
1. Click your service → **Variables** tab
2. Add these two variables:
   - `FRED_API_KEY` = your FRED key
   - `POLYGON_API_KEY` = your Polygon.io key
3. Railway will redeploy automatically

### Step 4 — Get Your URL
1. Click **Settings → Networking → Generate Domain**
2. Your server URL will be something like: `https://financial-mcp-production.up.railway.app`

### Step 5 — Connect to Claude
1. Go to [claude.ai](https://claude.ai) → Settings → Connectors
2. Click **Add Connector → Custom MCP**
3. Enter your Railway URL + `/mcp`:
   ```
   https://financial-mcp-production.up.railway.app/mcp
   ```
4. Save — Claude can now use all 9 financial tools!

---

## 💻 Run Locally (Optional)

```bash
npm install
node index.js
# Server runs at http://localhost:3000
```

Test health: `curl http://localhost:3000/health`

---

## 📊 Example Queries for Claude

Once connected, you can ask Claude things like:
- *"Show me US GDP growth over the last 5 years"*
- *"What's the current inflation rate trend? Use FRED."*
- *"Get me AAPL stock prices for Q1 2024"*
- *"Compare S&P 500 performance in 2023 vs 2024"*
- *"What were Apple's dividends in the last 2 years?"*
- *"Search FRED for housing market indicators"*

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import express from "express";
import fetch from "node-fetch";

const FRED_API_KEY = process.env.FRED_API_KEY;
const POLYGON_API_KEY = process.env.POLYGON_API_KEY;

const app = express();
app.use(express.json());

// ── Helpers ──────────────────────────────────────────────────────────────────

async function fredGet(endpoint, params = {}) {
  const url = new URL(`https://api.stlouisfed.org/fred/${endpoint}`);
  url.searchParams.set("api_key", FRED_API_KEY);
  url.searchParams.set("file_type", "json");
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") url.searchParams.set(k, v);
  }
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`FRED error ${res.status}: ${await res.text()}`);
  return res.json();
}

async function polygonGet(path, params = {}) {
  const url = new URL(`https://api.polygon.io${path}`);
  url.searchParams.set("apiKey", POLYGON_API_KEY);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") url.searchParams.set(k, v);
  }
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Polygon error ${res.status}: ${await res.text()}`);
  return res.json();
}

function formatFredObservations(data) {
  if (!data.observations) return JSON.stringify(data);
  return data.observations
    .filter((o) => o.value !== ".")
    .map((o) => `${o.date}: ${o.value}`)
    .join("\n");
}

// ── MCP Server ────────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "financial-data",
  version: "1.0.0",
});

// ── FRED Tools ────────────────────────────────────────────────────────────────

server.tool(
  "fred_get_series",
  "Fetch time-series observations from FRED (e.g. GDP, UNRATE, CPIAUCSL, FEDFUNDS)",
  {
    series_id: z.string().describe("FRED series ID, e.g. GDP, UNRATE, CPIAUCSL"),
    start_date: z.string().optional().describe("Start date YYYY-MM-DD"),
    end_date: z.string().optional().describe("End date YYYY-MM-DD"),
    frequency: z
      .enum(["d", "w", "bw", "m", "q", "sa", "a"])
      .optional()
      .describe("Frequency: d=daily, w=weekly, m=monthly, q=quarterly, a=annual"),
    units: z
      .enum(["lin", "chg", "ch1", "pch", "pc1", "pca", "cch", "cca", "log"])
      .optional()
      .describe("Units: lin=levels, pch=% change, pc1=% change from year ago"),
    limit: z.number().optional().describe("Max observations to return (default 100)"),
  },
  async ({ series_id, start_date, end_date, frequency, units, limit }) => {
    const data = await fredGet("series/observations", {
      series_id,
      observation_start: start_date,
      observation_end: end_date,
      frequency,
      units,
      limit: limit ?? 100,
      sort_order: "desc",
    });
    return {
      content: [
        {
          type: "text",
          text: `FRED Series: ${series_id}\n${"─".repeat(40)}\n${formatFredObservations(data)}`,
        },
      ],
    };
  }
);

server.tool(
  "fred_search_series",
  "Search FRED for economic data series by keyword",
  {
    query: z.string().describe("Search terms, e.g. 'consumer price index', 'unemployment'"),
    limit: z.number().optional().describe("Number of results (default 10)"),
  },
  async ({ query, limit }) => {
    const data = await fredGet("series/search", {
      search_text: query,
      limit: limit ?? 10,
      order_by: "popularity",
      sort_order: "desc",
    });
    if (!data.seriess?.length) return { content: [{ type: "text", text: "No series found." }] };
    const rows = data.seriess
      .map((s) => `• ${s.id.padEnd(20)} ${s.title} (${s.frequency_short}, last: ${s.last_updated?.slice(0, 10)})`)
      .join("\n");
    return { content: [{ type: "text", text: `Search results for "${query}":\n${"─".repeat(50)}\n${rows}` }] };
  }
);

server.tool(
  "fred_get_series_info",
  "Get metadata/details about a specific FRED series",
  {
    series_id: z.string().describe("FRED series ID"),
  },
  async ({ series_id }) => {
    const data = await fredGet("series", { series_id });
    const s = data.seriess?.[0];
    if (!s) return { content: [{ type: "text", text: "Series not found." }] };
    const info = [
      `ID:           ${s.id}`,
      `Title:        ${s.title}`,
      `Frequency:    ${s.frequency}`,
      `Units:        ${s.units}`,
      `Seasonal Adj: ${s.seasonal_adjustment}`,
      `Last Updated: ${s.last_updated}`,
      `Start:        ${s.observation_start}`,
      `End:          ${s.observation_end}`,
      `Notes:        ${s.notes ?? "—"}`,
    ].join("\n");
    return { content: [{ type: "text", text: info }] };
  }
);

server.tool(
  "fred_get_release",
  "List all data series in a FRED release (e.g. BLS Employment, BEA GDP)",
  {
    release_id: z.number().describe("FRED release ID (e.g. 53 = GDP, 10 = Employment Situation)"),
    limit: z.number().optional().describe("Number of series to return (default 20)"),
  },
  async ({ release_id, limit }) => {
    const data = await fredGet("release/series", { release_id, limit: limit ?? 20 });
    if (!data.seriess?.length) return { content: [{ type: "text", text: "No series found for this release." }] };
    const rows = data.seriess.map((s) => `• ${s.id.padEnd(20)} ${s.title}`).join("\n");
    return { content: [{ type: "text", text: `Release ${release_id} series:\n${"─".repeat(50)}\n${rows}` }] };
  }
);

// ── Polygon Tools ─────────────────────────────────────────────────────────────

server.tool(
  "polygon_stock_price",
  "Get end-of-day historical stock prices for a ticker",
  {
    ticker: z.string().describe("Stock ticker symbol, e.g. AAPL, MSFT, GOOGL"),
    from: z.string().describe("Start date YYYY-MM-DD"),
    to: z.string().describe("End date YYYY-MM-DD"),
    limit: z.number().optional().describe("Max results (default 50)"),
  },
  async ({ ticker, from, to, limit }) => {
    const data = await polygonGet(`/v2/aggs/ticker/${ticker.toUpperCase()}/range/1/day/${from}/${to}`, {
      adjusted: "true",
      sort: "desc",
      limit: limit ?? 50,
    });
    if (!data.results?.length)
      return { content: [{ type: "text", text: `No data found for ${ticker} in that date range.` }] };
    const rows = data.results
      .map(
        (r) =>
          `${new Date(r.t).toISOString().slice(0, 10)}  O:${r.o.toFixed(2)}  H:${r.h.toFixed(2)}  L:${r.l.toFixed(
            2
          )}  C:${r.c.toFixed(2)}  V:${r.v.toLocaleString()}`
      )
      .join("\n");
    return {
      content: [
        {
          type: "text",
          text: `${ticker.toUpperCase()} Daily OHLCV (${from} → ${to})\n${"─".repeat(60)}\nDate        Open    High    Low     Close   Volume\n${rows}`,
        },
      ],
    };
  }
);

server.tool(
  "polygon_ticker_details",
  "Get company/ticker details: name, sector, market cap, description, exchange",
  {
    ticker: z.string().describe("Stock ticker symbol, e.g. AAPL"),
  },
  async ({ ticker }) => {
    const data = await polygonGet(`/v3/reference/tickers/${ticker.toUpperCase()}`);
    const r = data.results;
    if (!r) return { content: [{ type: "text", text: "Ticker not found." }] };
    const info = [
      `Name:         ${r.name}`,
      `Ticker:       ${r.ticker}`,
      `Exchange:     ${r.primary_exchange}`,
      `Type:         ${r.type}`,
      `Market Cap:   ${r.market_cap ? "$" + Number(r.market_cap).toLocaleString() : "N/A"}`,
      `Sector:       ${r.sic_description ?? "N/A"}`,
      `Employees:    ${r.total_employees?.toLocaleString() ?? "N/A"}`,
      `Website:      ${r.homepage_url ?? "N/A"}`,
      `Description:  ${r.description?.slice(0, 300) ?? "N/A"}`,
    ].join("\n");
    return { content: [{ type: "text", text: info }] };
  }
);

server.tool(
  "polygon_index_price",
  "Get historical end-of-day prices for a major index (e.g. SPX, NDX, DJI)",
  {
    index: z
      .enum(["SPX", "NDX", "DJI", "RUT", "VIX"])
      .describe("Index: SPX=S&P500, NDX=Nasdaq100, DJI=Dow Jones, RUT=Russell2000, VIX=Volatility"),
    from: z.string().describe("Start date YYYY-MM-DD"),
    to: z.string().describe("End date YYYY-MM-DD"),
    limit: z.number().optional().describe("Max results (default 50)"),
  },
  async ({ index, from, to, limit }) => {
    const data = await polygonGet(`/v2/aggs/ticker/I:${index}/range/1/day/${from}/${to}`, {
      adjusted: "true",
      sort: "desc",
      limit: limit ?? 50,
    });
    if (!data.results?.length)
      return { content: [{ type: "text", text: `No index data found for ${index}.` }] };
    const rows = data.results
      .map(
        (r) =>
          `${new Date(r.t).toISOString().slice(0, 10)}  O:${r.o.toFixed(2)}  H:${r.h.toFixed(2)}  L:${r.l.toFixed(
            2
          )}  C:${r.c.toFixed(2)}`
      )
      .join("\n");
    return {
      content: [
        {
          type: "text",
          text: `${index} Index Daily (${from} → ${to})\n${"─".repeat(55)}\nDate        Open      High      Low       Close\n${rows}`,
        },
      ],
    };
  }
);

server.tool(
  "polygon_search_tickers",
  "Search for stock tickers by company name or keyword",
  {
    query: z.string().describe("Company name or keyword, e.g. 'Apple', 'electric vehicles'"),
    limit: z.number().optional().describe("Number of results (default 10)"),
  },
  async ({ query, limit }) => {
    const data = await polygonGet("/v3/reference/tickers", {
      search: query,
      active: "true",
      limit: limit ?? 10,
    });
    if (!data.results?.length) return { content: [{ type: "text", text: "No tickers found." }] };
    const rows = data.results
      .map((r) => `• ${r.ticker.padEnd(8)} ${r.name} (${r.primary_exchange}, ${r.type})`)
      .join("\n");
    return { content: [{ type: "text", text: `Ticker search: "${query}"\n${"─".repeat(50)}\n${rows}` }] };
  }
);

server.tool(
  "polygon_dividends",
  "Get dividend history for a stock ticker",
  {
    ticker: z.string().describe("Stock ticker symbol, e.g. AAPL"),
    limit: z.number().optional().describe("Number of results (default 20)"),
  },
  async ({ ticker, limit }) => {
    const data = await polygonGet("/v3/reference/dividends", {
      ticker: ticker.toUpperCase(),
      limit: limit ?? 20,
      order: "desc",
    });
    if (!data.results?.length) return { content: [{ type: "text", text: `No dividend data for ${ticker}.` }] };
    const rows = data.results
      .map(
        (r) =>
          `${r.ex_dividend_date}  $${r.cash_amount?.toFixed(4)}  (${r.frequency === 4 ? "quarterly" : r.frequency === 12 ? "monthly" : r.frequency === 1 ? "annual" : r.frequency})`
      )
      .join("\n");
    return {
      content: [
        { type: "text", text: `${ticker.toUpperCase()} Dividend History\n${"─".repeat(45)}\nEx-Date      Amount     Frequency\n${rows}` },
      ],
    };
  }
);

// ── HTTP Transport ────────────────────────────────────────────────────────────

app.post("/mcp", async (req, res) => {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => transport.close());
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.get("/mcp", async (req, res) => {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => transport.close());
  await server.connect(transport);
  await transport.handleRequest(req, res);
});

app.delete("/mcp", async (req, res) => {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => transport.close());
  await server.connect(transport);
  await transport.handleRequest(req, res);
});

app.get("/health", (_req, res) => res.json({ status: "ok", server: "financial-mcp", version: "1.0.0" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Financial MCP server running on port ${PORT}`));

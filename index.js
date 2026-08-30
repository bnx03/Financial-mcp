import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import express from "express";
import fetch from "node-fetch";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FRED_API_KEY = process.env.FRED_API_KEY;
const POLYGON_API_KEY = process.env.POLYGON_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const app = express();
app.use(express.json({ limit: "2mb" }));

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

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
  return data.observations.filter(o => o.value !== ".").map(o => `${o.date}: ${o.value}`).join("\n");
}

const server = new McpServer({ name: "financial-data", version: "1.0.0" });

server.tool("fred_get_series", "Fetch time-series observations from FRED", {
  series_id: z.string(),
  start_date: z.string().optional(),
  end_date: z.string().optional(),
  frequency: z.enum(["d","w","bw","m","q","sa","a"]).optional(),
  units: z.enum(["lin","chg","ch1","pch","pc1","pca","cch","cca","log"]).optional(),
  limit: z.number().optional(),
}, async ({ series_id, start_date, end_date, frequency, units, limit }) => {
  const data = await fredGet("series/observations", { series_id, observation_start: start_date, observation_end: end_date, frequency, units, limit: limit ?? 100, sort_order: "desc" });
  return { content: [{ type: "text", text: `FRED Series: ${series_id}\n${formatFredObservations(data)}` }] };
});

server.tool("fred_search_series", "Search FRED for economic data series by keyword", {
  query: z.string(),
  limit: z.number().optional(),
}, async ({ query, limit }) => {
  const data = await fredGet("series/search", { search_text: query, limit: limit ?? 10, order_by: "popularity", sort_order: "desc" });
  if (!data.seriess?.length) return { content: [{ type: "text", text: "No series found." }] };
  const rows = data.seriess.map(s => `• ${s.id.padEnd(20)} ${s.title} (${s.frequency_short})`).join("\n");
  return { content: [{ type: "text", text: `Results for "${query}":\n${rows}` }] };
});

server.tool("fred_get_series_info", "Get metadata about a specific FRED series", {
  series_id: z.string(),
}, async ({ series_id }) => {
  const data = await fredGet("series", { series_id });
  const s = data.seriess?.[0];
  if (!s) return { content: [{ type: "text", text: "Series not found." }] };
  return { content: [{ type: "text", text: `ID: ${s.id}\nTitle: ${s.title}\nFrequency: ${s.frequency}\nUnits: ${s.units}\nLast Updated: ${s.last_updated}\nStart: ${s.observation_start}\nEnd: ${s.observation_end}` }] };
});

server.tool("fred_get_release", "List all data series in a FRED release", {
  release_id: z.number(),
  limit: z.number().optional(),
}, async ({ release_id, limit }) => {
  const data = await fredGet("release/series", { release_id, limit: limit ?? 20 });
  if (!data.seriess?.length) return { content: [{ type: "text", text: "No series found." }] };
  const rows = data.seriess.map(s => `• ${s.id.padEnd(20)} ${s.title}`).join("\n");
  return { content: [{ type: "text", text: `Release ${release_id}:\n${rows}` }] };
});

server.tool("polygon_stock_price", "Get end-of-day historical stock prices for a ticker", {
  ticker: z.string(),
  from: z.string(),
  to: z.string(),
  limit: z.number().optional(),
}, async ({ ticker, from, to, limit }) => {
  const data = await polygonGet(`/v2/aggs/ticker/${ticker.toUpperCase()}/range/1/day/${from}/${to}`, { adjusted: "true", sort: "desc", limit: limit ?? 50 });
  if (!data.results?.length) return { content: [{ type: "text", text: `No data found for ${ticker}.` }] };
  const rows = data.results.map(r => `${new Date(r.t).toISOString().slice(0,10)}  O:${r.o.toFixed(2)}  H:${r.h.toFixed(2)}  L:${r.l.toFixed(2)}  C:${r.c.toFixed(2)}  V:${r.v.toLocaleString()}`).join("\n");
  return { content: [{ type: "text", text: `${ticker.toUpperCase()} Daily OHLCV (${from} to ${to})\n${rows}` }] };
});

server.tool("polygon_ticker_details", "Get company/ticker details", {
  ticker: z.string(),
}, async ({ ticker }) => {
  const data = await polygonGet(`/v3/reference/tickers/${ticker.toUpperCase()}`);
  const r = data.results;
  if (!r) return { content: [{ type: "text", text: "Ticker not found." }] };
  return { content: [{ type: "text", text: `Name: ${r.name}\nTicker: ${r.ticker}\nExchange: ${r.primary_exchange}\nMarket Cap: ${r.market_cap ? "$" + Number(r.market_cap).toLocaleString() : "N/A"}\nSector: ${r.sic_description ?? "N/A"}\nWebsite: ${r.homepage_url ?? "N/A"}` }] };
});

server.tool("polygon_index_price", "Get historical end-of-day prices for a major index", {
  index: z.enum(["SPX","NDX","DJI","RUT","VIX"]),
  from: z.string(),
  to: z.string(),
  limit: z.number().optional(),
}, async ({ index, from, to, limit }) => {
  const data = await polygonGet(`/v2/aggs/ticker/I:${index}/range/1/day/${from}/${to}`, { adjusted: "true", sort: "desc", limit: limit ?? 50 });
  if (!data.results?.length) return { content: [{ type: "text", text: `No index data found for ${index}.` }] };
  const rows = data.results.map(r => `${new Date(r.t).toISOString().slice(0,10)}  O:${r.o.toFixed(2)}  H:${r.h.toFixed(2)}  L:${r.l.toFixed(2)}  C:${r.c.toFixed(2)}`).join("\n");
  return { content: [{ type: "text", text: `${index} Index (${from} to ${to})\n${rows}` }] };
});

server.tool("polygon_search_tickers", "Search for stock tickers by company name", {
  query: z.string(),
  limit: z.number().optional(),
}, async ({ query, limit }) => {
  const data = await polygonGet("/v3/reference/tickers", { search: query, active: "true", limit: limit ?? 10 });
  if (!data.results?.length) return { content: [{ type: "text", text: "No tickers found." }] };
  const rows = data.results.map(r => `• ${r.ticker.padEnd(8)} ${r.name} (${r.primary_exchange})`).join("\n");
  return { content: [{ type: "text", text: `Ticker search: "${query}"\n${rows}` }] };
});

server.tool("polygon_dividends", "Get dividend history for a stock ticker", {
  ticker: z.string(),
  limit: z.number().optional(),
}, async ({ ticker, limit }) => {
  const data = await polygonGet("/v3/reference/dividends", { ticker: ticker.toUpperCase(), limit: limit ?? 20, order: "desc" });
  if (!data.results?.length) return { content: [{ type: "text", text: `No dividend data for ${ticker}.` }] };
  const rows = data.results.map(r => `${r.ex_dividend_date}  $${r.cash_amount?.toFixed(4)}`).join("\n");
  return { content: [{ type: "text", text: `${ticker.toUpperCase()} Dividends:\n${rows}` }] };
});

app.post("/chat", async (req, res) => {
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured." });
  try {
    const payload = {
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1000,
      ...req.body,
      mcp_servers: [
        { type: "url", url: "https://financial-mcp-9mgo.onrender.com/mcp", name: "financial-data" },
        { type: "url", url: "https://kfinance.kensho.com/integrations/mcp", name: "spglobal" },
      ],
    };
    console.log("[/chat] model:", payload.model, "msgs:", payload.messages?.length);
    const upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "mcp-client-2025-04-04",
      },
      body: JSON.stringify(payload),
    });
    const data = await upstream.json();
    if (!upstream.ok) console.error("[/chat] error:", upstream.status, JSON.stringify(data).slice(0, 300));
    res.status(upstream.status).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/test", async (_req, res) => {
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: "ANTHROPIC_API_KEY not set" });
  try {
    const upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 50, messages: [{ role: "user", content: "Say: ok" }] }),
    });
    const data = await upstream.json();
    res.status(upstream.status).json({ status: upstream.status, data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/dashboard", (_req, res) => {
  res.sendFile(join(__dirname, "dashboard.html"));
});

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

app.get("/health", (_req, res) => {
  res.json({ status: "ok", server: "financial-mcp", version: "3.2.0", endpoints: ["/mcp", "/chat", "/dashboard", "/test", "/health"] });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Financial MCP server running on port ${PORT}`));

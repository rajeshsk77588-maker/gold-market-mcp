import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const app = express();
app.use(express.json());

const server = new McpServer({
  name: "gold-market-mcp",
  version: "1.0.0"
});

server.tool(
  "get_gold_candles",
  "Get XAU/USD Gold OHLC candles for 1min, 5min, or 15min",
  {
    interval: z.enum(["1min", "5min", "15min"]),
    outputsize: z.number().int().min(1).max(100).default(20)
  },
  async ({ interval, outputsize }) => {
    const apiKey = process.env.TWELVE_DATA_API_KEY;

    if (!apiKey) {
      throw new Error("Twelve Data API key is not configured");
    }

    const url = new URL("https://api.twelvedata.com/time_series");
    url.searchParams.set("symbol", "XAU/USD");
    url.searchParams.set("interval", interval);
    url.searchParams.set("outputsize", String(outputsize));
    url.searchParams.set("apikey", apiKey);

    const response = await fetch(url);
    const data = await response.json();

    if (!response.ok || data.status === "error") {
      return {
        isError: true,
        content: [{
          type: "text",
          text: JSON.stringify(data)
        }]
      };
    }

    return {
      content: [{
        type: "text",
        text: JSON.stringify(data)
      }]
    };
  }
);

app.get("/", (_req, res) => {
  res.send("Gold Market MCP Server is running");
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.post("/mcp", async (req, res) => {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined
  });

  res.on("close", () => {
    transport.close();
    server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error(error);
    if (!res.headersSent) {
      res.status(500).json({ error: "MCP request failed" });
    }
  }
});

const port = process.env.PORT || 10000;
app.listen(port, "0.0.0.0", () => {
  console.log(`Gold MCP server listening on ${port}`);
});

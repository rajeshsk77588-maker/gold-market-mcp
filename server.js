import express from "express";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const app = express();

app.use(express.json({
  limit: "1mb"
}));

function createMcpServer() {
  const server = new McpServer({
    name: "gold-market-mcp",
    version: "1.1.0"
  });

  server.tool(
    "get_gold_candles",
    "Fetch real XAU/USD Gold OHLC candle data from Twelve Data.",
    {
      interval: z.enum(["1min", "5min", "15min"]),
      outputsize: z.number()
        .int()
        .min(1)
        .max(100)
        .default(20)
    },
    async ({ interval, outputsize }) => {
      const apiKey = process.env.TWELVE_DATA_API_KEY;

      if (!apiKey) {
        return {
          isError: true,
          content: [{
            type: "text",
            text: "Missing TWELVE_DATA_API_KEY environment variable."
          }]
        };
      }

      try {
        const url = new URL(
          "https://api.twelvedata.com/time_series"
        );

        url.searchParams.set("symbol", "XAU/USD");
        url.searchParams.set("interval", interval);
        url.searchParams.set(
          "outputsize",
          String(outputsize)
        );
        url.searchParams.set("apikey", apiKey);

        const response = await fetch(url, {
          signal: AbortSignal.timeout(20000)
        });

        const data = await response.json();

        if (
          !response.ok ||
          data.status === "error" ||
          !Array.isArray(data.values)
        ) {
          return {
            isError: true,
            content: [{
              type: "text",
              text: JSON.stringify({
                error: "Twelve Data did not return valid candle data.",
                httpStatus: response.status,
                details: data
              })
            }]
          };
        }

        const candles = data.values.map((candle) => ({
          datetime: candle.datetime,
          open: candle.open,
          high: candle.high,
          low: candle.low,
          close: candle.close
        }));

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              source: "Twelve Data",
              symbol: "XAU/USD",
              interval,
              requestedCandles: outputsize,
              returnedCandles: candles.length,
              meta: data.meta,
              candles
            })
          }]
        };
      } catch (error) {
        return {
          isError: true,
          content: [{
            type: "text",
            text: `Market data request failed: ${error.message}`
          }]
        };
      }
    }
  );

  return server;
}

app.get("/", (_req, res) => {
  res.json({
    service: "Gold Market MCP",
    status: "running"
  });
});

app.get("/health", (_req, res) => {
  res.json({
    status: "ok"
  });
});

// This server uses POST for MCP requests.
// SSE streaming through GET is not implemented.
app.get("/mcp", (_req, res) => {
  res.status(405).json({
    error: "Use an MCP client to send POST requests to /mcp."
  });
});

app.post("/mcp", async (req, res) => {
  const server = createMcpServer();

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true
  });

  res.on("close", () => {
    void transport.close();
    void server.close();
  });

  try {
    await server.connect(transport);

    await transport.handleRequest(
      req,
      res,
      req.body
    );
  } catch (error) {
    console.error("MCP request error:", error);

    if (!res.headersSent) {
      res.status(500).json({
        error: "MCP request failed"
      });
    }
  }
});

const port = process.env.PORT || 10000;

app.listen(port, "0.0.0.0", () => {
  console.log(
    `Gold Market MCP listening on port ${port}`
  );
});

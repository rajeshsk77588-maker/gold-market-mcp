import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const app = express();

app.use(express.json({
  limit: "1mb"
}));

const PORT = Number(process.env.PORT) || 10000;

const VALID_INTERVALS = ["1min", "5min", "15min"];

const INTERVAL_MS = {
  "1min": 60_000,
  "5min": 300_000,
  "15min": 900_000
};

const ALLOWED_ORIGINS = new Set([
  "Twelve Data"
]);

function createMcpServer() {
  const server = new McpServer({
    name: "gold-market-mcp",
    version: "1.2.0"
  });

  server.tool(
    "get_gold_candles",
    "Fetch and validate XAU/USD Gold OHLC candles from Twelve Data.",
    {
      interval: z.enum(VALID_INTERVALS),
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
        url.searchParams.set("outputsize", String(outputsize));
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
                error: "Twelve Data API returned an invalid response.",
                httpStatus: response.status,
                details: data
              })
            }]
          };
        }

        const seenTimestamps = new Set();
        const candles = [];
        const validationWarnings = [];

        for (const candle of data.values) {
          const timestamp = Date.parse(candle.datetime);

          if (
            !candle.datetime ||
            !Number.isFinite(timestamp)
          ) {
            validationWarnings.push(
              "A candle has a missing or invalid timestamp."
            );
            continue;
          }

          if (seenTimestamps.has(candle.datetime)) {
            validationWarnings.push(
              `Duplicate timestamp detected: ${candle.datetime}`
            );
            continue;
          }

          seenTimestamps.add(candle.datetime);

          const open = Number(candle.open);
          const high = Number(candle.high);
          const low = Number(candle.low);
          const close = Number(candle.close);

          if (
            ![open, high, low, close].every(Number.isFinite)
          ) {
            validationWarnings.push(
              `Invalid OHLC values at ${candle.datetime}`
            );
            continue;
          }

          if (
            high < low ||
            high < Math.max(open, close) ||
            low > Math.min(open, close)
          ) {
            validationWarnings.push(
              `Inconsistent OHLC values at ${candle.datetime}`
            );
            continue;
          }

          candles.push({
            datetime: candle.datetime,
            open,
            high,
            low,
            close
          });
        }

        // Sort from oldest to newest.
        candles.sort(
          (a, b) =>
            Date.parse(a.datetime) - Date.parse(b.datetime)
        );

        // Check candle spacing. Gaps can occur during market closures,
        // weekends, holidays or when the provider omits observations.
        for (let i = 1; i < candles.length; i++) {
          const previous = Date.parse(candles[i - 1].datetime);
          const current = Date.parse(candles[i].datetime);

          if (current <= previous) {
            validationWarnings.push(
              "Timestamps are not strictly increasing."
            );
          } else if (
            current - previous > INTERVAL_MS[interval]
          ) {
            validationWarnings.push(
              `A timestamp gap exists between ${candles[i - 1].datetime} and ${candles[i].datetime}.`
            );
          }
        }

        const latestCandle = candles.length
          ? candles[candles.length - 1]
          : null;

        const latestTimestamp = latestCandle
          ? Date.parse(latestCandle.datetime)
          : null;

        // A timestamp alone cannot prove that a candle is closed.
        // This is only a preliminary age check, not confirmation.
        const now = Date.now();

        const latestCandleAgeMs =
          latestTimestamp === null
            ? null
            : now - latestTimestamp;

        const latestCandleStatus =
          latestTimestamp === null
            ? "unknown"
            : latestCandleAgeMs < INTERVAL_MS[interval]
              ? "possibly_forming"
              : "closure_not_confirmed";

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              source: "Twelve Data",
              symbol: data.meta?.symbol ?? "XAU/USD",
              interval: data.meta?.interval ?? interval,
              requestedCandles: outputsize,
              receivedCandles: Array.isArray(data.values)
                ? data.values.length
                : 0,
              validCandles: candles.length,
              invalidOrDuplicateCandles:
                (Array.isArray(data.values)
                  ? data.values.length
                  : 0) - candles.length,
              timestampOrder: "oldest_to_newest",
              meta: data.meta ?? null,
              validation: {
                passed: validationWarnings.length === 0,
                warnings: [...new Set(validationWarnings)]
              },
              latestCandle: {
                datetime: latestCandle?.datetime ?? null,
                ageMs: latestCandleAgeMs,
                status: latestCandleStatus,
                closureConfirmed: false
              },
              candles
            }, null, 2)
          }]
        };
      } catch (error) {
        return {
          isError: true,
          content: [{
            type: "text",
            text: JSON.stringify({
              error: "Market data request failed.",
              message: error.message
            })
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
    status: "running",
    version: "1.2.0"
  });
});

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "gold-market-mcp"
  });
});

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

  let closed = false;

  const cleanup = async () => {
    if (closed) return;
    closed = true;

    try {
      await transport.close();
    } catch (error) {
      console.error("Transport cleanup error:", error.message);
    }

    try {
      await server.close();
    } catch (error) {
      console.error("Server cleanup error:", error.message);
    }
  };

  res.on("close", () => {
    void cleanup();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("MCP request error:", error);

    if (!res.headersSent) {
      res.status(500).json({
        error: "MCP request failed."
      });
    }
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `Gold Market MCP listening on port ${PORT}`
  );
});

import "dotenv/config";
import express from "express";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { extractProductQuery } from "./src/gemini.js";
import {
  searchFairPrice,
  closeBrowser,
  FairPriceUnavailableError,
} from "./src/fairprice.js";

if (
  !process.env.GEMINI_API_KEY ||
  process.env.GEMINI_API_KEY === "replace_with_your_gemini_api_key"
) {
  throw new Error("Set GEMINI_API_KEY in your .env file before starting.");
}

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "127.0.0.1";

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be an integer between 1 and 65535.");
}

const directory = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.disable("x-powered-by");
app.use(helmet());
app.use(express.json({ limit: "4kb" }));

app.use(
  "/api",
  rateLimit({
    windowMs: 60_000,
    limit: 15,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: {
      error: "Too many requests. Please wait a minute and try again.",
    },
  }),
);

app.use(express.static(path.join(directory, "public")));

let busy = false;

app.post("/api/chat", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");

  const message = req.body?.message;

  if (
    typeof message !== "string" ||
    !message.trim() ||
    message.length > 500
  ) {
    return res.status(400).json({
      error: "Please enter a question between 1 and 500 characters.",
    });
  }

  // Keep this small local version from launching too many browser tasks.
  if (busy) {
    return res.status(429).json({
      error: "Another search is running. Please try again shortly.",
    });
  }

  busy = true;

  try {
    const intent = await extractProductQuery(message.trim());

    if (!intent.supported) {
      return res.json({
        answer:
          "Ask me for the FairPrice price of one grocery product, for example: “What is the price of strawberries?”",
        products: [],
      });
    }

    const result = await searchFairPrice(intent.query);

    if (!result.products.length) {
      return res.json({
        answer:
          `I could not verify a current FairPrice price for "${intent.query}". ` +
          "There may be no matching product, or the website may not expose readable price data. I will not guess.",
        products: [],
        searchUrl: result.searchUrl,
      });
    }

    return res.json({
      answer:
        `Here are FairPrice search matches for "${intent.query}" with prices read from their product pages. ` +
        "Check the product name and pack size before comparing.",
      products: result.products,
      searchUrl: result.searchUrl,
      cached: result.cached,
      note:
        "Prices are in SGD. Delivery location, promotions, membership, and availability may affect the final checkout price. Results may be cached for up to two minutes.",
    });
  } catch (error) {
    console.error(`${error.name}: ${error.message}`);

    if (error instanceof FairPriceUnavailableError) {
      return res.status(503).json({ error: error.message });
    }

    return res.status(502).json({
      error:
        "The price lookup failed. Check the server terminal, your Gemini API configuration, and your internet connection, then try again.",
    });
  } finally {
    busy = false;
  }
});

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);

  if (error.type === "entity.too.large") {
    return res.status(413).json({ error: "The request is too large." });
  }

  if (error.type === "entity.parse.failed") {
    return res.status(400).json({ error: "Invalid JSON request." });
  }

  console.error(error);
  return res.status(500).json({ error: "An unexpected server error occurred." });
});

const server = app.listen(port, host, () => {
  console.log(`FairPrice chatbot: http://${host}:${port}`);
});

let shuttingDown = false;

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;

  const timer = setTimeout(() => process.exit(1), 10_000);
  timer.unref();

  server.close(async () => {
    await closeBrowser().catch(console.error);
    clearTimeout(timer);
    process.exit(0);
  });

  server.closeIdleConnections();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
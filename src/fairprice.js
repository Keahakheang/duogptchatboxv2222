import { chromium } from "playwright";

const ORIGIN = "https://www.fairprice.com.sg";
const MAX_PRODUCTS = 3;
const CACHE_TTL_MS = 120_000;
const MAX_CACHE_ENTRIES = 100;

const cache = new Map();

let browserPromise;

export class FairPriceUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = "FairPriceUnavailableError";
  }
}

function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium
      .launch({ headless: true })
      .then((browser) => {
        browser.on("disconnected", () => {
          browserPromise = undefined;
        });

        return browser;
      })
      .catch((error) => {
        browserPromise = undefined;
        throw error;
      });
  }

  return browserPromise;
}

export async function closeBrowser() {
  const pending = browserPromise;
  browserPromise = undefined;

  if (pending) {
    const browser = await pending.catch(() => null);
    await browser?.close();
  }
}

function isProductUrl(value) {
  try {
    const url = new URL(value);

    return (
      url.origin === ORIGIN &&
      url.pathname.startsWith("/product/") &&
      url.pathname.length > "/product/".length
    );
  } catch {
    return false;
  }
}

function flattenStructuredData(value, output = []) {
  if (Array.isArray(value)) {
    for (const item of value) {
      flattenStructuredData(item, output);
    }
  } else if (value && typeof value === "object") {
    output.push(value);

    for (const child of Object.values(value)) {
      if (child && typeof child === "object") {
        flattenStructuredData(child, output);
      }
    }
  }

  return output;
}

function isSchemaType(value, expected) {
  const types = Array.isArray(value) ? value : [value];

  return types.some(
    (type) =>
      type === expected ||
      type === `https://schema.org/${expected}` ||
      type === `http://schema.org/${expected}`,
  );
}

function parsePrice(value) {
  if (typeof value !== "string" && typeof value !== "number") {
    return null;
  }

  const text = String(value).trim();

  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) {
    return null;
  }

  const price = Number(text);

  return Number.isFinite(price) && price >= 0 ? price : null;
}

function normalizeAvailability(value) {
  if (typeof value !== "string") {
    return "unknown";
  }

  const status = value.split(/[\/#]/).pop();

  if (status === "InStock") return "in_stock";
  if (status === "OutOfStock") return "out_of_stock";
  if (status === "PreOrder") return "preorder";

  return "unknown";
}

function extractStructuredProduct(rawDocuments, pageUrl) {
  const nodes = [];

  for (const raw of rawDocuments) {
    try {
      flattenStructuredData(JSON.parse(raw), nodes);
    } catch {
      // Ignore malformed JSON-LD, never infer a price from it.
    }
  }

  for (const node of nodes) {
    if (
      !isSchemaType(node["@type"], "Product") ||
      typeof node.name !== "string" ||
      !node.name.trim()
    ) {
      continue;
    }

    // Avoid accidentally using a related product's structured data.
    const declaredUrl =
      typeof node.url === "string"
        ? node.url
        : typeof node["@id"] === "string"
          ? node["@id"]
          : null;

    if (declaredUrl) {
      try {
        const declared = new URL(declaredUrl, pageUrl);
        const current = new URL(pageUrl);

        if (
          declared.origin !== current.origin ||
          declared.pathname.replace(/\/$/, "") !==
            current.pathname.replace(/\/$/, "")
        ) {
          continue;
        }
      } catch {
        continue;
      }
    }

    const offers = Array.isArray(node.offers)
      ? node.offers
      : node.offers
        ? [node.offers]
        : [];

    const validOffers = offers.flatMap((offer) => {
      if (!offer || typeof offer !== "object") return [];

      const price = parsePrice(offer.price);
      const currency = String(offer.priceCurrency || "").toUpperCase();

      if (price === null || currency !== "SGD") return [];

      return [
        {
          price,
          availability: normalizeAvailability(offer.availability),
        },
      ];
    });

    if (!validOffers.length) continue;

    // Different variant/member prices must not be presented as one price.
    const prices = new Set(validOffers.map((offer) => offer.price));

    if (prices.size !== 1) continue;

    const availabilityValues = new Set(
      validOffers.map((offer) => offer.availability),
    );

    return {
      name: node.name.trim(),
      price: validOffers[0].price,
      currency: "SGD",
      availability:
        availabilityValues.size === 1
          ? validOffers[0].availability
          : "unknown",
      url: pageUrl,
      checkedAt: new Date().toISOString(),
    };
  }

  return null;
}

async function openPage(page, url) {
  const response = await page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: 20_000,
  });

  if (!response || response.status() >= 400) {
    throw new FairPriceUnavailableError(
      "FairPrice could not be accessed. It may be temporarily unavailable or blocking automated requests.",
    );
  }

  const title = await page.title();

  if (/captcha|access denied|verify you are human|just a moment/i.test(title)) {
    throw new FairPriceUnavailableError(
      "FairPrice requires an access check. Automated access was stopped.",
    );
  }
}

async function readProduct(context, url) {
  const page = await context.newPage();

  try {
    await openPage(page, url);

    if (!isProductUrl(page.url())) return null;

    await page
      .waitForFunction(
        () =>
          Array.from(
            document.querySelectorAll('script[type="application/ld+json"]'),
          ).some((script) => script.textContent?.includes("Product")),
        { timeout: 8_000 },
      )
      .catch(() => {});

    const documents = await page
      .locator('script[type="application/ld+json"]')
      .allTextContents();

    return extractStructuredProduct(documents, page.url());
  } finally {
    await page.close();
  }
}

export async function searchFairPrice(query) {
  const cacheKey = query.toLowerCase();
  const cached = cache.get(cacheKey);

  if (cached && Date.now() - cached.createdAt < CACHE_TTL_MS) {
    return { ...cached.result, cached: true };
  }

  const browser = await getBrowser();
  const context = await browser.newContext({
    locale: "en-SG",
    viewport: { width: 1440, height: 1000 },
  });

  context.setDefaultTimeout(10_000);

  // Images and fonts are unnecessary for extracting product data.
  await context.route("**/*", async (route) => {
    const type = route.request().resourceType();

    if (["image", "font", "media"].includes(type)) {
      await route.abort();
    } else {
      await route.continue();
    }
  });

  const searchUrl = `${ORIGIN}/search?query=${encodeURIComponent(query)}`;

  try {
    const page = await context.newPage();
    await openPage(page, searchUrl);

    await page
      .locator('a[href*="/product/"]')
      .first()
      .waitFor({ state: "attached", timeout: 12_000 })
      .catch(() => {});

    const links = await page
      .locator('a[href*="/product/"]')
      .evaluateAll((anchors) => anchors.map((anchor) => anchor.href));

    const productUrls = [...new Set(links)]
      .filter(isProductUrl)
      .slice(0, MAX_PRODUCTS);

    const products = [];

    for (const url of productUrls) {
      try {
        const product = await readProduct(context, url);

        if (product) products.push(product);
      } catch (error) {
        if (error instanceof FairPriceUnavailableError) throw error;

        // A failed individual product page does not invalidate other results.
        console.warn("Could not verify a FairPrice product page:", url);
      }
    }

    const result = {
      query,
      searchUrl,
      products,
      cached: false,
    };

    if (products.length) {
      if (cache.size >= MAX_CACHE_ENTRIES) {
        cache.delete(cache.keys().next().value);
      }

      cache.set(cacheKey, {
        createdAt: Date.now(),
        result,
      });
    }

    return result;
  } finally {
    await context.close();
  }
}

import "dotenv/config";

async function main() {
  const apiKey = process.env.GEMINI_API_KEY?.trim();

  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is missing from your .env file.");
  }

  let nextPageToken;

  do {
    const url = new URL(
      "https://generativelanguage.googleapis.com/v1beta/models",
    );

    if (nextPageToken) {
      url.searchParams.set("pageToken", nextPageToken);
    }

    const response = await fetch(url, {
      headers: {
        "x-goog-api-key": apiKey,
      },
      signal: AbortSignal.timeout(20_000),
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(
        `Gemini returned ${response.status}: ${
          data.error?.message || response.statusText
        }`,
      );
    }

    for (const model of data.models ?? []) {
      if (model.supportedGenerationMethods?.includes("generateContent")) {
        console.log(model.name.replace(/^models\//, ""));
      }
    }

    nextPageToken = data.nextPageToken;
  } while (nextPageToken);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});


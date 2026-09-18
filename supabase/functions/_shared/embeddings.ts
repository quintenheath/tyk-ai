// Gemini embeddings - kept separate from ai-router.ts since embeddings are a
// distinct capability (vector generation) rather than a chat completion.
const EMBEDDING_MODEL = "gemini-embedding-001";
const EMBEDDING_DIMENSIONS = 768;

function requireGeminiKey(): string {
  const key = Deno.env.get("GEMINI_API_KEY");
  if (!key) throw new Error("GEMINI_API_KEY is not configured.");
  return key;
}

export async function embedText(text: string): Promise<number[]> {
  const apiKey = requireGeminiKey();

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:embedContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        model: `models/${EMBEDDING_MODEL}`,
        content: { parts: [{ text }] },
        outputDimensionality: EMBEDDING_DIMENSIONS,
      }),
    },
  );

  const data = await response.json();
  if (!response.ok) {
    throw new Error(
      data?.error?.message || `Embedding request failed (${response.status})`,
    );
  }

  const values = data?.embedding?.values;
  if (!Array.isArray(values)) {
    throw new Error("Embedding response was missing values.");
  }
  return values;
}

// Batches multiple texts into as few Gemini requests as possible.
export async function embedTexts(
  texts: string[],
  batchSize = 10,
): Promise<number[][]> {
  const apiKey = requireGeminiKey();
  const results: number[][] = [];

  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:batchEmbedContents`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify({
          requests: batch.map((text) => ({
            model: `models/${EMBEDDING_MODEL}`,
            content: { parts: [{ text }] },
            outputDimensionality: EMBEDDING_DIMENSIONS,
          })),
        }),
      },
    );

    const data = await response.json();
    if (!response.ok) {
      throw new Error(
        data?.error?.message ||
          `Batch embedding request failed (${response.status})`,
      );
    }

    for (const embedding of data.embeddings || []) {
      results.push(embedding.values);
    }
  }

  return results;
}

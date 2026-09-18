// Central AI orchestrator. Providers are interchangeable, replaceable
// infrastructure - never a single point of failure for TYK. This is the
// ONLY place that knows about individual providers; everything else calls
// generateAnswer() and either gets an answer or a clean AiUnavailableError.
import { supabaseAdmin } from "./supabase-admin.ts";

const MAX_ATTEMPTS = 5;
const PAID_PROVIDERS_ALLOWED = Deno.env.get("ALLOW_PAID_PROVIDERS") === "true";

// Thrown only when every available provider/model has been exhausted.
// Callers MUST catch this and produce a clean, generic user-facing message -
// never surface err.message (which is safe/generic) or provider internals.
export class AiUnavailableError extends Error {
  constructor(message = "AI providers are currently unavailable.") {
    super(message);
    this.name = "AiUnavailableError";
  }
}

export interface ImageInput {
  mimeType: string;
  base64: string;
}

// --- Failure classification -------------------------------------------------

const COOLDOWN_MS = {
  quota: 10 * 60 * 1000,
  overload: 60 * 1000,
  timeout: 30 * 1000,
  network: 30 * 1000,
  invalid_key: 24 * 60 * 60 * 1000,
  invalid_model: 5 * 60 * 1000,
  malformed_response: 30 * 1000,
  unknown: 60 * 1000,
};

function classifyFailure(err) {
  const status = err?.status;
  const msg = (err?.message || "").toLowerCase();

  if (
    status === 429 || msg.includes("quota") || msg.includes("rate limit") ||
    msg.includes("resource exhausted")
  ) return "quota";
  if (
    status === 503 || msg.includes("overload") || msg.includes("high demand") ||
    msg.includes("capacity")
  ) return "overload";
  if (msg.includes("timeout") || err?.name === "AbortError") return "timeout";
  if (
    status === 401 || status === 403 || msg.includes("api key") ||
    msg.includes("unauthorized") || msg.includes("invalid_api_key")
  ) return "invalid_key";
  if (
    status === 404 || msg.includes("model not found") ||
    msg.includes("does not exist") || msg.includes("not supported")
  ) return "invalid_model";
  if (
    msg.includes("network") || msg.includes("fetch failed") ||
    msg.includes("econn")
  ) return "network";
  if (msg.includes("json") || msg.includes("parse") || msg.includes("malformed")) {
    return "malformed_response";
  }
  return "unknown";
}

// --- Provider health registry (persisted so it survives across serverless
// invocations, not just within a single warm isolate) ------------------------

async function loadHealth() {
  const { data } = await supabaseAdmin.from("provider_health").select("*");
  const byProvider = {};
  for (const row of data || []) byProvider[row.provider] = row;
  return byProvider;
}

function isInCooldown(health) {
  if (!health?.cooldown_until) return false;
  return new Date(health.cooldown_until).getTime() > Date.now();
}

async function recordSuccess(provider, model, latencyMs) {
  try {
    await supabaseAdmin.from("provider_health").upsert({
      provider,
      available: true,
      cooldown_until: null,
      consecutive_failures: 0,
      last_success: new Date().toISOString(),
      last_model: model,
      last_latency_ms: latencyMs,
      updated_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error(`Failed to record provider health for ${provider}:`, err);
  }
}

async function recordFailure(provider, model, err, latencyMs, priorFailures) {
  const errorType = classifyFailure(err);
  const cooldownMs = COOLDOWN_MS[errorType] ?? COOLDOWN_MS.unknown;
  console.error(
    `AI provider "${provider}" (${model}) failed [${errorType}]:`,
    err?.message,
  );
  try {
    await supabaseAdmin.from("provider_health").upsert({
      provider,
      available: errorType !== "invalid_key",
      cooldown_until: new Date(Date.now() + cooldownMs).toISOString(),
      consecutive_failures: (priorFailures || 0) + 1,
      last_failure: new Date().toISOString(),
      last_error_type: errorType,
      last_model: model,
      last_latency_ms: latencyMs,
      updated_at: new Date().toISOString(),
    });
  } catch (dbErr) {
    console.error(`Failed to record provider health for ${provider}:`, dbErr);
  }
}

// --- Provider adapters (all share the same shape: throw Error with
// `.status` set from the HTTP response when available) -----------------------

async function callGemini(prompt, images, apiKey, model) {
  const parts = [{ text: prompt }];
  for (const image of images) {
    parts.push({
      inline_data: { mime_type: image.mimeType, data: image.base64 },
    });
  }

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({ contents: [{ role: "user", parts }] }),
    },
  );

  const data = await response.json();
  if (!response.ok) {
    const err = new Error(data?.error?.message || "Gemini request failed.");
    err.status = response.status;
    throw err;
  }

  const answer = data?.candidates?.[0]?.content?.parts
    ?.map((part) => part.text || "")
    .join("");
  if (!answer) {
    const err = new Error("Gemini returned an empty response.");
    err.malformed = true;
    throw err;
  }
  return answer;
}

async function callOpenAiCompatible(url, prompt, images, apiKey, model) {
  const content = [{ type: "text", text: prompt }];
  for (const image of images) {
    content.push({
      type: "image_url",
      image_url: { url: `data:${image.mimeType};base64,${image.base64}` },
    });
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content }],
    }),
  });

  const data = await response.json();
  if (!response.ok) {
    const err = new Error(
      data?.error?.message || `Request to ${url} failed.`,
    );
    err.status = response.status;
    throw err;
  }

  const answer = data?.choices?.[0]?.message?.content;
  if (!answer) {
    const err = new Error("Provider returned an empty response.");
    err.malformed = true;
    throw err;
  }
  return answer;
}

// --- Provider definitions -----------------------------------------------
// Order = preference order. Each provider may list multiple models to try
// (model fallback) before the orchestrator moves to the next provider.
// Capability-aware: a provider def declares what it can actually do
// (text/vision/reasoning/document/voice) instead of one flat provider list -
// text-only free models are fast/cheap and stay the default for plain
// questions, while a SEPARATE vision-capable model is only selected when an
// image is actually attached. This is what lets a vision request fail over
// to a second, independent vision-capable provider instead of having only
// one (Gemini) as a single point of failure.
function buildProviderDefs(needsVision: boolean) {
  const defs = [];

  const geminiKey = Deno.env.get("GEMINI_API_KEY");
  if (geminiKey) {
    defs.push({
      name: "gemini",
      paid: false,
      capabilities: ["text", "vision", "reasoning"],
      models: [Deno.env.get("GEMINI_MODEL") || "gemini-3.6-flash"],
      call: (prompt, images, model) =>
        callGemini(prompt, images, geminiKey, model),
    });
  }

  const openrouterKey = Deno.env.get("OPENROUTER_API_KEY");
  if (openrouterKey) {
    let models;
    if (needsVision) {
      const configured = Deno.env.get("OPENROUTER_VISION_MODELS");
      models = configured
        ? configured.split(",").map((m) => m.trim()).filter(Boolean)
        : [
          "google/gemini-2.0-flash-exp:free",
          "qwen/qwen2.5-vl-32b-instruct:free",
        ];
    } else {
      const configured = Deno.env.get("OPENROUTER_MODELS");
      models = configured
        ? configured.split(",").map((m) => m.trim()).filter(Boolean)
        : [
          "meta-llama/llama-3.1-8b-instruct:free",
          "google/gemma-2-9b-it:free",
          "mistralai/mistral-7b-instruct:free",
        ];
    }
    defs.push({
      name: "openrouter",
      paid: false,
      capabilities: needsVision ? ["vision"] : ["text"],
      models,
      call: (prompt, images, model) =>
        callOpenAiCompatible(
          "https://openrouter.ai/api/v1/chat/completions",
          prompt,
          images,
          openrouterKey,
          model,
        ),
    });
  }

  const groqKey = Deno.env.get("GROQ_API_KEY");
  if (groqKey) {
    defs.push({
      name: "groq",
      paid: false,
      capabilities: needsVision ? ["vision"] : ["text", "reasoning"],
      models: [
        needsVision
          ? (Deno.env.get("GROQ_VISION_MODEL") || "llama-3.2-11b-vision-preview")
          : (Deno.env.get("GROQ_MODEL") || "llama-3.3-70b-versatile"),
      ],
      call: (prompt, images, model) =>
        callOpenAiCompatible(
          "https://api.groq.com/openai/v1/chat/completions",
          prompt,
          images,
          groqKey,
          model,
        ),
    });
  }

  const mistralKey = Deno.env.get("MISTRAL_API_KEY");
  if (mistralKey) {
    defs.push({
      name: "mistral",
      paid: false,
      capabilities: needsVision ? ["vision"] : ["text"],
      models: [
        needsVision
          ? (Deno.env.get("MISTRAL_VISION_MODEL") || "pixtral-12b-2409")
          : (Deno.env.get("MISTRAL_MODEL") || "mistral-small-latest"),
      ],
      call: (prompt, images, model) =>
        callOpenAiCompatible(
          "https://api.mistral.ai/v1/chat/completions",
          prompt,
          images,
          mistralKey,
          model,
        ),
    });
  }

  const openaiKey = Deno.env.get("OPENAI_API_KEY");
  if (openaiKey && PAID_PROVIDERS_ALLOWED) {
    defs.push({
      name: "openai",
      paid: true,
      capabilities: ["text", "vision", "reasoning", "document"],
      models: [Deno.env.get("OPENAI_MODEL") || "gpt-4o-mini"],
      call: (prompt, images, model) =>
        callOpenAiCompatible(
          "https://api.openai.com/v1/chat/completions",
          prompt,
          images,
          openaiKey,
          model,
        ),
    });
  }

  return defs;
}

export interface AiRouterResult {
  answer: string;
  provider: string;
  model: string;
  failedProviders: string[];
}

// Tries each configured provider/model in preference order, skipping anyone
// currently in cooldown, up to MAX_ATTEMPTS total - then throws
// AiUnavailableError. Never leaks provider names/errors to the caller;
// details are only in server-side logs + the provider_health table.
export async function generateAnswer(
  prompt: string,
  images: ImageInput[] = [],
): Promise<AiRouterResult> {
  const needsVision = images.length > 0;
  const defs = buildProviderDefs(needsVision).filter((d) =>
    d.capabilities.includes(needsVision ? "vision" : "text")
  );
  if (defs.length === 0) {
    throw new AiUnavailableError("No AI provider is configured.");
  }

  const health = await loadHealth();
  const usableDefs = defs.filter((def) => !isInCooldown(health[def.name]));

  const failedProviders = [];
  let attempts = 0;

  for (const def of usableDefs) {
    let moveToNextProvider = false;

    for (const model of def.models) {
      if (attempts >= MAX_ATTEMPTS || moveToNextProvider) break;
      attempts++;

      const startedAt = Date.now();
      try {
        const answer = await def.call(prompt, images, model);
        await recordSuccess(def.name, model, Date.now() - startedAt);
        return { answer, provider: def.name, model, failedProviders };
      } catch (err) {
        const errorType = classifyFailure(err);
        await recordFailure(
          def.name,
          model,
          err,
          Date.now() - startedAt,
          health[def.name]?.consecutive_failures,
        );
        failedProviders.push(def.name);
        // Only keep trying this provider's other models when the failure was
        // model-specific; any other failure means the whole provider is
        // down, so move on instead of wasting the attempt budget on it.
        if (errorType !== "invalid_model") moveToNextProvider = true;
      }
    }

    if (attempts >= MAX_ATTEMPTS) break;
  }

  throw new AiUnavailableError();
}


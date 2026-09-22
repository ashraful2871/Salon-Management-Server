import {
  ApiError as GeminiApiError,
  GoogleGenAI,
  ThinkingConfig,
  ThinkingLevel,
} from "@google/genai";
import { StatusCodes } from "http-status-codes";
import config from "../../../config";
import ApiError from "../../Error/error";

/**
 * The one place that talks to Gemini. Callers ask for "a query vector", "a
 * document vector", "text" or "JSON matching this schema"; model ids, SDK
 * shapes, timeouts and fallbacks stay in here.
 *
 * Search must keep working when Gemini does not: `generate` returns null
 * instead of throwing, and the search path treats a failed embedding as "no
 * semantic signal" rather than an error.
 */

/** Must match the `vector(768)` column on salons. */
export const EMBEDDING_DIMENSIONS = 768;

export const embeddingModel = () => config.ai.embeddingModel;

export const isGeminiConfigured = () => Boolean(config.ai.geminiApiKey);

let client: GoogleGenAI | null = null;

const gemini = () => {
  if (!config.ai.geminiApiKey) {
    throw new ApiError(
      StatusCodes.SERVICE_UNAVAILABLE,
      "GEMINI_API_KEY is not configured - AI features are unavailable.",
    );
  }
  client ??= new GoogleGenAI({ apiKey: config.ai.geminiApiKey });
  return client;
};

// ---------------------------------------------------------------------------
// Embeddings
// ---------------------------------------------------------------------------

/**
 * gemini-embedding-2 has no task_type parameter - the API accepts one and
 * silently ignores it - and wants the task written into the text instead.
 * Older models take task_type and plain text. Using the wrong recipe does not
 * fail; it quietly flattens the difference between a short question and a
 * long salon profile, which is harder to notice than an error.
 */
const usesPromptTasks = (model: string) =>
  model.startsWith("gemini-embedding-2");

type EmbedOptions = {
  /** Document title (the salon name). Ignored for queries. */
  title?: string;
  timeoutMs?: number;
  /** Extra attempts on 408/429/5xx. Background indexing only - search has no time to wait. */
  retries?: number;
};

/**
 * `httpOptions.timeout` is also sent to Google as an X-Server-Timeout
 * deadline, and generateContent rejects anything under 10 s with a 400. So
 * the short budgets a live search needs are enforced on our side with an
 * AbortSignal; only background work, which can wait, uses the SDK timeout and
 * its retries.
 */
const deadline = (timeoutMs: number, retries?: number) =>
  retries
    ? {
        httpOptions: {
          timeout: Math.max(timeoutMs, 10_000),
          retryOptions: { attempts: retries + 1 },
        },
      }
    : { abortSignal: AbortSignal.timeout(timeoutMs) };

const normalise = (values: number[]) => {
  const norm = Math.sqrt(values.reduce((sum, v) => sum + v * v, 0));
  return norm > 0 ? values.map((v) => v / norm) : values;
};

const embed = async (
  text: string,
  kind: "query" | "document",
  options: EmbedOptions = {},
): Promise<number[]> => {
  const model = embeddingModel();
  const promptTasks = usesPromptTasks(model);

  const contents = !promptTasks
    ? text
    : kind === "query"
      ? `task: search result | query: ${text}`
      : `title: ${options.title?.trim() || "none"} | text: ${text}`;

  const timeoutMs = options.timeoutMs ?? 10_000;

  const response = await gemini().models.embedContent({
    model,
    contents,
    config: {
      outputDimensionality: EMBEDDING_DIMENSIONS,
      ...(promptTasks
        ? {}
        : {
            taskType:
              kind === "query" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT",
            title: kind === "document" ? options.title : undefined,
          }),
      ...deadline(timeoutMs, options.retries),
    },
  });

  const values = response.embeddings?.[0]?.values;

  if (!values || values.length !== EMBEDDING_DIMENSIONS) {
    throw new ApiError(
      StatusCodes.BAD_GATEWAY,
      `Embedding model ${model} returned ${values?.length ?? 0} dimensions, expected ${EMBEDDING_DIMENSIONS}.`,
    );
  }

  // Only 3072-dim output comes back normalised from gemini-embedding-001.
  // Cosine distance does not care, but anything that later switches to inner
  // product would, so every stored and compared vector is unit length.
  return normalise(values);
};

export const embedQuery = (text: string, options?: EmbedOptions) =>
  embed(text, "query", options);

export const embedDocument = (
  title: string,
  text: string,
  options?: EmbedOptions,
) => embed(text, "document", { ...options, title });

/** pgvector's text input format. */
export const toVectorLiteral = (values: number[]) => `[${values.join(",")}]`;

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

/** How long a model that just failed is skipped before it is tried again. */
const COOLDOWN_MS = 60_000;
const cooldownUntil = new Map<string, number>();
/**
 * One slow answer is weather, not an outage. Benching a model after a
 * single timeout sent every following call to a fallback that was busier
 * still, so a timeout only counts once it happens twice running.
 */
const TIMEOUTS_BEFORE_COOLDOWN = 2;
const timeoutsInARow = new Map<string, number>();

const isTimeout = (error: unknown) =>
  error instanceof Error &&
  (error.name === "AbortError" || error.name === "TimeoutError");

/**
 * Thinking buys nothing for extraction and one-paragraph summaries and costs
 * a second or more. The controls differ by family: 2.5 Flash takes a budget
 * (0 turns it off), 3.5/3.6 Flash take a level, and 3.7+ reject "minimal" - so
 * anything not listed keeps its default rather than risk a 400.
 */
const thinkingFor = (model: string): ThinkingConfig | undefined => {
  if (/^gemini-2\.5-flash/.test(model)) return { thinkingBudget: 0 };
  if (/^gemini-3\.[56]-flash/.test(model)) {
    return { thinkingLevel: ThinkingLevel.MINIMAL };
  }
  return undefined;
};

const describeError = (error: unknown) => {
  if (error instanceof GeminiApiError) {
    return `${error.status} ${error.message.slice(0, 200)}`;
  }
  if (error instanceof Error) {
    return isTimeout(error) ? "timed out" : error.message.slice(0, 200);
  }
  return String(error).slice(0, 200);
};

export type GenerateOptions = {
  /** Shows up in logs: which feature was asking. */
  label: string;
  system: string;
  prompt: string;
  /** Budget for the whole call, fallbacks included. */
  timeoutMs: number;
  maxOutputTokens?: number;
  /** JSON Schema the reply must follow. Omit for plain text. */
  jsonSchema?: Record<string, unknown>;
};

export type GenerateResult = { text: string; model: string; ms: number };

/**
 * Tries each configured chat model in turn until one answers within the
 * budget. Returns null when none does - callers always have a non-AI
 * fallback, so a Gemini outage costs polish, never results.
 */
export const generate = async (
  options: GenerateOptions,
): Promise<GenerateResult | null> => {
  if (!isGeminiConfigured()) return null;

  const giveUpAt = Date.now() + options.timeoutMs;
  const now = Date.now();
  const models = config.ai.chatModels;
  const ready = models.filter((model) => (cooldownUntil.get(model) ?? 0) <= now);
  // Everything cooling down is still better served by one attempt than none.
  const order = ready.length ? ready : models.slice(0, 1);

  for (const model of order) {
    const remaining = giveUpAt - Date.now();
    if (remaining < 400) break;

    const started = Date.now();
    try {
      const response = await gemini().models.generateContent({
        model,
        contents: options.prompt,
        config: {
          systemInstruction: options.system,
          maxOutputTokens: options.maxOutputTokens,
          thinkingConfig: thinkingFor(model),
          ...(options.jsonSchema
            ? {
                responseMimeType: "application/json",
                responseJsonSchema: options.jsonSchema,
              }
            : {}),
          ...deadline(remaining),
        },
      });

      const text = response.text?.trim();
      if (!text) {
        throw new Error(
          `empty reply (finishReason ${response.candidates?.[0]?.finishReason ?? "unknown"})`,
        );
      }

      cooldownUntil.delete(model);
      timeoutsInARow.delete(model);
      return { text, model, ms: Date.now() - started };
    } catch (error) {
      const timeouts = isTimeout(error) ? (timeoutsInARow.get(model) ?? 0) + 1 : 0;
      timeoutsInARow.set(model, timeouts);
      if (!isTimeout(error) || timeouts >= TIMEOUTS_BEFORE_COOLDOWN) {
        cooldownUntil.set(model, Date.now() + COOLDOWN_MS);
      }
      console.warn(
        `[ai.gemini] ${options.label} via ${model} failed after ${Date.now() - started}ms: ${describeError(error)}`,
      );
    }
  }

  return null;
};

/**
 * `generate` with a JSON Schema, parsed. The model's output is untrusted
 * input: `parse` must validate it (a zod safeParse) and return null when it
 * does not fit.
 */
export const generateJson = async <T>(
  options: GenerateOptions & {
    jsonSchema: Record<string, unknown>;
    parse: (value: unknown) => T | null;
  },
): Promise<{ data: T; model: string; ms: number } | null> => {
  const result = await generate(options);
  if (!result) return null;

  try {
    const data = options.parse(JSON.parse(result.text));
    if (data === null) {
      console.warn(
        `[ai.gemini] ${options.label} via ${result.model} returned JSON that failed validation`,
      );
      return null;
    }
    return { data, model: result.model, ms: result.ms };
  } catch {
    console.warn(
      `[ai.gemini] ${options.label} via ${result.model} returned invalid JSON`,
    );
    return null;
  }
};

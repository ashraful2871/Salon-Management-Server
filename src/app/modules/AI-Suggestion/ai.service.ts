import { GoogleGenerativeAI, TaskType } from "@google/generative-ai";
import prisma from "../../shared/prisma";
import { toTaka } from "../../utils/money";
import ApiError from "../../Error/error";
import { StatusCodes } from "http-status-codes";

const genai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY as string);

const EMBEDDING_MODEL =
  process.env.GEMINI_EMBEDDING_MODEL || "gemini-embedding-2";
const CHAT_MODEL = process.env.GEMINI_CHAT_MODEL || "gemini-2.5-flash";

/** Must match the `vector(768)` column on salons. */
const EMBEDDING_DIMENSIONS = 768;

/**
 * Cosine similarity below this is treated as "not really what they asked for".
 * Tune with AI_SEARCH_MIN_SIMILARITY — every search logs the scores it saw.
 */
const MIN_SIMILARITY = Number(process.env.AI_SEARCH_MIN_SIMILARITY ?? 0.35);
const DEFAULT_LIMIT = Number(process.env.AI_SEARCH_LIMIT ?? 6);

const embeddingModel = genai.getGenerativeModel({ model: EMBEDDING_MODEL });

type SalonService = {
  id: string;
  name: string;
  category: string;
  price: number;
  duration: number;
};

type SalonMatch = {
  id: string;
  name: string;
  description: string | null;
  address: string;
  area: string;
  district: string;
  city: string;
  images: string[];
  rating: number;
  totalReviews: number;
  phone: string;
  similarity: number;
  services: SalonService[];
};

export const aiService = {
  /**
   * Documents and queries are embedded with different task types on purpose:
   * asymmetric retrieval puts a short question and a long salon profile into
   * comparable positions in the vector space. Symmetric embedding does not.
   */
  async generateEmbedding(
    text: string,
    taskType: TaskType = TaskType.RETRIEVAL_DOCUMENT
  ): Promise<number[]> {
    if (!process.env.GEMINI_API_KEY) {
      throw new ApiError(
        StatusCodes.INTERNAL_SERVER_ERROR,
        "GEMINI_API_KEY is not configured - AI search is unavailable."
      );
    }

    const result = await embeddingModel.embedContent({
      content: { role: "user", parts: [{ text }] },
      taskType,
      // @ts-ignore - outputDimensionality is supported by the API but missing in the SDK types
      outputDimensionality: EMBEDDING_DIMENSIONS,
    });

    const values = result.embedding?.values;

    if (!values?.length) {
      throw new ApiError(
        StatusCodes.INTERNAL_SERVER_ERROR,
        "Embedding model returned no vector."
      );
    }

    return values;
  },

  /**
   * Everything a user might search on goes into the embedded text: the full
   * location hierarchy, every service with its price, and the price range, so
   * a query like "cheap haircut in Dhanmondi" has something to match against.
   */
  buildSalonText(salon: {
    name: string;
    description: string | null;
    address: string;
    area: string;
    district: string;
    division: string;
    city: string;
    rating: number;
    totalReviews: number;
    services: Array<{
      name: string;
      category: string;
      priceMinor: number;
      duration: number;
    }>;
  }): string {
    // Prices are rendered in taka, exactly as they were when they were Floats,
    // so moving storage to poisha did not change a single embedded character
    // and existing vectors stay comparable.
    const services = salon.services.length
      ? salon.services
          .map(
            (s) =>
              `${s.name} (${s.category}, ${s.duration} min, BDT ${toTaka(s.priceMinor)})`
          )
          .join("; ")
      : "No services listed";

    const prices = salon.services
      .map((s) => toTaka(s.priceMinor))
      .filter((p) => Number.isFinite(p));

    const priceRange = prices.length
      ? `BDT ${Math.min(...prices)} to BDT ${Math.max(...prices)}`
      : "Not listed";

    const categories = [...new Set(salon.services.map((s) => s.category))].join(
      ", "
    );

    return [
      `Salon name: ${salon.name}`,
      `Location: ${salon.address}, ${salon.area}, ${salon.district}, ${salon.division}, ${salon.city}`,
      `Area: ${salon.area}. District: ${salon.district}. City: ${salon.city}.`,
      `Description: ${salon.description || "No description"}`,
      `Service categories: ${categories || "None"}`,
      `Services offered: ${services}`,
      `Price range: ${priceRange}`,
      `Rating: ${salon.rating} out of 5 from ${salon.totalReviews} reviews`,
    ].join("\n");
  },

  async generateAndSaveSaloneEmbedding(salonId: string) {
    const salon = await prisma.salon.findUnique({
      where: { id: salonId },
      include: {
        services: { where: { isDeleted: false, isActive: true } },
      },
    });

    if (!salon) {
      throw new ApiError(StatusCodes.NOT_FOUND, "Salon not found");
    }

    const vectorArray = await this.generateEmbedding(
      this.buildSalonText(salon),
      TaskType.RETRIEVAL_DOCUMENT
    );

    const vectorString = `[${vectorArray.join(",")}]`;

    await prisma.$executeRaw`
      UPDATE salons
      SET embedding = ${vectorString}::vector
      WHERE id = ${salonId}
    `;

    return { message: `AI Embedding saved successfully for ${salon.name}` };
  },

  /**
   * Regenerates embeddings. Pass onlyMissing=false after changing the embedded
   * text, since existing vectors describe the old text and are not comparable
   * with newly generated ones.
   */
  async backfillEmbeddings(onlyMissing = true) {
    const salons = await prisma.$queryRaw<Array<{ id: string; name: string }>>`
      SELECT id, name FROM salons
      WHERE "isDeleted" = false
        AND status = 'ACTIVE'
        AND (${onlyMissing}::boolean = false OR embedding IS NULL)
      ORDER BY "createdAt"
    `;

    const failures: Array<{ id: string; name: string; error: string }> = [];
    let succeeded = 0;

    for (const salon of salons) {
      try {
        await this.generateAndSaveSaloneEmbedding(salon.id);
        succeeded += 1;
      } catch (error) {
        failures.push({
          id: salon.id,
          name: salon.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return {
      total: salons.length,
      succeeded,
      failed: failures.length,
      failures,
    };
  },

  async searchSalon(userPrompt: string, limit = DEFAULT_LIMIT) {
    const prompt = userPrompt?.trim();

    if (!prompt) {
      throw new ApiError(StatusCodes.BAD_REQUEST, "Search prompt is required");
    }

    const searchVectorArray = await this.generateEmbedding(
      prompt,
      TaskType.RETRIEVAL_QUERY
    );
    const searchVectorString = `[${searchVectorArray.join(",")}]`;

    // Over-fetch so the relevance filter below has something to cut from, and
    // select the fields the salon cards actually render rather than a bare name.
    const candidates = await prisma.$queryRaw<SalonMatch[]>`
      SELECT
        s.id, s.name, s.description, s.address, s.area, s.district, s.city,
        s.images, s.rating, s."totalReviews", s.phone,
        1 - (s.embedding <=> ${searchVectorString}::vector) AS similarity,
        COALESCE(
          json_agg(
            json_build_object(
              'id', sv.id, 'name', sv.name, 'category', sv.category,
              'price', (sv."priceMinor" / 100.0)::float8, 'duration', sv.duration
            ) ORDER BY sv."priceMinor"
          ) FILTER (WHERE sv.id IS NOT NULL),
          '[]'
        ) AS services
      FROM salons s
      LEFT JOIN services sv
        ON sv."salonId" = s.id AND sv."isDeleted" = false AND sv."isActive" = true
      WHERE s."isDeleted" = false
        AND s.status = 'ACTIVE'
        AND s.embedding IS NOT NULL
      GROUP BY s.id
      ORDER BY s.embedding <=> ${searchVectorString}::vector
      LIMIT ${limit * 3}
    `;

    if (candidates.length === 0) {
      // Distinguish "nothing indexed" from "nothing relevant". Before, an empty
      // index looked exactly like a bad query and nobody found out.
      const [{ count }] = await prisma.$queryRaw<Array<{ count: number }>>`
        SELECT COUNT(*)::int AS count FROM salons
        WHERE "isDeleted" = false AND status = 'ACTIVE'
      `;

      console.error(
        `[ai.search] no salons are indexed (${count} active salons have no embedding). Run the embedding backfill.`
      );

      return {
        aiResponse:
          "Our salon recommendations are still being prepared. Please try browsing all salons for now.",
        salons: [],
        query: prompt,
      };
    }

    const scores = candidates.map((c) => Number(c.similarity).toFixed(3));
    console.log(`[ai.search] "${prompt}" -> similarities: ${scores.join(", ")}`);

    const relevant = candidates
      .filter((c) => Number(c.similarity) >= MIN_SIMILARITY)
      .slice(0, limit);

    if (relevant.length === 0) {
      return {
        aiResponse: `I could not find a salon that matches "${prompt}". Try describing the service you want, or the area you are in.`,
        salons: [],
        query: prompt,
      };
    }

    const aiResponse = await this.summariseMatches(prompt, relevant);

    return { aiResponse, salons: relevant, query: prompt };
  },

  /** Turns the matched rows into a recommendation, grounded strictly in those rows. */
  async summariseMatches(prompt: string, salons: SalonMatch[]) {
    const facts = salons.map((s) => ({
      name: s.name,
      area: s.area,
      district: s.district,
      city: s.city,
      rating: s.rating,
      totalReviews: s.totalReviews,
      description: s.description,
      services: s.services.map(
        (sv) => `${sv.name} (${sv.category}) - BDT ${sv.price}`
      ),
    }));

    const promptToGemini = `You are a friendly salon assistant for a Bangladeshi salon booking site.

The user asked: "${prompt}"

These are the ONLY salons available to recommend, already ranked by relevance:
${JSON.stringify(facts, null, 2)}

Write a short reply (2-4 sentences, no markdown headings) recommending these salons.
Rules:
- Mention them by name, best match first.
- Reference the specific services, prices or areas that answer what the user asked for.
- Use only the facts above. Do not invent salons, services, prices or ratings.
- If a detail the user asked about is missing from the data, say so plainly.
- Prices are in Bangladeshi Taka (BDT).`;

    try {
      const chatModel = genai.getGenerativeModel({ model: CHAT_MODEL });
      const chatResult = await chatModel.generateContent(promptToGemini);
      return chatResult.response.text();
    } catch (error) {
      console.error("[ai.search] summary generation failed:", error);

      // The matches are the valuable part; a dead chat model must not hide them.
      const names = salons.map((s) => `${s.name} (${s.area})`).join(", ");
      return `Here are the closest matches for "${prompt}": ${names}.`;
    }
  },
};

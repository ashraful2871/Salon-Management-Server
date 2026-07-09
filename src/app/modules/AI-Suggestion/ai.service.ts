import { GoogleGenerativeAI } from "@google/generative-ai";
import prisma from "../../shared/prisma";
import ApiError from "../../Error/error";
import { StatusCodes } from "http-status-codes";
import { json } from "zod";

const genai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY as string);
const embeddingModel = genai.getGenerativeModel({
  model: "gemini-embedding-2",
});
export const aiService = {
  async generetEmbedding(text: string): Promise<number[]> {
    const result = await embeddingModel.embedContent({
      content: { role: "user", parts: [{ text }] },
      // @ts-ignore - outputDimensionality is supported by the API but missing in the SDK types
      outputDimensionality: 768, // This tells Google to compress it to fit our database!
    });

    const embedding = result.embedding;
    return embedding.values;
  },
  async generateAndSaveSaloneEmbedding(salonId: string) {
    const salon = await prisma.salon.findUnique({
      where: {
        id: salonId,
      },
      include: {
        services: true,
      },
    });
    if (!salon) {
      throw new ApiError(StatusCodes.NOT_FOUND, "Salon not found");
    }
    const serviceName = salon.services
      .map((s) => `${s.name} (${s.category})`)
      .join(", ");
    const salonText = `
        Salon Name: ${salon.name}
        Location: ${salon.address}, ${salon.area}, ${salon.city}, 
        Descriptions: ${salon.description || "No Descriptions"}
        Services Offred: ${serviceName}
        Ratting: ${salon.rating}
        `;
    const vectorArray = await this.generetEmbedding(salonText);

    const vectorString = `[${vectorArray.join(",")}]`;

    await prisma.$executeRaw`
        UPDATE salons
        SET embedding= ${vectorString}:: vector
        WHERE id= ${salonId}
        `;

    return { message: `AI Embedding saved successfully for ${salon.name}` };
  },
  async searchSalon(userPrompt: string) {
    const searchVectorArray = await this.generetEmbedding(userPrompt);

    const searchVectorString = `[${searchVectorArray.join(",")}]`;

    const matchingSalon = await prisma.$queryRaw<any[]>`
    
    SELECT id, name, address, area, city, rating, description

    fROM salons
    WHERE "isDeleted"= false AND embedding IS NOT NULL 
    ORDER BY embedding <=> ${searchVectorString}::vector
    LIMIT 3
    `;

    if (matchingSalon.length === 0) {
      return {
        aiResponse:
          "I couldn't find any salons matching your request right now.",
      };
    }
    const chatModel = genai.getGenerativeModel({ model: "gemini-2.5-flash" });
    const promptToGemini = `
    
    The User Asked: "${userPrompt}"
 Here are the top 3 salons we found in our database that match their request: ${JSON.stringify(matchingSalon, null, 2)}

 Act as a friendly Salon Assistant. Write a short, helpful response recommending these salons to the user based on what they asked for.
    `;

    const chatResult = await chatModel.generateContent(promptToGemini);
    const aiResponseText = chatResult.response.text();
    return {
      aiResponse: aiResponseText,
      salons: matchingSalon,
    };
  },
};

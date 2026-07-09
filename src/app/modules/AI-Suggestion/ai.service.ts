import { GoogleGenerativeAI } from "@google/generative-ai";
import prisma from "../../shared/prisma";
import ApiError from "../../Error/error";
import { StatusCodes } from "http-status-codes";

const genai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY as string);
const embeddingModel = genai.getGenerativeModel({
  model: "text-embedding-004",
});
export const aiService = {
  async generetEmbedding(text: string): Promise<number[]> {
    const result = await embeddingModel.embedContent(text);
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
};

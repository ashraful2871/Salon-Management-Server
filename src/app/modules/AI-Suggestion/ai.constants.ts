import { ServiceCategory } from "@prisma/client";

/**
 * How a service category reads to a person. Used in the embedded salon
 * document, in match reasons ("No haircut listed") and sent to the frontend
 * for the "we understood" chips, so all three always agree.
 */
export const CATEGORY_LABELS: Record<ServiceCategory, string> = {
  HAIRCUT: "Haircut",
  STYLING: "Hair styling",
  COLORING: "Hair colouring",
  TREATMENT: "Hair & skin treatment",
  SPA: "Spa",
  FACIAL: "Facial",
  MANICURE: "Manicure",
  PEDICURE: "Pedicure",
  MAKEUP: "Makeup",
  WAXING: "Waxing & threading",
  MASSAGE: "Massage",
  OTHER: "Other services",
};

export const SERVICE_CATEGORIES = Object.keys(
  CATEGORY_LABELS,
) as ServiceCategory[];

/** Dhaka time. Opening hours are wall-clock times at the salon. */
export const SALON_TIME_ZONE = "Asia/Dhaka";

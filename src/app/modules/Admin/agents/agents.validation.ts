import { z } from "zod";

const place = z.string().trim().min(1).max(100);
const reason = z.string().trim().min(3, "Give a reason").max(500);

const updateArea = z.object({
  body: z.object({ division: place, district: place, area: place, reason }),
});

const updateStatus = z.object({
  body: z.object({ status: z.enum(["ACTIVE", "SUSPENDED", "BLOCKED"]), reason }),
});

export const AdminAgentsValidation = { updateArea, updateStatus };

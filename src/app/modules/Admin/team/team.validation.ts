import { z } from "zod";
import { AdminRole } from "@prisma/client";

const reason = z.string().trim().min(3, "Give a reason").max(500);

const changeRole = z.object({
  body: z.object({ adminRole: z.nativeEnum(AdminRole), reason }),
});

const withReason = z.object({ body: z.object({ reason }) });

export const AdminTeamValidation = { changeRole, withReason };

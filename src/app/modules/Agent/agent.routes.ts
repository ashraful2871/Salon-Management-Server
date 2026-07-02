import express from "express";
import validateRequest from "../../middlewares/validateRequest";
import auth from "../../middlewares/auth";
import { AgentController } from "./agent.controller";
import { AgentValidation } from "./agent.validation";

const router = express.Router();

router.post(
  "/create",
  auth("ADMIN"),
  validateRequest(AgentValidation.createAgentSchema),
  AgentController.createAgent
);

router.get("/", auth("ADMIN"), AgentController.getAllAgents);

export const AgentRoutes = router;

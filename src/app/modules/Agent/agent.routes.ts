import express from "express";
import { adminAuth } from "../Admin/admin.middleware";
import { AgentController } from "./agent.controller";

const router = express.Router();

// 410: agents are invited from the admin panel now.
router.post("/create", adminAuth("agents.manage"), AgentController.createAgent);

router.get("/", adminAuth("agents.manage"), AgentController.getAllAgents);

export const AgentRoutes = router;

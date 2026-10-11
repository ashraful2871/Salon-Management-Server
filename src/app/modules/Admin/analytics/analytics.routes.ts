import express, { Request, Response } from "express";
import { StatusCodes } from "http-status-codes";
import { z } from "zod";
import catchAsync from "../../../shared/catchAsync";
import sendResponse from "../../../shared/sendResponse";
import ApiError from "../../../Error/error";
import { audit } from "../../../utils/audit";
import { streamCsv } from "../../../utils/csv";
import { addDays, daysBetween, dhakaDay, isDay } from "../../Analytics/analytics.days";
import { getMetric } from "../../Analytics/analytics.metrics";
import { adminAuth, adminOnly } from "../admin.middleware";
import { AdminAnalyticsService, REPORTS, type ReportName, type ReportQuery } from "./analytics.service";

/**
 * /admin/analytics - platform-wide numbers, so agents (area-scoped) get none.
 *   GET /metrics                    the metric dictionary
 *   GET /:report                    { kpis, series, tables }
 *   GET /:report/export.csv         the same as rows (analytics.export, audited)
 */
const router = express.Router();

const MAX_DAYS = 400;
const truthy = z
  .union([z.boolean(), z.enum(["true", "false", "1", "0"])])
  .optional()
  .transform((v) => v === true || v === "true" || v === "1");

const querySchema = z.object({
  from: z.string().refine(isDay, "from must be YYYY-MM-DD").optional(),
  to: z.string().refine(isDay, "to must be YYYY-MM-DD").optional(),
  compare: z.enum(["prev", "none"]).default("prev"),
  area: z.string().trim().max(80).optional().transform((v) => v || undefined),
  channel: z.enum(["WEB", "ASSISTANT", "WALK_IN"]).optional(),
  includeTest: truthy,
});

const parse = (req: Request): { report: ReportName; q: ReportQuery } => {
  const report = String(req.params.report) as ReportName;
  if (!REPORTS.includes(report)) throw new ApiError(StatusCodes.NOT_FOUND, "No such report");
  const parsed = querySchema.parse(req.query);
  const today = dhakaDay();
  const to = parsed.to && parsed.to < today ? parsed.to : today;
  const from = parsed.from ?? addDays(to, -29);
  if (from > to) throw new ApiError(StatusCodes.BAD_REQUEST, "from must be on or before to");
  if (daysBetween(from, to).length > MAX_DAYS) {
    throw new ApiError(StatusCodes.BAD_REQUEST, `At most ${MAX_DAYS} days per report`);
  }
  return {
    report,
    q: { from, to, compare: parsed.compare, includeTest: parsed.includeTest, area: parsed.area, channel: parsed.channel },
  };
};

router.get(
  "/metrics",
  adminAuth("analytics.view"),
  adminOnly,
  catchAsync(async (_req: Request, res: Response) => {
    sendResponse(res, {
      statusCode: StatusCodes.OK,
      success: true,
      message: "Metric dictionary",
      data: AdminAnalyticsService.listMetrics(),
    });
  }),
);

router.get(
  "/:report",
  adminAuth("analytics.view"),
  adminOnly,
  catchAsync(async (req: Request, res: Response) => {
    const { report, q } = parse(req);
    const data = await AdminAnalyticsService.getReport(report, q);
    sendResponse(res, { statusCode: StatusCodes.OK, success: true, message: `Analytics: ${report}`, data });
  }),
);

type CsvRow = { i: number; day: string; metric: string; label: string; unit: string; value: number | null; previous: number | null };

// Tier 2: audited like every other export. Money stays in poisha (unit "minor").
router.get(
  "/:report/export.csv",
  adminAuth("analytics.export"),
  adminOnly,
  catchAsync(async (req: Request, res: Response) => {
    const { report, q } = parse(req);
    const data = await AdminAnalyticsService.getReport(report, q);
    const rows: CsvRow[] = ([
      ...data.kpis.map((k) => ({
        day: `${q.from}..${q.to}`,
        metric: k.id,
        label: k.label,
        unit: k.unit,
        value: k.value,
        previous: "previous" in k ? (k.previous ?? null) : null,
      })),
      ...Object.entries(data.series).flatMap(([id, points]) =>
        points.map((p) => ({
          day: p.day,
          metric: id,
          label: getMetric(id).label,
          unit: getMetric(id).unit,
          value: p.value,
          previous: null,
        })),
      ),
    ] as Omit<CsvRow, "i">[]).map((r, i) => ({ ...r, i }));

    const result = await streamCsv<CsvRow>(res, {
      filename: `analytics-${report}-${q.from}-${q.to}.csv`,
      showPii: false,
      columns: [
        { header: "day", value: (r) => r.day },
        { header: "metric", value: (r) => r.metric },
        { header: "label", value: (r) => r.label },
        { header: "unit", value: (r) => r.unit },
        { header: "value", value: (r) => r.value },
        { header: "previous", value: (r) => r.previous },
      ],
      fetchBatch: async (after, take) => rows.slice(after ? after.i + 1 : 0, (after ? after.i + 1 : 0) + take),
    });

    await audit(req.auditCtx, {
      action: "export.create",
      entityType: "export",
      entityId: `analytics.${report}`,
      after: { ...q, rows: result.rows, truncated: result.truncated },
    });
  }),
);

export const AdminAnalyticsRoutes = router;

import { StatusCodes } from "http-status-codes";
import ApiError from "../../../Error/error";
import prisma from "../../../shared/prisma";
import { AuditCtx } from "../../../utils/audit";
import {
  describeSettings,
  envOnlyStatus,
  getSetting,
  isSettingKey,
  SettingGroup,
  SETTINGS,
  setSetting,
} from "../../../utils/settings";

const GROUP_ORDER: SettingGroup[] = [
  "money",
  "limits",
  "flags",
  "security",
  "approvals",
  "retention",
  "system",
  "content",
];

type Person = { id: string; name: string; email: string };

const userNames = async (ids: (string | null)[]) => {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (!unique.length) return new Map<string, Person>();
  const users = await prisma.user.findMany({
    where: { id: { in: unique } },
    select: { id: true, name: true, email: true },
  });
  return new Map<string, Person>(users.map((u) => [u.id, u]));
};

/** Groups of settings with value, default, source and bounds, + env-only names. */
const listSettings = async () => {
  const entries = await describeSettings();
  const names = await userNames(entries.map((e) => e.updatedById));

  const groups = GROUP_ORDER.map((group) => ({
    group,
    settings: entries
      .filter((e) => e.group === group)
      .map(({ updatedById, ...e }) => ({
        ...e,
        updatedBy: updatedById
          ? (names.get(updatedById) ?? { id: updatedById, name: "Unknown", email: "" })
          : null,
      })),
  })).filter((g) => g.settings.length > 0);

  return { groups, env: envOnlyStatus() };
};

const assertKey = (key: string) => {
  if (!isSettingKey(key)) throw new ApiError(StatusCodes.NOT_FOUND, "Unknown setting");
  return key;
};

const valueOf = (json: unknown) =>
  json && typeof json === "object" && "value" in json
    ? (json as { value: unknown }).value
    : null;

/** The last 20 changes of one key, from the audit log. */
const getHistory = async (key: string) => {
  assertKey(key);
  const rows = await prisma.auditLog.findMany({
    where: { action: "setting.update", entityType: "setting", entityId: key },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
  const names = await userNames(rows.map((r) => r.actorUserId));

  return rows.map((r) => ({
    id: r.id,
    at: r.createdAt,
    actor: r.actorUserId ? (names.get(r.actorUserId) ?? null) : null,
    before: valueOf(r.before),
    after: valueOf(r.after),
    reason: r.reason,
  }));
};

const updateSetting = async (
  ctx: AuditCtx | undefined,
  rawKey: string,
  body: { value: unknown; reason: string },
) => {
  const key = assertKey(rawKey);

  if (SETTINGS[key].approval && (await getSetting("approvals.enabled"))) {
    // TODO(Phase 8): queue an AdminApproval and answer 202 APPROVAL_REQUIRED.
    // The approvals table does not exist yet, so the change applies directly.
  }

  return setSetting(key, body.value, ctx, body.reason);
};

export const AdminSettingsService = { listSettings, getHistory, updateSetting };

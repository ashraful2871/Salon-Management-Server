import prisma from "../../shared/prisma";
import { getSetting, publicSettings } from "../../utils/settings";

export type FeaturedSalon = {
  id: string;
  name: string;
  area: string;
  rating: number;
  totalReviews: number;
  cover: string | null;
};

/**
 * `content.featuredSalonIds` resolved in the saved order. Public: only salons
 * still ACTIVE and not test data, so a suspension drops one without an edit.
 * The admin view (`all`) keeps every id and says why one is hidden.
 */
export const resolveFeaturedSalons = async (all = false) => {
  const ids = await getSetting("content.featuredSalonIds");
  if (!ids.length) return [];
  const rows = await prisma.salon.findMany({
    where: all
      ? { id: { in: ids } }
      : { id: { in: ids }, status: "ACTIVE", isDeleted: false, isTest: false },
    select: {
      id: true,
      name: true,
      area: true,
      rating: true,
      totalReviews: true,
      images: true,
      status: true,
      isDeleted: true,
      isTest: true,
    },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.flatMap((id) => {
    const s = byId.get(id);
    if (!s) return [];
    const base: FeaturedSalon = {
      id: s.id,
      name: s.name,
      area: s.area,
      rating: s.rating,
      totalReviews: s.totalReviews,
      cover: s.images[0] ?? null,
    };
    return [all ? { ...base, status: s.status, isDeleted: s.isDeleted, isTest: s.isTest } : base];
  });
};

/** GET /settings/public: the public settings plus the featured salons, one call. */
const getPublic = async () => ({
  ...(await publicSettings()),
  featuredSalons: await resolveFeaturedSalons(),
});

export const SettingsService = { getPublic };

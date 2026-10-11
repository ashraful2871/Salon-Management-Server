/**
 * Shared list parsing for admin endpoints:
 * `?page=&limit=&q=&sort=createdAt:asc|desc` (or `sort=-createdAt`).
 * Unknown sort fields fall back to the default; `limit` is capped at 100.
 */
export type ListQuery = {
  skip: number;
  take: number;
  orderBy: Record<string, "asc" | "desc">;
  q: string | undefined;
  page: number;
  limit: number;
};

export const parseListQuery = (
  query: Record<string, unknown>,
  opts: { sortable: string[]; defaultSort: { field: string; order: "asc" | "desc" } },
): ListQuery => {
  const num = (v: unknown, fallback: number) => {
    const n = Number.parseInt(String(v ?? ""), 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };

  const page = num(query.page, 1);
  const limit = Math.min(num(query.limit, 20), 100);

  let { field, order } = opts.defaultSort;
  const rawSort = typeof query.sort === "string" ? query.sort.trim() : "";
  if (rawSort) {
    // `field:asc|desc` (what the dashboard writes) or `-field`.
    const [head, dir] = rawSort.split(":");
    const desc = dir ? dir === "desc" : head.startsWith("-");
    const name = !dir && desc ? head.slice(1) : head;
    if (opts.sortable.includes(name)) {
      field = name;
      order = desc ? "desc" : "asc";
    }
  }

  const q = typeof query.q === "string" && query.q.trim() ? query.q.trim().slice(0, 100) : undefined;

  return { skip: (page - 1) * limit, take: limit, orderBy: { [field]: order }, q, page, limit };
};

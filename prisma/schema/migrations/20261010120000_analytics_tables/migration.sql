-- Admin Phase 10: analytics aggregates. Additive only.

-- CreateTable
CREATE TABLE "metric_daily" (
    "day" DATE NOT NULL,
    "metric" TEXT NOT NULL,
    "dimension" TEXT NOT NULL DEFAULT '',
    "value" DOUBLE PRECISION NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "metric_daily_pkey" PRIMARY KEY ("day","metric","dimension")
);

-- CreateTable
CREATE TABLE "event_daily" (
    "day" DATE NOT NULL,
    "event" TEXT NOT NULL,
    "dimension" TEXT NOT NULL DEFAULT '',
    "count" INTEGER NOT NULL,

    CONSTRAINT "event_daily_pkey" PRIMARY KEY ("day","event","dimension")
);

-- CreateTable
CREATE TABLE "visitor_daily" (
    "day" DATE NOT NULL,
    "hash" TEXT NOT NULL,

    CONSTRAINT "visitor_daily_pkey" PRIMARY KEY ("day","hash")
);

-- CreateTable
CREATE TABLE "search_query_daily" (
    "day" DATE NOT NULL,
    "term" TEXT NOT NULL,
    "surface" TEXT NOT NULL,
    "count" INTEGER NOT NULL,
    "zeroResults" INTEGER NOT NULL,

    CONSTRAINT "search_query_daily_pkey" PRIMARY KEY ("day","term","surface")
);

-- CreateIndex
CREATE INDEX "metric_daily_metric_day_idx" ON "metric_daily"("metric", "day");

-- CreateIndex
CREATE INDEX "event_daily_event_day_idx" ON "event_daily"("event", "day");

-- CreateIndex
CREATE INDEX "search_query_daily_day_idx" ON "search_query_daily"("day");

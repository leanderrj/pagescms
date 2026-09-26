import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { projectAnalyticsConfigTable } from "@/db/schema";
import { getCachedConfig } from "@/lib/config-store";
import { checkEnvRefsPresent, collectEnvRefs, resolveEnvRef } from "@/lib/env-ref";

export type ResolvedAnalytics = {
  source: "d1" | "config";
  ga4MeasurementId: string | null;
  cfBeaconToken: string | null;
  requireConsent: boolean;
  honorDnt: boolean;
};

// Both values end up in a public script, so anything that isn't shaped like a
// real ID is dropped rather than echoed.
const GA4_ID = /^G-[A-Z0-9]{4,20}$/;
const CF_BEACON_TOKEN = /^[0-9a-f]{32}$/i;

const fromD1 = async (
  owner: string,
  repo: string,
  branch: string,
): Promise<ResolvedAnalytics | null> => {
  const row = await db.query.projectAnalyticsConfigTable.findFirst({
    where: and(
      sql`lower(${projectAnalyticsConfigTable.owner}) = ${owner.toLowerCase()}`,
      sql`lower(${projectAnalyticsConfigTable.repo}) = ${repo.toLowerCase()}`,
      eq(projectAnalyticsConfigTable.branch, branch),
    ),
  })
    ?? await db.query.projectAnalyticsConfigTable.findFirst({
      where: and(
        sql`lower(${projectAnalyticsConfigTable.owner}) = ${owner.toLowerCase()}`,
        sql`lower(${projectAnalyticsConfigTable.repo}) = ${repo.toLowerCase()}`,
        eq(projectAnalyticsConfigTable.branch, ""),
      ),
    });
  if (!row) return null;
  if (!row.ga4MeasurementId && !row.cfBeaconToken) return null;
  return {
    source: "d1",
    ga4MeasurementId: row.ga4MeasurementId ?? null,
    cfBeaconToken: row.cfBeaconToken ?? null,
    requireConsent: !!row.requireConsent,
    honorDnt: !!row.honorDnt,
  };
};

export type AnalyticsBlock = {
  ga4MeasurementId?: string;
  cfBeaconToken?: string;
  requireConsent?: boolean;
  honorDnt?: boolean;
};

export const findAnalyticsBlockInConfig = (configObject: any): AnalyticsBlock | null => {
  const block = configObject?.analytics;
  if (!block || typeof block !== "object") return null;
  return block as AnalyticsBlock;
};

export const collectAnalyticsEnvVarRefs = (block: AnalyticsBlock | null | undefined): string[] =>
  block ? collectEnvRefs([block.ga4MeasurementId, block.cfBeaconToken]) : [];

export const checkAnalyticsEnvVarsPresent = checkEnvRefsPresent;

const fromConfig = async (
  owner: string,
  repo: string,
  branch: string,
): Promise<ResolvedAnalytics | null> => {
  const cached = await getCachedConfig(owner, repo, branch).catch(() => null);
  const block = findAnalyticsBlockInConfig(cached?.object);
  if (!block) return null;

  const ga4Raw = resolveEnvRef(block.ga4MeasurementId);
  const cfRaw = resolveEnvRef(block.cfBeaconToken);
  const ga4 = GA4_ID.test(ga4Raw) ? ga4Raw : null;
  const cf = CF_BEACON_TOKEN.test(cfRaw) ? cfRaw : null;
  if (!ga4 && !cf) return null;

  return {
    source: "config",
    ga4MeasurementId: ga4,
    cfBeaconToken: cf,
    requireConsent: block.requireConsent ?? true,
    honorDnt: block.honorDnt ?? true,
  };
};

export const resolveAnalyticsConfig = async (
  owner: string,
  repo: string,
  branch: string,
): Promise<ResolvedAnalytics | null> => {
  return (await fromD1(owner, repo, branch)) ?? (await fromConfig(owner, repo, branch));
};

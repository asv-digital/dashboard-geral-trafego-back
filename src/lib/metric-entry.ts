export interface MetricEntryLike {
  adSet?: string | null;
  observations?: string | null;
}

export interface MetaAdsetLike {
  id: string;
  name: string;
}

export function extractMetaAdsetId(observations?: string | null): string | null {
  if (!observations) return null;
  const match = observations.match(/\badset=([^\s]+)/);
  return match?.[1] || null;
}

export function metricMatchesAdset(
  metric: MetricEntryLike,
  adset: MetaAdsetLike
): boolean {
  const observedAdsetId = extractMetaAdsetId(metric.observations);
  if (observedAdsetId) {
    return observedAdsetId === adset.id;
  }
  return metric.adSet === adset.name;
}

function normalizeLabel(value: string): string {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^\w\s-]+/g, " ")
    .replace(/\bcreative\b/g, "variant")
    .replace(/\bad\b/g, "variant")
    .replace(/\s+/g, " ")
    .trim();
}

export function creativeMatchesAdName(creativeName: string, adName: string): boolean {
  const normalizedCreative = normalizeLabel(creativeName);
  const normalizedAd = normalizeLabel(adName);

  if (!normalizedCreative || !normalizedAd) return false;
  if (normalizedCreative === normalizedAd) return true;

  const creativeBase = normalizedCreative.replace(/\s+variant\s+\d+$/, "").trim();
  const adBase = normalizedAd.replace(/\s+variant\s+\d+$/, "").trim();
  const creativeIndex = normalizedCreative.match(/variant\s+(\d+)$/)?.[1];
  const adIndex = normalizedAd.match(/variant\s+(\d+)$/)?.[1];

  return !!creativeBase && creativeBase === adBase && creativeIndex === adIndex;
}

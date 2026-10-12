const DETAIL_BUDGET = 3800;

export function boundedDetail(
  value: unknown,
  budget = DETAIL_BUDGET,
): { detail: string; detailsAvailable?: true } {
  const detail = JSON.stringify(value);
  if (detail.length <= budget) return { detail };
  return { detail: detail.slice(0, budget), detailsAvailable: true };
}

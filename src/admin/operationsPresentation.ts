/** Native bigint counters must never pass through Number or floating point formatting. */
export function operationalCount(value: string | null): string {
  return value === null ? "Not reported" : value.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
export const operationalStatus = (value: string) => value === "never" ? "No run recorded" : ["queued", "starting", "sending", "connecting", "running"].includes(value) ? value + " (in progress)" : value;

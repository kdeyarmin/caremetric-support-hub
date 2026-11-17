/** An Intel organization's status as Intel stores it (billing's, or `disabled` while CareMetric has it suspended), in words. */
const intelOrganizationStatuses: Record<string, string> = {
  payment_required: "Awaiting payment details", trial: "Trial", active: "Active", past_due: "Past due", canceled: "Canceled", disabled: "Suspended",
};
/** How an application's organization status reads in the Hub. Unknown values are shown as sent. */
export function organizationStatusLabel(product: string, status: string | null): string | null {
  return product === "intel" && status !== null ? intelOrganizationStatuses[status] ?? status : status;
}

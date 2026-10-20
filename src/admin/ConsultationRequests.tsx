import { useCallback } from "react";
import type { AdminPage, AdvisorInquiry } from "../../supabase/functions/_shared/portfolioProtocol";
import { PagedRecords } from "./PagedRecords";
import { readPortfolio } from "./portfolioClient";
import { timeLabel } from "./readState";

const statusLabels: Record<AdvisorInquiry["status"], string> = { new: "Needs review", "in-progress": "In progress", closed: "Closed" };

/** Healthcare Advisors consultation requests, read live from the Advisors inbox. */
export function ConsultationRequests() {
  const read = useCallback(async (search: string, offset: number, signal: AbortSignal) =>
    await readPortfolio("advisors", { operation: "inquiries.list", search: search || undefined, offset, limit: 20 }, signal) as AdminPage<AdvisorInquiry>, []);
  return <>
    <p className="admin-explanation">Requests submitted through the caremetricadvisors.com consultation form. Contact details are self-reported, and the website asks visitors not to include patient information. Advisors deletes requests after 365 days.</p>
    <PagedRecords<AdvisorInquiry> app="CareMetric Healthcare Advisors" title="Consultation requests" searchLabel="Search names, emails and organizations" columns={["Received", "Reference", "Contact", "Organization", "Interest", "Message", "Status"]} read={read} render={row => <>
      <td>{timeLabel(row.createdAt)}</td>
      <td>{row.id}</td>
      <td>{row.name}<div>{row.email}</div>{row.phone && <div>{row.phone}</div>}</td>
      <td>{row.organization}<div>{row.sector}</div></td>
      <td>{row.service}</td>
      <td style={{ whiteSpace: "pre-wrap", minWidth: "18rem" }}>{row.message}{row.notes && <div><strong>Notes:</strong> {row.notes}</div>}</td>
      <td>{statusLabels[row.status]}</td>
    </>} />
  </>;
}

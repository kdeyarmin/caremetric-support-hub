import { useCallback, useState } from "react";
import { readPortfolio } from "../admin/portfolioClient";
import { PagedRecords } from "../admin/PagedRecords";
import type { AdminPage, PhoneMessage } from "../../supabase/functions/_shared/portfolioProtocol";

const requestLabels: Record<string, string> = { healthcare_advisors: "Advisor message", tech_support: "Technical support", customer_service: "Customer service", sales: "Software inquiry", other: "Other" };
export function PhoneInbox() {
  const [revision, setRevision] = useState(0);
  const read = useCallback(async (search: string, offset: number, signal: AbortSignal) =>
    await readPortfolio("breathe", { operation: "phone.messages.list", search: search || undefined, offset, limit: 20 }, signal) as AdminPage<PhoneMessage>, []);
  return <>
    <div className="page-heading"><div><span className="eyebrow">CareMetric Support Hub</span><h1>Phone messages</h1><p>Software support, customer service, and Healthcare Advisors messages from (877) 521-2890.</p></div><button className="button button-secondary" onClick={() => setRevision(value => value + 1)}>Refresh messages</button></div>
    <p>Caller details are self-reported. Review the message before following up; a saved message does not verify an account or authorize account changes.</p>
    <PagedRecords<PhoneMessage> key={revision} app="CareMetric phone line" title="Shared phone inbox" searchLabel="Search call summaries" columns={["Received", "Request", "Caller", "Callback details", "Message", "Status"]} read={read} render={row => <>
      <td>{row.createdAt ? new Date(row.createdAt).toLocaleString() : "Not recorded"}</td>
      <td><strong>{requestLabels[row.requestType] ?? row.requestType}</strong><div>{row.product}</div></td>
      <td>{row.contactName ?? "Name not provided"}<div>{row.companyName}</div></td>
      <td><div>{row.phone ?? "No callback number"}</div><div>{row.email}</div></td>
      <td style={{ whiteSpace: "pre-wrap", minWidth: "18rem" }}>{row.message}</td><td>{row.status === "new" ? "Needs review" : row.status.replaceAll("_", " ")}</td>
    </>} />
  </>;
}

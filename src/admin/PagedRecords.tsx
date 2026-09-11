import { useCallback, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { ArrowLeft, ArrowRight, Search } from "lucide-react";
import type { AdminPage } from "../../supabase/functions/_shared/portfolioProtocol";
import { Loading, ReadFailure } from "./AdminReads";
import { timeLabel } from "./readState";
import { useAdminRead } from "./useAdminRead";
const formatNumber = new Intl.NumberFormat();

export function PagedRecords<T extends { id: string }>({ app, title, searchLabel, columns, read, render }: { app: string; title: string; searchLabel: string; columns: string[]; read: (search: string, offset: number, signal: AbortSignal) => Promise<AdminPage<T>>; render: (item: T) => ReactNode }) {
  const [input, setInput] = useState("");
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const retry = () => setRefresh(value => value + 1);
  const reader = useCallback((signal: AbortSignal) => { void refresh; return read(search, offset, signal); }, [read, search, offset, refresh]);
  const state = useAdminRead(reader);
  function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); setSearch(input.trim()); setOffset(0); retry(); }
  return <section className="panel portfolio-records"><div className="panel-heading"><h2>{title}</h2></div><div className="admin-section-body"><form className="admin-course-search" onSubmit={submit}><label className="admin-search"><span className="admin-field-label">{searchLabel}</span><span className="admin-search-input"><Search size={16} aria-hidden="true" /><input type="search" maxLength={100} value={input} onChange={event => setInput(event.target.value)} /></span></label><button className="button button-primary" type="submit">Search</button></form>
    {state.status === "loading" && <Loading label={`Loading ${title.toLowerCase()}`} app={app} />}
    {state.status === "error" && <ReadFailure error={state.error} retry={retry} />}
    {state.status === "ready" && <><p role="status">{formatNumber.format(state.data.total)} matching records · loaded {timeLabel(state.receivedAt)}</p><div className="portfolio-table-wrap"><table><thead><tr>{columns.map(column => <th key={column} scope="col">{column}</th>)}</tr></thead><tbody>{state.data.items.map(row => <tr key={row.id}>{render(row)}</tr>)}</tbody></table></div>{state.data.items.length === 0 && <p>No records on this page. Adjust your search or return to the previous page.</p>}<div className="admin-pagination"><span>{state.data.items.length} shown</span><div><button className="button button-secondary button-small" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 20))}><ArrowLeft size={13} aria-hidden="true" />Previous</button><button className="button button-secondary button-small" disabled={offset + 20 >= state.data.total || offset + 20 > 10000} onClick={() => setOffset(offset + 20)}>Next<ArrowRight size={13} aria-hidden="true" /></button></div></div>{offset + 20 > 10000 && offset + 20 < state.data.total && <p>Refine your search to browse more records.</p>}</>}
    </div></section>;
}

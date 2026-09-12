import { useCallback } from "react";
import { PagedRecords } from "./PagedRecords";
import { operationsClient, type OperationsClient } from "./operationsClient";
import { timeLabel } from "./readState";
import { operationalCount, operationalStatus } from "./operationsPresentation";
import type {ConfigurationTarget} from './configurationProtocol';
type Configure=(target:ConfigurationTarget,label:string)=>void;
const recorded = (value: string | null) => value || "Not recorded";
const yesNo = (value: boolean) => value ? "Yes" : "No";
const date = (value: string | null) => value === null ? "Not recorded" : timeLabel(value);

export function JobRecords({ client = operationsClient,onConfigure,controlsDisabled=false }: { client?: OperationsClient;onConfigure?:Configure;controlsDisabled?:boolean }) {
  const read = useCallback(async (search: string, offset: number, signal: AbortSignal) => {
    const page = await client.jobs({ search, offset, signal });
    return { ...page, items: page.items.map(row => ({ ...row, id: row.jobKey })) };
  }, [client]);
  return <><p className="admin-explanation">CareBase’s recorded job activity. Worker and Edge jobs use execution records; a successful dispatch alone does not show that work completed.</p>
    <PagedRecords app="CareBase" title="Job activity" searchLabel="Search job names or keys" columns={["Job", "Execution", "Last recorded run", "Freshness", "Counts from last run", "Stop control"]} read={read} render={row => <>
      <td><strong>{recorded(row.displayName)}</strong><div>{row.jobKey}</div><details><summary>Description</summary>{recorded(row.description)}</details></td>
      <td><div>{row.executionKind.replaceAll("_", " ")}</div><div>Schedule: {row.schedule ?? "Not recorded"}</div><div>Critical: {yesNo(row.isCritical)}</div><div>Retry mode: {row.retryMode}</div></td>
      <td><strong>{operationalStatus(row.lastStatus)}</strong><div>Attempt: {date(row.lastAttemptAt)}</div><div>Success: {date(row.lastSuccessAt)}</div><div>Duration: {row.lastDurationMs === null ? "Not reported" : operationalCount(row.lastDurationMs) + " ms"}</div><div>Error recorded: {yesNo(row.hasError)}</div></td>
      <td><div>{row.isStale === null ? "Freshness not reported" : row.isStale ? "Stale" : "Not stale"}</div><div>Next expected: {date(row.nextExpectedAt)}</div></td>
      <td><div>Attempted: {operationalCount(row.attemptedCount)}</div><div>Succeeded: {operationalCount(row.succeededCount)}</div><div>Failed: {operationalCount(row.failedCount)}</div></td>
      <td><div>Stop switch set: {yesNo(row.killSwitchEnabled)}</div><div>{row.killSwitchCanStop ? "Native job reports stop support" : "Switch cannot stop this job"}</div>{onConfigure&&<button type="button" className="button button-secondary button-small" disabled={controlsDisabled} onClick={()=>onConfigure({kind:'job',jobKey:row.jobKey},row.displayName??row.jobKey)}>Configure job stop</button>}</td>
    </>} /></>;
}
export function ReleaseRecords({ client = operationsClient,onConfigure,controlsDisabled=false,organizationId=null }: { client?: OperationsClient;onConfigure?:Configure;controlsDisabled?:boolean;organizationId?:string|null }) {
  const read = useCallback(async (search: string, offset: number, signal: AbortSignal) => {
    const page = await client.releases({ search, offset, signal });
    return { ...page, items: page.items.map(row => ({ ...row, id: row.featureKey })) };
  }, [client]);
  return <><p className="admin-explanation">Stored CareBase release configuration. These settings do not prove that an application consumer checks a flag or that a feature is available to a particular organization. Unconfigured definitions have no rollout record.</p>
    <PagedRecords app="CareBase" title="Release configuration" searchLabel="Search feature names or keys" columns={["Feature", "Stored rollout", "Owner", "Dates", "Current stop configuration"]} read={read} render={row => <>
      <td><strong>{recorded(row.displayName)}</strong><div>{row.featureKey}</div><div>Definition active: {yesNo(row.isActive)}</div><details><summary>Description</summary>{recorded(row.description)}</details></td>
      <td><div>{row.rolloutMode === "unconfigured" ? "Not configured" : row.rolloutMode}</div><div>Enabled: {row.isEnabled === null ? "Not configured" : yesNo(row.isEnabled)}</div></td>
      <td>{recorded(row.owner)}</td><td><div>Updated: {date(row.updatedAt)}</div><div>Expires: {date(row.expiresAt)}</div></td>
      <td><div>Global stop: {yesNo(row.globalKillSwitch)}</div><div>Organization stops: {operationalCount(row.organizationKillSwitchCount)}</div>{onConfigure&&<><button type="button" className="button button-secondary button-small" disabled={controlsDisabled} onClick={()=>onConfigure({kind:'release',featureKey:row.featureKey},row.displayName??row.featureKey)}>Configure rollout</button><button type="button" className="button button-secondary button-small" disabled={controlsDisabled} onClick={()=>onConfigure({kind:'featureKill',featureKey:row.featureKey,organizationId},`${row.displayName??row.featureKey} stop`)}>Configure feature stop</button></>}</td>
    </>} /></>;
}
export function AuditRecords({ client = operationsClient }: { client?: OperationsClient }) {
  const read = useCallback((search: string, offset: number, signal: AbortSignal) => client.audit({ search, offset, signal }), [client]);
  return <><p className="admin-explanation">CareBase audit event identifiers, newest first. Event payloads, previous values, clinical records, and raw error messages are excluded.</p>
    <PagedRecords app="CareBase" title="Audit history" searchLabel="Search audit actions or entity types" columns={["Time / event", "Action", "Entity", "Organization", "Actor identifiers"]} read={read} render={row => <>
      <td><div>{date(row.createdAt)}</div><small>{row.id}</small></td><td>{recorded(row.action)}</td>
      <td><div>{recorded(row.entityType)}</div><small>{recorded(row.entityId)}</small></td><td>{recorded(row.organizationId)}</td>
      <td><div>Profile: {recorded(row.actorProfileId)}</div><div>Subject: {recorded(row.actorSubjectId)}</div></td>
    </>} /></>;
}

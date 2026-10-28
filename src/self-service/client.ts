import { appRequest } from '../lib/appSession';
import { profilePage, workspaceSchema, diagnosticSupportReceipt, type NativeOperation, type ProfileRecord } from './protocol';
import { myLearningSchema } from '../learning/model';

export const selfServiceClient = {
  workspace: (signal?: AbortSignal) => appRequest('self-service', { action: 'workspace' }, signal).then(value => workspaceSchema.parse(value)),
  diagnosticSupport: (connectionId: string, requestId: string) => appRequest('self-service', { action: 'diagnostic_support', connection_id: connectionId, request_id: requestId, confirmed: true }).then(value => diagnosticSupportReceipt.parse(value)),
  native: (connectionId: string, operation: NativeOperation, signal?: AbortSignal) => appRequest<unknown>('self-service', { action: 'native', connection_id: connectionId, operation }, signal),
  async profile(connectionId: string, signal?: AbortSignal): Promise<ProfileRecord[]> {
    const records: ProfileRecord[] = []; let cursor = 0;
    for (;;) {
      const page = profilePage.parse(await this.native(connectionId, { action: 'profile.read', cursor }, signal));
      records.push(...page.records);
      if (page.next_cursor === null) return records;
      if (page.next_cursor <= cursor || page.next_cursor > 1_000_000) throw new Error('The application returned an invalid history page.');
      cursor = page.next_cursor;
    }
  },
  async hubLearning(signal?: AbortSignal): Promise<ProfileRecord[]> {
    const rows = myLearningSchema.parse(await appRequest('rpc/list_my_learning', {}, signal));
    return rows.map(row => ({ source: 'hub', id: row.enrollmentId, title: row.title, kind: row.certificateId ? 'certificate' : 'assignment', completed_on: row.completedAt, expires_on: null,
      warning_days: 90, status: row.completedAt ? 'current' : 'assigned', href: row.certificateId ? `/learn/certificates/${row.enrollmentId}` : `/learn/courses/${row.itemId}` }));
  },
  prepare: (connectionId: string, operation: NativeOperation) => appRequest<{ confirmation_id: string; expires_in: number }>('self-service', { action: 'prepare', connection_id: connectionId, operation }),
  confirm: (confirmationId: string) => appRequest<unknown>('self-service', { action: 'confirm', confirmation_id: confirmationId }),
  connect: (token: string) => appRequest('self-service', { action: 'connect', token, confirmed: true }),
};

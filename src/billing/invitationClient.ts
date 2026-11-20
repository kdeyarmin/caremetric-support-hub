import { appRequest } from '../lib/appSession';
import {
  invitationCommandSchema, invitationListSchema, invitationPreviewSchema, invitationResultSchema,
  type Invitation, type InvitationRecord,
} from './invitationProtocol';

/** The owner's invitation commands (POST /api/admin/invitations, server/customer-invitations.mjs). */
export const invitationClient = {
  async list(signal?: AbortSignal): Promise<Invitation[]> {
    return invitationListSchema.parse(await appRequest('admin/invitations', invitationCommandSchema.parse({ action: 'list' }), signal)).invitations;
  },
  async preview(invitation: InvitationRecord) {
    return invitationPreviewSchema.parse(await appRequest('admin/invitations', invitationCommandSchema.parse({ action: 'preview', invitation })));
  },
  async create(invitation: InvitationRecord, requestKey: string) {
    return invitationResultSchema.parse(await appRequest('admin/invitations', invitationCommandSchema.parse({ action: 'create', invitation, request_key: requestKey })));
  },
  async change(action: 'resend' | 'revoke' | 'link', id: string, expectedVersion: number) {
    return invitationResultSchema.parse(await appRequest('admin/invitations', invitationCommandSchema.parse({ action, id, expected_version: expectedVersion })));
  },
};
export type InvitationClient = typeof invitationClient;

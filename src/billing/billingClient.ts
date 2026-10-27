import { z } from 'zod';
import { appRequest } from '../lib/appSession';
import { billingCommandSchema, billingResultSchema, type BillingCommand, type BillingResult } from './billingProtocol';
import { customerDetailSchema, workspaceSchema, type BillingWorkspace, type CustomerDetail } from './billingModel';

/** Every billing read and command the Hub's Billing workspace makes. */
export const billingClient = {
  async workspace(signal?: AbortSignal): Promise<BillingWorkspace> {
    return workspaceSchema.parse(await appRequest('rpc/billing_workspace', {}, signal));
  },
  async customer(tenantId: string, signal?: AbortSignal): Promise<CustomerDetail> {
    return customerDetailSchema.parse(await appRequest('rpc/billing_customer', { p_tenant_id: tenantId }, signal));
  },
  async command(command: BillingCommand): Promise<BillingResult> {
    return billingResultSchema.parse(await appRequest('admin/billing', billingCommandSchema.parse(command)));
  },
  async createTenant(record: { name: string; slug: string; industry: string }): Promise<{ id: string }> {
    return z.object({ id: z.guid() }).parse(await appRequest('rpc/create_tenant', { p_record: record }));
  },
  async saveTenant(tenantId: string, record: { name: string; industry: string; status: 'active' | 'suspended' | 'closed' }, expectedUpdatedAt: string) {
    return z.object({ id: z.guid(), updated_at: z.string() }).parse(await appRequest('rpc/save_tenant', { p_tenant_id: tenantId, p_record: record, p_expected_updated_at: expectedUpdatedAt }));
  },
};
export type BillingClient = typeof billingClient;

/** The tenant administrator's own billing, as hub.my_billing() returns it. */
const myInvoice = z.object({
  id: z.string(), number: z.string().nullable(), status: z.string(), currency: z.string(), total: z.number().int(), amount_remaining: z.number().int(),
  due_date: z.string().nullable(), created: z.string(), hosted_invoice_url: z.string().nullable(), invoice_pdf: z.string().nullable(),
});
const myItem = z.object({ name: z.string(), kind: z.string(), quantity: z.number().int(), unit_label: z.string(), unit_amount: z.number().int().nullable(),
  currency: z.string(), interval: z.string().nullable(), interval_count: z.number().int().nullable() });
const mySubscription = z.object({ app: z.string().nullable(), status: z.string(), cancel_at_period_end: z.boolean(), current_period_end: z.string().nullable(),
  trial_end: z.string().nullable(), paused: z.boolean(), items: z.array(myItem) });
export const myBillingSchema = z.object({
  tenants: z.array(z.object({ id: z.guid(), name: z.string(), has_customer: z.boolean(), subscriptions: z.array(mySubscription), invoices: z.array(myInvoice) })),
  loaded_at: z.string(),
});
export type MyBilling = z.infer<typeof myBillingSchema>;
export const customerBillingClient = {
  async read(signal?: AbortSignal): Promise<MyBilling> { return myBillingSchema.parse(await appRequest('rpc/my_billing', {}, signal)); },
  async portal(tenantId: string): Promise<string> {
    const { url } = z.object({ url: z.url().startsWith('https://billing.stripe.com/') }).parse(await appRequest('billing/portal', { tenant_id: tenantId }));
    return url;
  },
};
export type CustomerBillingClient = typeof customerBillingClient;

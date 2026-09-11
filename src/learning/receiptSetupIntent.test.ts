import { describe, expect, it, vi } from "vitest";
import { receiptSetupId, type ReceiptSetupIntent } from "./receiptSetupIntent";

const access = { operation: "provision_access", nativeOrganizationId: "ABC-org-one", nativeEmployeeId: "employee-one", hubUserId: "user-one", tenantName: "First tenant" } as const;
const binding = { operation: "provision", sourceSnapshotId: "snapshot-one", nativeOrganizationId: "org-one", nativeEmployeeId: "employee-one", hubTenantId: "tenant-one", hubUserId: "user-one" } as const;
describe("receipt setup intent allocations used by the editor", () => {
  it("provisions two new organizations from one mounted form with distinct tenant IDs", () => {
    const cache = new Map(); const createId = vi.fn().mockReturnValueOnce("tenant-1").mockReturnValueOnce("tenant-2");
    expect(receiptSetupId(cache, access, createId)).toBe("tenant-1");
    expect(receiptSetupId(cache, { ...access, nativeOrganizationId: "org-two", tenantName: "Second tenant" }, createId)).toBe("tenant-2");
    expect(receiptSetupId(cache, access, createId)).toBe("tenant-1"); expect(createId).toHaveBeenCalledTimes(2);
  });
  it("retains the exact access request ID after a lost response and normalized retry", () => {
    const cache = new Map(); const createId = vi.fn(() => "same-tenant-id");
    const sent = receiptSetupId(cache, access, createId);
    expect(receiptSetupId(cache, { ...access, nativeOrganizationId: "abc-ORG-one", tenantName: " First tenant " }, createId)).toBe(sent);
    expect(createId).toHaveBeenCalledTimes(1);
  });
  it("retains binding retries but allocates again for every changed immutable binding input", () => {
    const cache = new Map(); let n = 0; const createId = () => `mapping-${++n}`;
    const sent = receiptSetupId(cache, binding, createId);
    expect(receiptSetupId(cache, binding, createId)).toBe(sent);
    for (const key of ["sourceSnapshotId", "nativeOrganizationId", "nativeEmployeeId", "hubTenantId", "hubUserId"] as const) {
      expect(receiptSetupId(cache, { ...binding, [key]: "changed" } as ReceiptSetupIntent, createId)).not.toBe(sent);
    }
    expect(receiptSetupId(cache, binding, createId)).toBe(sent); expect(n).toBe(6);
  });
});

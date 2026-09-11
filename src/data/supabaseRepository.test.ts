import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  schema: vi.fn(),
}));

vi.mock("../lib/appSession", () => ({ hubClient: { rpc: mocks.rpc }, appRequest: vi.fn() }));

import { SupabaseSupportRepository } from "./supabaseRepository";

const caseRow = {
  id: "10000000-0000-4000-8000-000000000001",
  case_number: 1001,
  tenant_id: "20000000-0000-4000-8000-000000000001",
  tenant_name: "Test tenant",
  product_id: "30000000-0000-4000-8000-000000000001",
  requester_id: "40000000-0000-4000-8000-000000000001",
  requester_name: "Test user",
  subject: "Cannot open a report",
  category: "technical_issue",
  priority: "normal",
  status: "open",
  source: "portal",
  assigned_to: null,
  assigned_to_name: null,
  app_version: null,
  route: "/reports",
  created_at: "2026-09-07T20:00:00.000Z",
  updated_at: "2026-09-07T20:00:00.000Z",
  last_message_at: "2026-09-07T20:00:00.000Z",
};

const actorRow = {
  id: caseRow.requester_id,
  name: caseRow.requester_name,
  role: "tenant_admin",
  tenant_id: "20000000-0000-4000-8000-000000000001",
  tenant_name: "Tenant A",
  memberships: [
    {
      tenant_id: "20000000-0000-4000-8000-000000000001",
      tenant_name: "Tenant A",
      product_id: "30000000-0000-4000-8000-000000000001",
      role: "customer",
      intake_enabled: true,
    },
    {
      tenant_id: "20000000-0000-4000-8000-000000000002",
      tenant_name: "Tenant B",
      product_id: "30000000-0000-4000-8000-000000000002",
      role: "tenant_admin",
      intake_enabled: false,
    },
  ],
};

describe("SupabaseSupportRepository request keys", () => {
  beforeEach(() => {
    mocks.rpc.mockReset();
    mocks.schema.mockReset();
    mocks.schema.mockReturnValue({ rpc: mocks.rpc });
  });

  it("maps every actor membership as an exact tenant/product pair", async () => {
    mocks.rpc.mockResolvedValue({
      data: actorRow,
      error: null,
    });

    await expect(new SupabaseSupportRepository().getActorContext()).resolves.toEqual({
      id: caseRow.requester_id,
      name: caseRow.requester_name,
      role: "tenant_admin",
      tenantId: "20000000-0000-4000-8000-000000000001",
      tenantName: "Tenant A",
      memberships: [
        {
          tenantId: "20000000-0000-4000-8000-000000000001",
          tenantName: "Tenant A",
          productId: "30000000-0000-4000-8000-000000000001",
          role: "customer",
          intakeEnabled: true,
        },
        {
          tenantId: "20000000-0000-4000-8000-000000000002",
          tenantName: "Tenant B",
          productId: "30000000-0000-4000-8000-000000000002",
          role: "tenant_admin",
          intakeEnabled: false,
        },
      ],
    });
  });

  it("fails closed when actor memberships or intake state are absent or malformed", async () => {
    mocks.rpc
      .mockResolvedValueOnce({ data: { ...actorRow, memberships: undefined }, error: null })
      .mockResolvedValueOnce({
        data: {
          ...actorRow,
          memberships: [{ ...actorRow.memberships[0], intake_enabled: "true" }],
        },
        error: null,
      });

    const repository = new SupabaseSupportRepository();
    await expect(repository.getActorContext()).rejects.toThrow(/Missing actor memberships/);
    await expect(repository.getActorContext()).rejects.toThrow(/membership intake state/);
  });

  it("preserves a caller-supplied key for a retried create action", async () => {
    const requestKey = "50000000-0000-4000-8000-000000000001";
    mocks.rpc.mockResolvedValue({ data: caseRow, error: null });

    const repository = new SupabaseSupportRepository();
    await repository.createCase({
      tenantId: caseRow.tenant_id,
      productId: caseRow.product_id,
      subject: caseRow.subject,
      category: "technical_issue",
      priority: "normal",
      message: "The report does not open for me.",
      route: "/reports",
      containsPhi: false,
      requestKey,
    });

    expect(mocks.rpc).toHaveBeenCalledOnce();
    expect(mocks.rpc).toHaveBeenCalledWith(
      "create_support_case",
      expect.objectContaining({ p_request_key: requestKey }),
    );
  });

  it("preserves a caller-supplied key for a retried reply action", async () => {
    const requestKey = "50000000-0000-4000-8000-000000000002";
    mocks.rpc.mockResolvedValue({
      data: {
        id: "60000000-0000-4000-8000-000000000001",
        case_id: caseRow.id,
        author_id: caseRow.requester_id,
        author_name: caseRow.requester_name,
        author_role: "customer",
        visibility: "customer",
        body: "Here is the additional detail.",
        created_at: "2026-09-07T20:01:00.000Z",
      },
      error: null,
    });

    const repository = new SupabaseSupportRepository();
    await repository.replyToCase(
      caseRow.id,
      "Here is the additional detail.",
      "customer",
      requestKey,
    );

    expect(mocks.rpc).toHaveBeenCalledOnce();
    expect(mocks.rpc).toHaveBeenCalledWith(
      "reply_to_support_case",
      expect.objectContaining({ p_request_key: requestKey }),
    );
  });
});

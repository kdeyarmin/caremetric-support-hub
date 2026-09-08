import { beforeEach, describe, expect, it } from "vitest";
import { DemoSupportRepository } from "./demoRepository";

describe("DemoSupportRepository", () => {
  let repository: DemoSupportRepository;

  beforeEach(() => {
    repository = new DemoSupportRepository();
    repository.setActorRole("customer");
  });

  it("rejects an intake marked as containing PHI", async () => {
    await expect(
      repository.createCase({
        tenantId: "tenant-penn",
        productId: "prod-carebase",
        subject: "Need help",
        category: "general",
        priority: "normal",
        message: "Contains protected information",
        containsPhi: true,
        requestKey: "50000000-0000-4000-8000-000000000001",
      }),
    ).rejects.toThrow(/Remove patient or clinical information/);
  });

  it("creates the case and first message together", async () => {
    const created = await repository.createCase({
      tenantId: "tenant-penn",
      productId: "prod-carebase",
      subject: "  Invitation issue  ",
      category: "account_access",
      priority: "high",
      message: "  The invitation opens an expired page.  ",
      containsPhi: false,
      requestKey: "50000000-0000-4000-8000-000000000002",
    });

    const thread = await repository.listMessages(created.id);
    expect(created.subject).toBe("Invitation issue");
    expect(thread).toHaveLength(1);
    expect(thread[0]?.body).toBe("The invitation opens an expired page.");
  });

  it("rejects tenant/product pairs that are not an active demo entitlement", async () => {
    await expect(repository.createCase({
      tenantId: "tenant-other",
      productId: "prod-carebase",
      subject: "Need help",
      category: "general",
      priority: "normal",
      message: "The feature is not working.",
      containsPhi: false,
      requestKey: "50000000-0000-4000-8000-000000000004",
    })).rejects.toThrow(/No active support intake entitlement/);
  });

  it("prevents a customer from creating an internal note", async () => {
    await expect(repository.replyToCase(
      "case-1042",
      "Hidden note",
      "internal",
      "50000000-0000-4000-8000-000000000003",
    )).rejects.toThrow(
      /cannot create internal notes/,
    );
  });

  it("keeps the central phone in canonical E.164 form", async () => {
    const contacts = await repository.listContacts();
    expect(contacts.find((contact) => contact.channel === "phone")?.value).toBe("+18775212890");
  });
});

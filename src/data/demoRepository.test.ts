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
    });

    const thread = await repository.listMessages(created.id);
    expect(created.subject).toBe("Invitation issue");
    expect(thread).toHaveLength(1);
    expect(thread[0]?.body).toBe("The invitation opens an expired page.");
  });

  it("prevents a customer from creating an internal note", async () => {
    await expect(repository.replyToCase("case-1042", "Hidden note", "internal")).rejects.toThrow(
      /cannot create internal notes/,
    );
  });

  it("keeps the central phone in canonical E.164 form", async () => {
    const contacts = await repository.listContacts();
    expect(contacts.find((contact) => contact.channel === "phone")?.value).toBe("+18775212890");
  });
});

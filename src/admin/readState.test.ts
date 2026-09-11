import { describe, expect, it, vi } from "vitest";
import { describeAdminReadError, readAdminResource } from "./readState";

describe("central administration read state", () => {
  it("keeps actual zero counts distinct from an unavailable connection", async () => {
    const receive = vi.fn();
    await readAdminResource(async () => ({ organizationCount: 0 }), new AbortController().signal, receive);
    expect(receive).toHaveBeenCalledWith(expect.objectContaining({ status: "ready", data: { organizationCount: 0 } }));
    await readAdminResource(async () => { throw new Error("upstream body with sensitive data"); }, new AbortController().signal, receive);
    const failure = receive.mock.calls[1][0];
    expect(failure.status).toBe("error");
    expect(failure).not.toHaveProperty("data");
    expect(JSON.stringify(failure)).not.toContain("sensitive");
  });

  it.each(["401", "403", "unconfigured", "notfound", "upstream"])("explains the %s failure without rendering the upstream message", (code) => {
    const result = describeAdminReadError({ code, message: "private upstream error" });
    expect(result.message).not.toContain("private upstream error");
    expect(result.title).toBeTruthy();
  });

  it("ignores a late course response after selecting another course", async () => {
    const controller = new AbortController();
    let resolveRead: ((value: string) => void) | undefined;
    const receive = vi.fn();
    const pending = readAdminResource(() => new Promise<string>((resolve) => { resolveRead = resolve; }), controller.signal, receive);
    controller.abort();
    resolveRead?.("previous course");
    await pending;
    expect(receive).not.toHaveBeenCalled();
  });

  it("does not report an aborted request as a connection failure", async () => {
    const controller = new AbortController();
    const receive = vi.fn();
    const pending = readAdminResource(async () => { controller.abort(); throw new Error("aborted"); }, controller.signal, receive);
    await pending;
    expect(receive).not.toHaveBeenCalled();
  });

  it("does not start a request after its signal was cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const reader = vi.fn();
    await readAdminResource(reader, controller.signal, vi.fn());
    expect(reader).not.toHaveBeenCalled();
  });
});

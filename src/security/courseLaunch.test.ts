import { describe, expect, it } from "vitest";
import { courseLaunchUrl } from "./courseLaunch";

const item = {
  id: "e4e3090e-19cb-4d83-99e3-ec8aea17304a", kind: "course", status: "published",
  sourceSystem: "support_hub", courseLaunchPath: "/app/courses/0bff2a72-df79-4b48-bc1b-e989cd9d4d61",
} as const;

describe("course ownership routing", () => {
  it("opens a migrated course in the Hub despite retained source launch metadata", () => {
    expect(courseLaunchUrl(item, "https://cmcarebase.com")).toBe(`/learn/courses/${item.id}`);
    expect(courseLaunchUrl(item, undefined)).toBe(`/learn/courses/${item.id}`);
  });
  it("retains validated source routes for courses awaiting migration", () => {
    expect(courseLaunchUrl({ ...item, sourceSystem: "penntrain" }, "https://cmcarebase.com"))
      .toBe(`https://cmcarebase.com${item.courseLaunchPath}`);
    expect(courseLaunchUrl({ ...item, sourceSystem: "penntrain" }, "https://evil.example")).toBeNull();
  });
  it("does not launch unpublished content, non-courses, or malformed Hub IDs", () => {
    expect(courseLaunchUrl({ ...item, status: "draft" }, "https://cmcarebase.com")).toBeNull();
    expect(courseLaunchUrl({ ...item, kind: "article" }, "https://cmcarebase.com")).toBeNull();
    expect(courseLaunchUrl({ ...item, id: "../../admin" }, "https://cmcarebase.com")).toBeNull();
  });
});

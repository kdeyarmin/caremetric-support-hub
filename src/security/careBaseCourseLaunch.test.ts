import { describe, expect, it } from "vitest";
import { careBaseCourseLaunchUrl, careBaseCourseOrigin } from "./careBaseCourseLaunch";

const courseId = "e4e3090e-19cb-4d83-99e3-ec8aea17304a";

describe("careBaseCourseLaunchUrl", () => {
  it("launches the exact course catalog and UUID detail routes on CareBase", () => {
    expect(careBaseCourseLaunchUrl("/app/courses", careBaseCourseOrigin)).toBe(
      "https://cmcarebase.com/app/courses",
    );
    expect(careBaseCourseLaunchUrl(`/app/courses/${courseId}`, `${careBaseCourseOrigin}/`)).toBe(
      `https://cmcarebase.com/app/courses/${courseId}`,
    );
  });

  it.each([
    "http://cmcarebase.com",
    "https://caremetrictrain.com",
    "https://courses.cmcarebase.com",
    "https://cmcarebase.com.evil.example",
    "https://user@cmcarebase.com",
    "https://user:password@cmcarebase.com",
    "https://cmcarebase.com:443",
    "https://cmcarebase.com:8443",
    "https://cmcarebase.com/app",
    "https://cmcarebase.com/?source=hub",
    "https://cmcarebase.com/#courses",
  ])("rejects an unapproved or decorated configured origin: %s", (configuredBaseUrl) => {
    expect(careBaseCourseLaunchUrl(`/app/courses/${courseId}`, configuredBaseUrl)).toBeNull();
  });

  it.each([
    "/app/courses/",
    "/APP/COURSES",
    "/app/courses/not-a-uuid",
    "/app/courses/e4e3090e19cb4d8399e3ec8aea17304a",
    `/app/courses/${courseId}/lessons`,
    `/app/courses/${courseId}?source=hub`,
    `/app/courses/${courseId}#overview`,
    "/app/courses/../admin",
    "/app/courses/%2e%2e/admin",
    "/app/courses/%252e%252e/admin",
    "/app/courses%2f..%2fadmin",
    "//evil.example/app/courses",
    `https://cmcarebase.com/app/courses/${courseId}`,
  ])("rejects a non-canonical course path: %s", (courseLaunchPath) => {
    expect(careBaseCourseLaunchUrl(courseLaunchPath, careBaseCourseOrigin)).toBeNull();
  });

  it("fails closed when configuration or course metadata is missing", () => {
    expect(careBaseCourseLaunchUrl(`/app/courses/${courseId}`, "")).toBeNull();
    expect(careBaseCourseLaunchUrl(`/app/courses/${courseId}`, undefined)).toBeNull();
    expect(careBaseCourseLaunchUrl("", careBaseCourseOrigin)).toBeNull();
    expect(careBaseCourseLaunchUrl(undefined, careBaseCourseOrigin)).toBeNull();
  });
});

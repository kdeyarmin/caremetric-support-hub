export const careBaseCourseOrigin = "https://cmcarebase.com";

const configuredOriginPattern = /^https:\/\/cmcarebase\.com\/?$/;
const uuidPattern = "[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[1-5][0-9A-Fa-f]{3}-[89ABab][0-9A-Fa-f]{3}-[0-9A-Fa-f]{12}";
const coursePathPattern = new RegExp(`^/app/courses(?:/${uuidPattern})?$`);

/**
 * Builds a launch URL only for the canonical CareBase production origin and
 * the two supported course routes. The raw-string checks are intentional:
 * URL parsing normalizes some unsafe inputs, including an explicit :443 port.
 */
export function careBaseCourseLaunchUrl(
  courseLaunchPath: string | null | undefined,
  configuredBaseUrl: string | null | undefined,
): string | null {
  const configuredOrigin = configuredBaseUrl?.trim();
  if (!configuredOrigin || !configuredOriginPattern.test(configuredOrigin) || !courseLaunchPath) return null;
  if (!coursePathPattern.test(courseLaunchPath)) return null;

  return `${careBaseCourseOrigin}${courseLaunchPath}`;
}

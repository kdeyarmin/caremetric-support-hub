import type { ContentItem } from "../domain";
import { careBaseCourseLaunchUrl } from "./careBaseCourseLaunch";

const courseIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Published Hub ownership takes precedence over retained source provenance. */
export function courseLaunchUrl(
  item: Pick<ContentItem, "id" | "kind" | "status" | "sourceSystem" | "courseLaunchPath">,
  legacyBaseUrl: string | null | undefined,
): string | null {
  if (item.kind !== "course" || item.status !== "published") return null;
  if (item.sourceSystem === "support_hub") {
    return courseIdPattern.test(item.id) ? `/learn/courses/${item.id}` : null;
  }
  return careBaseCourseLaunchUrl(item.courseLaunchPath, legacyBaseUrl);
}

export interface CareBaseOverview {
  organizationCount: number;
  activeUserCount: number;
  globalCourseCount: number;
}

export interface CareBaseCourseSummary {
  id: string;
  title: string;
  description: string | null;
  category: string | null;
  status: string;
  estimatedDurationMinutes: number | null;
  updatedAt: string;
}

export interface CareBaseCoursePage {
  items: CareBaseCourseSummary[];
  total: number;
  limit: number;
  offset: number;
}

export interface CareBaseCourseDetail {
  course: CareBaseCourseSummary;
  lessons: Array<{ id: string; title: string | null; type: string; position: number }>;
  lessonsTruncated: boolean;
}

export interface AdminClient {
  getOverview(options: { signal: AbortSignal }): Promise<CareBaseOverview>;
  listCourses(options: { search?: string; offset: number; limit: number; signal: AbortSignal }): Promise<CareBaseCoursePage>;
  getCourse(options: { courseId: string; signal: AbortSignal }): Promise<CareBaseCourseDetail>;
}

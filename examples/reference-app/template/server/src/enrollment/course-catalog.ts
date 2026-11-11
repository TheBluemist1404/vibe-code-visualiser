import { Injectable } from "@nestjs/common";
import type { Course } from "./enrollment.types.js";

/** The seeded course catalog. Fixed data keeps runs and tests deterministic. */
export const SEED_COURSES: readonly Course[] = [
  { id: "crs-algebra", title: "Linear Algebra", capacity: 2 },
  { id: "crs-poetry", title: "Modern Poetry", capacity: 1 },
];

@Injectable()
export class CourseCatalog {
  private readonly courses = new Map(SEED_COURSES.map((c) => [c.id, { ...c }]));

  all(): Course[] {
    return [...this.courses.values()];
  }

  find(courseId: string): Course | undefined {
    return this.courses.get(courseId);
  }
}

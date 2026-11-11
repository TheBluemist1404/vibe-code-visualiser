import { Injectable } from "@nestjs/common";
import type { Enrollment } from "./enrollment.types.js";

/** In-memory enrollment storage. */
@Injectable()
export class EnrollmentRepository {
  private readonly rows: Enrollment[] = [];

  nextId(): string {
    return `enr-${this.rows.length + 1}`;
  }

  save(enrollment: Enrollment): Enrollment {
    this.rows.push(enrollment);
    return enrollment;
  }

  findById(id: string): Enrollment | undefined {
    return this.rows.find((e) => e.id === id);
  }

  confirmedFor(courseId: string): Enrollment[] {
    return this.rows.filter((e) => e.courseId === courseId && e.status === "confirmed");
  }
}

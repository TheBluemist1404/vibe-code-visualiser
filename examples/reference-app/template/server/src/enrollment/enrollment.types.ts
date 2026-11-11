/** Data contracts of the enrollment API. */

export interface Course {
  id: string;
  title: string;
  capacity: number;
}

export type CourseSummary = Course & { seatsLeft: number };

export type EnrollmentStatus = "confirmed" | "rejected";

export type RejectionReason = "COURSE_FULL" | "ALREADY_ENROLLED";

export interface Enrollment {
  id: string;
  studentId: string;
  courseId: string;
  status: EnrollmentStatus;
  /** Set when status is "rejected". */
  reason?: RejectionReason;
}

export interface EnrollmentRequest {
  studentId: string;
  courseId: string;
}

/** Validates an untrusted request body. Returns the request or a list of problems. */
export function parseEnrollmentRequest(body: unknown): EnrollmentRequest | { problems: string[] } {
  const problems: string[] = [];
  const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  for (const field of ["studentId", "courseId"] as const) {
    if (typeof b[field] !== "string" || !(b[field] as string).trim()) problems.push(`${field} must be a non-empty string`);
  }
  return problems.length ? { problems } : { studentId: (b.studentId as string).trim(), courseId: (b.courseId as string).trim() };
}

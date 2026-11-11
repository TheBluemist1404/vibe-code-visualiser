import { Injectable, NotFoundException } from "@nestjs/common";
import { NotificationsService } from "../notifications/notifications.service.js";
import { CourseCatalog } from "./course-catalog.js";
import { EnrollmentRepository } from "./enrollment.repository.js";
import type { CourseSummary, Enrollment, EnrollmentRequest, RejectionReason } from "./enrollment.types.js";

/**
 * Enrollment rules. Every decision is recorded and announced to the student:
 * a confirmed enrollment takes a seat; a full course or a repeat request is rejected.
 */
@Injectable()
export class EnrollmentService {
  constructor(
    private readonly catalog: CourseCatalog,
    private readonly enrollments: EnrollmentRepository,
    private readonly notifications: NotificationsService,
  ) {}

  courses(): CourseSummary[] {
    return this.catalog.all().map((c) => ({ ...c, seatsLeft: c.capacity - this.enrollments.confirmedFor(c.id).length }));
  }

  enroll(request: EnrollmentRequest): Enrollment {
    const course = this.catalog.find(request.courseId);
    if (!course) throw new NotFoundException(`unknown course ${request.courseId}`);

    const taken = this.enrollments.confirmedFor(course.id);
    const reason: RejectionReason | undefined = taken.some((e) => e.studentId === request.studentId)
      ? "ALREADY_ENROLLED"
      : taken.length >= course.capacity
        ? "COURSE_FULL"
        : undefined;

    const enrollment = this.enrollments.save({
      id: this.enrollments.nextId(),
      studentId: request.studentId,
      courseId: course.id,
      status: reason ? "rejected" : "confirmed",
      ...(reason ? { reason } : {}),
    });

    if (reason) {
      this.notifications.notify(
        enrollment.studentId,
        "enrollment-rejected",
        enrollment.id,
        reason === "COURSE_FULL" ? `${course.title} is full; your enrollment was not accepted.` : `You are already enrolled in ${course.title}.`,
      );
    } else {
      this.notifications.notify(enrollment.studentId, "enrollment-confirmed", enrollment.id, `You are enrolled in ${course.title}.`);
    }
    return enrollment;
  }

  get(id: string): Enrollment {
    const enrollment = this.enrollments.findById(id);
    if (!enrollment) throw new NotFoundException(`unknown enrollment ${id}`);
    return enrollment;
  }
}

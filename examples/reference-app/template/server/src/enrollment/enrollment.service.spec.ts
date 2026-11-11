import { describe, it, expect } from "vitest";
import { Test } from "@nestjs/testing";
import { NotificationsModule } from "../notifications/notifications.module.js";
import { NotificationsService } from "../notifications/notifications.service.js";
import { CourseCatalog } from "./course-catalog.js";
import { EnrollmentRepository } from "./enrollment.repository.js";
import { EnrollmentService } from "./enrollment.service.js";

async function setup() {
  const moduleRef = await Test.createTestingModule({
    imports: [NotificationsModule],
    providers: [CourseCatalog, EnrollmentRepository, EnrollmentService],
  }).compile();
  return { enrollment: moduleRef.get(EnrollmentService), notifications: moduleRef.get(NotificationsService) };
}

describe("EnrollmentService", () => {
  it("confirms an enrollment while seats are left and notifies the student", async () => {
    const { enrollment, notifications } = await setup();
    const e = enrollment.enroll({ studentId: "stu-ada", courseId: "crs-poetry" });
    expect(e).toEqual({ id: "enr-1", studentId: "stu-ada", courseId: "crs-poetry", status: "confirmed" });
    expect(notifications.forRecipient("stu-ada")).toEqual([
      { id: "ntf-1", recipientId: "stu-ada", kind: "enrollment-confirmed", enrollmentId: "enr-1", message: "You are enrolled in Modern Poetry." },
    ]);
    expect(enrollment.courses().find((c) => c.id === "crs-poetry")?.seatsLeft).toBe(0);
  });

  it("rejects an enrollment into a full course and notifies the student", async () => {
    const { enrollment, notifications } = await setup();
    enrollment.enroll({ studentId: "stu-ada", courseId: "crs-poetry" });
    const e = enrollment.enroll({ studentId: "stu-bob", courseId: "crs-poetry" });
    expect(e).toMatchObject({ status: "rejected", reason: "COURSE_FULL" });
    expect(notifications.forRecipient("stu-bob")).toEqual([
      expect.objectContaining({ kind: "enrollment-rejected", enrollmentId: e.id }),
    ]);
  });

  it("rejects a repeat enrollment without taking a second seat", async () => {
    const { enrollment } = await setup();
    enrollment.enroll({ studentId: "stu-ada", courseId: "crs-algebra" });
    expect(enrollment.enroll({ studentId: "stu-ada", courseId: "crs-algebra" })).toMatchObject({ status: "rejected", reason: "ALREADY_ENROLLED" });
    expect(enrollment.courses().find((c) => c.id === "crs-algebra")?.seatsLeft).toBe(1);
  });

  it("refuses an unknown course without recording or notifying anything", async () => {
    const { enrollment, notifications } = await setup();
    expect(() => enrollment.enroll({ studentId: "stu-ada", courseId: "crs-missing" })).toThrow("unknown course crs-missing");
    expect(notifications.forRecipient("stu-ada")).toEqual([]);
  });
});

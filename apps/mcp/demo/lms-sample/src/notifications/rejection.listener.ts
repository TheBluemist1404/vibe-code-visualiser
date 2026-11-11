// Invented sample code for the VCV M1 agent demo; not the real LMS.
import { enrollmentEvents, EnrollmentRepository } from "../enrollment/enrollment.service.ts";

export function registerRejectionNotice(repo: EnrollmentRepository, send: (to: string, text: string) => void) {
  enrollmentEvents.on("enrollment.rejected", (e: { requestId: string; studentId: string }) => {
    // Reads the student's note straight from Enrollment's repository.
    const note = repo.get(e.requestId)?.note ?? "";
    send(e.studentId, `Your enrollment request was rejected. ${note}`);
  });
}

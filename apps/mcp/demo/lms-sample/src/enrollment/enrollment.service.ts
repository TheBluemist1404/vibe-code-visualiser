// Invented sample code for the VCV M1 agent demo; not the real LMS.
import { EventEmitter } from "node:events";

export type EnrollmentRequest = { id: string; studentId: string; status: "pending" | "approved" | "rejected"; note?: string };

export const enrollmentEvents = new EventEmitter();

export class EnrollmentRepository {
  private rows = new Map<string, EnrollmentRequest>();
  get(id: string) { return this.rows.get(id); }
  save(r: EnrollmentRequest) { this.rows.set(r.id, r); }
}

export class EnrollmentService {
  constructor(readonly repo: EnrollmentRepository) {}

  reject(id: string, lecturerId: string) {
    const r = this.repo.get(id);
    if (!r || r.status !== "pending") throw new Error("only pending requests can be rejected");
    r.status = "rejected";
    this.repo.save(r);
    enrollmentEvents.emit("enrollment.rejected", { requestId: id, studentId: r.studentId, by: lecturerId });
  }
}

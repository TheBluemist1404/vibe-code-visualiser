/** Mirrors the server's data contracts (enrollment.types.ts and notification.types.ts). */
export interface CourseSummary {
  id: string;
  title: string;
  capacity: number;
  seatsLeft: number;
}

export interface Enrollment {
  id: string;
  studentId: string;
  courseId: string;
  status: "confirmed" | "rejected";
  reason?: "COURSE_FULL" | "ALREADY_ENROLLED";
}

export interface Notification {
  id: string;
  recipientId: string;
  kind: "enrollment-confirmed" | "enrollment-rejected";
  message: string;
  enrollmentId: string;
}

export interface CourseDeskApi {
  courses(): Promise<CourseSummary[]>;
  enroll(studentId: string, courseId: string): Promise<Enrollment>;
  notifications(recipientId: string): Promise<Notification[]>;
}

export function httpApi(base = "/api", fetchImpl: typeof fetch = fetch): CourseDeskApi {
  const json = async <T,>(res: Response): Promise<T> => {
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return (await res.json()) as T;
  };
  return {
    courses: async () => json(await fetchImpl(`${base}/courses`)),
    enroll: async (studentId, courseId) =>
      json(await fetchImpl(`${base}/enrollments`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ studentId, courseId }) })),
    notifications: async (recipientId) => json(await fetchImpl(`${base}/notifications?recipientId=${encodeURIComponent(recipientId)}`)),
  };
}

import { useEffect, useState } from "react";
import type { CourseDeskApi, CourseSummary, Enrollment, Notification } from "./api/client";
import { EnrollmentForm } from "./components/EnrollmentForm";
import { NotificationList } from "./components/NotificationList";

export function App({ api }: { api: CourseDeskApi }) {
  const [courses, setCourses] = useState<CourseSummary[]>([]);
  const [last, setLast] = useState<Enrollment | null>(null);
  const [inbox, setInbox] = useState<{ recipientId: string; items: Notification[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.courses().then(setCourses, (e: Error) => setError(e.message));
  }, [api]);

  const enroll = async (studentId: string, courseId: string) => {
    try {
      setError(null);
      const enrollment = await api.enroll(studentId, courseId);
      setLast(enrollment);
      // The outcome reaches the student as a notification, so show their inbox next.
      const [items, updated] = await Promise.all([api.notifications(studentId), api.courses()]);
      setInbox({ recipientId: studentId, items });
      setCourses(updated);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <main>
      <h1>Course Desk</h1>
      <EnrollmentForm courses={courses} onEnroll={(s, c) => void enroll(s, c)} />
      {last && (
        <p role="status">
          Enrollment {last.id}: {last.status}
          {last.reason ? ` (${last.reason})` : ""}
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {inbox && <NotificationList recipientId={inbox.recipientId} items={inbox.items} />}
    </main>
  );
}

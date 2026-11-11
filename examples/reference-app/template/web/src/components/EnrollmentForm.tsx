import { useState } from "react";
import type { FormEvent } from "react";
import type { CourseSummary } from "../api/client";

interface Props {
  courses: CourseSummary[];
  onEnroll(studentId: string, courseId: string): void;
}

export function EnrollmentForm({ courses, onEnroll }: Props) {
  const [studentId, setStudentId] = useState("stu-ada");
  const [courseId, setCourseId] = useState("");
  const selected = courseId || courses[0]?.id || "";

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (studentId.trim() && selected) onEnroll(studentId.trim(), selected);
  };

  return (
    <form onSubmit={submit} aria-label="Enroll">
      <label>
        Student ID <input value={studentId} onChange={(e) => setStudentId(e.target.value)} />
      </label>
      <label>
        Course{" "}
        <select value={selected} onChange={(e) => setCourseId(e.target.value)}>
          {courses.map((c) => (
            <option key={c.id} value={c.id}>
              {c.title} ({c.seatsLeft} of {c.capacity} seats left)
            </option>
          ))}
        </select>
      </label>
      <button type="submit">Enroll</button>
    </form>
  );
}

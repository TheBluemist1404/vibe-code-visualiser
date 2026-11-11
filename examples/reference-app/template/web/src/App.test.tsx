import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { httpApi } from "./api/client";
import type { CourseDeskApi, Enrollment, Notification } from "./api/client";

afterEach(cleanup);

/** A fake API with the server's observable behavior for one course with one seat. */
function fakeApi(): CourseDeskApi {
  const enrollments: Enrollment[] = [];
  const notifications: Notification[] = [];
  const confirmed = () => enrollments.filter((e) => e.status === "confirmed").length;
  return {
    courses: async () => [{ id: "crs-poetry", title: "Modern Poetry", capacity: 1, seatsLeft: 1 - confirmed() }],
    enroll: async (studentId, courseId) => {
      const full = confirmed() >= 1;
      const e: Enrollment = { id: `enr-${enrollments.length + 1}`, studentId, courseId, status: full ? "rejected" : "confirmed", ...(full ? { reason: "COURSE_FULL" as const } : {}) };
      enrollments.push(e);
      notifications.push({
        id: `ntf-${notifications.length + 1}`,
        recipientId: studentId,
        kind: full ? "enrollment-rejected" : "enrollment-confirmed",
        enrollmentId: e.id,
        message: full ? "Modern Poetry is full; your enrollment was not accepted." : "You are enrolled in Modern Poetry.",
      });
      return e;
    },
    notifications: async (recipientId) => notifications.filter((n) => n.recipientId === recipientId),
  };
}

describe("App", () => {
  it("shows the outcome and the student's notification after enrolling, then a rejection when full", async () => {
    render(<App api={fakeApi()} />);
    await screen.findByRole("option", { name: "Modern Poetry (1 of 1 seats left)" });

    fireEvent.click(screen.getByRole("button", { name: "Enroll" }));
    expect((await screen.findByRole("status")).textContent).toBe("Enrollment enr-1: confirmed");
    expect(await screen.findByText("You are enrolled in Modern Poetry.")).toBeTruthy();
    await screen.findByRole("option", { name: "Modern Poetry (0 of 1 seats left)" });

    fireEvent.change(screen.getByLabelText("Student ID"), { target: { value: "stu-bob" } });
    fireEvent.click(screen.getByRole("button", { name: "Enroll" }));
    await screen.findByText("Enrollment enr-2: rejected (COURSE_FULL)");
    expect(await screen.findByText("Modern Poetry is full; your enrollment was not accepted.")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Notifications for stu-bob" })).toBeTruthy();
  });
});

describe("httpApi", () => {
  it("posts enrollments as JSON to the server's routes", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ id: "enr-1" }), { status: 201 }));
    await httpApi("/api", fetchImpl as unknown as typeof fetch).enroll("stu-ada", "crs-poetry");
    expect(fetchImpl).toHaveBeenCalledWith("/api/enrollments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ studentId: "stu-ada", courseId: "crs-poetry" }),
    });
  });

  it("surfaces HTTP errors", async () => {
    const fetchImpl = async () => new Response("{}", { status: 404, statusText: "Not Found" });
    await expect(httpApi("/api", fetchImpl as typeof fetch).notifications("x")).rejects.toThrow("404 Not Found");
  });
});

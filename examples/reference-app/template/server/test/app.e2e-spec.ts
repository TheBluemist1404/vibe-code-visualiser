import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { AppModule } from "../src/app.module.js";
import { configureApp } from "../src/app.setup.js";

describe("Course Desk API (e2e)", () => {
  let app: INestApplication;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(moduleRef.createNestApplication());
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it("lists the seeded courses with free seats", async () => {
    const res = await request(app.getHttpServer()).get("/api/courses").expect(200);
    expect(res.body).toEqual([
      { id: "crs-algebra", title: "Linear Algebra", capacity: 2, seatsLeft: 2 },
      { id: "crs-poetry", title: "Modern Poetry", capacity: 1, seatsLeft: 1 },
    ]);
  });

  it("confirms, then rejects when full; each student is notified of their outcome", async () => {
    const server = app.getHttpServer();
    const first = await request(server).post("/api/enrollments").send({ studentId: "stu-ada", courseId: "crs-poetry" }).expect(201);
    expect(first.body).toEqual({ id: "enr-1", studentId: "stu-ada", courseId: "crs-poetry", status: "confirmed" });

    const second = await request(server).post("/api/enrollments").send({ studentId: "stu-bob", courseId: "crs-poetry" }).expect(201);
    expect(second.body).toEqual({ id: "enr-2", studentId: "stu-bob", courseId: "crs-poetry", status: "rejected", reason: "COURSE_FULL" });

    await request(server).get("/api/enrollments/enr-2").expect(200, second.body);

    const ada = await request(server).get("/api/notifications").query({ recipientId: "stu-ada" }).expect(200);
    expect(ada.body).toEqual([{ id: "ntf-1", recipientId: "stu-ada", kind: "enrollment-confirmed", enrollmentId: "enr-1", message: "You are enrolled in Modern Poetry." }]);
    const bob = await request(server).get("/api/notifications").query({ recipientId: "stu-bob" }).expect(200);
    expect(bob.body).toEqual([
      { id: "ntf-2", recipientId: "stu-bob", kind: "enrollment-rejected", enrollmentId: "enr-2", message: "Modern Poetry is full; your enrollment was not accepted." },
    ]);
  });

  it("answers 400 for an invalid request and 404 for unknown courses or enrollments", async () => {
    const server = app.getHttpServer();
    await request(server).post("/api/enrollments").send({ studentId: "" }).expect(400);
    await request(server).post("/api/enrollments").send({ studentId: "stu-ada", courseId: "crs-missing" }).expect(404);
    await request(server).get("/api/enrollments/enr-99").expect(404);
    await request(server).get("/api/notifications").expect(400);
  });
});

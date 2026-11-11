import { BadRequestException, Body, Controller, Get, HttpCode, Param, Post } from "@nestjs/common";
import { EnrollmentService } from "./enrollment.service.js";
import { parseEnrollmentRequest } from "./enrollment.types.js";
import type { CourseSummary, Enrollment } from "./enrollment.types.js";

@Controller()
export class EnrollmentController {
  constructor(private readonly enrollment: EnrollmentService) {}

  @Get("courses")
  courses(): CourseSummary[] {
    return this.enrollment.courses();
  }

  /** Always answers 201 with the recorded decision; a rejection is a result, not an error. */
  @Post("enrollments")
  @HttpCode(201)
  enroll(@Body() body: unknown): Enrollment {
    const request = parseEnrollmentRequest(body);
    if ("problems" in request) throw new BadRequestException(request.problems);
    return this.enrollment.enroll(request);
  }

  @Get("enrollments/:id")
  get(@Param("id") id: string): Enrollment {
    return this.enrollment.get(id);
  }
}

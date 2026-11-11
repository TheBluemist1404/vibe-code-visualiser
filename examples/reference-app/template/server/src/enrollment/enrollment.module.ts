import { Module } from "@nestjs/common";
import { NotificationsModule } from "../notifications/notifications.module.js";
import { CourseCatalog } from "./course-catalog.js";
import { EnrollmentController } from "./enrollment.controller.js";
import { EnrollmentRepository } from "./enrollment.repository.js";
import { EnrollmentService } from "./enrollment.service.js";

@Module({
  imports: [NotificationsModule],
  controllers: [EnrollmentController],
  providers: [CourseCatalog, EnrollmentRepository, EnrollmentService],
})
export class EnrollmentModule {}

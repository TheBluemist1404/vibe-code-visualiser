import { Module } from "@nestjs/common";
import { EnrollmentModule } from "./enrollment/enrollment.module.js";
import { NotificationsModule } from "./notifications/notifications.module.js";

@Module({
  imports: [EnrollmentModule, NotificationsModule],
})
export class AppModule {}

import { BadRequestException, Controller, Get, Query } from "@nestjs/common";
import type { Notification } from "./notification.types.js";
import { NotificationsService } from "./notifications.service.js";

@Controller("notifications")
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  list(@Query("recipientId") recipientId?: string): Notification[] {
    if (!recipientId) throw new BadRequestException("recipientId is required");
    return this.notifications.forRecipient(recipientId);
  }
}

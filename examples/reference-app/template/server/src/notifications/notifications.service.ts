import { Injectable } from "@nestjs/common";
import type { Notification, NotificationKind } from "./notification.types.js";

/**
 * In-memory outbox. Other modules call notify(); recipients read their notifications over HTTP.
 * Delivery is deterministic: IDs are sequential and nothing leaves the process.
 */
@Injectable()
export class NotificationsService {
  private readonly outbox: Notification[] = [];

  notify(recipientId: string, kind: NotificationKind, enrollmentId: string, message: string): Notification {
    const notification: Notification = { id: `ntf-${this.outbox.length + 1}`, recipientId, kind, message, enrollmentId };
    this.outbox.push(notification);
    return notification;
  }

  forRecipient(recipientId: string): Notification[] {
    return this.outbox.filter((n) => n.recipientId === recipientId);
  }
}

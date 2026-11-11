export type NotificationKind = "enrollment-confirmed" | "enrollment-rejected";

export interface Notification {
  id: string;
  recipientId: string;
  kind: NotificationKind;
  /** Human-readable text shown to the recipient. */
  message: string;
  /** The enrollment this notification is about. */
  enrollmentId: string;
}

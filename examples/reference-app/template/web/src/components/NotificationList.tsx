import type { Notification } from "../api/client";

export function NotificationList({ recipientId, items }: { recipientId: string; items: Notification[] }) {
  return (
    <section aria-label="Notifications">
      <h2>Notifications for {recipientId}</h2>
      {items.length === 0 ? (
        <p>No notifications yet.</p>
      ) : (
        <ul>
          {items.map((n) => (
            <li key={n.id} data-kind={n.kind}>
              {n.message}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

import { describe, it, expect } from "vitest";
import { NotificationsService } from "./notifications.service.js";

describe("NotificationsService", () => {
  it("keeps each recipient's notifications separate, in order", () => {
    const service = new NotificationsService();
    service.notify("stu-ada", "enrollment-confirmed", "enr-1", "first");
    service.notify("stu-bob", "enrollment-rejected", "enr-2", "other");
    service.notify("stu-ada", "enrollment-rejected", "enr-3", "second");

    expect(service.forRecipient("stu-ada").map((n) => [n.id, n.message])).toEqual([
      ["ntf-1", "first"],
      ["ntf-3", "second"],
    ]);
    expect(service.forRecipient("stu-nobody")).toEqual([]);
  });
});

/**
 * Gửi thông báo thử tới mọi thiết bị của một người dùng.
 *
 *   npm run notify:test -- <userId>
 *
 * Chạy từ máy dev: dùng chung DB Turso trong .env và file khoá đặt ở
 * GOOGLE_APPLICATION_CREDENTIALS. Không in registration id/token ra màn hình.
 */
import "../config/env.js";
import { newId } from "../utils/id.js";
import { listDevicesByUser } from "../repositories/notifications.js";
import { initFirebase } from "../services/firebase.js";
import { notifyUser } from "../services/notifications.js";

const main = async (): Promise<number> => {
  const userId = process.argv[2];
  if (!userId || userId.startsWith("-")) {
    console.error("Cách dùng: npm run notify:test -- <userId>");
    return 1;
  }

  const ready = await initFirebase();
  if (!ready) {
    console.error(
      "Firebase chưa sẵn sàng. Đặt GOOGLE_APPLICATION_CREDENTIALS trong .env trỏ tới file service account."
    );
    return 1;
  }

  const devices = await listDevicesByUser(userId);
  if (devices.length === 0) {
    console.error(
      "Người dùng này chưa có thiết bị nào (gọi POST /api/v1/devices từ app trước)."
    );
    return 1;
  }
  console.log(
    `Gửi thông báo thử tới ${devices.length} thiết bị: ` +
      `${devices.filter((d) => d.kind === "fid").length} fid, ` +
      `${devices.filter((d) => d.kind === "token").length} token...`
  );

  const result = await notifyUser(userId, {
    title: "Thông báo thử",
    body: "Nếu bạn thấy tin này, FCM đang hoạt động.",
    data: { type: "test", id: newId() },
  });

  console.log(
    `Thiết bị: ${result.devices} | thành công: ${result.sent} | ` +
      `thất bại: ${result.failed} | đã xóa (không còn hợp lệ): ${result.removed}`
  );
  if (result.error) console.error(`Lỗi: ${result.error}`);
  return result.sent > 0 ? 0 : 1;
};

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error("Fatal error:", error instanceof Error ? error.message : error);
    process.exit(1);
  });

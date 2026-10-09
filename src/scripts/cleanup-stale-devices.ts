/**
 * Xóa các thiết bị push có last_seen_at cũ hơn N ngày (mặc định 30).
 * Chạy tay, chưa được lên lịch tự động.
 *
 *   npm run devices:cleanup                  # xóa thiết bị cũ hơn 30 ngày
 *   npm run devices:cleanup -- 45            # ngưỡng 45 ngày
 *   npm run devices:cleanup -- --dry-run     # chỉ đếm, không xóa
 */
import {
  cleanupStaleDevices,
  DEFAULT_STALE_DEVICE_DAYS,
} from "../services/notifications.js";

const main = async (): Promise<number> => {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const daysArg = args.find((arg) => !arg.startsWith("-"));
  const days = daysArg === undefined ? DEFAULT_STALE_DEVICE_DAYS : Number(daysArg);

  if (!Number.isFinite(days) || days <= 0) {
    console.error("Số ngày phải là số dương. Ví dụ: npm run devices:cleanup -- 30");
    return 1;
  }

  const result = await cleanupStaleDevices(days, { dryRun });
  console.log(
    dryRun
      ? `[dry-run] ${result.count} thiết bị có last_seen_at < ${result.cutoff} (chưa xóa).`
      : `Đã xóa ${result.count} thiết bị có last_seen_at < ${result.cutoff}.`
  );
  return 0;
};

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error("Fatal error:", error instanceof Error ? error.message : error);
    process.exit(1);
  });

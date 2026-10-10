import "dotenv/config";
import { z } from "zod";
import { normalizeFastLoopSeconds } from "./notification-policy.js";

const boolFromEnv = z
  .string()
  .optional()
  .transform((value) => {
    if (value === undefined || value.trim() === "") return false;
    return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
  });

// Biến bí mật tùy chọn: để trống/không đặt = chưa cấu hình (không phải lỗi).
const optionalSecret = (minLength: number) =>
  z
    .string()
    .optional()
    .transform((value) => (value && value.trim() !== "" ? value.trim() : undefined))
    .refine((value) => value === undefined || value.length >= minLength, {
      message: `must be at least ${minLength} chars when set`,
    });

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),

  TURSO_DATABASE_URL: z.string().min(1, "TURSO_DATABASE_URL is required"),
  TURSO_AUTH_TOKEN: z.string().optional(),

  JWT_SECRET: z.string().min(16, "JWT_SECRET must be at least 16 chars"),
  JWT_ADMIN_SECRET: z.string().min(16, "JWT_ADMIN_SECRET must be at least 16 chars"),
  COOKIE_SECRET: z.string().min(32, "COOKIE_SECRET must be at least 32 chars"),

  ADMIN_USERNAME: z.string().min(1, "ADMIN_USERNAME is required"),
  ADMIN_PASSWORD_HASH: z
    .string()
    .regex(/^\$2[aby]\$\d{2}\$.{53}$/, "ADMIN_PASSWORD_HASH must be a bcrypt hash (run `npm run admin:hash <password>`)"),

  // Thông báo theo lịch (notification_jobs). Tick ngoài: POST /internal/notifications/tick
  // với header x-notify-tick-secret; thiếu NOTIFY_TICK_SECRET thì endpoint từ chối mọi yêu cầu.
  NOTIFY_TICK_SECRET: optionalSecret(16),
  // Tự tick mỗi 60 s trong tiến trình (chỉ chạy khi instance đang thức).
  NOTIFY_INPROCESS_TICK: boolFromEnv,
  // Chu kỳ (giây) của vòng NHANH gửi job đến hạn khi NOTIFY_INPROCESS_TICK=true.
  // Mặc định 3, tối thiểu 1; giá trị sai được chuẩn hóa thay vì làm sập server.
  NOTIFY_FAST_LOOP_SECONDS: z.string().optional().transform(normalizeFastLoopSeconds),
  // Chỉ ghi log, không gọi FCM (job vẫn được đánh sent).
  NOTIFY_DRY_RUN: boolFromEnv,
  // Application Default Credentials: path to the service-account JSON file
  // (on Render: the Secret File, /etc/secrets/<name>).
  GOOGLE_APPLICATION_CREDENTIALS: z.string().trim().min(1).optional(),
  // Deprecated alias of GOOGLE_APPLICATION_CREDENTIALS, kept so existing deploys keep working.
  FIREBASE_SERVICE_ACCOUNT_PATH: z.string().trim().min(1).optional(),
});

const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment variables:");
  for (const issue of parsed.error.issues) {
    console.error(`  - ${issue.path.join(".")}: ${issue.message}`);
  }
  process.exit(1);
}

// firebase-admin's applicationDefault() reads GOOGLE_APPLICATION_CREDENTIALS straight
// from process.env, so mirror the deprecated alias into it before anything initialises the SDK.
if (
  !parsed.data.GOOGLE_APPLICATION_CREDENTIALS &&
  parsed.data.FIREBASE_SERVICE_ACCOUNT_PATH
) {
  parsed.data.GOOGLE_APPLICATION_CREDENTIALS =
    parsed.data.FIREBASE_SERVICE_ACCOUNT_PATH;
  process.env.GOOGLE_APPLICATION_CREDENTIALS =
    parsed.data.FIREBASE_SERVICE_ACCOUNT_PATH;
}

export const env = parsed.data;
export type Env = typeof env;

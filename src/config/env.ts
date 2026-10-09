import "dotenv/config";
import { z } from "zod";

const boolFromEnv = z
  .string()
  .optional()
  .transform((value) => {
    if (value === undefined || value.trim() === "") return false;
    return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
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

  NOTIFICATIONS_ENABLED: boolFromEnv,
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

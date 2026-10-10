import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import sensible from "@fastify/sensible";
import { env } from "./config/env.js";
import viewPlugin from "./plugins/view.js";
import adminAuth from "./plugins/admin-auth.js";
import userAuth from "./plugins/user-auth.js";
import adminRoutes from "./routes/admin/index.js";
import apiRoutes from "./routes/api/v1/index.js";
import notificationRoutes from "./routes/api/notifications.js";
import internalNotificationRoutes from "./routes/internal/notifications.js";
import {
  startNotificationScheduler,
  stopNotificationScheduler,
} from "./services/notification-scheduler.js";
import { startDailyTodoLogScheduler } from "./services/daily-todo-log-scheduler.js";
import { initFirebase } from "./services/firebase.js";
import { createShutdownHandler } from "./utils/graceful-shutdown.js";

const app: FastifyInstance = Fastify({
  logger: {
    transport:
      env.NODE_ENV !== "production" ? { target: "pino-pretty" } : undefined,
  },
});

// Security
await app.register(helmet, {
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", "data:"],
      formAction: ["'self'"],
      baseUri: ["'self'"],
    },
  },
});
await app.register(cors, { origin: true });
await app.register(sensible);

// ── Custom JSON body parser ────────────────────────────────────────────────────
// Fastify 5 throws FST_ERR_CTP_EMPTY_JSON_BODY when Content-Type: application/json
// is sent with no body (Flutter sends this header on every request including DELETE).
// Override the default parser to treat an empty body as undefined instead of 400.
app.addContentTypeParser(
  "application/json",
  { parseAs: "string" },
  (req, body, done) => {
    if (!body || (body as string).trim() === "") {
      done(null, undefined);
      return;
    }
    try {
      done(null, JSON.parse(body as string));
    } catch (err) {
      const e = err as Error & { statusCode?: number };
      e.statusCode = 400;
      done(e, undefined);
    }
  }
);

// View + static + formbody
await app.register(viewPlugin);

// Admin auth (cookie + jwt default namespace)
await app.register(adminAuth);

// Mobile/user auth (jwt namespace "user", bearer token)
await app.register(userAuth);

// Public health
app.get("/health", async () => ({
  status: "ok",
  time: new Date().toISOString(),
}));

// Admin web
await app.register(adminRoutes, { prefix: "/admin" });

// Mobile REST API
await app.register(apiRoutes, { prefix: "/api/v1" });

// Notification API alias requested by mobile integrations.
await app.register(notificationRoutes, { prefix: "/api/notifications" });

// Notification tick for an external cron (Render sleeps when idle). Protected by
// NOTIFY_TICK_SECRET in the x-notify-tick-secret header; without it every request is rejected.
await app.register(internalNotificationRoutes, {
  prefix: "/internal/notifications",
  secret: env.NOTIFY_TICK_SECRET,
  dryRun: env.NOTIFY_DRY_RUN,
});
if (!env.NOTIFY_TICK_SECRET && !env.NOTIFY_INPROCESS_TICK) {
  app.log.warn(
    "Neither NOTIFY_TICK_SECRET nor NOTIFY_INPROCESS_TICK is set; scheduled notifications will not be sent"
  );
}

// Firebase Admin SDK (Application Default Credentials). Missing credentials only
// log a warning; the server keeps running with push disabled.
await initFirebase(app.log);

// With NOTIFY_INPROCESS_TICK=true the loops run inside this process, so SIGTERM (every Render
// deploy) must let an in-flight send finish and be recorded before the process exits.
// Without the loops nothing is registered and shutdown behaves exactly as before.
if (startNotificationScheduler(app.log)) {
  const shutdown = createShutdownHandler({
    stop: stopNotificationScheduler,
    close: async () => {
      await app.close();
    },
    exit: (code) => process.exit(code),
    log: app.log,
  });
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => void shutdown(signal));
  }
}
startDailyTodoLogScheduler(app.log);

// Start
try {
  await app.listen({ port: env.PORT, host: "0.0.0.0" });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

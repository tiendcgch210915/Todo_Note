import { access, constants } from "node:fs/promises";
import {
  applicationDefault,
  getApps,
  initializeApp,
  type App,
} from "firebase-admin/app";
import { getMessaging, type Message } from "firebase-admin/messaging";
import { env } from "../config/env.js";
import type { DeviceKind } from "../repositories/notifications.js";

/** Android channel created by the mobile app (see AndroidManifest default_notification_channel_id). */
export const ANDROID_CHANNEL_ID = "general_notifications";

/** FCM: "Maximum payload for both message types is 4096 bytes". */
const MAX_PAYLOAD_BYTES = 4096;
/** sendEach() accepts up to 500 messages per call. */
const SEND_BATCH_SIZE = 500;
/** FCM reserved data keys / prefixes (set-message-type docs). */
const RESERVED_DATA_KEYS = new Set(["from", "message_type"]);
const RESERVED_DATA_PREFIXES = ["google.", "gcm."];

/**
 * Codes (firebase-admin >= 14.5) meaning the registration itself is dead.
 * - registration-token-not-registered    UNREGISTERED / NOT_FOUND for a `token` target
 * - installation-id-not-registered       UNREGISTERED for a `fid` target
 * - invalid-argument / invalid-registration-token   INVALID_ARGUMENT; only trustworthy
 *   because validatePushPayload() guarantees the payload is valid before we send
 * Anything else (server-unavailable, internal-error, message-rate-exceeded,
 * authentication-error, third-party-auth-error, mismatched-credential, ...) is
 * transient or a configuration problem and must NOT delete a device.
 */
const DEAD_REGISTRATION_CODES = new Set([
  "messaging/registration-token-not-registered",
  "messaging/installation-id-not-registered",
  "messaging/invalid-argument",
  "messaging/invalid-registration-token",
]);

export type PushDevice = {
  /** user_devices.id — used to delete the row, never logged together with the registration id. */
  id: string;
  registrationId: string;
  kind: DeviceKind;
};

export type PushMessage = {
  devices: PushDevice[];
  title: string;
  body: string;
  data?: Record<string, string>;
};

export type PushResult = {
  successCount: number;
  failureCount: number;
  /** user_devices.id of registrations FCM reported as dead. */
  invalidDeviceIds: string[];
};

export type PushLogger = {
  info: (obj: object, msg: string) => void;
  warn: (obj: object, msg: string) => void;
  error: (obj: object, msg: string) => void;
};

/** Minimal slice of firebase-admin's Messaging that we use (also what tests fake). */
export type MessagingClient = {
  sendEach: (messages: Message[]) => Promise<{
    responses: Array<{ success: boolean; error?: { code?: string } }>;
  }>;
};

export class PushPayloadError extends Error {}

const consoleLogger: PushLogger = {
  info: (obj, msg) => console.info(msg, obj),
  warn: (obj, msg) => console.warn(msg, obj),
  error: (obj, msg) => console.error(msg, obj),
};

let log: PushLogger = consoleLogger;
let firebaseApp: App | null = null;
let messagingOverride: MessagingClient | null = null;

/** Logger that always forwards to the currently configured one (set by initFirebase / setPushLogger). */
export const pushLogger: PushLogger = {
  info: (obj, msg) => log.info(obj, msg),
  warn: (obj, msg) => log.warn(obj, msg),
  error: (obj, msg) => log.error(obj, msg),
};

export const setMessagingClientForTests = (
  client: MessagingClient | null
): void => {
  messagingOverride = client;
};

export const setPushLogger = (logger: PushLogger | null): void => {
  log = logger ?? consoleLogger;
};

export const isPushConfigured = (): boolean =>
  messagingOverride !== null || firebaseApp !== null;

/**
 * Initialise the Admin SDK once, using Application Default Credentials
 * (GOOGLE_APPLICATION_CREDENTIALS -> service-account JSON file).
 * Never throws: if credentials are missing or unreadable it logs a warning and
 * push stays disabled so the API keeps serving requests.
 */
export const initFirebase = async (logger?: PushLogger): Promise<boolean> => {
  if (logger) log = logger;
  if (firebaseApp) return true;

  const credentialsPath = env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!credentialsPath) {
    log.warn(
      {},
      "GOOGLE_APPLICATION_CREDENTIALS is not set; push notifications are disabled"
    );
    return false;
  }

  try {
    await access(credentialsPath, constants.R_OK);
  } catch {
    log.warn(
      { path: credentialsPath },
      "GOOGLE_APPLICATION_CREDENTIALS points to a file that does not exist or is not readable; push notifications are disabled"
    );
    return false;
  }

  try {
    // Reuse an app created elsewhere (e.g. hot reload) instead of throwing on a duplicate.
    firebaseApp =
      getApps()[0] ?? initializeApp({ credential: applicationDefault() });
    log.info({}, "Firebase Admin SDK initialised");
    return true;
  } catch (error) {
    // Log only the error type: the message may echo parts of the key file.
    log.error(
      { errorName: error instanceof Error ? error.name : "unknown" },
      "Could not initialise Firebase Admin SDK from GOOGLE_APPLICATION_CREDENTIALS; push notifications are disabled"
    );
    return false;
  }
};

/** Throws PushPayloadError unless the payload is one FCM will accept. */
export const validatePushPayload = (
  message: Pick<PushMessage, "title" | "body" | "data">
): void => {
  if (typeof message.title !== "string" || message.title.trim() === "") {
    throw new PushPayloadError("title must be a non-empty string");
  }
  if (typeof message.body !== "string" || message.body.trim() === "") {
    throw new PushPayloadError("body must be a non-empty string");
  }
  for (const [key, value] of Object.entries(message.data ?? {})) {
    if (key === "" || typeof value !== "string") {
      throw new PushPayloadError("data keys must be non-empty and values strings");
    }
    if (
      RESERVED_DATA_KEYS.has(key) ||
      RESERVED_DATA_PREFIXES.some((prefix) => key.startsWith(prefix))
    ) {
      throw new PushPayloadError(`data key "${key}" is reserved by FCM`);
    }
  }
  const size = Buffer.byteLength(
    JSON.stringify({
      title: message.title,
      body: message.body,
      data: message.data ?? {},
    }),
    "utf8"
  );
  if (size > MAX_PAYLOAD_BYTES) {
    throw new PushPayloadError(`payload exceeds ${MAX_PAYLOAD_BYTES} bytes`);
  }
};

const chunksOf = <T>(items: T[], size: number): T[][] => {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
};

const buildMessage = (
  device: PushDevice,
  payload: Pick<PushMessage, "title" | "body" | "data">
): Message => {
  const common = {
    notification: { title: payload.title, body: payload.body },
    data: payload.data,
    android: {
      priority: "high" as const,
      notification: { channelId: ANDROID_CHANNEL_ID },
    },
  };
  // firebase-admin >= 14.1 targets a Firebase Installation ID with `fid`;
  // `token` is deprecated and only used for registrations stored as kind="token".
  return device.kind === "fid"
    ? { ...common, fid: device.registrationId }
    : { ...common, token: device.registrationId };
};

const getClient = (): MessagingClient | null => {
  if (messagingOverride) return messagingOverride;
  if (!firebaseApp) return null;
  return getMessaging(firebaseApp);
};

/**
 * Send one notification to a set of devices. Throws PushPayloadError for a bad
 * payload; per-device FCM failures are reported in the result, never thrown.
 */
export const sendFirebasePush = async (
  message: PushMessage
): Promise<PushResult> => {
  validatePushPayload(message);

  const seen = new Set<string>();
  const devices = message.devices.filter((device) => {
    if (device.registrationId.length === 0 || seen.has(device.registrationId)) {
      return false;
    }
    seen.add(device.registrationId);
    return true;
  });
  if (devices.length === 0) {
    return { successCount: 0, failureCount: 0, invalidDeviceIds: [] };
  }

  const client = getClient();
  if (!client) {
    return {
      successCount: 0,
      failureCount: devices.length,
      invalidDeviceIds: [],
    };
  }

  let successCount = 0;
  let failureCount = 0;
  const invalidDeviceIds: string[] = [];

  for (const chunk of chunksOf(devices, SEND_BATCH_SIZE)) {
    const response = await client.sendEach(
      chunk.map((device) => buildMessage(device, message))
    );

    response.responses.forEach((result, index) => {
      if (result.success) {
        successCount++;
        return;
      }
      failureCount++;
      const device = chunk[index];
      if (!device) return;
      const code = result.error?.code ?? "unknown";
      if (DEAD_REGISTRATION_CODES.has(code)) {
        invalidDeviceIds.push(device.id);
        log.info(
          { deviceId: device.id, kind: device.kind, code },
          "FCM reported a dead registration; it will be removed"
        );
      } else {
        // Transient (overload, quota) or configuration error: keep the device.
        log.warn(
          { deviceId: device.id, kind: device.kind, code },
          "FCM send failed; device kept"
        );
      }
    });
  }

  return { successCount, failureCount, invalidDeviceIds };
};

import { z } from "zod";
import {
  HHMM_RE,
  isEveningTimeAllowed,
  isValidTimeZone,
} from "../../utils/time.js";

const HHmm = z.string().regex(HHMM_RE, "Expected HH:mm");

/**
 * PUT /notification-settings. Giờ thói quen = eveningTime + 30 phút (tính tự động, tối đa
 * 23:59) nên eveningTime phải <= 23:29.
 */
export const UpdateNotificationSettingsSchema = z.object({
  morningTime: HHmm,
  eveningTime: HHmm.refine(
    isEveningTimeAllowed,
    "eveningTime must be 23:29 or earlier so the habit summary (+30 min) stays within the day"
  ),
  timezone: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .refine(isValidTimeZone, "Unknown IANA time zone"),
});
export type UpdateNotificationSettingsInput = z.infer<
  typeof UpdateNotificationSettingsSchema
>;

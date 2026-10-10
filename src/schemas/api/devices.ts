import { z } from "zod";

const RegistrationId = z.string().trim().min(1).max(4096);

export const RegisterDeviceSchema = z.object({
  registrationId: RegistrationId,
  kind: z.enum(["fid", "token"]),
  platform: z.enum(["android"]),
  /**
   * Registration this device used before its FID/token rotated. If it is one of the
   * caller's own, that row is updated in place so its id (and any job pointing at it)
   * survives. Unknown or foreign values are ignored.
   */
  previousRegistrationId: RegistrationId.optional(),
});

export const UnregisterDeviceSchema = z.object({
  registrationId: RegistrationId,
});

export type RegisterDeviceInput = z.infer<typeof RegisterDeviceSchema>;
export type UnregisterDeviceInput = z.infer<typeof UnregisterDeviceSchema>;

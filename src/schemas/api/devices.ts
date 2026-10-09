import { z } from "zod";

const RegistrationId = z.string().trim().min(1).max(4096);

export const RegisterDeviceSchema = z.object({
  registrationId: RegistrationId,
  kind: z.enum(["fid", "token"]),
  platform: z.enum(["android"]),
});

export const UnregisterDeviceSchema = z.object({
  registrationId: RegistrationId,
});

export type RegisterDeviceInput = z.infer<typeof RegisterDeviceSchema>;
export type UnregisterDeviceInput = z.infer<typeof UnregisterDeviceSchema>;

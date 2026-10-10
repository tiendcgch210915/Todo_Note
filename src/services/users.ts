import * as repo from "../repositories/users.js";
import { hashPassword, randomPassword } from "../utils/password.js";
import * as notificationTriggers from "./notification-triggers.js";

export const listUsers = repo.listUsers;
export const getUserById = repo.getUserById;
export const disableUser = repo.disableUser;
export const enableUser = repo.enableUser;
// A timezone change (admin edit) moves every pending digest; the other fields don't matter.
export const updateUserProfile = async (
  id: string,
  patch: Parameters<typeof repo.updateUserProfile>[1]
): Promise<void> => {
  await repo.updateUserProfile(id, patch);
  if (patch.timezone !== undefined) {
    await notificationTriggers.onUserSettingsChanged(id);
  }
};

export const resetUserPassword = async (id: string): Promise<string> => {
  const plain = randomPassword(12);
  const hash = await hashPassword(plain);
  await repo.updateUserPassword(id, hash);
  return plain;
};

import { authClient } from '@/lib/auth-client';
import type { Passkey } from '@better-auth/passkey';

export const getPasskeys = async (): Promise<Passkey[]> => {
  const { data, error } = await authClient.passkey.listUserPasskeys();
  if (error) throw error;
  return (data || []) as Passkey[];
};
export const addPasskey = async (name?: string) => {
  const { data, error } = await authClient.passkey.addPasskey({
    name: name || undefined,
  });
  if (error) throw error;
  return data;
};

export const deletePasskey = async (id: string) => {
  const { error } = await authClient.passkey.deletePasskey({ id });
  if (error) throw error;
};

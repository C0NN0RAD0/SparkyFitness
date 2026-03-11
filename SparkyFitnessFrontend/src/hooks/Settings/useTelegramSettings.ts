import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  generateTelegramLinkToken,
  getTelegramStatus,
  unlinkTelegram,
} from '@/api/Settings/telegramService';
import { telegramKeys } from '@/api/keys/settings';

// Re-export types so pages can import from the hook without touching the service layer
export type {
  LinkTokenResult,
  TelegramStatus,
} from '@/api/Settings/telegramService';

export const useTelegramStatusQuery = (userId: string | undefined) => {
  return useQuery({
    queryKey: telegramKeys.status(),
    queryFn: getTelegramStatus,
    enabled: !!userId,
    meta: {
      errorMessage: 'Failed to load Telegram status',
    },
  });
};

export const useGenerateTelegramLinkTokenMutation = () => {
  return useMutation({
    mutationFn: generateTelegramLinkToken,
    meta: {
      errorMessage: 'Failed to generate Telegram link token',
    },
  });
};

export const useUnlinkTelegramMutation = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: unlinkTelegram,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: telegramKeys.status() });
    },
    meta: {
      successMessage: 'Telegram account unlinked successfully.',
      errorMessage: 'Failed to unlink Telegram account',
    },
  });
};

import { apiCall } from '@/api/api';

export interface TelegramStatus {
  linked: boolean;
  bot_configured: boolean;
  telegram_username?: string | null;
  linked_at?: string;
}

export interface LinkTokenResult {
  token: string;
  expires_at: string;
  deep_link: string | null;
}

export const getTelegramStatus = async (): Promise<TelegramStatus> => {
  return apiCall('/telegram/status', { method: 'GET' });
};

export const generateTelegramLinkToken = async (): Promise<LinkTokenResult> => {
  return apiCall('/telegram/generate-link-token', { method: 'POST' });
};

export const unlinkTelegram = async (): Promise<{ message: string }> => {
  return apiCall('/telegram/unlink', { method: 'DELETE' });
};

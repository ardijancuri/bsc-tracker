export type TelegramNotificationState = {
  available: boolean;
  connection: 'not_connected' | 'pending' | 'connected' | 'blocked' | 'error';
  enabled: boolean;
  buys: boolean;
  sells: boolean;
  language: 'en' | 'zh-CN';
  mutedKols: string[];
  lastError: string | null;
};

export type TelegramNotificationPreferences = Partial<Pick<TelegramNotificationState, 'enabled' | 'buys' | 'sells' | 'language'>>;

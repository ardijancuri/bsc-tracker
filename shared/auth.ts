export type AuthUser = {
  id: string;
  name: string;
  username: string | null;
  avatarUrl: string | null;
};

export type AuthState = { enabled: boolean; user: AuthUser | null };
export type AuthError = 'cancelled' | 'failed' | 'merge_limit';

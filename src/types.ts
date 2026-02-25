import type { JwtPayload } from 'jsonwebtoken';

export interface TokenClaims extends JwtPayload {
  sub: string;
  jti: string;
  site?: string;
  origin?: string;
  email?: string;
  name?: string;
  exp: number;
  anon?: boolean;
}

export interface ChatMessage {
  id: number;
  visitor_id: string;
  sender: 'visitor' | 'agent';
  content: string;
  type: 'text' | 'image' | 'file';
  file_url: string | null;
  created_at: string;
}

export type VisitorAuthType = 'authenticated' | 'anonymous';

export interface VisitorRecord {
  id: string;
  name: string | null;
  site: string | null;
  email: string | null;
  auth_type: VisitorAuthType;
  telegram_topic_id: number | null;
  created_at: string;
  last_seen: string;
}

export interface TokenSessionRecord {
  jti: string;
  sub: string;
  site: string | null;
  origin_host: string | null;
  expires_at: number;
  revoked_at: string | null;
  created_at: string;
  last_seen: string;
}

export type SupportPresenceState = 'online' | 'offline';

export interface SettingRecord {
  key: string;
  value: string;
  updated_at: string;
}

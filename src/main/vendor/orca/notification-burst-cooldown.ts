// Copied from Orca 36913fd4f556c44495ed6da5cd6a81910c3cde21, src/shared/notification-burst-cooldown.ts.
// Copyright (c) 2026 Lovecast Inc. MIT; see licenses/Orca-MIT.txt.
const NOTIFICATION_COOLDOWN_MS = 5000;
const MAX_RECENT_NOTIFICATION_KEYS = 50;

function pruneRecentNotifications(recentNotifications: Map<string, number>, now: number): void {
  if (recentNotifications.size <= MAX_RECENT_NOTIFICATION_KEYS) return;
  for (const [key, timestamp] of recentNotifications) {
    if (now - timestamp >= NOTIFICATION_COOLDOWN_MS) recentNotifications.delete(key);
  }
  while (recentNotifications.size > MAX_RECENT_NOTIFICATION_KEYS) {
    const oldest = recentNotifications.keys().next();
    if (oldest.done) break;
    recentNotifications.delete(oldest.value);
  }
}

export function reserveNotificationCooldown(recentNotifications: Map<string, number>, dedupeKey: string, now: number): boolean {
  const lastSentAt = recentNotifications.get(dedupeKey) ?? 0;
  if (now - lastSentAt < NOTIFICATION_COOLDOWN_MS) return false;
  recentNotifications.delete(dedupeKey);
  recentNotifications.set(dedupeKey, now);
  pruneRecentNotifications(recentNotifications, now);
  return true;
}

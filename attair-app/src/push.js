import { isNative } from './native.js';

export async function registerNativePush() {
  if (!isNative) return null;
  const { PushNotifications } = await import('@capacitor/push-notifications');
  const perm = await PushNotifications.requestPermissions();
  if (perm.receive !== 'granted') return null;
  await PushNotifications.register();
  return new Promise((resolve) => {
    PushNotifications.addListener('registration', (token) => resolve(token.value));
    PushNotifications.addListener('registrationError', () => resolve(null));
  });
}

export function onNativePushReceived(callback) {
  if (!isNative) return;
  import('@capacitor/push-notifications').then(({ PushNotifications }) => {
    PushNotifications.addListener('pushNotificationReceived', callback);
  });
}

export function onNativePushActionPerformed(callback) {
  if (!isNative) return;
  import('@capacitor/push-notifications').then(({ PushNotifications }) => {
    PushNotifications.addListener('pushNotificationActionPerformed', callback);
  });
}

import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.attaire.app',
  appName: 'ATTAIRE',
  webDir: 'dist',
  plugins: {
    SplashScreen: {
      launchAutoHide: true,
      launchShowDuration: 1500,
      backgroundColor: '#0C0C0E',
      showSpinner: false,
    },
    PushNotifications: {
      presentationOptions: ['badge', 'sound', 'alert'],
    },
  },
  ios: {
    scheme: 'ATTAIRE',
    contentInset: 'automatic',
    backgroundColor: '#0C0C0E',
    preferredContentMode: 'mobile',
  },
};

export default config;

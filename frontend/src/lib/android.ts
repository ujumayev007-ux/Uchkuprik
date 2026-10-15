// Bridge to the Android app shell (WebView). The shell injects `FastFoodAndroid`;
// in a browser or the desktop app it does not exist and every helper is a no-op.

type Bridge = {
  // Starts (or reconfigures) the background alert service. JSON settings.
  configureAlerts: (json: string) => void;
  // Stops the alert service (signed out, feature switched off).
  stopAlerts: () => void;
  // JSON: { running: boolean, notifications: boolean, ttsReady: boolean }.
  alertStatus: () => string;
  // Asks Android for the notification permission (Android 13+).
  requestNotificationPermission: () => void;
  // Opens the system screen where the alert channel can be adjusted.
  openAlertSettings: () => void;
};

export const androidBridge = (): Bridge | undefined =>
  (window as unknown as { FastFoodAndroid?: Bridge }).FastFoodAndroid;

export type AlertStatus = {
  running: boolean;
  notifications: boolean;
  ttsReady: boolean;
};

export function androidAlertStatus(): AlertStatus | null {
  try {
    const raw = androidBridge()?.alertStatus();
    return raw ? (JSON.parse(raw) as AlertStatus) : null;
  } catch {
    return null;
  }
}

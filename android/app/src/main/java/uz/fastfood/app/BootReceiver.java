package uz.fastfood.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Restarts the alert service after a reboot when the waiter had it switched on. */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction()) && AlertService.wanted(context)) {
            try {
                AlertService.start(context);
            } catch (RuntimeException ignored) {
                // Background start refused: the alerts resume when the app is opened.
            }
        }
    }
}

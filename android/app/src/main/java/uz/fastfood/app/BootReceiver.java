package uz.fastfood.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * After a reboot: the queue TV opens its screen by itself; the waiter app restarts the
 * alert service when the waiter had it switched on.
 */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (BuildConfig.IS_TV) {
            try {
                context.startActivity(new Intent(context, MainActivity.class)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            } catch (RuntimeException ignored) {
                // Background start refused (newer Android): the TV home-screen choice opens it.
            }
            return;
        }
        if (Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction()) && AlertService.wanted(context)) {
            try {
                AlertService.start(context);
            } catch (RuntimeException ignored) {
                // Background start refused: the alerts resume when the app is opened.
            }
        }
    }
}

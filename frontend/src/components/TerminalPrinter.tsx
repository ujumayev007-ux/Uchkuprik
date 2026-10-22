import { useEffect, useState } from 'react';
import { t } from '../i18n';
import { useRealtimeEvent } from '../lib/realtime';
import {
  Button,
  Checkbox,
  Dialog,
  FormError,
  SelectField,
  useToast,
} from './ui';

/** This terminal's own receipt printer; offered only by the Kassa application. */
export type TerminalPrinterConfig = {
  deviceName: string;
  widthMm: 58 | 80;
  copies: number;
  auto: boolean;
};
type PrinterInfo = { name: string; label: string; isDefault: boolean };
type PrinterBridge = {
  list: () => Promise<PrinterInfo[]>;
  get: () => Promise<TerminalPrinterConfig>;
  set: (value: TerminalPrinterConfig) => Promise<TerminalPrinterConfig>;
  print: (pagePath: string) => Promise<{ ok: true }>;
  // Kitchen printer (Kassa 1.6.0 and later).
  kitchenGet?: () => Promise<TerminalPrinterConfig>;
  kitchenSet?: (value: TerminalPrinterConfig) => Promise<TerminalPrinterConfig>;
  kitchenTest?: () => Promise<{ ok: true }>;
  kitchenOrder?: (
    orderId: string,
  ) => Promise<{ printed: boolean; number?: string }>;
};

export const terminalPrinter = () =>
  (window as unknown as { fastfoodPrinter?: PrinterBridge }).fastfoodPrinter;

/** Prints the order's receipt on this terminal's printer (silently). */
export const printOnTerminal = (orderId: string) =>
  terminalPrinter()!.print(`/chek/${orderId}`);

/** After a payment: prints by itself when this terminal asked for it. */
export async function autoPrintReceipt(orderId: string) {
  const bridge = terminalPrinter();
  if (!bridge) return false;
  const config = await bridge.get();
  if (!config.auto) return false;
  await bridge.print(`/chek/${orderId}`);
  return true;
}

/** autoPrintReceipt with the usual messages (Kassa and Buyurtmalar pages). */
export function receiptAfterPayment(
  orderId: string,
  toast: (message: string, tone?: 'error') => void,
) {
  void autoPrintReceipt(orderId)
    .then((printed) => printed && toast(t.terminalPrinter.printed))
    .catch((error: unknown) =>
      toast(
        `${t.terminalPrinter.failed}: ${error instanceof Error ? error.message : ''}`,
        'error',
      ),
    );
}

/**
 * Sends the order to this terminal's kitchen printer. The application prints only what
 * the kitchen has not seen yet, so calling it again for the same order is safe.
 */
export function printForKitchen(
  orderId: string,
  toast?: (message: string, tone?: 'error') => void,
) {
  const bridge = terminalPrinter();
  if (!bridge?.kitchenOrder) return;
  void bridge
    .kitchenOrder(orderId)
    .catch((error: unknown) =>
      toast?.(
        `${t.terminalPrinter.kitchenFailed}: ${error instanceof Error ? error.message : ''}`,
        'error',
      ),
    );
}

/**
 * Kassa application: every new or changed order of this branch (from this cashier, a
 * waiter or online) goes to the kitchen printer when automatic printing is on.
 */
export function KitchenAutoPrint() {
  const toast = useToast();
  const available = !!terminalPrinter()?.kitchenOrder;
  useRealtimeEvent((event, payload) => {
    if (!available) return;
    if (event !== 'order.changed' && event !== 'order.updated') return;
    const orderId = payload.orderId;
    if (typeof orderId === 'string') printForKitchen(orderId, toast);
  });
  return null;
}

function PrinterFields({
  printers,
  form,
  onChange,
  autoLabel,
}: {
  printers: PrinterInfo[];
  form: TerminalPrinterConfig;
  onChange: (value: TerminalPrinterConfig) => void;
  autoLabel: string;
}) {
  return (
    <>
      <SelectField
        label={t.terminalPrinter.printer}
        value={form.deviceName}
        onChange={(e) => onChange({ ...form, deviceName: e.target.value })}
      >
        <option value="">{t.terminalPrinter.systemDefault}</option>
        {printers.map((printer) => (
          <option key={printer.name} value={printer.name}>
            {printer.label}
          </option>
        ))}
      </SelectField>
      <div className="toolbar">
        <SelectField
          label={t.terminalPrinter.paper}
          value={String(form.widthMm)}
          onChange={(e) =>
            onChange({ ...form, widthMm: e.target.value === '58' ? 58 : 80 })
          }
        >
          <option value="80">80 mm</option>
          <option value="58">58 mm</option>
        </SelectField>
        <SelectField
          label={t.terminalPrinter.copies}
          value={String(form.copies)}
          onChange={(e) =>
            onChange({ ...form, copies: Number(e.target.value) })
          }
        >
          {[1, 2, 3, 4, 5].map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </SelectField>
      </div>
      <Checkbox
        label={autoLabel}
        checked={form.auto}
        onChange={(checked) => onChange({ ...form, auto: checked })}
      />
    </>
  );
}

/** «Printerlar» button: this terminal's receipt and kitchen printers. */
export function TerminalPrinterButton() {
  const bridge = terminalPrinter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [printers, setPrinters] = useState<PrinterInfo[]>([]);
  const [form, setForm] = useState<TerminalPrinterConfig | null>(null);
  const [kitchen, setKitchen] = useState<TerminalPrinterConfig | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const hasKitchen = !!bridge?.kitchenGet;
  useEffect(() => {
    if (!open || !bridge) return;
    setError(null);
    void Promise.all([
      bridge.list(),
      bridge.get(),
      bridge.kitchenGet ? bridge.kitchenGet() : Promise.resolve(null),
    ])
      .then(([list, config, kitchenConfig]) => {
        setPrinters(list);
        setForm(config);
        setKitchen(kitchenConfig);
      })
      .catch(setError);
  }, [open, bridge]);
  if (!bridge) return null;
  const run = async (action: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      toast(done);
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };
  const text = t.terminalPrinter;
  return (
    <>
      <Button onClick={() => setOpen(true)}>
        🖨 {hasKitchen ? text.openBoth : text.open}
      </Button>
      <Dialog
        open={open}
        title={hasKitchen ? text.titleBoth : text.title}
        onClose={() => setOpen(false)}
        footer={
          <Button
            variant="primary"
            disabled={!form}
            busy={busy}
            onClick={() =>
              void run(async () => {
                setForm(await bridge.set(form!));
                if (kitchen && bridge.kitchenSet)
                  setKitchen(await bridge.kitchenSet(kitchen));
                setOpen(false);
              }, text.saved)
            }
          >
            {text.save}
          </Button>
        }
      >
        <div className="stack">
          <p className="muted">{text.hint}</p>
          {form && (
            <section className="card stack">
              <h3 style={{ margin: 0 }}>🧾 {text.receiptSection}</h3>
              <PrinterFields
                printers={printers}
                form={form}
                onChange={setForm}
                autoLabel={text.auto}
              />
              <div>
                <Button
                  busy={busy}
                  onClick={() =>
                    void run(async () => {
                      await bridge.set(form);
                      await bridge.print('/chek-sinov');
                    }, text.testSent)
                  }
                >
                  {text.test}
                </Button>
              </div>
            </section>
          )}
          {kitchen && (
            <section className="card stack">
              <h3 style={{ margin: 0 }}>🍳 {text.kitchenSection}</h3>
              <p className="muted small">{text.kitchenHint}</p>
              <PrinterFields
                printers={printers}
                form={kitchen}
                onChange={setKitchen}
                autoLabel={text.kitchenAuto}
              />
              {form &&
                kitchen.auto &&
                form.deviceName === kitchen.deviceName && (
                  <p className="muted small">⚠ {text.samePrinter}</p>
                )}
              <div>
                <Button
                  busy={busy}
                  onClick={() =>
                    void run(async () => {
                      await bridge.kitchenSet!(kitchen);
                      await bridge.kitchenTest!();
                    }, text.testSent)
                  }
                >
                  {text.kitchenTest}
                </Button>
              </div>
            </section>
          )}
          <FormError error={error} />
        </div>
      </Dialog>
    </>
  );
}

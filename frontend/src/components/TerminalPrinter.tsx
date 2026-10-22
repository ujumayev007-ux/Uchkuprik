import { useEffect, useState } from 'react';
import { t } from '../i18n';
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
type PrinterBridge = {
  list: () => Promise<{ name: string; label: string; isDefault: boolean }[]>;
  get: () => Promise<TerminalPrinterConfig>;
  set: (value: TerminalPrinterConfig) => Promise<TerminalPrinterConfig>;
  print: (pagePath: string) => Promise<{ ok: true }>;
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

/** «Chek printeri» button with this terminal's printer settings. */
export function TerminalPrinterButton() {
  const bridge = terminalPrinter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [printers, setPrinters] = useState<
    { name: string; label: string; isDefault: boolean }[]
  >([]);
  const [form, setForm] = useState<TerminalPrinterConfig | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open || !bridge) return;
    setError(null);
    void Promise.all([bridge.list(), bridge.get()])
      .then(([list, config]) => {
        setPrinters(list);
        setForm(config);
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
  return (
    <>
      <Button onClick={() => setOpen(true)}>🖨 {t.terminalPrinter.open}</Button>
      <Dialog
        open={open}
        title={t.terminalPrinter.title}
        onClose={() => setOpen(false)}
      >
        <div className="stack">
          <p className="muted">{t.terminalPrinter.hint}</p>
          {form && (
            <>
              <SelectField
                label={t.terminalPrinter.printer}
                value={form.deviceName}
                onChange={(e) =>
                  setForm({ ...form, deviceName: e.target.value })
                }
              >
                <option value="">{t.terminalPrinter.systemDefault}</option>
                {printers.map((printer) => (
                  <option key={printer.name} value={printer.name}>
                    {printer.label}
                  </option>
                ))}
              </SelectField>
              <SelectField
                label={t.terminalPrinter.paper}
                value={String(form.widthMm)}
                onChange={(e) =>
                  setForm({
                    ...form,
                    widthMm: e.target.value === '58' ? 58 : 80,
                  })
                }
              >
                <option value="80">80 mm</option>
                <option value="58">58 mm</option>
              </SelectField>
              <SelectField
                label={t.terminalPrinter.copies}
                value={String(form.copies)}
                onChange={(e) =>
                  setForm({ ...form, copies: Number(e.target.value) })
                }
              >
                {[1, 2, 3, 4, 5].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </SelectField>
              <Checkbox
                label={t.terminalPrinter.auto}
                checked={form.auto}
                onChange={(checked) => setForm({ ...form, auto: checked })}
              />
            </>
          )}
          <FormError error={error} />
          <div className="form-actions">
            <Button
              disabled={!form}
              busy={busy}
              onClick={() =>
                void run(async () => {
                  await bridge.set(form!);
                  await bridge.print('/chek-sinov');
                }, t.terminalPrinter.testSent)
              }
            >
              {t.terminalPrinter.test}
            </Button>
            <Button
              variant="primary"
              disabled={!form}
              busy={busy}
              onClick={() =>
                void run(async () => {
                  setForm(await bridge.set(form!));
                  setOpen(false);
                }, t.terminalPrinter.saved)
              }
            >
              {t.terminalPrinter.save}
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}

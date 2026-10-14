import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  Button,
  Checkbox,
  Dialog,
  FormError,
  SelectField,
  TextField,
  useToast,
} from '../components/ui';
import { t } from '../i18n';
import { api, post } from '../lib/api';
import type { Station } from './KitchenPage';

const d = t.ticketTemplate;

export type TicketTemplate = {
  header: string;
  footer: string;
  largeItems: boolean;
  showWaiter: boolean;
  showNotes: boolean;
  copies: number;
};
const defaults: TicketTemplate = {
  header: '',
  footer: '',
  largeItems: true,
  showWaiter: true,
  showNotes: true,
  copies: 1,
};

/** Department ticket layout with a plain-text preview and a test print. */
export function StationTemplateDialog({
  station,
  onClose,
}: {
  station: Station & { template?: TicketTemplate };
  onClose: () => void;
}) {
  const client = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState<TicketTemplate>({
    ...defaults,
    ...station.template,
  });
  const [error, setError] = useState<unknown>(null);
  const preview = [
    form.header,
    station.name.toUpperCase(),
    'N 123',
    'Olib ketish - Stol 5 - 12:30',
    form.showWaiter ? 'Ofitsiant: Ali' : '',
    '------------------------------',
    form.largeItems ? '2 X NAMUNA TAOM' : '2 x Namuna taom',
    form.showNotes ? '   ! Achchiq' : '',
    form.footer ? '------------------------------' : '',
    form.footer,
  ]
    .filter(Boolean)
    .join('\n');

  return (
    <Dialog open wide title={`${d.title}: ${station.name}`} onClose={onClose}>
      <div className="form-grid">
        <div className="stack">
          <TextField
            label={d.header}
            value={form.header}
            maxLength={60}
            onChange={(e) => setForm({ ...form, header: e.target.value })}
          />
          <TextField
            label={d.footer}
            value={form.footer}
            maxLength={80}
            onChange={(e) => setForm({ ...form, footer: e.target.value })}
          />
          <Checkbox
            label={d.largeItems}
            checked={form.largeItems}
            onChange={(largeItems) => setForm({ ...form, largeItems })}
          />
          <Checkbox
            label={d.showWaiter}
            checked={form.showWaiter}
            onChange={(showWaiter) => setForm({ ...form, showWaiter })}
          />
          <Checkbox
            label={d.showNotes}
            checked={form.showNotes}
            onChange={(showNotes) => setForm({ ...form, showNotes })}
          />
          <SelectField
            label={d.copies}
            value={String(form.copies)}
            onChange={(e) =>
              setForm({ ...form, copies: Number(e.target.value) })
            }
          >
            {[1, 2, 3].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </SelectField>
        </div>
        <div>
          <span className="field-label">{d.preview}</span>
          <pre className="ticket-preview">{preview}</pre>
        </div>
      </div>
      <FormError error={error} />
      <div className="form-actions">
        <Button
          onClick={async () => {
            try {
              const result = await post<{ printers: number }>(
                `/kitchen/stations/${station.id}/test-print`,
              );
              toast(
                result.printers
                  ? d.testSent.replace('{n}', String(result.printers))
                  : d.noPrinters,
                result.printers ? undefined : 'error',
              );
            } catch (caught) {
              setError(caught);
            }
          }}
        >
          🖨 {d.test}
        </Button>
        <Button
          variant="primary"
          onClick={async () => {
            try {
              await api(`/kitchen/stations/${station.id}/template`, {
                method: 'PUT',
                body: form,
              });
              toast(t.common.saved);
              await client.invalidateQueries({ queryKey: ['kitchen'] });
              onClose();
            } catch (caught) {
              setError(caught);
            }
          }}
        >
          {t.common.save}
        </Button>
      </div>
    </Dialog>
  );
}

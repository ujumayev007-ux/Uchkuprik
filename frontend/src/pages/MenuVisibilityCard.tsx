import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Button, Checkbox, FormError, LoadingState, useToast } from '../components/ui';
import { api } from '../lib/api';

type ConfigurableMenu = {
  path: string;
  label: string;
  category: string;
};

const CONFIGURABLE_MENUS: ConfigurableMenu[] = [
  { path: '/bozorlik', label: 'Bozorlik (Xaridlar)', category: 'Asosiy va savdo' },
  { path: '/chiqimlar', label: 'Chiqimlar (Xarajatlar)', category: 'Asosiy va savdo' },
  { path: '/ombor', label: 'Ombor va qoldiqlar', category: 'Asosiy va savdo' },
  { path: '/menyu', label: 'Menyu va taomlar', category: 'Asosiy va savdo' },
  { path: '/zallar', label: 'Zallar va stollar', category: 'Asosiy va savdo' },
  { path: '/smena', label: 'Kassa smenasi', category: 'Asosiy va savdo' },

  { path: '/oshxona', label: 'Oshxona ekrani', category: 'Terminallar' },
  { path: '/navbat', label: 'Navbat ekrani (TV)', category: 'Terminallar' },
  { path: '/ofitsiant', label: 'Ofitsiant ekrani', category: 'Terminallar' },

  { path: '/hisobotlar', label: 'Hisobotlar', category: 'Tahlil va moliya' },
  { path: '/tahlil', label: 'Savdo tahlili', category: 'Tahlil va moliya' },
  { path: '/moliya', label: 'Moliya va P&L', category: 'Tahlil va moliya' },

  { path: '/yetkazish', label: 'Yetkazib berish (Dostavka)', category: 'Xizmatlar' },
  { path: '/kuryer', label: 'Kuryerlar', category: 'Xizmatlar' },
  { path: '/mijozlar', label: 'Mijozlar (CRM)', category: 'Xizmatlar' },

  { path: '/xodimlar', label: 'Xodimlar', category: 'Xodimlar va boshqaruv' },
  { path: '/rollar', label: 'Rollar va huquqlar', category: 'Xodimlar va boshqaruv' },
  { path: '/ish-vaqti', label: 'Davomat va ish vaqti', category: 'Xodimlar va boshqaruv' },
  { path: '/ish-haqi', label: 'Ish haqi va maosh', category: 'Xodimlar va boshqaruv' },

  { path: '/operatsiyalar', label: 'Operatsion nazorat', category: 'Kengaytirilgan' },
  { path: '/uskunalar', label: 'Uskunalar va ta’mirlash', category: 'Kengaytirilgan' },
  { path: '/oqitish', label: 'O‘qitish va testlar', category: 'Kengaytirilgan' },
  { path: '/tasdiqlar', label: 'Tasdiqlar (So‘rovlar)', category: 'Kengaytirilgan' },
  { path: '/brendlar', label: 'Brendlar', category: 'Kengaytirilgan' },
  { path: '/franshiza', label: 'Franshiza tarmog‘i', category: 'Kengaytirilgan' },
  { path: '/filiallar', label: 'Filiallar', category: 'Kengaytirilgan' },
  { path: '/qurilmalar', label: 'Qurilmalar (Terminallar)', category: 'Kengaytirilgan' },
  { path: '/printerlar', label: 'Printer sozlamalari', category: 'Kengaytirilgan' },
  { path: '/chek-dizayni', label: 'Chek dizayneri', category: 'Kengaytirilgan' },
  { path: '/tolovlar', label: 'Onlayn to‘lovlar', category: 'Kengaytirilgan' },
  { path: '/qr-tolov', label: 'QR to‘lov', category: 'Kengaytirilgan' },
  { path: '/obuna', label: 'Obuna', category: 'Kengaytirilgan' },
  { path: '/bildirishnomalar', label: 'Bildirishnomalar', category: 'Kengaytirilgan' },
  { path: '/integratsiyalar', label: 'Integratsiyalar va API', category: 'Kengaytirilgan' },
  { path: '/audit', label: 'Audit jurnali', category: 'Kengaytirilgan' },
];

export function MenuVisibilityCard({ editable }: { editable: boolean }) {
  const client = useQueryClient();
  const toast = useToast();

  const visibility = useQuery({
    queryKey: ['admin-menu-visibility'],
    queryFn: () =>
      api<{ hidden: string[] }>('/admin/menu-visibility').then((d) => d.hidden),
  });

  const [hidden, setHidden] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (visibility.data) {
      setHidden(visibility.data);
    }
  }, [visibility.data]);

  const toggle = (path: string) => {
    setHidden((prev) =>
      prev.includes(path) ? prev.filter((p) => p !== path) : [...prev, path],
    );
  };

  const handleSave = async (itemsToSave: string[]) => {
    setBusy(true);
    setError(null);
    try {
      await api('/admin/menu-visibility', {
        method: 'PUT',
        body: { hidden: itemsToSave },
      });
      await client.invalidateQueries({ queryKey: ['admin-menu-visibility'] });
      toast('Menyular ko‘rinishi muvaffaqiyatli saqlandi');
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  const handleResetAll = async () => {
    setHidden([]);
    await handleSave([]);
    toast('Barcha menyular qayta tiklandi va ko‘rsatildi');
  };

  if (visibility.isPending && !visibility.data) return <LoadingState />;

  const categories = Array.from(
    new Set(CONFIGURABLE_MENUS.map((m) => m.category)),
  );

  return (
    <div className="card stack">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem' }}>
        <div>
          <h2>Menyular ko‘rinishi (Admin paneli)</h2>
          <p className="muted small" style={{ margin: 0 }}>
            Restoran boshqaruv panelida ko‘rinadigan yoki yashiriladigan menyu bo‘limlarini sozlang. Boshqaruv paneli, Sozlamalar va Litsenziya kabi asosiy sahifalar xavfsizlik maqsadida doim faol qoladi.
          </p>
        </div>
        {editable && (
          <Button
            type="button"
            variant="secondary"
            onClick={handleResetAll}
            busy={busy}
          >
            Hammasini tiklash (Barchasini ko‘rsatish)
          </Button>
        )}
      </div>

      <FormError error={error} />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '1.5rem', marginTop: '1rem' }}>
        {categories.map((cat) => (
          <div key={cat} style={{ background: 'var(--color-bg-subtle, #f8f9fa)', padding: '1rem', borderRadius: '8px', border: '1px solid var(--color-border, #e9ecef)' }}>
            <h3 style={{ fontSize: '0.95rem', marginBottom: '0.75rem', color: 'var(--color-text-subtle)' }}>
              {cat}
            </h3>
            <div className="stack" style={{ gap: '0.5rem' }}>
              {CONFIGURABLE_MENUS.filter((m) => m.category === cat).map((item) => {
                const isHidden = hidden.includes(item.path);
                return (
                  <Checkbox
                    key={item.path}
                    label={item.label}
                    description={isHidden ? 'Yashirilgan' : 'Ko‘rinadi'}
                    checked={!isHidden}
                    disabled={!editable || busy}
                    onChange={() => toggle(item.path)}
                  />
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {editable && (
        <div className="form-actions" style={{ marginTop: '1rem' }}>
          <Button
            type="button"
            variant="primary"
            busy={busy}
            onClick={() => handleSave(hidden)}
          >
            Saqlash
          </Button>
        </div>
      )}
    </div>
  );
}

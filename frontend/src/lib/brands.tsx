import { useQuery } from '@tanstack/react-query';
import { hasFeature, useMe } from '../auth/session';
import { SelectField } from '../components/ui';
import { t } from '../i18n';
import { api } from './api';

export type Brand = {
  id: string;
  code: string;
  name: string;
  logoUrl: string | null;
  primaryColor: string | null;
  receiptHeader: string | null;
  receiptFooter: string | null;
  isActive: boolean;
  sortOrder: number;
  branchCount: number;
  categoryCount: number;
};

/** Brands of the tenant; only loaded when the plan includes multi-brand. */
export function useBrands() {
  const { data: me } = useMe();
  return useQuery({
    queryKey: ['brands'],
    queryFn: () =>
      api<{ brands: Brand[] }>('/brands').then((data) => data.brands),
    enabled: hasFeature(me, 'multi_brand'),
  });
}

/** Brand picker for branch and category forms; hidden when there are no brands. */
export function BrandSelect({
  value,
  onChange,
  emptyLabel,
}: {
  value: string;
  onChange: (brandId: string) => void;
  emptyLabel: string;
}) {
  const brands = useBrands();
  const options = (brands.data ?? []).filter(
    (brand) => brand.isActive || brand.id === value,
  );
  if (options.length === 0) return null;
  return (
    <SelectField
      label={t.brands.brand}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    >
      <option value="">{emptyLabel}</option>
      {options.map((brand) => (
        <option key={brand.id} value={brand.id}>
          {brand.name}
        </option>
      ))}
    </SelectField>
  );
}

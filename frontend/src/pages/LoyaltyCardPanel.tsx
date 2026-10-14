import { useEffect, useState } from 'react';
import { Button, TextField, useToast } from '../components/ui';
import { t } from '../i18n';
import { post } from '../lib/api';

const k = t.loyaltyCard;

/**
 * Loyalty card (QR with the card code; scanning it at the till finds the customer)
 * and the referral code of the friend who invited a new customer.
 */
export function LoyaltyCardPanel({
  customerId,
  name,
  cardCode,
  canReferral,
  onChange,
}: {
  customerId: string;
  name: string;
  cardCode: string | null;
  canReferral: boolean;
  onChange: () => void;
}) {
  const toast = useToast();
  const [code, setCode] = useState(cardCode);
  const [svg, setSvg] = useState('');
  const [friend, setFriend] = useState('');
  useEffect(() => {
    if (!code) return;
    void import('qrcode')
      .then(({ default: QRCode }) =>
        QRCode.toString(code, { type: 'svg', margin: 1, width: 200 }),
      )
      .then(setSvg)
      .catch(() => setSvg(''));
  }, [code]);
  const fail = (caught: unknown) =>
    toast(
      caught instanceof Error ? caught.message : t.common.errorTitle,
      'error',
    );

  return (
    <section className="card stack">
      <h3>💳 {k.title}</h3>
      {code ? (
        <div className="loyalty-card" id="loyalty-card">
          <div dangerouslySetInnerHTML={{ __html: svg }} />
          <div>
            <strong>{name}</strong>
            <p className="handoff-code">{code}</p>
          </div>
        </div>
      ) : (
        <p className="muted small">{k.none}</p>
      )}
      <div className="toolbar">
        {!code ? (
          <Button
            size="sm"
            variant="primary"
            onClick={() =>
              void post<{ cardCode: string }>(`/customers/${customerId}/card`)
                .then((result) => {
                  setCode(result.cardCode);
                  onChange();
                })
                .catch(fail)
            }
          >
            {k.issue}
          </Button>
        ) : (
          <Button size="sm" onClick={() => window.print()}>
            🖨 {k.print}
          </Button>
        )}
      </div>
      {canReferral && (
        <div className="toolbar">
          <TextField
            label={k.friendCode}
            hint={k.friendHint}
            value={friend}
            onChange={(e) => setFriend(e.target.value.toUpperCase())}
          />
          <Button
            size="sm"
            disabled={friend.trim().length < 4}
            onClick={() =>
              void post(`/customers/${customerId}/referrer`, {
                code: friend.trim(),
              })
                .then(() => {
                  setFriend('');
                  toast(k.referralSaved);
                  onChange();
                })
                .catch(fail)
            }
          >
            {k.saveReferral}
          </Button>
        </div>
      )}
    </section>
  );
}

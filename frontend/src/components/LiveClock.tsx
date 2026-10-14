import { useEffect, useState } from 'react';

const WEEKDAYS = [
  'Yakshanba',
  'Dushanba',
  'Seshanba',
  'Chorshanba',
  'Payshanba',
  'Juma',
  'Shanba',
];
const MONTHS = [
  'yanvar',
  'fevral',
  'mart',
  'aprel',
  'may',
  'iyun',
  'iyul',
  'avgust',
  'sentabr',
  'oktabr',
  'noyabr',
  'dekabr',
];
const pad = (value: number) => String(value).padStart(2, '0');

/** Live local time and date, ticking every second (shown on every panel). */
export function LiveClock({ large = false }: { large?: boolean }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <time
      className={`live-clock${large ? ' large' : ''}`}
      dateTime={now.toISOString()}
      aria-live="off"
    >
      <span className="live-clock-time">
        {pad(now.getHours())}:{pad(now.getMinutes())}
        <span className="live-clock-seconds">:{pad(now.getSeconds())}</span>
      </span>
      <span className="live-clock-date">
        {WEEKDAYS[now.getDay()]}, {now.getDate()}-{MONTHS[now.getMonth()]}{' '}
        {now.getFullYear()}
      </span>
    </time>
  );
}

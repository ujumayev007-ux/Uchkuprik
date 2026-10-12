// Minimal in-process Prometheus metrics. Labels are low-cardinality only
// (method and status class); paths, tenants and users are never recorded.

const buckets = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];

const requests = new Map<string, number>();
const durationCounts = new Map<string, number[]>();
const durationSums = new Map<string, number>();

export function recordRequest(method: string, status: number, seconds: number) {
  const statusClass = `${Math.floor(status / 100)}xx`;
  const key = `${method}|${statusClass}`;
  requests.set(key, (requests.get(key) ?? 0) + 1);
  const counts = durationCounts.get(method) ?? buckets.map(() => 0);
  buckets.forEach((bucket, index) => {
    if (seconds <= bucket) counts[index]! += 1;
  });
  durationCounts.set(method, counts);
  durationSums.set(method, (durationSums.get(method) ?? 0) + seconds);
}

export function renderMetrics(gauges: Record<string, number>) {
  const lines: string[] = [
    '# HELP ff_http_requests_total HTTP requests by method and status class.',
    '# TYPE ff_http_requests_total counter',
  ];
  for (const [key, value] of requests) {
    const [method, status] = key.split('|');
    lines.push(
      `ff_http_requests_total{method="${method}",status="${status}"} ${value}`,
    );
  }
  lines.push(
    '# HELP ff_http_request_duration_seconds Request duration.',
    '# TYPE ff_http_request_duration_seconds histogram',
  );
  for (const [method, counts] of durationCounts) {
    const total = [...requests.entries()]
      .filter(([key]) => key.startsWith(`${method}|`))
      .reduce((sum, [, value]) => sum + value, 0);
    buckets.forEach((bucket, index) =>
      lines.push(
        `ff_http_request_duration_seconds_bucket{method="${method}",le="${bucket}"} ${counts[index]}`,
      ),
    );
    lines.push(
      `ff_http_request_duration_seconds_bucket{method="${method}",le="+Inf"} ${total}`,
      `ff_http_request_duration_seconds_sum{method="${method}"} ${(durationSums.get(method) ?? 0).toFixed(3)}`,
      `ff_http_request_duration_seconds_count{method="${method}"} ${total}`,
    );
  }
  const memory = process.memoryUsage();
  const all: Record<string, number> = {
    ff_process_resident_memory_bytes: memory.rss,
    ff_process_heap_used_bytes: memory.heapUsed,
    ff_process_uptime_seconds: Math.round(process.uptime()),
    ...gauges,
  };
  for (const [name, value] of Object.entries(all))
    lines.push(`# TYPE ${name} gauge`, `${name} ${value}`);
  return `${lines.join('\n')}\n`;
}

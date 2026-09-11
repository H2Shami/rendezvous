export function formatLine(component: string, line: string): string | null {
  if (!line.trim()) return null;
  const prefix = `[${component}]`;
  try {
    const entry = JSON.parse(line);
    if (!entry || typeof entry.event !== 'string') return `${prefix} ${line}`;
    const id = entry.request_id ? `  req=${entry.request_id}` : '';
    if (entry.event === 'http.started') return null; // Completion is the access log; polls have poll.started.
    if (['http.completed', 'http.disconnected'].includes(entry.event)) {
      return `${prefix} ${entry.method} ${entry.path} → ${entry.status ?? 'disconnected'}  ${entry.duration_ms}ms${entry.error_code ? `  ${entry.error_code}` : ''}${entry.upstream ? `  → ${entry.upstream}` : ''}${id}`;
    }
    const details = Object.entries(entry).filter(([key]) => !['event', 'component', 'timestamp', 'request_id'].includes(key))
      .map(([key, value]) => `${key}=${typeof value === 'string' ? JSON.stringify(value) : JSON.stringify(value)}`).join(' ');
    return `${prefix} ${entry.event}${details ? `  ${details}` : ''}${id}`;
  } catch { return `${prefix} ${line}`; }
}

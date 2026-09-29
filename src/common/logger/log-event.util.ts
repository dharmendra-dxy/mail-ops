/**
 * Formats a log line as `event=<name> key=value …`.
 *
 * Per-candidate send logs used to be free-form sentences, which are pleasant to
 * read but impossible to filter on once a 60-row batch is running. The event name
 * is the stable part an operator greps for; the fields are the row-specific
 * detail.
 */
export function formatLogEvent(
  event: string,
  fields: Record<string, string | number | boolean | null | undefined> = {},
): string {
  const parts = [`event=${event}`];

  for (const [key, value] of Object.entries(fields)) {
    if (value === null || value === undefined) continue;
    parts.push(`${key}=${formatValue(value)}`);
  }

  return parts.join(' ');
}

function formatValue(value: string | number | boolean): string {
  const text = String(value);
  // Quoting only when needed keeps the common case readable while staying
  // parseable for values that contain a space.
  return /[\s"=]/.test(text) ? `"${text.replace(/"/g, '\\"')}"` : text;
}

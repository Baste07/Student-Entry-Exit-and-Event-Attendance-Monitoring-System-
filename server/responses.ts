export function json(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}

export function message(status: number, value: string, success = false): Response {
  return json(status, { success, message: value });
}

export async function bodyObject(request: Request, maxBytes = 8192): Promise<Record<string, unknown> | null> {
  if (Number(request.headers.get('content-length') || 0) > maxBytes) return null;
  const raw = await request.text();
  if (Buffer.byteLength(raw, 'utf8') > maxBytes) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown> : null;
  } catch { return null; }
}

export const uuidPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export function trimmed(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

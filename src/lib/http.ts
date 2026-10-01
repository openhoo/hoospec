import { ApiError } from './errors';

export function checkOrigin(request: Request) {
  const origin = request.headers.get('origin');
  const url = new URL(request.url);
  const expected = process.env.HOOSPEC_ORIGIN || `${url.protocol}//${request.headers.get('host') || url.host}`;
  if (origin && origin !== expected) throw new ApiError('Anfragen von anderen Websites sind nicht erlaubt.', 403);
}

export async function bodyOf(request: Request): Promise<Record<string, unknown>> {
  checkOrigin(request);
  const text = await readRequestText(request);
  try { const body = JSON.parse(text); if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error(); return body; }
  catch { throw new ApiError('Ungültige Anfrage.'); }
}

/** Bound memory while receiving a body, including requests without Content-Length. */
export async function readRequestText(request: Request, maxBytes = 2000000): Promise<string> {
  const declared = request.headers.get('content-length');
  if (declared && Number(declared) > maxBytes) throw new ApiError('Die Anfrage ist zu groß.', 413);
  if (!request.body) return '';
  const reader = request.body.getReader(), decoder = new TextDecoder();
  let bytes = 0, text = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return text + decoder.decode();
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new ApiError('Die Anfrage ist zu groß.', 413);
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally { reader.releaseLock(); }
}

export function textField(body: Record<string, unknown>, key: string, max = 200000) {
  if (typeof body[key] !== 'string' || !body[key] || body[key].length > max) throw new ApiError(`Ungültiges Feld: ${key}.`);
  return body[key] as string;
}

export function versionField(body: Record<string, unknown>) {
  if (!Number.isSafeInteger(body.version) || Number(body.version) < 1) throw new ApiError('Ungültige Version.');
  return Number(body.version);
}

export function errorResponse(error: unknown) {
  return Response.json({ error: error instanceof ApiError || (error instanceof Error && error.name.includes('Parser')) ? error.message : 'Die Änderung konnte nicht gespeichert werden. Bitte Dokumentformat und Server prüfen.' }, { status: error instanceof ApiError ? error.status : 400 });
}

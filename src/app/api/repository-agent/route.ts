import { timingSafeEqual } from 'node:crypto';
import { generateAgentReplacement } from '@/lib/agent-provider';
import { flattenNodes } from '@/lib/gherkin';
import { parseDocument } from '@/lib/document';
import { ApiError } from '@/lib/errors';
import { textField, errorResponse, readRequestText } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 180;
let running = 0;
function cors(request: Request) {
  const expected = process.env.HOOSPEC_PAGES_ORIGIN;
  if (!expected) throw new ApiError('Der Repository-Agent ist nicht für GitLab Pages konfiguriert.', 503);
  if (request.headers.get('origin') !== expected) throw new ApiError('Diese Pages-Adresse ist nicht freigegeben.', 403);
  return { 'Access-Control-Allow-Origin': expected, 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', Vary: 'Origin' };
}
export function OPTIONS(request: Request) {
  try { return new Response(null, { status: 204, headers: cors(request) }); } catch (error) { return errorResponse(error); }
}
export async function POST(request: Request) {
  let headers: ReturnType<typeof cors> | undefined;
  try {
    headers = cors(request);
    const secret = process.env.HOOSPEC_REPOSITORY_AGENT_TOKEN;
    if (!secret || secret.length < 32) throw new ApiError('Der Repository-Agent braucht einen serverseitig konfigurierten Zugang.', 503);
    const provided = Buffer.from(request.headers.get('authorization')?.replace(/^Bearer /, '') || ''), expected = Buffer.from(secret);
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) throw new ApiError('Bitte den Zugang zum Repository-Agenten prüfen.', 401);
    if (running >= 4) throw new ApiError('Der Agent ist ausgelastet. Bitte kurz warten.', 429);
    const raw = await readRequestText(request, 1000000);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); if (!body || Array.isArray(body) || typeof body !== 'object') throw new Error(); } catch { throw new ApiError('Ungültige Anfrage.'); }
    const filename = textField(body, 'filename', 120), source = textField(body, 'source', 200000), instruction = textField(body, 'instruction', 4000);
    if (!/^[\p{L}\p{N}_. -]+\.(feature|md|markdown)$/iu.test(filename)) throw new ApiError('Ungültiger Dateiname.');
    const node = flattenNodes(parseDocument(source, filename)).find(item => item.id === textField(body, 'nodeId', 80));
    if (!node) throw new ApiError('Die Auswahl ist nicht mehr aktuell.', 409);
    // Body parsing yields: recheck before reserving one of the four slots.
    if (running >= 4) throw new ApiError('Der Agent ist ausgelastet. Bitte kurz warten.', 429);
    const encoder = new TextEncoder(); running++;
    const abort = new AbortController();
    const cancel = () => abort.abort();
    request.signal.addEventListener('abort', cancel, { once: true });
    if (request.signal.aborted) abort.abort();
    const stream = new ReadableStream({
      async start(controller) {
        const timer = setTimeout(() => abort.abort(), 150000);
        const send = (event: string, data: unknown) => { try { controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)); } catch { /* Disconnected browser. */ } };
        try {
          send('status', { message: 'Agent liest die Auswahl …' });
          const { replacement } = await generateAgentReplacement({ source, filename }, node, instruction, send, abort.signal);
          send('complete', { replacement });
        } catch (error) { send('error', { message: error instanceof ApiError ? error.message : 'Der Agent konnte keine gültige Änderung abschließen. Das Repository bleibt erhalten.' }); }
        finally { running--; clearTimeout(timer); abort.abort(); request.signal.removeEventListener('abort', cancel); try { controller.close(); } catch { /* Disconnected. */ } }
      },
      cancel,
    });
    return new Response(stream, { headers: { ...headers, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' } });
  } catch (error) {
    const response = errorResponse(error);
    if (headers) for (const [key, value] of Object.entries(headers)) response.headers.set(key, value);
    return response;
  }
}

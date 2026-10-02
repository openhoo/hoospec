import { CopilotBroker } from '@/lib/copilot-broker';
import { copilotRuntime } from '@/lib/copilot-runtime';
import { agentMessages } from '@/lib/agent-prompt';
import { flattenNodes, sourceOf } from '@/lib/gherkin';
import { parseDocument, documentKind } from '@/lib/document';
import { alignAgentIndent, normalizeAgentSource } from '@/lib/agent-output';
import { ApiError } from '@/lib/errors';
import { readRequestText, textField, errorResponse } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 180;
const broker = new CopilotBroker(copilotRuntime);
let running = 0;
function cors(request: Request) {
  const origin = request.headers.get('origin');
  const expected = process.env.HOOSPEC_PAGES_ORIGIN || process.env.HOOSPEC_ORIGIN || new URL(request.url).origin;
  if (origin !== expected) throw new ApiError('Diese Studio-Adresse ist nicht für Copilot freigegeben.', 403);
  return { 'Access-Control-Allow-Origin': expected, 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', Vary: 'Origin', 'Cache-Control': 'no-store' };
}
export function OPTIONS(request: Request) {
  try { return new Response(null, { status: 204, headers: cors(request) }); } catch (error) { return errorResponse(error); }
}
export async function POST(request: Request) {
  let headers: ReturnType<typeof cors> | undefined;
  let reserved = false, streaming = false;
  try {
    headers = cors(request);
    if (running >= 4) throw new ApiError('Copilot-Dienst ist ausgelastet. Bitte kurz warten.', 429);
    const raw = await readRequestText(request, 1000000);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); if (!body || Array.isArray(body) || typeof body !== 'object') throw new Error(); } catch { throw new ApiError('Ungültige Anfrage.'); }
    if (running >= 4) throw new ApiError('Copilot-Dienst ist ausgelastet. Bitte kurz warten.', 429);
    running++; reserved = true;
    const action = textField(body, 'action', 30);
    const key = request.headers.get('authorization')?.replace(/^Bearer /, '') || '';
    if (action !== 'start' && !/^[a-f0-9]{64}$/.test(key)) throw new ApiError('Bitte mit Copilot verbinden.', 401);
    const clientId = process.env.HOOSPEC_COPILOT_CLIENT_ID || '';
    if (action === 'start') return Response.json(await broker.start(clientId), { headers });
    if (action === 'poll') return Response.json(await broker.poll(key, clientId), { headers });
    if (action === 'disconnect') { broker.disconnect(key); return Response.json({ disconnected: true }, { headers }); }
    if (action !== 'agent') throw new ApiError('Unbekannte Copilot-Aktion.');
    const filename = textField(body, 'filename', 120), source = textField(body, 'source', 200000), instruction = textField(body, 'instruction', 4000), model = textField(body, 'model', 200);
    if (!/^[\p{L}\p{N}_. -]+\.(feature|md|markdown)$/iu.test(filename)) throw new ApiError('Ungültiger Dateiname.');
    const node = flattenNodes(parseDocument(source, filename)).find(item => item.id === textField(body, 'nodeId', 80));
    if (!node) throw new ApiError('Die Auswahl ist nicht mehr aktuell.', 409);
    broker.authorize(key, model);
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, request.signal, AbortSignal.timeout(150000)]);
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const send = (event: string, data: unknown) => { if (!signal.aborted) { try { controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)); } catch { abort.abort(); } } };
        try {
          send('status', { message: 'Copilot liest die Auswahl …' });
          let replacement = await broker.generate(key, model, agentMessages({ filename, source }, node, instruction), text => send('delta', { text }), signal);
          signal.throwIfAborted();
          replacement = alignAgentIndent(sourceOf(source, node), normalizeAgentSource(replacement, documentKind(filename) === 'adr' ? 'markdown' : 'gherkin'));
          send('complete', { replacement });
        } catch (error) { send('error', { message: error instanceof ApiError ? error.message : 'Copilot konnte keine vollständige Änderung liefern. Bitte erneut versuchen.' }); }
        finally { running--; abort.abort(); try { controller.close(); } catch { /* Disconnected. */ } }
      }, cancel() { abort.abort(); },
    });
    streaming = true;
    return new Response(stream, { headers: { ...headers, 'Content-Type': 'text/event-stream', 'X-Accel-Buffering': 'no' } });
  } catch (error) { const response = errorResponse(error); if (headers) for (const [key, value] of Object.entries(headers)) response.headers.set(key, value); return response; }
  finally { if (reserved && !streaming) running--; }
}

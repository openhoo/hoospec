import { agentModel } from '@/lib/agent-connection';
import { flattenNodes } from '@/lib/gherkin';
import { generateAgentReplacement } from '@/lib/agent-provider';
import { parseDocument, documentKind } from '@/lib/document';
import { ApiError, applyChange, clearDraft, fileAt, snapshot, transact, updateDraft } from '@/lib/store';
import { previewAgentSource } from '@/lib/agent-output';
import { bodyOf, errorResponse, textField, versionField } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 180;
const busy = globalThis as typeof globalThis & { hoospecAgentBusy?: Set<string> };
const active = busy.hoospecAgentBusy ??= new Set<string>();

export async function POST(request: Request) {
  try {
    const body = await bodyOf(request);
    const fileId = textField(body, 'fileId', 80), actor = textField(body, 'actor', 40);
    const instruction = textField(body, 'instruction', 4000), version = versionField(body);
    const nodeId = textField(body, 'nodeId', 80);
    const model = await agentModel(body.model);
    if (active.has(fileId)) throw new ApiError('Für diese Spec arbeitet bereits ein Agent. Bitte kurz warten.', 409);
    const file = fileAt(await snapshot(), fileId, version);
    const node = flattenNodes(parseDocument(file.source, file.filename)).find(n => n.id === nodeId);
    const adr = documentKind(file.filename) === 'adr';
    if (!node) throw new ApiError('Die Auswahl ist nicht mehr aktuell.', 409);
    if (active.has(fileId)) throw new ApiError('Für diese Spec arbeitet bereits ein Agent. Bitte kurz warten.', 409);
    active.add(fileId);
    const encoder = new TextEncoder();
    const abort = new AbortController();
    const cancel = () => abort.abort();
    request.signal.addEventListener('abort', cancel, { once: true });
    if (request.signal.aborted) abort.abort();
    const stream = new ReadableStream({
      async start(controller) {
        function send(event: string, data: unknown) {
          try { controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)); } catch { /* Client disconnected. */ }
        }
        send('status', { message: 'Agent liest die Auswahl …' });
        updateDraft({ fileId, nodeId, version, actor, text: '', phase: 'reading' });
        const timer = setTimeout(() => abort.abort(), 150000);
        let stage = 'generate'; let output = '';
        try {
          const { source, replacement } = await generateAgentReplacement(file, node, instruction, (event, data) => {
            send(event, data);
            if (event === 'delta' && data.text) {
              output += data.text;
              updateDraft({ fileId, nodeId, version, actor, text: previewAgentSource(output, adr ? 'markdown' : 'gherkin'), phase: 'writing' });
            }
          }, abort.signal, model);
          updateDraft({ fileId, nodeId, version, actor, text: replacement, phase: 'validating' });
          stage = 'save';
          await transact(current => {
            abort.signal.throwIfAborted();
            applyChange(current, fileId, version, source, actor, instruction, 'ai');
          });
          send('complete', await snapshot());
        } catch (error) {
          const cause = error instanceof Error ? error.cause as { code?: string } | undefined : undefined;
          console.warn('Hoospec agent failure', { stage, type: error instanceof Error ? error.name : 'unknown', code: cause?.code || null, status: error instanceof ApiError ? error.status : null });
          send('error', { message: error instanceof ApiError ? error.message : 'Die Änderung konnte nicht übernommen werden. Bitte die Gherkin-Syntax prüfen oder erneut versuchen. Die gespeicherte Spec bleibt erhalten.' });
        } finally {
          clearTimeout(timer); abort.abort(); active.delete(fileId);
          request.signal.removeEventListener('abort', cancel);
          clearDraft(fileId);
          try { controller.close(); } catch { /* Already disconnected. */ }
        }
      },
      cancel,
    });
    return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' } });
  } catch (error) { return errorResponse(error); }
}

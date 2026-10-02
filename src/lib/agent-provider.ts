import { agentModel, invalidateAgentConnection } from './agent-connection';
import { agentMessages } from './agent-prompt';
import { replaceNode, sourceOf, type SpecNode } from './gherkin';
import { EventStreamDecoder } from './event-stream';
import { readAdrStatus } from './adr';
import { parseDocument, documentKind } from './document';
import { ApiError } from './errors';
import { alignAgentIndent, normalizeAgentSource } from './agent-output';

export async function generateAgentReplacement(file: { source: string; filename: string }, node: SpecNode, instruction: string, send: (event: string, data: { message?: string; text?: string }) => void, signal: AbortSignal, requestedModel?: unknown) {
  const key = process.env.HOOSPEC_AI_KEY, model = await agentModel(requestedModel);
  if (!key || !model) throw new ApiError('Der serverseitige AI-Agent ist noch nicht verbunden.', 503);
  const adr = documentKind(file.filename) === 'adr';
  const base = (process.env.HOOSPEC_AI_BASE_URL || 'https://ai.openhoo.ai/v1').replace(/\/$/, '');
  const response = await fetch(`${base}/chat/completions`, {
    method: 'POST', signal, redirect: 'error',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, stream: true, messages: agentMessages(file, node, instruction) }),
  }).catch(() => { if (!signal.aborted) invalidateAgentConnection(); throw new ApiError('Der AI-Dienst ist nicht erreichbar. Bitte die Verbindung prüfen.', 503); });
  if ([401, 403, 503].includes(response.status)) invalidateAgentConnection();
  if (!response.ok || !response.body) throw new ApiError(`Der AI-Anbieter hat die Anfrage nicht ausgeführt (HTTP ${response.status}). Bitte die Serverkonfiguration prüfen.`, 502);
  send('status', { message: 'Agent formuliert die Änderung …' });

  const reader = response.body.getReader(), decoder = new TextDecoder();
  const events = new EventStreamDecoder();
  let replacement = '', completed = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      for (const frame of events.push(done ? decoder.decode() : decoder.decode(value, { stream: true }), done)) {
        if (frame.data === '[DONE]') { completed = true; continue; }
        const chunk = JSON.parse(frame.data);
        if (chunk.error) throw new ApiError('Der AI-Anbieter meldet einen Fehler. Bitte erneut versuchen.', 502);
        const choice = chunk.choices?.[0];
        const delta = choice?.delta?.content;
        if (typeof delta === 'string') {
          replacement += delta;
          if (replacement.length > 200000) throw new ApiError('Die Antwort des Agenten ist zu groß.', 502);
          send('delta', { text: delta });

        }
        if (choice?.finish_reason === 'length') throw new ApiError('Die AI-Antwort wurde abgeschnitten. Bitte einen kleineren Bereich auswählen.', 502);
        if (choice?.finish_reason && choice.finish_reason !== 'stop') throw new ApiError('Der AI-Anbieter konnte die Antwort nicht vollständig ausführen. Bitte erneut versuchen.', 502);
        if (choice?.finish_reason === 'stop') completed = true;
      }
      if (done) break;
    }
  } finally { reader.releaseLock(); }
  if (!completed) throw new ApiError('Die Verbindung zum AI-Anbieter wurde unterbrochen. Die unvollständige Antwort wurde nicht gespeichert.', 502);

  try { replacement = alignAgentIndent(sourceOf(file.source, node), normalizeAgentSource(replacement, adr ? 'markdown' : 'gherkin')); }
  catch (error) { throw new ApiError(error instanceof Error ? error.message : 'Ungültiger Änderungsblock.', 502); }
  if (!replacement.trim()) throw new ApiError('Der Agent hat keine Änderung zurückgegeben.', 502);
  if (node.kind === 'adr-answer' && !/^\s+(?:\*\*)?(?:Antwort|Answer)(?:\*\*)?\s*:/i.test(replacement)) throw new ApiError('Der Agent muss den ausgewählten Antwortbereich erhalten.', 502);
  send('status', { message: adr ? 'ADR prüfen …' : 'Gherkin prüfen …' });


  const source = replaceNode(file.source, node, replacement);
  parseDocument(source, file.filename);
  if (adr && readAdrStatus(source) !== readAdrStatus(file.source)) throw new ApiError('Der Agent darf den Entscheidungsstatus nicht ändern. Bitte den Status im Studio selbst setzen.', 502);

  return { replacement, source };
}

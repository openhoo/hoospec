'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Textarea } from './ui/textarea';
import { flattenNodes, type SpecNode } from '@/lib/gherkin';
import { parseDocument } from '@/lib/document';
import { documentFromSource } from '@/lib/json-document';
import { inlineSource, inlineValue, type InlineMode } from '@/lib/inline-source';
import type { TableCell } from '@/lib/table-cells';
import { serverBackend, type StudioBackend } from '@/lib/studio-backend';
import type { Snapshot, SpecFile } from '@/lib/types';

type Edit = { node: SpecNode; file: SpecFile; mode: InlineMode; cell?: TableCell };
export function InlineEditor({ edit, backend = serverBackend, actor, onSnapshot, onClose, onHistory, onFlushReady, onInsertRow, onInsertStep, children }: {
  edit: Edit; backend?: StudioBackend; actor: string; onSnapshot: (state: Snapshot) => void; onClose: () => void;
  onInsertStep?: (file: SpecFile, node: SpecNode) => Promise<void>;
  onInsertRow?: (file: SpecFile, node: SpecNode, cell: TableCell) => Promise<void>;
  onFlushReady: (flush: () => Promise<SpecFile>) => void;
  onHistory: (action: 'undo' | 'redo', state?: Snapshot) => Promise<void>; children?: React.ReactNode;
}) {
  const initial = inlineValue(edit.file.source, edit.node, edit.mode, edit.cell);
  const [value, setValue] = useState(initial);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const current = useRef({ file: edit.file, node: edit.node, saved: initial, value: initial });
  const draftRedo = useRef<string | null>(null);
  const running = useRef<Promise<Snapshot | null> | null>(null);
  const area = useRef<HTMLElement>(null);
  const callbacks = useRef({ actor, onSnapshot, onClose, onHistory, onInsertRow, onInsertStep });
  useEffect(() => { callbacks.current = { actor, onSnapshot, onClose, onHistory, onInsertRow, onInsertStep }; }, [actor, onSnapshot, onClose, onHistory, onInsertRow, onInsertStep]);

  const flush = useCallback((): Promise<Snapshot | null> => {
    if (running.current) return running.current;
    const work = async () => {
      let result: Snapshot | null = null;
      while (current.current.value !== current.current.saved) {
        const { file, node, value } = current.current;
        const source = inlineSource(file.source, node, edit.mode, value, edit.cell);
        if (source === file.source) { current.current.saved = value; setStatus(backend.repository ? 'Entwurf' : 'Gespeichert'); continue; }
        setStatus('Speichert …'); setError('');
        const state = await backend.request({ action: 'save-document', fileId: file.id, version: file.version, document: documentFromSource(source, file.filename), actor: callbacks.current.actor });
        const savedFile = state.files.find((item: SpecFile) => item.id === file.id)!;
        const savedNodes = flattenNodes(parseDocument(source, file.filename));
        const savedNode = savedNodes.find(item => item.id === node.id) || savedNodes.find(item => item.kind === node.kind && item.start >= node.start && item.start <= node.end + source.split('\n').length - file.source.split('\n').length) || { ...node, end: node.end + source.split('\n').length - file.source.split('\n').length };
        current.current = { ...current.current, file: savedFile, node: savedNode, saved: value };
        callbacks.current.onSnapshot(state); result = state;
        setStatus(backend.repository ? 'Entwurf' : 'Gespeichert');
      }
      return result;
    };
    const promise = work().catch(cause => { setError((cause as Error).message); setStatus('Nicht gespeichert'); throw cause; }).finally(() => { running.current = null; });
    running.current = promise;
    return promise;
  }, [edit.mode, edit.cell, backend]);

  useEffect(() => { onFlushReady(async () => { await flush(); return current.current.file; }); }, [flush, onFlushReady]);

  useEffect(() => {
    if (value === current.current.saved) return;
    const timer = setTimeout(() => { void flush().catch(() => {}); }, 400);
    return () => clearTimeout(timer);
  }, [value, flush]);

  useEffect(() => { area.current?.querySelector('textarea')?.focus({ preventScroll: true }); }, []);

  const finish = () => { void flush().then(() => callbacks.current.onClose()).catch(() => {}); };
  return <section ref={area} className={`zen-inline-edit zen-inline-${edit.node.kind} zen-inline-mode-${edit.mode}`} onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()} onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) finish();
  }}>
    <div className="zen-inline-row">{edit.mode === 'name' && <span className="zen-keyword">{edit.node.keyword}</span>}
      <Textarea rows={edit.mode === 'name' || edit.mode === 'cell' || edit.mode === 'question' ? 1 : undefined} className={edit.mode === 'name' ? 'zen-inline-name' : edit.mode === 'description' ? 'zen-inline-description' : edit.mode === 'cell' ? 'zen-inline-cell' : edit.mode === 'answer' ? 'zen-inline-answer' : edit.mode === 'question' ? 'zen-inline-question' : ''} placeholder={edit.mode === 'answer' ? 'Eure Antwort …' : undefined} aria-label={edit.mode === 'answer' ? 'Antwort direkt bearbeiten' : edit.mode === 'question' ? 'Frage direkt bearbeiten' : edit.mode === 'name' ? 'Text direkt bearbeiten' : edit.mode === 'description' ? 'Beschreibung direkt bearbeiten' : edit.mode === 'cell' ? `Zelle bearbeiten: Zeile ${edit.cell!.row + 1}, Spalte ${edit.cell!.column + 1}` : 'Bereich direkt bearbeiten'} value={value} spellCheck={edit.mode === 'name'} onChange={event => {
        draftRedo.current = null; current.current.value = event.target.value; setValue(event.target.value); setError(''); setStatus('');
      }} onKeyDown={event => {
        if (event.nativeEvent.isComposing) return;
        const key = event.key.toLowerCase();
        if ((edit.mode === 'cell' || (edit.mode === 'name' && edit.node.kind === 'step')) && event.key === 'Enter' && event.shiftKey) {
          event.preventDefault(); event.stopPropagation();
          if (event.repeat) return;
          void flush().then(() => edit.mode === 'cell' ? callbacks.current.onInsertRow?.(current.current.file, current.current.node, edit.cell!) : callbacks.current.onInsertStep?.(current.current.file, current.current.node)).catch(() => {});
        } else if ((event.ctrlKey || event.metaKey) && (key === 'z' || key === 'y')) {
          event.preventDefault(); event.stopPropagation();
          const action = key === 'y' || event.shiftKey ? 'redo' : 'undo';
          if (action === 'undo' && current.current.value !== current.current.saved) {
            draftRedo.current = current.current.value; current.current.value = current.current.saved;
            setValue(current.current.saved); setError(''); setStatus(backend.repository ? 'Entwurf' : 'Gespeichert'); return;
          }
          if (action === 'redo' && draftRedo.current !== null) {
            current.current.value = draftRedo.current; setValue(draftRedo.current); draftRedo.current = null; setError(''); return;
          }
          void flush().then(state => { callbacks.current.onClose(); return callbacks.current.onHistory(action, state || undefined); }).catch(() => {});
        } else if (event.key === 'Escape' || (event.key === 'Enter' && (edit.mode === 'name' || edit.mode === 'cell' || event.ctrlKey || event.metaKey))) {
          event.preventDefault(); event.stopPropagation(); finish();
        }
      }}/>
    </div>
    <div className="zen-inline-status" role={error ? 'alert' : 'status'}>{error || status}</div>
    {children}
  </section>;
}

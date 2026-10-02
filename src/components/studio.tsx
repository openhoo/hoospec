'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { diffLines } from 'diff';
import { ArrowDownToLine, ArrowUp, Check, ChevronDown, ChevronRight, Code2, FilePlus2, FileText, History, Link2, Loader2, MoreHorizontal, Sparkles, Undo2, Upload, Users, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { RepositoryReviewDialog } from './repository-review';
import { DocumentOverview } from './document-overview';
import { InlineEditor } from './inline-editor';
import { AnimatedWords } from './animated-words';
import { flattenNodes, replaceNode, sourceOf, type SpecNode } from '@/lib/gherkin';
import { deleteTableRow, insertTableRow, tableRows, type TableCell } from '@/lib/table-cells';
import { parseDocument, documentKind } from '@/lib/document';
import { documentFromSource } from '@/lib/json-document';
import { adrStatuses, readAdrStatus, adrIntroduction, createAdr, nextAdrFilename, type AdrStatus } from '@/lib/adr';
import { structuralTarget, type HoveredRow } from '@/lib/editor-target';
import { deleteSpecNode, insertStepAfter } from '@/lib/node-edit';
import { useTheme } from '@/lib/theme';
import type { InlineMode } from '@/lib/inline-source';
import { resolveNode } from '@/lib/node-anchor';
import { mergeSnapshot } from '@/lib/snapshot-state';
import { EventStreamDecoder } from '@/lib/event-stream';
import { previewAgentSource } from '@/lib/agent-output';
import { serverBackend, type StudioBackend } from '@/lib/studio-backend';
import type { Change, LiveDraft, Snapshot, SpecFile } from '@/lib/types';

type Selection = { node: SpecNode; file: SpecFile };
const labels: Record<SpecNode['kind'], string> = { feature: 'Feature', rule: 'Regel', scenario: 'Szenario', background: 'Hintergrund', step: 'Schritt', examples: 'Beispiele', adr: 'ADR', 'adr-section': 'Abschnitt', 'adr-question': 'Frage', 'adr-answer': 'Antwort' };
const initialSource = 'Feature: Eine neue Idee\n  Was soll für unsere Nutzer möglich werden?\n\n  Scenario: Der erste Anwendungsfall\n    Given eine Ausgangssituation\n    When eine Aktion ausgeführt wird\n    Then ist das erwartete Ergebnis sichtbar\n';

export function Studio({ backend = serverBackend, onRepository, suspended = false }: { backend?: StudioBackend; onRepository?: () => void; suspended?: boolean }) {
  const [repositoryOpen, setRepositoryOpen] = useState(false);
  const request = useCallback((body: Record<string, unknown>) => backend.request(body), [backend]);
  const { theme, setTheme } = useTheme();
  const [workspace, setWorkspace] = useState<Snapshot | null>(null);
  const readOnly = backend.readOnly === true || workspace?.repository?.submissionPending === true;
  const [connected, setConnected] = useState(false);
  const [browserOnline, setBrowserOnline] = useState(true);
  useEffect(() => {
    const update = () => setBrowserOnline(navigator.onLine); update();
    window.addEventListener('online', update); window.addEventListener('offline', update);
    return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update); };
  }, []);
  const [identity, setIdentity] = useState({ id: '', name: 'Gast' });
  const [selection, setSelectionState] = useState<Selection | null>(null);
  const [hoverId, setHoverIdState] = useState<string | null>(null);
  const [hoveredRow, setHoveredRowState] = useState<HoveredRow | null>(null);
  // Pointer and key events can arrive before React installs the next effect.
  const interaction = useRef<{ selection: Selection | null; hoverId: string | null; row: HoveredRow | null }>({ selection: null, hoverId: null, row: null });
  const setSelection = useCallback((next: Selection | null) => { interaction.current.selection = next; setSelectionState(next); }, []);
  const setHoverId = useCallback((next: string | null) => { interaction.current.hoverId = next; setHoverIdState(next); }, []);
  const setHoveredRow = useCallback((next: HoveredRow | null) => { interaction.current.row = next; setHoveredRowState(next); }, []);
  const tableMutation = useRef(false);
  const historyMutation = useRef(false);
  const [instruction, setInstruction] = useState('');
  const [selectedModel, setSelectedModel] = useState('');
  const aiAvailable = connected && browserOnline && workspace?.aiReady === true && !readOnly;
  const aiModels = workspace?.aiModels || [];
  const aiModel = aiModels.find(item => item.id === selectedModel)?.id || workspace?.aiModel || aiModels[0]?.id || '';
  const [inlineEdit, setInlineEdit] = useState<{ node: SpecNode; file: SpecFile; mode: InlineMode; cell?: TableCell } | null>(null);
  const [busy, setBusy] = useState(false);
  const agentRequest = useRef<AbortController | null>(null);
  useEffect(() => () => agentRequest.current?.abort(), []);
  const [localDraft, setLocalDraft] = useState<LiveDraft | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [pending, setPending] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  const [overview, setOverview] = useState(true);
  const [tools, setTools] = useState<'source' | 'json' | 'history' | 'profile' | 'new' | null>(null);
  const [query, setQuery] = useState('');
  const [follow, setFollow] = useState(backend.collaboration);
  const [localId, setLocalId] = useState<string | null>(null);
  const [editor, setEditor] = useState<{ file: SpecFile; draft: string } | null>(null);
  const [fileFilter, setFileFilter] = useState<'all' | 'feature' | 'adr' | 'open'>('all');
  const [newKind, setNewKind] = useState<'feature' | 'adr'>('feature');
  const [newTitle, setNewTitle] = useState('');
  const [newContext, setNewContext] = useState('');
  const [newName, setNewName] = useState('neue-spec.feature');
  const [newSource, setNewSource] = useState(initialSource);
  const [profileName, setProfileName] = useState('');
  const [changeView, setChangeView] = useState<Change | null>(null);
  const [box, setBox] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const inlineFlush = useRef<(() => Promise<SpecFile>) | null>(null);
  const command = useRef<HTMLInputElement>(null);
  const upload = useRef<HTMLInputElement>(null);
  const scroll = useRef<HTMLElement>(null);
  const elements = useRef(new Map<string, HTMLElement>());

  useEffect(() => {
    if (!backend.repository || !inlineEdit) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [backend, inlineEdit]);
  async function openRepositoryReview() {
    try {
      if (inlineEdit && inlineFlush.current) await inlineFlush.current();
      setInlineEdit(null); setRepositoryOpen(true);
    } catch { /* Keep invalid inline drafts visible. */ }
  }

  const accept = useCallback((next: Snapshot) => setWorkspace(current => mergeSnapshot(current, next)), []);
  useEffect(() => {
    let person: { id: string; name: string };
    try { person = JSON.parse(sessionStorage.getItem('hoospec-person') || 'null') || { id: crypto.randomUUID(), name: 'Gast' }; }
    catch { person = { id: crypto.randomUUID(), name: 'Gast' }; }
    if (typeof person?.id !== 'string' || !/^[\w-]{1,80}$/.test(person.id) || typeof person.name !== 'string') person = { id: crypto.randomUUID(), name: 'Gast' };
    try { sessionStorage.setItem('hoospec-person', JSON.stringify(person)); } catch { /* The editor remains usable without browser storage. */ }
    let disposed = false;
    void backend.load().then(next => { if (!disposed) accept(next); }).catch(cause => { if (!disposed) setError(cause instanceof Error ? cause.message : 'Die Verbindung konnte nicht hergestellt werden.'); });
    let initialized = false;
    const stream = backend.subscribe({
      snapshot: next => { if (!disposed) accept(next); },
      connection: live => { if (!disposed) { if (!initialized) { initialized = true; setIdentity(person); setProfileName(person.name); } setConnected(live); } },
      error: message => { if (!disposed) setError(message); },
    });
    return () => { disposed = true; stream(); };
  }, [accept, backend]);
  useEffect(() => {
    if (!identity.id || !backend.collaboration) return;
    const beat = () => request({ action: 'presence', actor: identity.name, participantId: identity.id }).then(accept).catch(() => {});
    beat();
    const timer = setInterval(beat, 10000);
    return () => clearInterval(timer);
  }, [identity, accept, request, backend]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 4000);
    return () => clearTimeout(timer);
  }, [notice]);

  const heldFileId = inlineEdit?.file.id || localDraft?.fileId || ((tools === 'source' || tools === 'json') ? editor?.file.id : undefined);
  const file = workspace?.files.find(f => f.id === (heldFileId || (follow ? workspace.activeFileId : localId || workspace.activeFileId))) || workspace?.files[0];
  const isAdr = !!file && documentKind(file.filename) === 'adr';
  const viewFile = inlineEdit && inlineEdit.file.id === file?.id ? inlineEdit.file : file;
  const tree = useMemo(() => viewFile ? parseDocument(viewFile.source, viewFile.filename) : null, [viewFile]);
  const nodes = useMemo(() => tree ? flattenNodes(tree) : [], [tree]);
  const editingNode = inlineEdit ? nodes.find(node => node.id === inlineEdit.node.id) || nodes.find(node => node.kind === inlineEdit.node.kind && node.start >= inlineEdit.node.start && node.start <= inlineEdit.node.end) : null;
  const hovered = nodes.find(n => n.id === hoverId);
  const selectedNode = selection && selection.file.id === file?.id && viewFile ? resolveNode(selection.node, selection.file.source, viewFile.source, viewFile.filename) : undefined;
  const scopedTarget = selectedNode || editingNode || hovered;
  const target = scopedTarget || tree;
  const draft = localDraft?.fileId === file?.id ? localDraft : workspace?.drafts?.find(d => d.fileId === file?.id && d.version === file?.version);
  const draftNode = draft ? nodes.find(n => n.id === draft.nodeId) : undefined;
  const preview = useMemo(() => {
    if (!file || !tree || !draftNode || !draft?.text.trim()) return { tree, source: viewFile?.source || '' };
    try { const source = replaceNode(viewFile?.source || file.source, draftNode, draft.text); return { tree: parseDocument(source, file.filename), source }; } catch { return { tree, source: viewFile?.source || file.source }; }
  }, [file, viewFile, tree, draftNode, draft]);
  const outlinedId = draft?.nodeId || scopedTarget?.id;
  const changes = workspace?.changes.filter(c => c.fileId === file?.id) || [];

  useEffect(() => {
    if (scroll.current) scroll.current.scrollTop = 0;
    const frame = requestAnimationFrame(() => { setSelection(null); setHoverId(null); setHoveredRow(null); setInstruction(''); });
    return () => cancelAnimationFrame(frame);
  }, [file?.id, setSelection, setHoverId, setHoveredRow]);
  useEffect(() => {
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const element = outlinedId ? elements.current.get(outlinedId) : undefined;
        const rect = element?.getBoundingClientRect();
        setBox(rect ? { left: rect.left - 10, top: rect.top - 7, width: rect.width + 20, height: rect.height + 14 } : null);
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (scroll.current) observer.observe(scroll.current);
    if (outlinedId && elements.current.get(outlinedId)) observer.observe(elements.current.get(outlinedId)!);
    window.addEventListener('scroll', measure, true);
    window.addEventListener('resize', measure);
    return () => { observer.disconnect(); cancelAnimationFrame(frame); window.removeEventListener('scroll', measure, true); window.removeEventListener('resize', measure); };
  }, [outlinedId, preview, inlineEdit]);

  async function clearFocus() {
    if (busy || draft) return;
    try { if (inlineEdit && inlineFlush.current) await inlineFlush.current(); }
    catch { return; }
    setInlineEdit(null); setSelection(null); setHoverId(null); setHoveredRow(null); setError('');
    command.current?.blur();
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  }

  const pin = useCallback(async (node: SpecNode) => {
    if (!file || busy || draft || pending) return;
    try {
      const latest = inlineEdit && inlineFlush.current ? await inlineFlush.current() : file;
      const currentNode = resolveNode(node, viewFile?.source || file.source, latest.source, latest.filename, inlineEdit?.node.id === node.id);
      if (!currentNode) return;
      setInlineEdit(null); setSelection({ node: currentNode, file: structuredClone(latest) }); setError('');
      command.current?.focus({ preventScroll: true });
    } catch { /* Keep the failed editor open. */ }
  }, [file, viewFile, busy, draft, pending, inlineEdit, setSelection]);
  const restore = useCallback(async (action: 'undo' | 'redo', state?: Snapshot) => {
    if (readOnly || historyMutation.current || busy || pending || draft) return;
    historyMutation.current = true;
    try {
      const current = state?.files.find(item => item.id === file?.id) || (inlineEdit && inlineFlush.current ? await inlineFlush.current() : file);
      if (!current) return;
      setInlineEdit(null); setSelection(null); setHoverId(null); setHoveredRow(null); setBox(null); setPending(true); setError('');
      accept(await request({ action, fileId: current.id, version: current.version, actor: identity.name }));
      setNotice(action === 'undo' ? 'Rückgängig gemacht.' : 'Wiederhergestellt.');
    } catch (error) { setError((error as Error).message); }
    finally { historyMutation.current = false; setPending(false); }
  }, [file, inlineEdit, busy, pending, draft, identity.name, accept, request, setSelection, setHoverId, setHoveredRow, readOnly]);
  const changeTableRow = useCallback(async (action: 'insert' | 'delete', currentFile: SpecFile, node: SpecNode, cell: TableCell) => {
    if (readOnly || tableMutation.current || busy || pending || draft) return;
    tableMutation.current = true; setPending(true); setError(''); setBox(null); setSelection(null); setHoverId(null); setHoveredRow(null);
    try {
      const source = action === 'insert' ? insertTableRow(currentFile.source, node, cell.row) : deleteTableRow(currentFile.source, node, cell.row);
      const state = await request({ action: 'save-document', fileId: currentFile.id, version: currentFile.version, document: documentFromSource(source, currentFile.filename), actor: identity.name });
      accept(state); setSelection(null); setHoverId(null); setHoveredRow(null);
      if (action === 'insert') {
        const saved = state.files.find(item => item.id === currentFile.id)!;
        const savedNode = flattenNodes(parseDocument(saved.source, saved.filename)).find(item => item.id === node.id)!;
        setInlineEdit({ file: saved, node: savedNode, mode: 'cell', cell: { row: cell.row + 1, column: cell.column } });
      } else setInlineEdit(null);
      setNotice(action === 'insert' ? 'Zeile eingefügt.' : 'Zeile gelöscht.');
    } catch (error) { setError((error as Error).message); }
    finally { tableMutation.current = false; setPending(false); }
  }, [busy, pending, draft, identity.name, accept, request, setSelection, setHoverId, setHoveredRow, readOnly]);
  const changeNode = useCallback(async (action: 'insert' | 'delete', node: SpecNode, currentFile = file) => {
    if (readOnly || !currentFile || tableMutation.current || busy || pending || draft || (inlineEdit && action === 'delete')) return;
    tableMutation.current = true; setPending(true); setError('');
    setBox(null); setSelection(null); setHoverId(null); setHoveredRow(null);
    try {
      const source = action === 'delete' ? deleteSpecNode(currentFile.source, node) : insertStepAfter(currentFile.source, node);
      const state = await request({ action: 'save-document', fileId: currentFile.id, version: currentFile.version, document: documentFromSource(source, currentFile.filename), actor: identity.name });
      accept(state);
      if (action === 'insert') {
        const saved = state.files.find(item => item.id === currentFile.id)!;
        const added = flattenNodes(parseDocument(saved.source, saved.filename)).find(item => item.kind === 'step' && item.start === node.end + 1)!;
        setInlineEdit({ file: saved, node: added, mode: 'name' });
      }
      setNotice(action === 'delete' ? `${labels[node.kind]} gelöscht.` : 'Schritt eingefügt.');
    } catch (cause) { setError((cause as Error).message); }
    finally { tableMutation.current = false; setPending(false); }
  }, [file, busy, pending, draft, inlineEdit, identity.name, accept, request, setSelection, setHoverId, setHoveredRow, readOnly]);
  const startInline = useCallback(async (node: SpecNode, mode: InlineMode, cell?: TableCell) => {
    if (readOnly) return;
    if (!file || busy || draft || pending) return;
    if (inlineEdit?.node.id === node.id && inlineEdit.mode === mode && inlineEdit.cell?.row === cell?.row && inlineEdit.cell?.column === cell?.column) return;
    try {
      const latest = inlineEdit && inlineFlush.current ? await inlineFlush.current() : file;
      const currentNode = resolveNode(node, viewFile?.source || file.source, latest.source, latest.filename, inlineEdit?.node.id === node.id);
      if (!currentNode) return;
      setSelection(null); setHoverId(null); setError('');
      setInlineEdit({ node: currentNode, file: structuredClone(latest), mode, cell });
    } catch { /* The current editor keeps its unsaved text and error visible. */ }
  }, [file, viewFile, busy, draft, pending, inlineEdit, setSelection, setHoverId, readOnly]);

  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if (suspended || repositoryOpen || overview) return;
      if (event.isComposing) return;
      const typing = (event.target as HTMLElement)?.closest('input,textarea,[contenteditable=true]');
      const currentInteraction = interaction.current;
      const structural = structuralTarget({ selected: currentInteraction.selection && currentInteraction.selection.file.id === file?.id && viewFile ? resolveNode(currentInteraction.selection.node, currentInteraction.selection.file.source, viewFile.source, viewFile.filename) : undefined,
        hovered: nodes.find(node => node.id === currentInteraction.hoverId), hoveredRow: currentInteraction.row, fileId: file?.id,
        input: event.target === command.current ? 'command' : typing ? 'editor' : 'none',
        commandText: command.current?.value || '', editing: !!inlineEdit });
      if (structural && file && !tools && !filesOpen && !changeView && !event.repeat && !event.ctrlKey && !event.metaKey && !event.altKey) {
        if (event.key === 'Enter' && !event.shiftKey && structural.kind === 'node' && (structural.node.kind === 'adr-question' || structural.node.kind === 'adr-answer')) {
          event.preventDefault();
          void startInline(structural.node, 'answer');
          return;
        }
        if (event.key === 'Backspace' || (event.key === 'Enter' && event.shiftKey && (structural.kind === 'row' || structural.node.kind === 'step'))) {
          event.preventDefault();
          if (event.target === command.current) command.current?.blur();
          if (structural.kind === 'row') void changeTableRow(event.key === 'Backspace' ? 'delete' : 'insert', file, structural.node, { row: structural.row, column: 0 });
          else void changeNode(event.key === 'Backspace' ? 'delete' : 'insert', structural.node);
          return;
        }
      }
      if (structural?.kind === 'node' && structural.node.kind === 'adr-section' && event.key === 'Enter' && !event.shiftKey && !typing && !tools && !filesOpen && !busy) { event.preventDefault(); void startInline(structural.node, 'description'); return; }
      if (inlineEdit) return;
      const key = event.key.toLowerCase();
      if ((!typing || (event.target === command.current && !command.current?.value)) && !tools && !filesOpen && !changeView && (event.ctrlKey || event.metaKey) && (key === 'z' || key === 'y')) {
        event.preventDefault();
        void restore(key === 'y' || event.shiftKey ? 'redo' : 'undo');
        return;
      }
      if (event.key === 'Escape' && !busy && !tools && !filesOpen && !changeView) { setSelection(null); setHoverId(null); setInstruction(''); command.current?.blur(); }
      if (event.key === '/' && aiAvailable && !typing && target && !tools && !filesOpen && !changeView) { event.preventDefault(); pin(target); }
      if (event.altKey && event.key === 'ArrowUp' && target && !typing && !tools && !filesOpen && !changeView && !busy) {
        event.preventDefault();
        const parent = [...nodes].reverse().find(n => n.id !== target.id && n.start <= target.start && n.end >= target.end);
        if (parent) pin(parent);
      }
      if (event.altKey && event.key === 'ArrowDown' && target && !typing && !tools && !filesOpen && !changeView && !busy) {
        event.preventDefault();
        if (target.children[0]) pin(target.children[0]);
      }
    };
    window.addEventListener('keydown', keyboard);
    return () => window.removeEventListener('keydown', keyboard);
  }, [target, pin, nodes, viewFile, changeView, busy, tools, filesOpen, inlineEdit, restore, hoveredRow, file, changeTableRow, changeNode, overview, setSelection, setHoverId, startInline, suspended, repositoryOpen, aiAvailable]);

  async function mutate(body: Record<string, unknown>, message?: string) {
    if (readOnly && body.action !== 'navigate') { setError('Du hast auf diesem Branch nur Leserechte.'); return null; }
    setPending(true); setError('');
    try { const state = await request({ ...body, actor: identity.name }); accept(state); if (body.action === 'import') setLocalId(state.activeFileId); if (message) setNotice(message); return true; }
    catch (e) { setError((e as Error).message); return false; }
    finally { setPending(false); }
  }
  async function openNew(kind: 'feature' | 'adr') {
    if (readOnly) return;
    try { if (inlineEdit && inlineFlush.current) await inlineFlush.current(); } catch { return; }
    setInlineEdit(null);
    setNewKind(kind); setNewTitle(''); setNewContext(''); setNewSource(initialSource);
    setNewName(kind === 'adr' ? nextAdrFilename(workspace?.files.map(item => item.filename) || []) : 'neue-spec.feature');
    setFilesOpen(false); setTools('new'); setError('');
  }
  async function changeAdrStatus(status: AdrStatus) {
    if (!file || busy || draft || pending) return;
    try {
      const latest = inlineEdit && inlineFlush.current ? await inlineFlush.current() : file;
      setInlineEdit(null); setSelection(null); setHoverId(null);
      await mutate({ action: 'adr-status', fileId: latest.id, version: latest.version, status }, `ADR: ${adrStatuses[status]}.`);
    } catch { /* Retain failed inline edits. */ }
  }
  async function navigate(id: string) {
    if (busy || pending) return;
    try { if (inlineEdit && inlineFlush.current) await inlineFlush.current(); } catch { return; }
    setInlineEdit(null);
    setSelection(null); setHoverId(null); setInstruction(''); setFilesOpen(false); setOverview(false); setLocalId(id);
    if (follow) await mutate({ action: 'navigate', fileId: id });
  }
  async function runAgent() {
    if (!aiAvailable || !aiModel || !file || !target || !instruction.trim() || busy || draft || pending) return;
    let latest = file;
    try { if (inlineEdit && inlineFlush.current) latest = await inlineFlush.current(); } catch { return; }
    const currentNode = resolveNode(target, viewFile?.source || file.source, latest.source, latest.filename, inlineEdit?.node.id === target.id);
    if (!currentNode) return;
    const chosen = { node: currentNode, file: structuredClone(latest) };
    setInlineEdit(null);
    setSelection(chosen); setBusy(true); setError('');
    const initial: LiveDraft = { fileId: chosen.file.id, nodeId: chosen.node.id, version: chosen.file.version, actor: identity.name, text: '', phase: 'reading' };
    setLocalDraft(initial);
    const abort = new AbortController(); agentRequest.current = abort;
    try {
      const response = await backend.agent({ fileId: chosen.file.id, version: chosen.file.version, nodeId: chosen.node.id, instruction: instruction.trim(), actor: identity.name, model: aiModel }, abort.signal);
      if (!response.ok) throw new Error((await response.json()).error);
      if (!response.body) throw new Error('Verbindung zum Agenten unterbrochen.');
      const reader = response.body.getReader(), decoder = new TextDecoder();
      // The completion event includes the workspace, which is larger than provider chunks.
      const events = new EventStreamDecoder(256000000);
      let output = '', complete = false;
      try { while (true) {
        const { value, done } = await reader.read();
        for (const frame of events.push(done ? decoder.decode() : decoder.decode(value, { stream: true }), done)) {
          const data = JSON.parse(frame.data);
          if (frame.event === 'delta') { output += data.text; setLocalDraft({ ...initial, text: previewAgentSource(output, isAdr ? 'markdown' : 'gherkin'), phase: 'writing' }); }
          if (frame.event === 'error') throw new Error(data.message);
          if (frame.event === 'complete') { complete = true; accept(data); setInstruction(''); setSelection(null); setNotice(backend.repository ? 'Im Entwurf gespeichert.' : 'Gespeichert.'); }
        }
        if (done) break;
      } } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      if (!complete) throw new Error('Verbindung unterbrochen. Bitte den gespeicherten Stand prüfen.');
    } catch (e) { setError((e as Error).message); void backend.load().then(accept).catch(() => {}); }
    finally { if (agentRequest.current === abort) agentRequest.current = null; setBusy(false); setLocalDraft(null); }
  }
  async function openSource(format: 'source' | 'json') {
    if (readOnly) return;
    if (!file || busy || pending) return;
    try {
      const latest = inlineEdit && inlineFlush.current ? await inlineFlush.current() : file;
      setInlineEdit(null); setSelection(null); setHoverId(null); setError('');
      setEditor({ file: structuredClone(latest), draft: format === 'json' ? JSON.stringify(latest.document, null, 2) : latest.source });
      setTools(format);
    } catch { /* The failed editor keeps its draft. */ }
  }

  async function importFile(event: React.ChangeEvent<HTMLInputElement>) {
    const imported = event.target.files?.[0]; event.target.value = '';
    if (!imported) return;
    try { if (inlineEdit && inlineFlush.current) await inlineFlush.current(); } catch { return; }
    setInlineEdit(null);
    const maxSize = /\.json$/i.test(imported.name) ? 2000000 : 200000;
    if (imported.size > maxSize) { setError(`Die Datei darf maximal ${maxSize / 1000} KB groß sein.`); return; }
    await mutate({ action: 'import', filename: imported.name, source: await imported.text() }, 'Dokument importiert.');
  }


  function renderNode(node: SpecNode) {
    const affected = !!draftNode && node.start >= draftNode.start && node.end <= draftNode.end;
    const waiting = affected && draft?.phase === 'reading';
    const bindings = {
      ref: (element: HTMLElement | null) => { if (element) elements.current.set(node.id, element); else elements.current.delete(node.id); },
      onPointerMove: (event: React.PointerEvent) => { event.stopPropagation(); if (!busy && !draft && !inlineEdit && !pending) setHoverId(node.id); },
      onClick: (event: React.MouseEvent<HTMLElement>) => {
        event.stopPropagation();
        const element = event.target as HTMLElement;
        if (element === event.currentTarget || element.classList.contains('zen-children')) clearFocus();
        else pin(node);
      },
      onDoubleClick: (event: React.MouseEvent<HTMLElement>) => {
        event.stopPropagation(); event.preventDefault();
        if (node.kind === 'adr-answer') { void startInline(node, 'answer'); return; }
        startInline(node, (event.target as HTMLElement).closest('button') && node.kind !== 'examples' ? 'name' : node.kind === 'adr-section' ? 'description' : 'source');
      },
      'data-spec-node': node.id,
    };
    const activeEdit = inlineEdit && editingNode?.id === node.id && inlineEdit.file.id === file?.id ? inlineEdit : null;
    const field = (mode: InlineMode) => activeEdit?.mode === mode ? <InlineEditor key={`${activeEdit.node.id}:${mode}:${activeEdit.cell?.row}:${activeEdit.cell?.column}`} edit={activeEdit} backend={backend} actor={identity.name} onSnapshot={accept} onInsertStep={(file, node) => changeNode('insert', node, file)} onInsertRow={(file, node, cell) => changeTableRow('insert', file, node, cell)} onFlushReady={flush => { inlineFlush.current = flush; }} onClose={() => { setInlineEdit(current => current === activeEdit ? null : current); }} onHistory={restore}/> : null;
    if (activeEdit?.mode === 'source') return <section key={node.id} {...bindings}>{field('source')}</section>;
    if (node.kind === 'adr') {
      const status = readAdrStatus(preview.source), intro = adrIntroduction(preview.source);
      return <section key={node.id} {...bindings} className="zen-section zen-feature zen-adr">
        <div className="zen-adr-meta" onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}><span>Architecture Decision Record</span><DropdownMenu><DropdownMenuTrigger render={<button className={`zen-adr-status status-${status}`} aria-label={`ADR-Status: ${adrStatuses[status]}`} disabled={readOnly || busy || pending || !!draft}/>}>{adrStatuses[status]}<ChevronDown size={12}/></DropdownMenuTrigger><DropdownMenuContent align="start">{(Object.keys(adrStatuses) as AdrStatus[]).map(value => <DropdownMenuItem key={value} disabled={value === status} onClick={() => void changeAdrStatus(value)}>{adrStatuses[value]}</DropdownMenuItem>)}</DropdownMenuContent></DropdownMenu></div>
        {activeEdit?.mode === 'name' ? field('name') : <button className="zen-feature-title" aria-label="Gesamte ADR auswählen" onFocus={() => setHoverId(node.id)}><h1><AnimatedWords text={node.name} waiting={waiting} animated={affected}/></h1></button>}
        {activeEdit?.mode === 'description' ? field('description') : intro && <p className="zen-description" onDoubleClick={event => { event.stopPropagation(); void startInline(node, 'description'); }}>{intro}</p>}
        <div className="zen-children">{node.children.map(renderNode)}</div>
      </section>;
    }
    if (node.kind === 'adr-question') {
      return <li key={node.id} {...bindings} className={`zen-question ${node.description ? 'is-answered' : ''}`}>
        <div className="zen-question-line"><span className="zen-question-marker" aria-label={node.description ? 'Beantwortet' : 'Offen'}>{node.description ? <Check size={13}/> : <span/>}</span>
          {activeEdit?.mode === 'question' ? field('question') : <button className="zen-question-text" onFocus={() => { if (!selection) setHoverId(node.id); }} aria-label={`Frage auswählen: ${node.name}`} onDoubleClick={event => { event.stopPropagation(); void startInline(node, 'question'); }}><AnimatedWords text={node.name} waiting={waiting} animated={affected}/></button>}
        </div>
        {activeEdit?.mode === 'answer' ? <section className="zen-question-answer"><span className="zen-answer-label">Antwort</span>{field('answer')}</section> : node.children.map(renderNode)}
      </li>;
    }
    if (node.kind === 'adr-answer') {
      return <section key={node.id} {...bindings} className="zen-question-answer" aria-label="Antwort">
        <span className="zen-answer-label">Antwort</span>
        {activeEdit?.mode === 'answer' ? field('answer') : <button className="zen-answer-text" aria-label="Antwort auswählen" onFocus={() => { if (!selection) setHoverId(node.id); }}><AnimatedWords text={node.description || 'Antwort ergänzen …'} waiting={waiting} animated={affected}/></button>}
      </section>;
    }
    if (node.kind === 'adr-section') {
      return <section key={node.id} {...bindings} className="zen-section zen-adr-section">
        {activeEdit?.mode === 'name' ? field('name') : <button className="zen-section-title" aria-label={`ADR-Abschnitt auswählen: ${node.name}`} onFocus={() => { if (!selection) setHoverId(node.id); }}><h2><AnimatedWords text={node.name} waiting={waiting} animated={affected}/></h2></button>}
        {activeEdit?.mode === 'description' ? field('description') : (node.description || !node.children.length) && <div className={`zen-adr-body ${!node.description ? 'is-empty' : ''}`} onDoubleClick={event => { event.stopPropagation(); void startInline(node, 'description'); }}>{node.description ? <AnimatedWords text={node.description} waiting={waiting} animated={affected}/> : readOnly ? 'Noch kein Inhalt.' : 'Doppelklick zum Schreiben …'}</div>}
        {node.children.some(child => child.kind === 'adr-question') && <ul className="zen-question-list" aria-label={node.name}>{node.children.filter(child => child.kind === 'adr-question').map(renderNode)}</ul>}{node.children.some(child => child.kind !== 'adr-question') && <div className="zen-children">{node.children.filter(child => child.kind !== 'adr-question').map(renderNode)}</div>}
      </section>;
    }
    if (node.kind === 'step') {
      const extra = file ? sourceOf(preview.source, node).split('\n').slice(1).join('\n') : '';
      return <div key={node.id} {...bindings} className="zen-step">{activeEdit?.mode === 'name' ? field('name') : <button className="zen-step-button" aria-label={`Schritt bearbeiten: ${node.name}`} onFocus={() => { if (!selection) setHoverId(node.id); }}><span className="zen-keyword">{node.keyword}</span><span className="zen-sentence"><AnimatedWords text={node.name} waiting={waiting} animated={affected}/></span></button>}{extra.trim() && <pre className="zen-attachment">{extra}</pre>}</div>;
    }
    if (node.kind === 'examples') {
      const rows = tableRows(preview.source, node);
      return <section key={node.id} {...bindings} className="zen-examples"><button className="zen-table-select" onClick={event => { event.stopPropagation(); void pin(node); }} onDoubleClick={event => event.stopPropagation()} aria-label="Ganze Tabelle auswählen" aria-pressed={selectedNode?.id === node.id}>{node.keyword}</button><div className="zen-table-scroll"><table aria-label="Beispieldaten" style={{ width: Math.max(300, (rows[0]?.cells.length || 2) * 160) }}><tbody>{rows.map((row, i) => <tr key={i} data-table-row={i} className={hoveredRow && hoveredRow.fileId === file?.id && hoveredRow.nodeId === node.id && hoveredRow.row === i && (!selectedNode || selectedNode.id === node.id) ? 'zen-row-hovered' : ''} onPointerMove={() => { if (file && !pending && !busy && !draft) setHoveredRow({ fileId: file.id, nodeId: node.id, row: i }); }} onPointerLeave={() => setHoveredRow(null)}>{row.cells.map((cell, j) => {
        const content = activeEdit?.mode === 'cell' && activeEdit.cell?.row === i && activeEdit.cell.column === j ? field('cell') : <button className="zen-cell" aria-label={`Zelle bearbeiten: Zeile ${i + 1}, Spalte ${j + 1}`} disabled={readOnly || busy || !!draft} onFocus={() => { void startInline(node, 'cell', { row: i, column: j }); }} onClick={event => { event.stopPropagation(); void startInline(node, 'cell', { row: i, column: j }); }} onDoubleClick={event => event.stopPropagation()}>{cell.value || <span className="zen-empty-cell">…</span>}</button>;
        return i === 0 ? <th key={j} scope="col">{content}</th> : <td key={j}>{content}</td>;
      })}</tr>)}</tbody></table></div><p className="zen-table-shortcuts"><kbd>Shift ↵</kbd> neue Zeile <span>·</span> <kbd>⌫</kbd> gehoverte Zeile löschen</p></section>;
    }
    return <section key={node.id} {...bindings} className={`zen-section zen-${node.kind}`}>
      {node.kind === 'feature' ? <><div className="zen-feature-tags">{node.tags.join('  ')}</div>{activeEdit?.mode === 'name' ? field('name') : <button className="zen-feature-title" aria-label="Gesamtes Feature bearbeiten" onFocus={() => setHoverId(node.id)}><h1><AnimatedWords text={node.name} waiting={waiting} animated={affected}/></h1></button>}{activeEdit?.mode === 'description' ? field('description') : node.description && <p className="zen-description" onDoubleClick={event => { event.stopPropagation(); void startInline(node, 'description'); }}><AnimatedWords text={node.description} waiting={waiting} animated={affected}/></p>}</> : <><div className="zen-section-kind">{node.keyword}{node.tags.length > 0 && <span>{node.tags.join(' ')}</span>}</div>{activeEdit?.mode === 'name' ? field('name') : <button className="zen-section-title" aria-label={`${labels[node.kind]} bearbeiten: ${node.name}`} onFocus={() => { if (!selection) setHoverId(node.id); }}><h2><AnimatedWords text={node.name} waiting={waiting} animated={affected}/></h2></button>}{activeEdit?.mode === 'description' ? field('description') : node.description && <p className="zen-section-description" onDoubleClick={event => { event.stopPropagation(); void startInline(node, 'description'); }}>{node.description}</p>}</>}
      <div className="zen-children">{node.children.map(renderNode)}</div>
    </section>;
  }

  return <div className="zen-studio" onClick={event => {
    if (!(event.target as HTMLElement).closest('button,a,input,textarea,[role="dialog"],[role="menu"],.zen-command')) clearFocus();
  }}>
    <header className="zen-header"><button className="zen-brand" aria-label="Zur Übersicht" disabled={busy || pending || !!draft} onClick={async () => { try { if (inlineEdit && inlineFlush.current) await inlineFlush.current(); setInlineEdit(null); setSelection(null); setHoverId(null); setHoveredRow(null); setOverview(true); } catch { /* Preserve unsaved drafts. */ } }}>hoospec<span>.</span></button><button className="zen-file-picker" onClick={() => setFilesOpen(true)} aria-label="Dokument auswählen"><span>{overview ? 'Übersicht' : file?.filename || 'Dokumente laden …'}</span><ChevronDown size={15}/></button><div className="zen-header-right">{backend.repository && workspace?.repository && <button className="zen-repository-state" onClick={() => void openRepositoryReview()} disabled={busy || pending || !!draft} title="Änderungen und gemeinsame Entwürfe"><span className={workspace.repository.changes.length ? 'zen-draft-dot' : ''}/><span>{workspace.repository.conflict ? 'Konflikt prüfen' : workspace.repository.submissionPending ? 'Einreichung fortsetzen' : workspace.repository.changes.length ? 'Änderungen' : workspace.repository.mergeRequest ? `Entwurf !${workspace.repository.mergeRequest.iid}` : 'Entwürfe'}</span></button>}{backend.readOnly && <span className="zen-readonly">Nur lesen</span>}<span className={`zen-live-dot ${connected ? 'connected' : ''}`} role="status" aria-label={connected ? backend.label : 'Verbindung unterbrochen. Wird erneut verbunden.'} title={connected ? backend.label : 'Verbindung unterbrochen. Wird erneut verbunden.'}/>{(workspace?.participants.length || 0) > 1 && <button className="zen-peers" onClick={() => setTools('profile')} aria-label="Teilnehmer"><Users size={16}/>{workspace?.participants.length}</button>}<DropdownMenu><DropdownMenuTrigger render={<Button variant="ghost" size="icon" aria-label="Studio-Menü"/>}><MoreHorizontal size={20}/></DropdownMenuTrigger><DropdownMenuContent align="end" className="zen-menu"><DropdownMenuItem disabled={overview || readOnly} onClick={() => void openSource('source')}><Code2/>{isAdr ? 'Markdown bearbeiten' : 'Gherkin bearbeiten'}</DropdownMenuItem><DropdownMenuItem disabled={overview || readOnly} onClick={() => void openSource('json')}><Code2/>JSON bearbeiten</DropdownMenuItem><DropdownMenuItem disabled={overview} onClick={() => setTools('history')}><History/>Verlauf</DropdownMenuItem><DropdownMenuItem onClick={() => void restore('undo')} disabled={overview || readOnly || pending || busy || !(workspace?.history?.[file?.id || ''] ? workspace.history[file?.id || ''].undo : changes.some(c => c.before && c.kind !== 'review'))}><Undo2/>Rückgängig</DropdownMenuItem><DropdownMenuItem onClick={() => void restore('redo')} disabled={overview || readOnly || pending || busy || !workspace?.history?.[file?.id || '']?.redo}><History/>Wiederherstellen</DropdownMenuItem><DropdownMenuSeparator/>{(['light', 'dark', 'system'] as const).map(mode => <DropdownMenuItem key={mode} onClick={() => setTheme(mode)}>{theme === mode ? <Check/> : <span className="zen-theme-placeholder"/>}{mode === 'light' ? 'Hell' : mode === 'dark' ? 'Dunkel' : 'System'}</DropdownMenuItem>)}<DropdownMenuSeparator/><DropdownMenuItem disabled={readOnly} onClick={() => upload.current?.click()}><Upload/>Dokument importieren</DropdownMenuItem><DropdownMenuItem disabled={readOnly} onClick={() => openNew('feature')}><FilePlus2/>Neue Spec</DropdownMenuItem><DropdownMenuItem disabled={readOnly} onClick={() => openNew('adr')}><FilePlus2/>Neue ADR</DropdownMenuItem><DropdownMenuItem disabled={overview || !file} onClick={() => file && backend.download(file, 'source')}><ArrowDownToLine/>Herunterladen</DropdownMenuItem><DropdownMenuItem disabled={overview || !file} onClick={() => file && backend.download(file, 'json')}><ArrowDownToLine/>JSON herunterladen</DropdownMenuItem><DropdownMenuSeparator/><DropdownMenuItem onClick={async () => { try { await navigator.clipboard.writeText(location.href); setNotice('Link kopiert.'); } catch { setError('Bitte die Browser-Adresse kopieren.'); } }}><Link2/>Link kopieren</DropdownMenuItem>{backend.collaboration && <DropdownMenuItem onClick={() => { setLocalId(file?.id || null); setFollow(value => !value); }}>{follow ? 'Zur eigenen Ansicht wechseln' : 'Gemeinsamer Ansicht folgen'}</DropdownMenuItem>}<DropdownMenuItem onClick={() => setTools('profile')}><Users/>Dein Name</DropdownMenuItem>{onRepository && <><DropdownMenuSeparator/><DropdownMenuItem onClick={async () => { try { if (inlineEdit && inlineFlush.current) await inlineFlush.current(); setInlineEdit(null); onRepository(); } catch { /* Keep failed drafts visible. */ } }}><Link2/>Repository-Verbindung</DropdownMenuItem></>}</DropdownMenuContent></DropdownMenu></div></header>
    <input ref={upload} type="file" accept=".feature,.md,.markdown,.json" className="hidden" onChange={importFile}/>
    <main ref={scroll} className="zen-canvas" onPointerLeave={() => { setHoverId(null); setHoveredRow(null); }}>{overview && workspace ? <DocumentOverview files={workspace.files} disabled={busy || pending} readOnly={readOnly} onOpen={id => void navigate(id)} onCreate={kind => void openNew(kind)}/> : preview.tree && file ? <article key={file.id} className="zen-document">{renderNode(preview.tree)}</article> : <div className="zen-loading" role="status">{workspace && !workspace.files.length ? <><span>Noch keine Specs oder ADRs.</span><button onClick={() => void openNew('feature')}>Neue Spec</button><button onClick={() => void openNew('adr')}>Neue ADR</button></> : error ? <><span>{error}</span><button onClick={() => location.reload()}>Erneut verbinden</button></> : <><Loader2 size={24} className="animate-spin"/>{connected ? 'Dokumente werden geladen …' : 'Verbindung wird hergestellt …'}</>}</div>}<div className="zen-bottom-space"/></main>
    {!overview && box && !tools && !filesOpen && !pending && <div className={`zen-outline ${draft ? 'zen-working' : ''} ${selection ? 'zen-pinned' : ''}`} style={box}><span className="zen-outline-label">{draft ? <><Sparkles size={11}/> {draft.phase === 'validating' ? 'Prüfen …' : 'Wird geändert …'}</> : target ? labels[target.kind] : ''}</span></div>}

    {aiAvailable && !overview && (target || draft) && !tools && !filesOpen && <div className={`zen-command ${busy || draft ? 'is-working' : ''}`}><form onSubmit={event => { event.preventDefault(); runAgent(); }}><Input ref={command} aria-label="Was soll sich ändern?" placeholder={readOnly ? 'Du hast auf diesem Branch nur Leserechte.' : 'Was soll sich ändern?'} value={instruction} maxLength={4000} disabled={readOnly || busy || (!!draft && !localDraft)} onFocus={() => { if (!interaction.current.selection && scopedTarget && viewFile) setSelection({ node: scopedTarget, file: structuredClone(viewFile) }); }} onChange={event => setInstruction(event.target.value)} className="zen-command-input"/>{scopedTarget && <button type="button" className="zen-command-clear" aria-label="Auswahl aufheben" disabled={readOnly || busy || !!draft} onClick={clearFocus}><X size={14}/></button>}<Button type="submit" size="icon" aria-label="Änderung umsetzen" disabled={readOnly || pending || busy || !!draft || !instruction.trim()} className="zen-send">{busy || draft ? <Loader2 size={17} className="animate-spin"/> : <ArrowUp size={18}/>}</Button></form>{aiModels.length > 0 && <div className="zen-command-model"><select aria-label="AI-Modell" value={aiModel} disabled={busy || !!draft || pending} onChange={event => setSelectedModel(event.target.value)}>{aiModels.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select><ChevronDown size={12} aria-hidden="true"/></div>}{error && <p className="zen-command-error" role="alert">{error}</p>}</div>}
    {aiAvailable && !overview && !target && !draft && !tools && !filesOpen && <p className="zen-quiet-hint">Zeige auf eine Stelle. <kbd>/</kbd> Sag, was sich ändern soll.</p>}
    {notice && <div className="zen-toast" role="status"><Check size={14}/>{notice}</div>}
    {error && !!file && (!aiAvailable || !target || !!inlineEdit) && !tools && <div className="zen-error-toast" role="alert">{error}<button aria-label="Meldung schließen" onClick={() => setError('')}><X size={14}/></button></div>}

    {backend.repository && workspace?.repository && <RepositoryReviewDialog open={repositoryOpen} onOpenChange={setRepositoryOpen} backend={backend} state={workspace.repository} accept={accept}/>}
    <Dialog open={filesOpen} onOpenChange={setFilesOpen}><DialogContent className="zen-files-dialog sm:max-w-lg"><DialogHeader><DialogTitle>Deine Dokumente</DialogTitle><DialogDescription>Specs und Entscheidungen. Gemeinsam.</DialogDescription></DialogHeader>
      <div className="zen-document-filters" aria-label="Dokumentfilter">{(['all', 'feature', 'adr', 'open'] as const).map(filter => <button key={filter} aria-pressed={fileFilter === filter} onClick={() => setFileFilter(filter)}>{filter === 'all' ? 'Alle' : filter === 'feature' ? 'Specs' : filter === 'adr' ? 'ADRs' : 'Offene ADRs'}</button>)}</div>
      <Input aria-label="Dokumente durchsuchen" placeholder="Dokument finden …" value={query} onChange={event => setQuery(event.target.value)}/>
      <div className="zen-files-list">{workspace?.files.filter(f => (fileFilter === 'all' || (fileFilter === 'open' ? documentKind(f.filename) === 'adr' && readAdrStatus(f.source) === 'open' : documentKind(f.filename) === fileFilter)) && (f.filename + ' ' + parseDocument(f.source, f.filename).name).toLowerCase().includes(query.toLowerCase())).map(f => <button key={f.id} onClick={() => navigate(f.id)} disabled={busy}><FileText size={17}/><span className="zen-file-details"><strong>{documentKind(f.filename) === 'adr' ? parseDocument(f.source, f.filename).name : f.filename}</strong>{documentKind(f.filename) === 'adr' && <small>{f.filename} · {adrStatuses[readAdrStatus(f.source)]}</small>}</span>{f.id === file?.id ? <span className="zen-file-current"/> : null}</button>)}{workspace && !workspace.files.some(f => (fileFilter === 'all' || (fileFilter === 'open' ? documentKind(f.filename) === 'adr' && readAdrStatus(f.source) === 'open' : documentKind(f.filename) === fileFilter)) && (f.filename + ' ' + parseDocument(f.source, f.filename).name).toLowerCase().includes(query.toLowerCase())) && <p className="zen-files-empty">{fileFilter === 'open' ? 'Keine offenen Entscheidungen.' : 'Keine passenden Dokumente.'}</p>}</div>
      <div className="zen-document-create"><button onClick={() => openNew('feature')}><FilePlus2 size={15}/>Neue Spec</button><button onClick={() => openNew('adr')}><FilePlus2 size={15}/>Neue ADR</button></div>
    </DialogContent></Dialog>
    <Dialog open={!!tools} onOpenChange={open => { if (!open) setTools(null); }}><DialogContent className={tools === 'source' || tools === 'json' || tools === 'new' || tools === 'history' ? 'zen-tools-dialog sm:max-w-3xl' : 'sm:max-w-md'}><DialogHeader><DialogTitle>{tools === 'json' ? 'JSON bearbeiten' : tools === 'source' ? (isAdr ? 'Markdown bearbeiten' : 'Gherkin bearbeiten') : tools === 'new' ? (newKind === 'adr' ? 'Neue ADR' : 'Neue Spec') : tools === 'history' ? 'Änderungsverlauf' : 'Dein Name'}</DialogTitle><DialogDescription>{tools === 'history' ? 'Jede Änderung bleibt nachvollziehbar.' : tools === 'profile' ? 'So sieht dein Team, wer etwas geändert hat.' : 'Änderungen werden vor dem Speichern geprüft.'}</DialogDescription></DialogHeader>
      {(tools === 'source' || tools === 'json') && editor && <><Textarea aria-label={tools === 'json' ? 'JSON-Dokument' : isAdr ? 'Markdown-Quelltext' : 'Gherkin-Quelltext'} className="zen-source-input" value={editor.draft} onChange={event => setEditor({ ...editor, draft: event.target.value })} spellCheck={false}/>{error && <p role="alert" className="zen-dialog-error">{error}</p>}<DialogFooter><Button onClick={async () => {
        try {
          const document = tools === 'json' ? JSON.parse(editor.draft) : documentFromSource(editor.draft, editor.file.filename);
          if (await mutate({ action: 'save-document', fileId: editor.file.id, version: editor.file.version, document }, backend.repository ? 'Im Entwurf gespeichert.' : 'Gespeichert.')) { setTools(null); setEditor(null); }
        } catch (cause) { setError(cause instanceof SyntaxError ? 'Ungültiges JSON. Bitte die Syntax prüfen.' : (cause as Error).message); }
      }} disabled={pending || editor.draft === (tools === 'json' ? JSON.stringify(editor.file.document, null, 2) : editor.file.source)}>Speichern</Button></DialogFooter></>}

      {tools === 'new' && <><Input aria-label="Dateiname" value={newName} onChange={event => setNewName(event.target.value)}/>{newKind === 'adr' ? <><Input aria-label="ADR-Titel" placeholder="Welche Entscheidung steht an?" value={newTitle} onChange={event => setNewTitle(event.target.value)}/><Textarea aria-label="ADR-Kontext" placeholder="Was ist das Problem oder die offene Frage?" value={newContext} onChange={event => setNewContext(event.target.value)}/><p className="zen-new-adr-hint">Beginnt offen. Kontext, Fragen, Optionen und Entscheidung könnt ihr gemeinsam ausarbeiten.</p></> : <Textarea aria-label="Neue Gherkin-Spec" className="zen-source-input" value={newSource} onChange={event => setNewSource(event.target.value)}/>} {error && <p role="alert" className="zen-dialog-error">{error}</p>}<DialogFooter><Button disabled={pending || (newKind === 'adr' && !newTitle.trim())} onClick={async () => {
        if (newKind === 'adr' && documentKind(newName) !== 'adr') { setError('ADRs werden als .md-Dateien gespeichert.'); return; }
        if (newKind === 'feature' && !newName.toLowerCase().endsWith('.feature')) { setError('Specs werden als .feature-Dateien gespeichert.'); return; }
        if (await mutate({ action: 'import', filename: newName, source: newKind === 'adr' ? createAdr(newTitle, newContext) : newSource }, newKind === 'adr' ? 'Offene ADR erstellt.' : 'Spec erstellt.')) {
          setTools(null); setSelection(null); setHoverId(null); setInlineEdit(null); setOverview(false); setFollow(backend.collaboration);
        }
      }}>{newKind === 'adr' ? 'ADR erstellen' : 'Spec erstellen'}</Button></DialogFooter></>}
      {tools === 'profile' && <><Input aria-label="Dein Name" value={profileName} maxLength={40} onChange={event => setProfileName(event.target.value)}/><DialogFooter><Button onClick={() => { const person = { ...identity, name: profileName.trim() || 'Gast' }; setIdentity(person); try { sessionStorage.setItem('hoospec-person', JSON.stringify(person)); } catch { /* Session only. */ } setTools(null); }}>Speichern</Button></DialogFooter></>}
      {tools === 'history' && <div className="zen-history">{changes.length ? changes.map(change => <button key={change.id} onClick={() => { setChangeView(change); setTools(null); }}><span>{change.kind === 'ai' ? <Sparkles size={17}/> : <History size={17}/>}</span><div><strong>{change.instruction}</strong><small>{change.actor} · v{change.version} · {new Date(change.time).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}</small></div><ChevronRight size={15}/></button>) : <p>Hier erscheinen eure Änderungen.</p>}</div>}
      {error && tools !== 'source' && tools !== 'json' && tools !== 'new' && <p role="alert" className="zen-dialog-error">{error}</p>}
    </DialogContent></Dialog>
    <Dialog open={!!changeView} onOpenChange={open => !open && setChangeView(null)}><DialogContent className="sm:max-w-3xl"><DialogHeader><DialogTitle>{changeView?.instruction}</DialogTitle><DialogDescription>{changeView?.actor} · {changeView?.filename} · v{changeView?.version}</DialogDescription></DialogHeader><div className="zen-diff">{changeView && (changeView.before === changeView.after ? <p>Review-Status aktualisiert.</p> : diffLines(changeView.before, changeView.after).map((part, i) => <pre key={i} className={part.added ? 'added' : part.removed ? 'removed' : ''}>{part.value}</pre>))}</div></DialogContent></Dialog>
  </div>;
}

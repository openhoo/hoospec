'use client';

import { useEffect, useState } from 'react';
import { diffLines } from 'diff';
import { ArrowUpRight, Loader2 } from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';
import type { StudioBackend, ReviewSession } from '@/lib/studio-backend';
import type { RepositoryReview, Snapshot } from '@/lib/types';

export function RepositoryReviewDialog({ open, onOpenChange, backend, state, accept }: {
  open: boolean; onOpenChange: (open: boolean) => void; backend: StudioBackend; state: RepositoryReview; accept: (snapshot: Snapshot) => void;
}) {
  const [title, setTitle] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [sessions, setSessions] = useState<ReviewSession[] | null>(null);
  const [discarding, setDiscarding] = useState(false);
  const repository = backend.repository!;
  const dirty = state.changes.length > 0;
  useEffect(() => {
    if (!open) return;
    let disposed = false;
    const refresh = () => repository.sessions().then(value => { if (!disposed) setSessions(value); }).catch(cause => { if (!disposed) setError((cause as Error).message); });
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 10000);
    return () => { disposed = true; clearInterval(timer); };
  }, [open, repository, state.mergeRequest?.iid, dirty]);
  async function run(action: () => Promise<Snapshot>) {
    setBusy(true); setError('');
    try { accept(await action()); setDiscarding(false); }
    catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }
  const others = sessions?.filter(item => item.iid !== state.mergeRequest?.iid);
  return <Dialog open={open} onOpenChange={value => { if (!busy) { setError(''); setDiscarding(false); onOpenChange(value); } }}><DialogContent className="zen-repository-review sm:max-w-3xl"><DialogHeader>
    <DialogTitle>{state.mergeRequest ? `Entwurf !${state.mergeRequest.iid}` : dirty ? 'Änderungen teilen' : 'Gemeinsame Entwürfe'}</DialogTitle>
    <DialogDescription>{state.project} · {state.targetBranch}</DialogDescription>
  </DialogHeader>
    {state.mergeRequest && <a className="zen-review-link" href={state.mergeRequest.url} target="_blank" rel="noopener noreferrer">{state.mergeRequest.title.replace(/^Draft:\s*/i, '')} <ArrowUpRight size={14}/></a>}
    {state.conflict && <p role="alert" className="zen-review-conflict">Im Team gibt es einen neueren Stand. Welchen möchtest du weiterbearbeiten?</p>}
    {state.submissionPending && <p role="status" className="zen-repository-explanation">Die Einreichung ist noch nicht bestätigt. Du kannst sie sicher erneut versuchen.</p>}
    {dirty && <div className="zen-review-changes">{state.changes.map(change => <details key={change.path}><summary>{change.filename}</summary><div className="zen-diff">{change.before === change.after ? <p>Dokument-Metadaten geändert.</p> : diffLines(change.before, change.after).map((part, index) => <pre key={index} className={part.added ? 'added' : part.removed ? 'removed' : ''}>{part.value}</pre>)}</div></details>)}</div>}
    {(dirty || state.submissionPending) && !state.conflict && <Input aria-label={state.mergeRequest ? 'Commit-Nachricht' : 'Titel des Merge Requests'} placeholder={state.mergeRequest ? 'Was habt ihr geändert?' : 'Titel des Merge Requests'} maxLength={200} value={title} disabled={busy || state.submissionPending} onChange={event => setTitle(event.target.value)}/>}
    {!dirty && !state.submissionPending && <section className="zen-review-sessions">{state.mergeRequest && <p className="zen-repository-explanation">Alle Änderungen sind im gemeinsamen Entwurf.</p>}{others?.length ? <>{state.mergeRequest && <h3>Weitere Entwürfe</h3>}{others.map(item => <button key={item.iid} disabled={busy} onClick={() => void run(() => repository.join(item.iid))}><span>{item.title.replace(/^Draft:\s*/i, '')}</span><span>!{item.iid} ↗</span></button>)}</> : !state.mergeRequest && <p>{sessions === null ? 'Entwürfe laden …' : 'Noch keine gemeinsamen Entwürfe.'}</p>}</section>}
    {error && <p role="alert" className="zen-dialog-error">{error}</p>}
    {discarding && <div className="zen-review-discard"><p>Deine lokalen Änderungen verwerfen?</p><Button variant="ghost" disabled={busy} onClick={() => setDiscarding(false)}>Behalten</Button><Button variant="outline" disabled={busy} onClick={() => void run(repository.discard)}>Verwerfen</Button></div>}
    <DialogFooter className="zen-review-footer"><div>{dirty && !state.conflict && <span className="zen-review-saved" role="status">Lokal gesichert</span>}{dirty && !state.submissionPending && !state.conflict && <Button variant="ghost" disabled={busy} onClick={() => setDiscarding(true)}>Verwerfen</Button>}{!dirty && state.mergeRequest && <Button variant="ghost" disabled={busy} onClick={() => void run(repository.leave)}>Zurück zu {state.targetBranch}</Button>}</div>
      {state.conflict ? <div><Button variant="ghost" disabled={busy || backend.readOnly} onClick={() => void run(repository.discard)}>Gemeinsamen Stand verwenden</Button><Button disabled={busy || backend.readOnly} onClick={() => void run(repository.resolveConflict)}>Meinen Entwurf behalten</Button></div> : (dirty || state.submissionPending) && <Button disabled={busy || backend.readOnly || (!title.trim() && !state.submissionPending)} onClick={() => void run(() => repository.submit(title.trim() || 'Hoospec Änderungen'))}>{busy && <Loader2 size={15} className="animate-spin"/>}{state.submissionPending ? 'Erneut versuchen' : state.mergeRequest ? 'Änderungen synchronisieren' : 'Entwurfs-MR erstellen'}</Button>}
    </DialogFooter>
  </DialogContent></Dialog>;
}

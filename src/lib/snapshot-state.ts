import type { Snapshot } from './types';

/** Presence and draft updates should not recreate unchanged documents or their ASTs. */
export function mergeSnapshot(current: Snapshot | null, next: Snapshot): Snapshot {
  if (!current) return next;
  if (next.revision < current.revision) return current;
  const previous = new Map(current.files.map(file => [file.id, file]));
  const files = next.files.map(file => {
    const old = previous.get(file.id);
    return old && old.version === file.version && old.source === file.source && old.reviewed === file.reviewed ? old : file;
  });
  return { ...next, files, changes: next.revision === current.revision ? current.changes : next.changes };
}

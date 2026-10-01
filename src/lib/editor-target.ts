import type { SpecNode } from './gherkin';

export type HoveredRow = { fileId: string; nodeId: string; row: number };
export type StructuralTarget = { kind: 'node'; node: SpecNode } | { kind: 'row'; node: SpecNode; row: number };

/** Structural shortcuts always act on the same scope as the visible selection. */
export function structuralTarget({ selected, hovered, hoveredRow, fileId, input, commandText, editing }: {
  selected?: SpecNode; hovered?: SpecNode; hoveredRow: HoveredRow | null; fileId?: string;
  input: 'none' | 'command' | 'editor'; commandText: string; editing: boolean;
}): StructuralTarget | null {
  if (editing || input === 'editor' || (input === 'command' && (commandText.length > 0 || !selected))) return null;
  const node = selected || hovered;
  if (!node) return null;
  if (hoveredRow && hoveredRow.fileId === fileId && hoveredRow.nodeId === node.id) {
    // Hovering the header must never fall through to deleting the whole table.
    return hoveredRow.row > 0 ? { kind: 'row', node, row: hoveredRow.row } : null;
  }
  return (node.kind === 'feature' || node.kind === 'adr') ? null : { kind: 'node', node };
}

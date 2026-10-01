import { flattenNodes, type SpecNode } from './gherkin';
import { parseDocument } from './document';

/** Rebase a clicked node after an inline save adds/removes lines above it. */
export function resolveNode(node: SpecNode, previousSource: string, source: string, filename: string, allowChanged = false): SpecNode | undefined {
  const nodes = flattenNodes(parseDocument(source, filename));
  if (previousSource === source) return nodes.find(item => item.id === node.id && item.kind === node.kind);
  const before = previousSource.split('\n'), after = source.split('\n');
  let prefix = 0, suffix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
  while (suffix < before.length - prefix && suffix < after.length - prefix && before[before.length - suffix - 1] === after[after.length - suffix - 1]) suffix++;
  const changedEnd = before.length - suffix;
  if (node.start > prefix && node.end <= changedEnd) {
    // A replaced/deleted node must never silently become a different sibling.
    return nodes.find(item => item.kind === node.kind && item.start === node.start && (allowChanged || item.name === node.name));
  }
  const start = node.start > changedEnd ? node.start + after.length - before.length : node.start;
  return nodes.find(item => item.kind === node.kind && item.start === start);
}

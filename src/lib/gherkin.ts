import { parseAdr } from './adr';
import { AstBuilder, GherkinClassicTokenMatcher, Parser } from '@cucumber/gherkin';
import type { Feature, Rule, Scenario, Background, Step, Examples } from '@cucumber/messages';

export type SpecNode = {
  id: string; kind: 'feature' | 'rule' | 'scenario' | 'background' | 'step' | 'examples' | 'adr' | 'adr-section' | 'adr-question' | 'adr-answer';
  keyword: string; name: string; description: string; start: number; end: number;
  tags: string[]; children: SpecNode[];
};

export function parseSpec(source: string): SpecNode {
  let id = 0;
  const parser = new Parser(new AstBuilder(() => String(++id)), new GherkinClassicTokenMatcher());
  const document = parser.parse(source);
  if (!document.feature) throw new Error('Die Datei muss ein Feature enthalten.');
  const lines = source.split('\n');
  type Ast = Feature | Rule | Scenario | Background | Step | Examples;
  function build(ast: Ast, kind: SpecNode['kind'], boundary: number): SpecNode {
    const tags = 'tags' in ast ? ast.tags : [];
    const start = Math.min(ast.location.line, ...tags.map(t => t.location.line));
    let end = boundary;
    while (end > start && !lines[end - 1]?.trim()) end--;
    const node: SpecNode = {
      id: `${kind}:${start}`, kind, keyword: ast.keyword.trim(),
      name: 'name' in ast ? ast.name : ast.text,
      description: 'description' in ast ? ast.description : '',
      start, end, tags: tags.map(t => t.name), children: [],
    };
    const children: { ast: Ast; kind: SpecNode['kind'] }[] = [];
    if ('children' in ast) {
      for (const child of ast.children) {
        if ('rule' in child && child.rule) children.push({ ast: child.rule, kind: 'rule' });
        else if (child.scenario) children.push({ ast: child.scenario, kind: 'scenario' });
        else if (child.background) children.push({ ast: child.background, kind: 'background' });
      }
    }
    if ('steps' in ast) children.push(...ast.steps.map(step => ({ ast: step, kind: 'step' as const })));
    if ('examples' in ast) children.push(...ast.examples.map(example => ({ ast: example, kind: 'examples' as const })));
    const firstLine = (item: Ast) => Math.min(item.location.line, ...('tags' in item ? item.tags.map(t => t.location.line) : []));
    node.children = children.map((child, i) => build(child.ast, child.kind, i + 1 < children.length ? firstLine(children[i + 1].ast) - 1 : end));
    return node;
  }
  return build(document.feature, 'feature', lines.length);
}

export function flattenNodes(root: SpecNode): SpecNode[] {
  return [root, ...root.children.flatMap(flattenNodes)];
}

export function sourceOf(source: string, node: SpecNode) {
  return source.split('\n').slice(node.start - 1, node.end).join('\n');
}

export function replaceNode(source: string, node: SpecNode, replacement: string) {
  const lines = source.split('\n');
  lines.splice(node.start - 1, node.end - node.start + 1, ...replacement.replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n'));
  const result = lines.join('\n');
  if (node.kind === 'adr' || node.kind === 'adr-section' || node.kind === 'adr-question' || node.kind === 'adr-answer') parseAdr(result);
  else parseSpec(result);
  return result;
}

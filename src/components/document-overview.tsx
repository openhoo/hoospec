import { useMemo, useState } from 'react';
import { ArrowUpRight, Plus, Search } from 'lucide-react';
import { adrStatuses, readAdrStatus } from '@/lib/adr';
import { documentKind, parseDocument } from '@/lib/document';
import { flattenNodes } from '@/lib/gherkin';
import type { SpecFile } from '@/lib/types';

export function DocumentOverview({ files, disabled, readOnly, onOpen, onCreate }: {
  files: SpecFile[]; disabled: boolean; readOnly: boolean;
  onOpen: (id: string) => void; onCreate: (kind: 'feature' | 'adr') => void;
}) {
  const [query, setQuery] = useState('');
  const documents = useMemo(() => files.map(file => {
    const tree = parseDocument(file.source, file.filename);
    const nodes = flattenNodes(tree);
    return { file, tree, kind: documentKind(file.filename),
      questions: nodes.filter(node => node.kind === 'adr-question' && !node.description.trim()).length };
  }), [files]);
  const matching = documents.filter(({ file, tree }) => `${file.filename} ${tree.name}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  return <article className="zen-overview">
    <div className="zen-overview-intro"><h1>Übersicht</h1></div>
    <label className="zen-overview-search"><Search size={17} aria-hidden="true"/><input type="search" aria-label="Übersicht durchsuchen" placeholder="Dokument finden …" value={query} onChange={event => setQuery(event.target.value)}/></label>
    {(['feature', 'adr'] as const).map(kind => {
      const rows = matching.filter(document => document.kind === kind);
      return <section key={kind} className="zen-overview-section" aria-labelledby={`overview-${kind}`}>
        <div className="zen-overview-section-heading"><h2 id={`overview-${kind}`}>{kind === 'feature' ? 'Feature Specs' : 'Entscheidungen'}</h2>{!readOnly && <button disabled={disabled} onClick={() => onCreate(kind)}><Plus size={15}/>{kind === 'feature' ? 'Neue Spec' : 'Neue ADR'}</button>}</div>
        {rows.length ? <table className={`zen-overview-table ${kind === 'feature' ? 'is-feature' : ''}`} aria-label={kind === 'feature' ? 'Feature Specs' : 'ADRs'}><thead><tr><th scope="col">{kind === 'feature' ? 'Feature' : 'Entscheidung'}</th>{kind === 'adr' && <th scope="col">Status</th>}{kind === 'adr' && <th scope="col" className="zen-overview-questions">Offene Fragen</th>}<th scope="col"><span className="sr-only">Öffnen</span></th></tr></thead><tbody>{rows.map(({ file, tree, questions }) => <tr key={file.id} onClick={() => { if (!disabled) onOpen(file.id); }}>
          <td><button disabled={disabled} className="zen-overview-title" onClick={event => { event.stopPropagation(); onOpen(file.id); }}><strong>{tree.name}</strong></button></td>
          {kind === 'adr' && <td><span className={`zen-overview-status status-${readAdrStatus(file.source)}`}>{adrStatuses[readAdrStatus(file.source)]}</span></td>}
          {kind === 'adr' && <td className="zen-overview-questions">{questions || '—'}</td>}<td className="zen-overview-open"><ArrowUpRight size={17} aria-hidden="true"/></td>
        </tr>)}</tbody></table> : <p className="zen-overview-empty">{query.trim() ? 'Keine passenden Dokumente.' : kind === 'feature' ? 'Hier beginnen eure nächsten Ideen.' : 'Hier finden eure Entscheidungen ihren Platz.'}</p>}
      </section>;
    })}
  </article>;
}

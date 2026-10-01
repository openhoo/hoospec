import { ApiError, snapshot } from '@/lib/store';
import { renderDocument } from '@/lib/json-document';
import { errorResponse } from '@/lib/http';

export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const id = params.get('id');
    const format = params.get('format') || 'source';
    if (!['source', 'json'].includes(format)) throw new ApiError('Ungültiges Exportformat.');
    const file = (await snapshot()).files.find(f => f.id === id);
    if (!file) throw new ApiError('Dokument nicht gefunden.', 404);
    const filename = format === 'json' ? file.filename + '.json' : file.filename;
    const content = format === 'json' ? JSON.stringify({ schemaVersion: 1, filename: file.filename, document: file.document }, null, 2) + '\n' : renderDocument(file.document);
    return new Response(content, { headers: { 'Content-Type': format === 'json' ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8', 'Content-Disposition': `attachment; filename="document"; filename*=UTF-8''${encodeURIComponent(filename)}`, 'Cache-Control': 'no-store' } });
  } catch (error) { return errorResponse(error); }
}

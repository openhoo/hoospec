import { presence, snapshot, transact } from '@/lib/store';
import { bodyOf, errorResponse, textField } from '@/lib/http';
import { applyWorkspaceAction } from '@/lib/workspace-actions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() { return Response.json(await snapshot(), { headers: { 'Cache-Control': 'no-store' } }); }
export async function POST(request: Request) {
  try {
    const body = await bodyOf(request);
    if (body.action === 'presence') presence(textField(body, 'participantId', 80), textField(body, 'actor', 40));
    else await transact(workspace => applyWorkspaceAction(workspace, body));
    return Response.json(await snapshot());
  } catch (error) { return errorResponse(error); }
}

import { snapshot, subscribe } from '@/lib/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const encoder = new TextEncoder();
  let cleanup = () => {};
  const stream = new ReadableStream({
    start(controller) {
      let stopped = false;
      const send = async () => {
        try {
          const state = await snapshot();
          if (!stopped) controller.enqueue(encoder.encode(`data: ${JSON.stringify(state)}\n\n`));
        } catch { cleanup(); }
      };
      const unsubscribe = subscribe(send);
      const heartbeat = setInterval(send, 15000);
      cleanup = () => {
        if (stopped) return;
        stopped = true; unsubscribe(); clearInterval(heartbeat);
        request.signal.removeEventListener('abort', cleanup);
        try { controller.close(); } catch { /* The browser already closed its stream. */ }
      };
      request.signal.addEventListener('abort', cleanup, { once: true });
      void send();
    },
    cancel() { cleanup(); },
  });
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' } });
}

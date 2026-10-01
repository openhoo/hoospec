export type StreamEvent = { event: string; data: string };

/** Incremental SSE framing, including CRLF split across network chunks. */
export class EventStreamDecoder {
  private buffer = '';
  constructor(private readonly maxFrameLength = 250000) {}
  push(text: string, final = false): StreamEvent[] {
    this.buffer += text;
    const events: StreamEvent[] = [];
    let boundary: RegExpMatchArray | null;
    const read = (frame: string) => {
      if (frame.length > this.maxFrameLength) throw new Error('Ungültiger oder zu großer Ereignisblock.');
      let event = 'message'; const data: string[] = [];
      for (const line of frame.split(/\r?\n/)) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      if (data.length) events.push({ event, data: data.join('\n') });
    };
    while ((boundary = this.buffer.match(/\r?\n\r?\n/))) {
      read(this.buffer.slice(0, boundary.index));
      this.buffer = this.buffer.slice(boundary.index! + boundary[0].length);
    }
    if (this.buffer.length > this.maxFrameLength) throw new Error('Ungültiger oder zu großer Ereignisblock.');
    if (final && this.buffer.trim()) { read(this.buffer); this.buffer = ''; }
    return events;
  }
}

'use client';

import { useEffect, useRef, useState } from 'react';

/** The same in-place rewrite rhythm as livejev, without changing persisted text. */
export function AnimatedWords({ text, waiting = false, animated = false }: { text: string; waiting?: boolean; animated?: boolean }) {
  const [display, setDisplay] = useState(text);
  const shown = useRef(text);
  useEffect(() => {
    let frame = 0;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    let prefix = 0;
    while (prefix < text.length && prefix < shown.current.length && text[prefix] === shown.current[prefix]) prefix++;
    let position = prefix;
    const tick = () => {
      if (reduced || !animated) { shown.current = text; setDisplay(text); return; }
      if (waiting) {
        shown.current = text;
        setDisplay(text);
      } else {
        position = Math.min(text.length, position + Math.max(1, Math.ceil((text.length - position) / 9)));
        shown.current = text.slice(0, position);
        setDisplay(shown.current);
        if (position < text.length) frame = requestAnimationFrame(tick);
      }
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [text, waiting, animated]);
  return <><span aria-hidden="true" className={animated ? `zen-animated-text ${waiting ? 'is-waiting' : ''}` : undefined}>{animated ? <><span className="zen-text-measure">{text}</span><span className="zen-text-visible">{display}</span></> : text}</span><span className="sr-only">{text}</span></>;
}

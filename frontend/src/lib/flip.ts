import { useLayoutEffect, useRef, type RefObject } from 'react';

/**
 * Smooth list animation (FLIP): items marked with `data-flip="<key>"` slide from
 * their old position to the new one, new items fade and drop in, and an item that
 * moves between two lists of the same container flies across. Honours the system
 * "reduce motion" setting. Call it on every render of the container.
 */
export function useFlip(container: RefObject<HTMLElement | null>) {
  const previous = useRef<Map<string, DOMRect> | null>(null);
  useLayoutEffect(() => {
    const root = container.current;
    if (!root) return;
    const nodes = Array.from(root.querySelectorAll<HTMLElement>('[data-flip]'));
    const next = new Map<string, DOMRect>();
    for (const node of nodes)
      next.set(node.dataset.flip!, node.getBoundingClientRect());
    const before = previous.current;
    previous.current = next;
    // The first paint is not animated; neither is "reduce motion".
    if (
      !before ||
      typeof window.matchMedia !== 'function' ||
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    )
      return;
    for (const node of nodes) {
      if (typeof node.animate !== 'function') continue;
      const key = node.dataset.flip!;
      const from = before.get(key);
      const to = next.get(key)!;
      if (!from) {
        node.animate(
          [
            { opacity: 0, transform: 'translateY(-28px) scale(0.94)' },
            { opacity: 1, transform: 'none' },
          ],
          { duration: 450, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' },
        );
        continue;
      }
      const dx = from.left - to.left;
      const dy = from.top - to.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
      node.animate(
        [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }],
        { duration: 380, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' },
      );
    }
  });
}

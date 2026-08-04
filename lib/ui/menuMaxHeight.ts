import { useEffect, useState } from 'react'
import type { RefObject } from 'react'

/**
 * Max height (px) for an upward-opening menu (`bottom-full` / `bottom-*`) so it never
 * clips against the top of the app shell, whose `overflow: hidden` would otherwise cut
 * off — and make unreachable — the top of a long list on a small window.
 *
 * Pure so the arithmetic is unit-tested. No fixed floor that could EXCEED the available
 * space (the old `Math.max(140, …)` did, so a short window still clipped): a
 * cramped-but-scrollable menu beats a clipped one. Capped so a tall window doesn't get an
 * absurdly long menu.
 */
export function menuMaxHeightAbove(triggerTop: number, margin = 16, cap = 560): number {
  return Math.min(cap, Math.max(0, Math.floor(triggerTop - margin)))
}

/**
 * React hook: the live max-height for an upward menu, recomputed on open AND on resize
 * (the trigger's position — and therefore the space above it — moves when the window
 * changes size). `undefined` while closed.
 */
export function useMenuMaxHeight(
  open: boolean,
  triggerRef: RefObject<HTMLButtonElement | null>,
  margin = 16,
): number | undefined {
  const [maxH, setMaxH] = useState<number | undefined>(undefined)
  useEffect(() => {
    if (!open || !triggerRef.current) { setMaxH(undefined); return }
    const compute = () => {
      const el = triggerRef.current
      if (el) setMaxH(menuMaxHeightAbove(el.getBoundingClientRect().top, margin))
    }
    compute()
    window.addEventListener('resize', compute)
    return () => window.removeEventListener('resize', compute)
  }, [open, triggerRef, margin])
  return maxH
}

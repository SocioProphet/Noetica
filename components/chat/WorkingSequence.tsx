'use client'

import { useEffect, useRef } from 'react'

/**
 * WorkingSequence — the "model is working" indicator.
 *
 * A single point grows into a line, then a triangle, a square, a pentagon, and onward through each
 * N-gon while the model works: one new vertex per beat, always inscribed in the same circle so the
 * footprint never changes. It reads as a clock — more sides means more elapsed time — and in the
 * limit the polygon approaches a circle. Deliberately monochrome and minimal: just points and edges,
 * inheriting the surrounding text color via `currentColor`. Replaces the old Hopf-fibration loader.
 */
export function WorkingSequence({ size = 34 }: { size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    canvas.width = size * dpr
    canvas.height = size * dpr
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.lineJoin = 'round'
    ctx.lineCap = 'round'

    const color = getComputedStyle(canvas).color || '#888'
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false

    const cx = size / 2
    const cy = size / 2
    const R = size * 0.34               // one radius for every N-gon → constant footprint
    const dotR = Math.max(1, size * 0.05)
    const edgeW = Math.max(0.9, size * 0.032)

    const STEP = 1100                   // ms per new vertex — the beat of the clock
    const HOLD = 0.68                   // fraction of each step the N-gon holds before morphing
    const ROT = 0.00022                 // rad/ms — a slow drift so it breathes
    const MAX_N = 64                    // past here it's a circle; stop adding vertices
    const TAU = Math.PI * 2
    const smooth = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x))

    const start = performance.now()
    let raf = 0

    const at = (angle: number): [number, number] => [cx + R * Math.cos(angle), cy + R * Math.sin(angle)]

    const frame = (now: number) => {
      const t = now - start
      const stepF = t / STEP
      const n = Math.min(MAX_N, 1 + Math.floor(stepF))     // vertices, starting at 1 (a point)
      const frac = stepF - Math.floor(stepF)
      const morph = reduce || n >= MAX_N ? 0 : smooth((frac - HOLD) / (1 - HOLD))
      const base = -Math.PI / 2 + (reduce ? 0 : t * ROT)   // vertex 0 starts at the top

      ctx.clearRect(0, 0, size, size)

      // The first n vertices ease from the n-gon layout toward the (n+1)-gon layout; during the morph
      // an (n+1)-th vertex fades in — so the ring redistributes as it gains a side.
      const count = morph > 0 ? n + 1 : n
      const angles: number[] = []
      for (let i = 0; i < n; i++) {
        const from = (i * TAU) / n
        const to = (i * TAU) / (n + 1)
        angles.push(base + from + (to - from) * morph)
      }
      if (morph > 0) angles.push(base + (n * TAU) / (n + 1))

      // ── edges ──
      ctx.strokeStyle = color
      ctx.lineWidth = edgeW
      const edge = (i: number, j: number, alpha: number) => {
        if (alpha <= 0) return
        const a = at(angles[i]!)
        const b = at(angles[j]!)
        ctx.globalAlpha = alpha
        ctx.beginPath()
        ctx.moveTo(a[0], a[1])
        ctx.lineTo(b[0], b[1])
        ctx.stroke()
      }
      if (count >= 2) {
        const closes = count >= 3          // 2-gon is a single segment, no return edge
        for (let i = 0; i < count; i++) {
          if (!closes && i === count - 1) break
          const j = (i + 1) % count
          const touchesNew = morph > 0 && (i === n || j === n)
          edge(i, j, touchesNew ? morph : 1)
        }
        // the n-gon's closing edge (last → first) is replaced as the new vertex arrives — fade it out
        if (morph > 0 && n >= 3) edge(n - 1, 0, 1 - morph)
      }

      // ── vertices (points) ──
      ctx.fillStyle = color
      for (let i = 0; i < count; i++) {
        const isNew = morph > 0 && i === n
        const a = at(angles[i]!)
        ctx.globalAlpha = isNew ? morph : 1
        ctx.beginPath()
        ctx.arc(a[0], a[1], isNew ? dotR * morph : dotR, 0, TAU)
        ctx.fill()
      }

      ctx.globalAlpha = 1
      raf = requestAnimationFrame(frame)
    }

    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [size])

  return (
    <span className="inline-flex shrink-0" style={{ width: size, height: size }}>
      <canvas ref={ref} style={{ width: size, height: size, display: 'block' }} aria-hidden />
    </span>
  )
}

import { useRef } from 'react'
import type { CurvePoint } from '../lib/pictureControl'
import { buildCurveLut } from '../lib/pictureControl'

interface Props {
  points: CurvePoint[]
  onChange: (pts: CurvePoint[]) => void
}

const SIZE = 240
const PAD = 8

export default function CurveEditor({ points, onChange }: Props) {
  const svgRef = useRef<SVGSVGElement>(null)
  const dragIdx = useRef<number | null>(null)

  const toScreen = (p: CurvePoint) => ({
    cx: PAD + (p.x / 255) * (SIZE - 2 * PAD),
    cy: SIZE - PAD - (p.y / 255) * (SIZE - 2 * PAD)
  })

  const toData = (clientX: number, clientY: number): CurvePoint => {
    const rect = svgRef.current!.getBoundingClientRect()
    const sx = ((clientX - rect.left) / rect.width) * SIZE
    const sy = ((clientY - rect.top) / rect.height) * SIZE
    const x = ((sx - PAD) / (SIZE - 2 * PAD)) * 255
    const y = ((SIZE - PAD - sy) / (SIZE - 2 * PAD)) * 255
    return { x: clamp(x, 0, 255), y: clamp(y, 0, 255) }
  }

  const lut = buildCurveLut(points)
  const curvePath = Array.from({ length: 256 }, (_, i) => {
    const cx = PAD + (i / 255) * (SIZE - 2 * PAD)
    const cy = SIZE - PAD - (lut[i] / 255) * (SIZE - 2 * PAD)
    return `${i === 0 ? 'M' : 'L'}${cx.toFixed(1)},${cy.toFixed(1)}`
  }).join(' ')

  const onDown = (i: number) => (e: React.PointerEvent) => {
    e.stopPropagation()
    ;(e.target as Element).setPointerCapture(e.pointerId)
    dragIdx.current = i
  }

  const onMove = (e: React.PointerEvent) => {
    if (dragIdx.current === null) return
    const i = dragIdx.current
    const d = toData(e.clientX, e.clientY)
    const next = [...points]
    // endpoints keep their x; interior points clamp between neighbours
    if (i === 0) d.x = 0
    else if (i === points.length - 1) d.x = 255
    else d.x = clamp(d.x, points[i - 1].x + 1, points[i + 1].x - 1)
    next[i] = d
    onChange(next)
  }

  const onUp = () => {
    dragIdx.current = null
  }

  const addPoint = (e: React.PointerEvent) => {
    if (e.target !== e.currentTarget) return
    const d = toData(e.clientX, e.clientY)
    const next = [...points, d].sort((a, b) => a.x - b.x)
    onChange(next)
  }

  const removePoint = (i: number) => (e: React.MouseEvent) => {
    e.preventDefault()
    if (i === 0 || i === points.length - 1) return
    onChange(points.filter((_, j) => j !== i))
  }

  return (
    <div className="curve-editor">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        className="curve-svg"
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerDown={addPoint}
      >
        {[0.25, 0.5, 0.75].map((g) => (
          <g key={g}>
            <line
              x1={PAD + g * (SIZE - 2 * PAD)}
              y1={PAD}
              x2={PAD + g * (SIZE - 2 * PAD)}
              y2={SIZE - PAD}
              className="grid"
            />
            <line
              x1={PAD}
              y1={PAD + g * (SIZE - 2 * PAD)}
              x2={SIZE - PAD}
              y2={PAD + g * (SIZE - 2 * PAD)}
              className="grid"
            />
          </g>
        ))}
        <line x1={PAD} y1={SIZE - PAD} x2={SIZE - PAD} y2={PAD} className="grid diag" />
        <path d={curvePath} className="curve-line" />
        {points.map((p, i) => {
          const { cx, cy } = toScreen(p)
          return (
            <circle
              key={i}
              cx={cx}
              cy={cy}
              r={6}
              className="curve-pt"
              onPointerDown={onDown(i)}
              onContextMenu={removePoint(i)}
            />
          )
        })}
      </svg>
      <p className="hint">클릭=포인트 추가 · 드래그=이동 · 우클릭=삭제</p>
    </div>
  )
}

function clamp(v: number, lo: number, hi: number) {
  return v < lo ? lo : v > hi ? hi : v
}

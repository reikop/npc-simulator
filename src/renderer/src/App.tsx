import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Slider from './components/Slider'
import CurveEditor from './components/CurveEditor'
import {
  applyPictureControl,
  defaultControl,
  identityCurve,
  TONING_TYPES,
  type PictureControl
} from './lib/pictureControl'
import { loadImageBitmap, isRawName } from './lib/nef'
import { nefToPictureControl } from './lib/nefPictureControl'
import { ALL_PRESETS, clonePreset, type LibraryPreset } from './lib/presets'
import { fromRecipeJson, readNpcName, type NpcFileInfo } from './lib/npc'
import { pickImageFile, pickNpcFolder, pickXmpFile, downloadBlob } from './lib/fileio'
import { buildNp3 } from './lib/np3'
import { xmpToPictureControl } from './lib/xmp'

const IMPORTED_KEY = 'npc-sim-imported-v1'

function loadImported(): PictureControl[] {
  try {
    const raw = localStorage.getItem(IMPORTED_KEY)
    const arr = raw ? (JSON.parse(raw) as PictureControl[]) : []
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}

const MAX_EDGE = 1600 // working-resolution cap for real-time editing

type Tab = 'adjust' | 'curve' | 'presets' | 'npc' | 'help'

interface LoadedImage {
  name: string
  source: 'jpeg' | 'nef-embedded'
  base: ImageData // unprocessed, at working resolution
  width: number
  height: number
}

export default function App() {
  const [tab, setTab] = useState<Tab>('presets')
  const [pc, setPc] = useState<PictureControl>(defaultControl())
  const [image, setImage] = useState<LoadedImage | null>(null)
  const [showOriginal, setShowOriginal] = useState(false)
  const [status, setStatus] = useState<string>('이미지를 열어 시작하세요.')
  const [busy, setBusy] = useState(false)

  const [npcFolder, setNpcFolder] = useState<string | null>(null)
  const [npcFiles, setNpcFiles] = useState<NpcFileInfo[]>([])
  const [embeddedPc, setEmbeddedPc] = useState<PictureControl | null>(null)
  const [imported, setImported] = useState<PictureControl[]>(loadImported)

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rafRef = useRef<number>(0)

  const patch = useCallback((p: Partial<PictureControl>) => setPc((c) => ({ ...c, ...p })), [])

  // -- open an image (JPG/NEF) -------------------------------------------------
  const openImage = useCallback(async () => {
    setBusy(true)
    try {
      const opened = await pickImageFile()
      if (!opened) return
      const { bitmap, source } = await loadImageBitmap(opened.name, opened.bytes)
      const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height))
      const w = Math.max(1, Math.round(bitmap.width * scale))
      const h = Math.max(1, Math.round(bitmap.height * scale))
      const off = document.createElement('canvas')
      off.width = w
      off.height = h
      const octx = off.getContext('2d', { willReadFrequently: true })!
      octx.drawImage(bitmap, 0, 0, w, h)
      const base = octx.getImageData(0, 0, w, h)
      bitmap.close?.()
      setImage({ name: opened.name, source, base, width: w, height: h })

      // NEF: try to pull the in-camera Picture Control out of the MakerNote
      let embedded: PictureControl | null = null
      if (isRawName(opened.name)) {
        try {
          embedded = nefToPictureControl(opened.bytes)
        } catch {
          embedded = null
        }
      }
      setEmbeddedPc(embedded)
      setStatus(
        `${opened.name} · ${bitmap.width}×${bitmap.height}` +
          (source === 'nef-embedded' ? ' · NEF 임베디드 JPEG' : '') +
          (embedded ? ` · 내장 Picture Control: ${embedded.name}` : '')
      )
    } catch (err) {
      setStatus('이미지 로드 실패: ' + (err as Error).message)
    } finally {
      setBusy(false)
    }
  }, [])

  // -- render pipeline (debounced to animation frame) -------------------------
  const render = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas || !image) return
    canvas.width = image.width
    canvas.height = image.height
    const ctx = canvas.getContext('2d')!
    const work = new ImageData(
      new Uint8ClampedArray(image.base.data),
      image.width,
      image.height
    )
    if (!showOriginal) applyPictureControl(work, pc)
    ctx.putImageData(work, 0, 0)
  }, [image, pc, showOriginal])

  useEffect(() => {
    cancelAnimationFrame(rafRef.current)
    rafRef.current = requestAnimationFrame(render)
    return () => cancelAnimationFrame(rafRef.current)
  }, [render])

  // -- NPC folder management ---------------------------------------------------
  const chooseNpcFolder = useCallback(async () => {
    const entries = await pickNpcFolder()
    if (!entries) return
    const infos: NpcFileInfo[] = entries.map((e) => ({
      name: e.name,
      size: e.size,
      bytes: e.bytes,
      controlName: readNpcName(e.bytes)
    }))
    setNpcFiles(infos)
    setNpcFolder(`폴더에서 불러옴 · NPC ${infos.length}개`)
    setTab('npc')
    setStatus(`NPC ${infos.length}개 불러옴`)
  }, [])

  // -- export / save -----------------------------------------------------------
  const exportNpc = useCallback(() => {
    // Real camera-loadable .NP3 (Picture Control v0310), built from a reverse-
    // engineered NX Studio template. The preset name is written into the file;
    // the look is inherited from the template (per-slider/curve encoding needs
    // more samples — see np3.ts). Drop it in NIKON/CUSTOMPC on the SD card.
    const safe = pc.name.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 20) || 'CUSTOM'
    downloadBlob(`${safe}.NP3`, buildNp3(pc.name))
    setStatus(`내보냄: ${safe}.NP3 (카메라용 Picture Control)`)
  }, [pc])

  const saveRecipe = useCallback(() => {
    const safe = pc.name.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 20) || 'recipe'
    downloadBlob(
      `${safe}.json`,
      JSON.stringify({ format: 'npc-simulator-recipe', version: 1, control: pc }, null, 2)
    )
    setStatus(`레시피 저장: ${safe}.json`)
  }, [pc])

  const applyPreset = useCallback((preset: PictureControl) => {
    setPc(clonePreset(preset))
    setStatus(`프리셋 적용: ${preset.name}`)
  }, [])

  // -- import an Adobe XMP preset, convert to NPC, and register it -------------
  const persistImported = useCallback((list: PictureControl[]) => {
    try {
      localStorage.setItem(IMPORTED_KEY, JSON.stringify(list))
    } catch {
      /* storage full / disabled — keep in-memory only */
    }
  }, [])

  const importXmp = useCallback(async () => {
    try {
      const opened = await pickXmpFile()
      if (!opened) return
      const ctrl = xmpToPictureControl(opened.text, opened.name)
      setImported((prev) => {
        const next = [ctrl, ...prev.filter((p) => p.id !== ctrl.id)]
        persistImported(next)
        return next
      })
      setPc(clonePreset(ctrl))
      setTab('presets')
      setStatus(`XMP 변환·등록: ${ctrl.name}`)
    } catch (err) {
      setStatus('XMP 변환 실패: ' + (err as Error).message)
    }
  }, [persistImported])

  const removeImported = useCallback(
    (id: string) => {
      setImported((prev) => {
        const next = prev.filter((p) => p.id !== id)
        persistImported(next)
        return next
      })
    },
    [persistImported]
  )

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">◐</span> NPC Simulator
        </div>
        <div className="top-actions">
          <button onClick={openImage} disabled={busy}>
            이미지 열기 (JPG/NEF)
          </button>
          <button onClick={chooseNpcFolder}>NPC 폴더…</button>
          <button onClick={importXmp}>XMP 가져오기</button>
          <button onClick={exportNpc} disabled={!image && false}>
            내보내기
          </button>
          <button onClick={saveRecipe}>레시피 저장</button>
          <label className="toggle">
            <input
              type="checkbox"
              checked={showOriginal}
              onChange={(e) => setShowOriginal(e.target.checked)}
            />
            원본 비교
          </label>
        </div>
      </header>

      <div className="body">
        <main className="viewer">
          {image ? (
            <div className="canvas-wrap">
              <canvas ref={canvasRef} />
              <div className="canvas-badge">
                {showOriginal ? '원본' : pc.name}
                {image.source === 'nef-embedded' && ' · NEF'}
              </div>
              {embeddedPc && (
                <div className="embedded-pc">
                  <span>
                    📷 이 NEF의 Picture Control: <strong>{embeddedPc.name}</strong>
                  </span>
                  <button
                    onClick={() => {
                      setPc({ ...embeddedPc })
                      setStatus(`NEF 내장 Picture Control 적용: ${embeddedPc.name}`)
                    }}
                  >
                    추출·적용
                  </button>
                </div>
              )}
            </div>
          ) : (
            <div className="empty" onClick={openImage}>
              <div className="empty-inner">
                <div className="empty-icon">⬚</div>
                <p>JPG 또는 NEF 이미지를 열어 Picture Control을 미리보세요</p>
                <button onClick={openImage}>이미지 열기</button>
              </div>
            </div>
          )}
        </main>

        <aside className="panel">
          <nav className="tabs">
            {(
              [
                ['presets', '프리셋'],
                ['adjust', '조정'],
                ['curve', '톤커브'],
                ['npc', 'NPC 파일'],
                ['help', '도움말']
              ] as [Tab, string][]
            ).map(([t, label]) => (
              <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
                {label}
              </button>
            ))}
          </nav>

          <div className="tab-body">
            {tab === 'presets' && (
              <PresetGrid
                current={pc}
                onPick={applyPreset}
                extra={imported}
                onRemove={removeImported}
              />
            )}

            {tab === 'adjust' && (
              <div className="controls">
                <label className="field">
                  <span>이름</span>
                  <input
                    value={pc.name}
                    onChange={(e) => patch({ name: e.target.value })}
                    maxLength={20}
                  />
                </label>
                <div className="seg">
                  <button
                    className={pc.mode === 'color' ? 'on' : ''}
                    onClick={() => patch({ mode: 'color' })}
                  >
                    컬러
                  </button>
                  <button
                    className={pc.mode === 'monochrome' ? 'on' : ''}
                    onClick={() => patch({ mode: 'monochrome' })}
                  >
                    흑백
                  </button>
                </div>
                <Slider label="밝기" value={pc.brightness} min={-100} max={100} onChange={(v) => patch({ brightness: v })} />
                <Slider label="대비" value={pc.contrast} min={-100} max={100} onChange={(v) => patch({ contrast: v })} />
                {pc.mode === 'color' && (
                  <>
                    <Slider label="채도" value={pc.saturation} min={-100} max={100} onChange={(v) => patch({ saturation: v })} />
                    <Slider label="색조" value={pc.hue} min={-180} max={180} unit="°" onChange={(v) => patch({ hue: v })} />
                  </>
                )}
                <Slider label="샤프닝" value={pc.sharpening} min={0} max={100} onChange={(v) => patch({ sharpening: v })} />

                {pc.mode === 'monochrome' && (
                  <label className="field">
                    <span>필터</span>
                    <select
                      value={pc.filter}
                      onChange={(e) => patch({ filter: e.target.value as PictureControl['filter'] })}
                    >
                      <option value="none">없음</option>
                      <option value="yellow">노랑</option>
                      <option value="orange">주황</option>
                      <option value="red">빨강</option>
                      <option value="green">초록</option>
                    </select>
                  </label>
                )}

                {pc.mode === 'monochrome' ? (
                  <div className="toning">
                    <label className="field">
                      <span>토닝</span>
                      <select
                        value={pc.monoTone?.type ?? 'none'}
                        onChange={(e) => {
                          const type = e.target.value as NonNullable<PictureControl['monoTone']>['type']
                          patch({
                            monoTone: type === 'none' ? null : { type, density: pc.monoTone?.density ?? 4 }
                          })
                        }}
                      >
                        {TONING_TYPES.map((t) => (
                          <option key={t.value} value={t.value}>
                            {t.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    {pc.monoTone && (
                      <Slider
                        label="농도"
                        value={pc.monoTone.density}
                        min={1}
                        max={7}
                        onChange={(v) => patch({ monoTone: { ...pc.monoTone!, density: v } })}
                      />
                    )}
                  </div>
                ) : (
                  <div className="toning">
                    <label className="toggle">
                      <input
                        type="checkbox"
                        checked={!!pc.toning}
                        onChange={(e) =>
                          patch({ toning: e.target.checked ? { color: '#caa86a', strength: 30 } : null })
                        }
                      />
                      토닝(색상 틴트)
                    </label>
                    {pc.toning && (
                      <div className="toning-row">
                        <input
                          type="color"
                          value={pc.toning.color}
                          onChange={(e) => patch({ toning: { ...pc.toning!, color: e.target.value } })}
                        />
                        <Slider
                          label="강도"
                          value={pc.toning.strength}
                          min={0}
                          max={100}
                          onChange={(v) => patch({ toning: { ...pc.toning!, strength: v } })}
                        />
                      </div>
                    )}
                  </div>
                )}

                <button className="reset" onClick={() => setPc(defaultControl())}>
                  초기화
                </button>
              </div>
            )}

            {tab === 'curve' && (
              <div className="controls">
                <CurveEditor points={pc.curve} onChange={(curve) => patch({ curve })} />
                <button className="reset" onClick={() => patch({ curve: identityCurve() })}>
                  커브 초기화
                </button>
              </div>
            )}

            {tab === 'npc' && (
              <NpcPanel
                folder={npcFolder}
                files={npcFiles}
                onChoose={chooseNpcFolder}
                onLoadRecipe={(info) => {
                  const text = info.bytes ? new TextDecoder().decode(info.bytes) : ''
                  const loaded = fromRecipeJson(text)
                  if (loaded) {
                    setPc(loaded)
                    setStatus('레시피 로드: ' + info.name)
                  } else {
                    setStatus(
                      `${info.name}: 바이너리 NPC는 미리보기 정보만 표시됩니다 (완전한 파싱은 로드맵).`
                    )
                  }
                }}
              />
            )}

            {tab === 'help' && <HelpPanel />}
          </div>
        </aside>
      </div>

      <footer className="statusbar">
        <span>{status}</span>
        <span className="right">{image ? `${image.width}×${image.height} 작업본` : ''}</span>
      </footer>
    </div>
  )
}

function PresetGrid({
  current,
  onPick,
  extra = [],
  onRemove
}: {
  current: PictureControl
  onPick: (p: PictureControl) => void
  extra?: PictureControl[]
  onRemove?: (id: string) => void
}) {
  const [q, setQ] = useState('')
  const [mono, setMono] = useState<'all' | 'color' | 'monochrome'>('all')
  const importedIds = useMemo(() => new Set(extra.map((p) => p.id)), [extra])
  const all = useMemo(() => [...extra, ...ALL_PRESETS], [extra])
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return all.filter((p) => {
      if (mono !== 'all' && p.mode !== mono) return false
      if (needle && !p.name.toLowerCase().includes(needle)) return false
      return true
    })
  }, [q, mono, all])

  return (
    <div className="preset-wrap">
      <div className="preset-toolbar">
        <input
          className="search"
          placeholder={`${all.length}개 검색…`}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <div className="seg small">
          {(['all', 'color', 'monochrome'] as const).map((m) => (
            <button key={m} className={mono === m ? 'on' : ''} onClick={() => setMono(m)}>
              {m === 'all' ? '전체' : m === 'color' ? '컬러' : '흑백'}
            </button>
          ))}
        </div>
      </div>
      <p className="hint count-line">{filtered.length}개 표시</p>
      <div className="preset-grid">
        {filtered.map((p) => {
          const isImported = importedIds.has(p.id)
          return (
            <button
              key={p.id}
              className={'preset ' + (current.name === p.name ? 'on' : '')}
              onClick={() => onPick(p)}
              title={isImported ? 'XMP 가져옴' : (p as LibraryPreset).sourcePath ?? p.name}
            >
              <span className={'swatch ' + p.mode}>{p.mode === 'monochrome' ? '◑' : '●'}</span>
              <span className="preset-name">{p.name}</span>
              {isImported && <span className="preset-badge">XMP</span>}
              {isImported && onRemove && (
                <span
                  className="preset-del"
                  role="button"
                  title="등록 해제"
                  onClick={(e) => {
                    e.stopPropagation()
                    onRemove(p.id)
                  }}
                >
                  ×
                </span>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}

function NpcPanel({
  folder,
  files,
  onChoose,
  onLoadRecipe
}: {
  folder: string | null
  files: NpcFileInfo[]
  onChoose: () => void
  onLoadRecipe: (info: NpcFileInfo) => void
}) {
  return (
    <div className="npc-panel">
      <button className="wide" onClick={onChoose}>
        NPC 폴더 선택…
      </button>
      {folder && <p className="folder-path">{folder}</p>}
      {files.length === 0 && folder && <p className="hint">이 폴더에 NPC 파일이 없습니다.</p>}
      <ul className="npc-list">
        {files.map((f) => (
          <li key={f.name} onClick={() => onLoadRecipe(f)}>
            <span className="npc-icon">▤</span>
            <span className="npc-meta">
              <strong>{f.controlName ?? f.name}</strong>
              <small>
                {f.name} · {(f.size / 1024).toFixed(1)} KB
              </small>
            </span>
          </li>
        ))}
      </ul>
      <p className="hint">
        카메라 SD카드의 <code>NIKON/CUSTOMPC</code> 폴더를 선택하면 저장된 Picture Control이
        나열됩니다.
      </p>
    </div>
  )
}

function HelpPanel() {
  return (
    <div className="help">
      <h3>NPC Simulator</h3>
      <p>Nikon Picture Control 파일을 관리하고 JPG/NEF 미리보기에 적용해보는 비공식 도구입니다.</p>
      <ol>
        <li>
          <strong>이미지 열기</strong>로 JPG 또는 NEF를 불러옵니다. NEF는 내장 JPEG
          미리보기를 추출합니다.
        </li>
        <li>
          <strong>프리셋</strong>에서 필름 룩을 고르거나 <strong>조정/톤커브</strong>로
          직접 편집합니다.
        </li>
        <li>
          <strong>원본 비교</strong> 체크로 전/후를 비교합니다.
        </li>
        <li>
          <strong>NPC 폴더</strong>로 SD카드의 <code>NIKON/CUSTOMPC</code>를 열어 파일을
          확인합니다.
        </li>
        <li>
          <strong>레시피 저장 / 내보내기</strong>로 설정을 보관합니다.
        </li>
      </ol>
      <p className="muted">
        ※ 카메라용 바이너리 NPC의 완전한 read/write는 로드맵입니다. 현재 내보내기는 자체 레시피
        포맷(JSON)을 사용합니다. 이 도구는 Nikon 공식 제품이 아닙니다.
      </p>
    </div>
  )
}

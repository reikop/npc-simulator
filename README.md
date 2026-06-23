# NPC Simulator

Nikon Picture Control(NPC) 파일을 관리하고 **JPG / NEF** 이미지에 적용해 미리보는 **브라우저 웹앱**.
[nikonpc.com](https://nikonpc.com)의 기능을 참고해 **직접 구현**한 비공식 도구입니다 (코드·에셋 복사 없음).

> 이 도구는 Nikon 공식 제품이 아닙니다.

## 기능

- **이미지 열기** — JPG는 그대로, **NEF는 내장 JPEG 미리보기를 순수 TS로 추출**(libraw/dcraw 불필요)
- **Picture Control 편집** — 밝기 / 대비 / 채도 / 색조 / 샤프닝, 흑백 변환 + 컬러 필터 + 토닝
- **톤커브 에디터** — 포인트 추가·드래그·삭제 (Catmull-Rom 보간)
- **프리셋 라이브러리** — 내장 9종 + **nikonpc.com에서 받아온 166종** (검색·컬러/흑백 필터)
- **XMP 가져오기** — Adobe Lightroom/Camera Raw `.xmp` 프리셋을 **전체 파라미터까지 변환·등록**: 화이트밸런스 · 노출/대비/하이라이트/섀도/화이트/블랙 · 파라메트릭 + RGB 채널 톤커브 · HSL 8밴드(색조/채도/광도) · 컬러그레이딩(섀도/미드톤/하이라이트/글로벌)+스플릿토닝 · 텍스처/클래리티/디헤이즈 · 샤프닝(반경/마스킹) · 필름그레인. 브라우저에 저장되고 프리셋 목록에 추가됨
- **원본 비교** 토글
- **NPC 폴더 관리** — `NIKON/CUSTOMPC` 폴더를 열어 NPC 파일 나열 + 이름 추출
- **레시피 저장 / 내보내기** — 카메라용 **.NP3 Picture Control** 다운로드(NX Studio 포맷 리버스, 이름 주입) + 자체 레시피 포맷(JSON)

## 기술 스택

Vite + React + TypeScript. 순수 브라우저 앱(서버·네이티브 의존성 없음).
파일 입출력은 File System Access API(폴더 선택) + `<input type=file>` + Blob 다운로드.

> 폴더 선택은 Chromium 계열(Chrome/Edge)에서 가장 잘 동작합니다.

## 실행

```bash
npm install
npm run dev        # http://localhost:5173 (자동으로 브라우저 열림)
npm run build      # dist/ 정적 번들
npm run preview    # 빌드 결과 미리보기
npm run typecheck
```

## 프리셋 수집 (선택)

`npm run fetch-npc` — nikonpc.com에서 166개 Picture Control 정의를 받아
`src/renderer/src/lib/library.json`(앱 라이브러리), `data/npc-raw/*.txt`(원본 응답 아카이브),
`data/npc-bin/*.NCP`(커브 기반 NCP 바이너리)를 생성합니다. 이미 받아둔 상태로 커밋되어 있어
다시 실행할 필요는 없습니다.

## 구조

```
src/renderer/
  index.html
  src/
    App.tsx              UI 셸 + 캔버스 파이프라인 + 탭
    components/          Slider, CurveEditor
    lib/
      nef.ts                TIFF/NEF 파서 → 임베디드 JPEG 추출
      nefPictureControl.ts  NEF MakerNote에서 촬영 당시 Picture Control 추출
      pictureControl.ts     조정 모델 + Canvas 처리 파이프라인
      fileio.ts             브라우저 파일 입출력(열기/폴더/다운로드)
      npc.ts                NPC 이름 추출 + 레시피 직렬화
      presets.ts            내장 프리셋 + library.json 로딩
      library.json          nikonpc.com에서 받은 166개 프리셋
    styles.css
scripts/
  fetch-npc.mjs       nikonpc.com에서 프리셋 수집 (네트워크)
  parse-npc.mjs       공유 파서: loadNpc 응답 → 레시피 포맷
  rebuild-library.mjs 로컬 아카이브(data/npc-raw)로 library.json 재생성 (오프라인)
  dump-nef-pc.mjs     진단: NEF의 PictureControlData 블록 헥스 덤프
data/npc-raw, data/npc-bin   원본 응답 / 생성된 NCP 바이너리
```

## 로드맵

- 카메라용 **바이너리 NPC(.NCP/.NP2/.NP3) 완전 read/write** — 현재 `.NP3`(v0310)는 TLV 컨테이너 구조를 리버스해 **이름 주입 + 유효 파일 생성**까지 가능. 슬라이더별 값 레코드(0x03~0x1e)와 커브 블록(0x1f00/0x2000) 인코딩은 varied 샘플이 더 모이면 매핑 예정 (전체 포맷은 Nikon 비공개 규격)
- NEF **풀 RAW 디모자이크** (현재는 내장 JPEG 미리보기)
- 클래리티/필터 효과, 히스토그램, 일괄 적용·내보내기

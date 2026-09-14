# Review 탭: 항목별 사람 결정 → LLM 반영 워크플로우

**Status:** Spec (구조 검토용). 구현 미착수.

**Goal:** 위키 갱신 후 Review 탭에 쌓인 개별 검토 항목에 대해, 사람이
"그대로 둘지 / 제안대로 고칠지 / 어떻게 고칠지"를 프롬프트로 입력하면,
LLM이 대상 위키 페이지의 수정본을 만들고, 사람이 diff를 확인한 뒤
적용해서 위키가 갱신되는 흐름을 만든다.

**Non-goals (이번 라운드):**
- 웹 검색(Deep Research) 연동. 별도 건.
- Review 항목 생성 로직(ingest 프롬프트) 변경.
- Agent runtime(`wiki.write_page` 툴) 경유 실행. 아래 §4에서 배제 이유 기술.
- 다중 사용자 동시 편집.

---

## 1. 현재 구조 (코드 확인 결과, 추정 아님)

| 구성요소 | 파일 | 역할 |
|---|---|---|
| 항목 타입 | `src/stores/review-store.ts:10` | `ReviewItem` = type / title / description / sourcePath / affectedPages / searchQueries / options / resolved / resolvedAction |
| 안정 ID | `review-store.ts:48` `reviewIdFor` | `FNV-1a(type::normalizedTitle)`. 재수집·리로드에도 동일 ID |
| 생성 | `src/lib/ingest.ts:2139` `parseReviewBlocks` | LLM 출력의 `---REVIEW: type\|title---` 블록 파싱 |
| 영속 | `src/lib/persist.ts:14` | `.llm-wiki/review.json` 전량 rewrite, `auto-save.ts` 구독 |
| 자동 해소 | `src/lib/sweep-reviews.ts` | ingest 큐가 비면 규칙+LLM으로 pending 항목 자동 resolve |
| UI | `src/components/review/review-view.tsx` | 카드 목록 + `item.options` 버튼 |
| 외부 API | `src-tauri/src/api_server.rs:348` | GET reviews / POST resolve / PATCH review |

**현재 "결정"의 실체:** `resolveItem(id, action)` — action은 그냥 문자열이다.
`review-view.tsx:497` 이하 휴리스틱이 문자열을 보고 분기한다:

- `save:` / `open:` / `delete:` / `__create_page__:` 접두사
- `actionLooksLikeResearch()` — "research/investigate/研究…" 포함 여부
- `actionIsDismissal()` — "skip/dismiss/ignore/approve/keep existing/no"
- `actionLooksLikeCreate()` — **위 dismissal이 아니면 전부 페이지 생성**

즉 지금 가능한 결과는 사실상 두 가지뿐이다: **새 페이지를 만들거나, 무시하거나.**
기존 페이지를 고치는 경로가 없다. 사용자가 요청한 기능의 공백은 여기다.

**부수적으로 확인된 사실(별건, 이번 작업에서 건드리지 않음):**
- `searchQueries`는 파싱·저장되지만 **소비하는 UI가 없다** (`grep`로 확인).
  ingest 프롬프트(`ingest.ts:2394`)는 "Deep Research 버튼이 시스템에 의해 자동 추가된다"고
  모델에 알려주지만 그런 버튼은 존재하지 않는다. 죽은 데이터 + 거짓 프롬프트.
- 로케일은 `src/i18n/en.json` 하나뿐(파리티 테스트 있음).

---

## 2. 재사용할 기존 자산

새 기능 대부분은 이미 있는 조각의 조립으로 만든다.

| 필요 기능 | 기존 자산 |
|---|---|
| 제안→diff→수락 UX 패턴 | `wiki-editor.tsx:170-290` 선택영역 편집 (streamChat → diff → apply) |
| 단어 단위 diff | `src/lib/selection-edit.ts` `buildWordDiff` |
| 모델 출력의 외곽 코드펜스 제거 | `selection-edit.ts` `normalizeSelectionReplacement` |
| 다중 파일 출력 파싱 | `ingest.ts:461` `parseFileBlocks` (+ `FILE_BLOCK_REGEX`) |
| 경로 안전성 검사 | `ingest.ts:395` `isSafeIngestPath` |
| 본문 유실 방지 검사 | `src/lib/page-merge.ts` — `BODY_SHRINK_THRESHOLD 0.7`, `LOCKED_FIELDS` (type/title/created) |
| 낙관적 동시성 쓰기 | `src-tauri/src/commands/fs.rs:1323` `apply_text_selection_edit_inner` (prefix/selection/suffix 스냅샷 검증) |
| 되돌리기 | `file_history::record_file_version` — `write_file`이 자동 기록. `restore_file_history`로 복원 |
| 동시 실행 차단 | `src/lib/project-mutex.ts` `withProjectLock` (ingest와 공유) |
| 작업별 모델 선택 | `src/lib/llm-task-routing.ts` `getTaskLlmConfig` |

---

## 3. 제안 구조

### 3.1 데이터 모델

`ReviewItem`에 `decision` 한 필드만 추가한다. 기존 `options` / `resolvedAction`은
호환을 위해 유지(레거시 문자열 액션 경로는 그대로 동작).

```ts
// src/stores/review-store.ts
export type ReviewDecisionKind = "keep" | "apply-suggestion" | "custom"

export interface ReviewDecision {
  kind: ReviewDecisionKind
  instruction: string           // 사람이 넣는 프롬프트. keep이면 빈 문자열
  targets: string[]             // 대상 위키 경로(프로젝트 상대). 기본값 affectedPages
  allowCreate: boolean          // 대상에 없는 새 페이지 생성 허용 여부
  status: "draft" | "proposed" | "applied" | "failed"
  proposalRef?: string          // 제안 본문 파일 키 (= review id). §3.3
  appliedPaths?: string[]
  appliedAt?: number
  error?: string
}
```

제안 본문(페이지 전체 before/after)은 `ReviewItem`에 넣지 않는다.
`review.json`은 스토어가 바뀔 때마다 전량 rewrite되므로(`auto-save.ts:89`)
페이지 전문 수 KB × N을 여기에 넣으면 저장 비용이 항목 수에 비례해 터진다.

```ts
// .llm-wiki/review-proposals/<reviewId>.json — 제안 생성 시에만 기록
export interface ReviewProposal {
  reviewId: string
  createdAt: number
  model: string                 // projectLlmProfile 결과 (apiKey 제외)
  instruction: string
  edits: ReviewPageEdit[]
}
export interface ReviewPageEdit {
  filePath: string              // 프로젝트 상대
  op: "update" | "create"
  before: string                // op=create면 ""
  after: string
}
```

`delete` op은 1차에서 제외한다. 삭제는 되돌리기 비용이 다르고,
duplicate 항목은 "병합 후 리다이렉트 스텁"이 더 안전하다. (§6 열린 질문)

### 3.2 파이프라인

`page-merge.ts`가 이미 쓰는 방식 — **순수 로직 + LLM 호출 주입** — 을 따른다.
새 파일 `src/lib/review-decision.ts` (순수) + `src/lib/review-apply.ts` (I/O).

```
1. buildReviewDecisionPrompt(item, decision, pages)     순수, 단위 테스트 대상
2. proposeReviewEdit(...)  → streamChat(getTaskLlmConfig("ingest"))
3. parseFileBlocks(raw)    → 기존 함수 재사용, ---FILE:--- 포맷 그대로
4. validateReviewEdit(before, after)                    순수
      - isSafeIngestPath
      - targets 밖 경로 거부 (allowCreate=false일 때)
      - LOCKED_FIELDS(type/title/created) 원복
      - 본문 길이 < before의 70% → 거부 (BODY_SHRINK_THRESHOLD 재사용)
5. applyReviewEdit(...)    withProjectLock 안에서 페이지별 쓰기
      - index.md / log.md 갱신
      - resolveItem(id, 요약문), decision.status = "applied"
```

2단계 프롬프트로 나누지 않는다. 대상 페이지 수가 적고(보통 1~3),
ingest처럼 분석/생성을 쪼갤 이유가 없다.

**프롬프트 골자** (`buildReviewDecisionPrompt`):

```
- 검토 항목: type / title / description
- 사람의 결정: kind + instruction  ← 최우선 지시
- 대상 페이지 전문 (frontmatter 포함)
- 출력 규약: 수정이 필요한 페이지만 ---FILE: path--- 블록으로 전문 출력.
  수정 불필요하면 아무 블록도 출력하지 말 것.
- frontmatter의 type/title/created는 변경 금지
- 기존 문장 보존, 필요한 부분만 수정 (전면 재작성 금지)
- 출력 언어 규칙: 기존 output-language / korean-prose-rules 주입
```

`kind`별로 instruction 기본값을 템플릿으로 채워 넣고 사람이 편집하게 한다:

- `keep` → LLM 호출 없음. 즉시 `resolveItem(id, "Kept as-is")`.
- `apply-suggestion` → "이 검토 항목의 제안을 대상 페이지에 반영하라."
- `custom` → 빈칸.

### 3.3 동시성 / 안전성

- **stale write 방지:** 제안 생성 시 `before`를 스냅샷으로 잡고, 적용 직전 파일을
  다시 읽어 `before`와 완전 일치할 때만 쓴다. 불일치면 적용 거부 후
  "파일이 변경됨, 다시 제안 생성" 표시.
  - 프론트엔드 read-then-write는 원자적이지 않다. 정확히 하려면
    Rust 커맨드 `apply_page_replacement(projectPath, filePath, expectedBefore, after)`를
    추가해 `apply_text_selection_edit_inner`와 같은 방식으로 서버 측 검증한다.
    (선택지: 프론트 검증만으로 타협 가능. §6)
- **ingest와의 충돌:** `withProjectLock(pp, ...)`으로 감싼다. sweep이 같은 항목을
  자동 resolve하는 레이스는 이미 `sweep-reviews.race.test.ts`가 다루는 패턴을 따른다.
  적용 중인 항목은 sweep 대상에서 제외해야 한다 (`status === "proposed" | "applied"`).
- **되돌리기:** `write_file`이 file history를 자동 기록하므로 별도 백업 불필요.
  적용 후 카드에 "되돌리기" 버튼 → `restoreFileHistory`.

### 3.4 UI (`review-view.tsx`)

카드를 접이식 결정 패널로 확장한다. 기존 옵션 버튼 줄은 유지.

```
┌ [x] ⚠ 제목                                              [닫기]
│ 설명
│ 영향 페이지: wiki/concepts/a.md, wiki/entities/b.md
│ ─────────────────────────────────────────────
│ 결정:  ( ) 그대로 둠   (•) 제안대로 수정   ( ) 직접 지시
│ 대상:  [x] concepts/a.md  [ ] entities/b.md  [ ] + 새 페이지
│ 지시:  ┌──────────────────────────────────┐
│        │ (kind별 템플릿 프리필, 편집 가능)  │
│        └──────────────────────────────────┘
│                          [제안 생성]  ← 스트리밍 진행 표시
│ ─── 제안 결과 (페이지별 탭/아코디언) ───
│ concepts/a.md   +12 / -3   [diff 렌더: buildWordDiff]
│                    [적용]  [다시 생성]  [버리기]
└
```

- diff는 페이지 전문 대신 **변경 구간만** 접어서 보여준다(문서 전체 워드 diff는
  `buildWordDiff`의 250k 토큰 상한에 걸릴 수 있음 — `selection-edit.ts:38`).
- 적용 후에는 resolved 상태 + `resolvedAction`에 "Updated: a.md, b.md" 요약.

### 3.5 일괄 처리

기존 다중 선택 UI를 재사용해서 "선택 항목에 같은 지시 적용"을 추가한다.
항목별로 순차 실행(락 때문에 병렬 무의미), 실패는 항목별로 격리해서 표시.

### 3.6 외부 API

`PATCH /projects/:id/reviews/:reviewId`에 `decision` 필드를 받도록 확장.
단, **LLM 실행은 프론트엔드에만 둔다** — API 서버(Rust)에는 streamChat 경로가 없고,
CLI provider(claude-code/codex-cli/gemini-cli)는 프론트에서만 동작한다.
API로는 `keep` 결정과 상태 조회만 지원. (§6)

---

## 4. 배제한 대안

**(A) Agent runtime(`wiki.write_page`)에 맡기기.** 모델이 알아서 파일을 고치게 한다.
배제 이유: diff 사전 검토가 불가능하고(툴 호출이 바로 쓰기), 권한 프롬프트 흐름이
따로 있고, CLI provider일 때 백엔드에 HTTP LLM이 없어 경로가 갈린다
(`agent/provider.rs:75` `is_usable_for_backend_http`). 검토 워크플로우의 요점은
"사람이 보고 승인"이므로 제안/적용 분리가 필수다.

**(B) 검토 항목을 Chat으로 넘겨서 대화로 처리.** 이미 사실상 가능하고
(항목 텍스트 복사), 결정이 review.json에 기록되지 않아 감사 추적이 끊긴다.

**(C) `resolvedAction` 문자열에 지시를 욱여넣기.** 현재 휴리스틱 파서
(`actionLooksLikeCreate` = "dismissal 아니면 전부 생성")와 정면 충돌한다.
구조화 필드가 필요하다.

---

## 5. 구현 순서 (각 단계 검증 기준 포함)

1. `ReviewDecision` 타입 + 스토어 액션 `setDecision` / 마이그레이션
   → 검증: `review-store.test.ts`에 decision 없는 기존 review.json 로드 테스트
2. `buildReviewDecisionPrompt` + `validateReviewEdit` (순수)
   → 검증: 단위 테스트 (locked field 원복, 70% 축소 거부, 경로 이탈 거부)
3. `keep` 경로만 UI 연결 (LLM 없음)
   → 검증: 클릭 → resolved + review.json에 decision 기록
4. 제안 생성 + diff 렌더
   → 검증: mock streamChat으로 시나리오 테스트, 실제 모델은 `*.real-llm.test.ts` 관례
5. 적용 + stale 검사 + file history 되돌리기
   → 검증: 적용 후 파일 내용 일치, 중간 변경 시 거부, restore 동작
6. 일괄 처리 + sweep 제외 규칙
   → 검증: `sweep-reviews.race.test.ts` 패턴으로 레이스 테스트

---

## 6. 결정 사항 (확정, 2026-09-14)

| # | 질문 | 결정 | 구현 위치 |
|---|---|---|---|
| 1 | 삭제/병합 op | **삭제 없음.** 내용을 옮기고 빈 페이지에는 리다이렉트 스텁을 남기도록 프롬프트가 지시 | `review-decision.ts` 프롬프트 규칙 |
| 2 | stale 검사 위치 | **프론트엔드 + 기존 프로젝트 락.** 적용 직전 재읽기 후 `before`와 완전 일치할 때만 쓰기 | `review-apply.ts` `applyReviewProposal` |
| 3 | 제안 영속화 | **파일로 저장.** 항목당 1개, 적용/폐기 시 삭제 | `.llm-wiki/review-proposals/<reviewId>.json` |
| 4 | 모델 라우팅 | **`getTaskLlmConfig("ingest")` 재사용.** 새 태스크 종류 신설 안 함 | `review-apply.ts` |
| 5 | API 서버 범위 | **`keep` 결정 기록 + 조회만.** 다른 kind는 400으로 거부 | `api_server.rs` `normalize_patch_decision` |

구현 완료. 실제 구조는 §3과 일치하며, 차이점은 아래뿐이다:

- `ReviewDecision.proposalRef`(§3.1 초안) → `hasProposal: boolean`. 제안 파일명이
  항상 review id이므로 별도 참조 문자열이 불필요했다.
- diff는 페이지 전문 대신 frontmatter를 제외한 본문에 대해 계산하고,
  긴 무변경 구간은 `condenseDiff`로 접는다.

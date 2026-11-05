# 검토: (1) 원본 소스 개별 삭제 (2) Chat 응답 속도

조사 대상 커밋: `3e0da2a` (v0.6.17). 모든 주장에 파일:줄 근거를 붙였고,
근거를 확인하지 못한 항목은 "확실하지 않음"으로 표시했다.
실행 중인 앱으로 측정한 수치는 없다 — 이 조사는 코드 경로 추적만으로 했다.

---

## 1. 원본 소스를 나중에 하나만 깔끔히 제거할 수 있는가

### 결론

**부분적으로 가능하다.** 파일·캐시·단독 소스 페이지는 이미 깔끔히 정리되지만,
**여러 소스를 합쳐 만든 페이지는 "B가 기여한 문장"이 본문에 그대로 남는다.**
즉 A·B·C를 넣고 분석한 뒤 B만 지우면, B만의 페이지는 사라지지만
A+B가 섞인 페이지에서는 `sources:` 목록에서 B만 빠지고 내용은 그대로다.

### 이미 동작하는 부분

삭제 진입점은 `deleteSourceFiles` (`src/lib/source-lifecycle.ts:458`)이고,
소스 하나당 다음을 지운다.

| 대상 | 처리 | 근거 |
|---|---|---|
| 원본 파일 | 삭제 | `source-lifecycle.ts:486` |
| 파싱된 마크다운 | 삭제 | `source-lifecycle.ts:491` (`removeParsedMarkdown`) |
| 파서 캐시 `.cache/<name>.txt(.parser)` | 삭제 | `source-lifecycle.ts:493-502` |
| ingest 캐시 항목 | 삭제 | `source-lifecycle.ts:503-510` |
| 소스가 B 하나뿐인 위키 페이지 | 페이지 삭제 + 역링크/인덱스 정리 | `source-lifecycle.ts:545`, `wiki-page-delete.ts:161` |
| 삭제된 페이지의 임베딩 | 삭제 | `wiki-page-delete.ts:76` (`removePageEmbedding`) |
| 삭제된 페이지의 `wiki/media/<slug>` | 삭제 | `source-lifecycle.ts:618` |
| 삭제 이력 | 로그 기록 | `source-lifecycle.ts:563` (`appendSourceDeleteLog`) |
| 폴더 단위 삭제 | 파일별로 같은 경로 재사용 | `source-lifecycle.ts:578` |

소스 이름 매칭은 파일명과 소스 식별자 양쪽을 대소문자 무시로 본다
(`sourceNameMatchesAny`), 그래서 `B.md` / `b.md` 혼용도 잡는다.

### 남아 있는 구멍 (3가지)

**① 본문이 재합성되지 않는다 — 핵심 문제**

소스가 둘 이상인 페이지는 `writeSources(content, survivors)`로만 고쳐지고
(`source-lifecycle.ts:548`), `writeSources`는 프론트매터의 `sources:` 배열만
바꾼다 (`sources-merge.ts:231-233`). 본문은 한 글자도 건드리지 않는다.

결과: `sources: [A]`인데 본문에는 B에서 온 서술이 남는다. 출처 표기와 내용이
불일치하는 상태이고, "B를 깔끔히 제거"라는 요구의 핵심이 여기서 깨진다.

**② 살아남은 페이지의 임베딩이 갱신되지 않는다**

`removePageEmbedding`은 *삭제된* 페이지에만 호출된다
(`wiki-page-delete.ts:76`, `source-lifecycle.ts:616`).
재색인(`embedPage`)은 ingest 파이프라인(`ingest.ts:1495`)과
설정 화면의 "전체 재색인" 버튼에서만 호출된다.

결과: ①로 본문에 남은 B 내용의 청크가 LanceDB에 그대로 있어서,
Chat 검색·중복 검사에서 계속 끌려 나온다. 프론트매터만 고쳐도
벡터 인덱스는 모르는 상태다.

**③ Review 항목이 정리되지 않는다**

`ReviewItem`은 `sourcePath`를 들고 있는데 (`src/stores/review-store.ts:44`),
삭제 경로는 review 스토어를 전혀 건드리지 않는다 (`source-lifecycle.ts` /
`wiki-page-delete.ts` / `sources-view.tsx` 어디에도 review-store import 없음).

결과: 사라진 B를 가리키는 검토 항목이 Review 탭에 남고, 결정 워크플로우로
"제안 생성"을 누르면 존재하지 않는 소스를 근거로 프롬프트가 만들어진다.

### 제안하는 보완 방향

세 가지를 **별개 작업**으로 본다. ①이 제일 크고 유일하게 LLM이 필요하다.

- **①-a (권장): 영향 페이지를 "재검토 대기"로 표시**
  본문을 자동으로 고치지 않고, B가 빠진 페이지마다 Review 항목
  (`type: "confirm"`)을 만들어 사람이 0.6.17의 결정 워크플로우로 처리하게 한다.
  장점: 기존 기능 재사용, 데이터 손실 위험 없음, LLM 호출이 사용자 선택 시점에만.
  단점: 자동이 아니다 — 페이지가 많으면 손이 많이 간다.

- **①-b: 삭제 시 자동 재합성**
  남은 소스만으로 해당 페이지를 즉시 다시 쓰게 한다.
  장점: 진짜 "깔끔히 제거".
  단점: 소스 삭제가 LLM 호출·비용·실패 가능성을 떠안게 되고, 사람 확인 없이
  본문을 덮어쓴다. `BODY_SHRINK_THRESHOLD` 같은 안전장치가 필수.
  삭제 한 번에 페이지 수십 개가 걸릴 수 있다.

- **①-c: 아무것도 안 하고 경고만**
  삭제 확인 대화상자에 "N개 페이지에 B 내용이 남습니다"를 표시.
  가장 저렴하지만 문제를 해결하지는 않는다.

- **② 보완:** `writeSources`로 고친 페이지마다 `embedPage`를 다시 호출.
  작고 독립적이며 ①을 어떻게 하든 필요하다.

- **③ 보완:** 삭제 후 `sourcePath`가 사라진 소스를 가리키는 미해결 review 항목을
  제거. 순수 필터 함수 + 호출 한 줄 수준.

### 함께 발견한 미사용 코드 (이번 요청 범위 밖, 삭제하지 않음)

- `decidePageFate` (`src/lib/source-delete-decision.ts:33`) — 호출자가 없다.
  같은 3분기 판단이 `deleteSourceFiles` 안에 인라인으로 다시 구현돼 있다
  (`source-lifecycle.ts:538-550`). 전용 테스트 파일은 계속 통과하지만
  제품 코드 경로를 검증하지 않는다.
- `isGreeting` (`src/lib/greeting-detector.ts:45`) — 호출자가 없다. 2번 항목과
  직접 관련이 있어 아래에서 다시 다룬다.

---

## 2. Chat 모드에서 외부 CLI LLM 응답이 느린 원인

### 측정하지 않았음을 먼저 밝힌다

이 세션은 헤드리스라 앱을 띄워 구간별 시간을 잴 수 없었다. 아래는 **코드가
반드시 하는 일**에서 도출한 원인이고, 어느 구간이 실제로 몇 초인지는
확실하지 않다. 그래서 마지막에 계측 추가를 제안한다.

### CLI 공급자의 한 턴 경로

`chat-panel.tsx:1055` 부터:

1. `invoke("agent_start_turn", …)` — Rust 백엔드로 **검색만** 요청
   (`retrievalOnly: true`, `chat-panel.tsx:1066`). **스트리밍 아님.**
2. 1번이 끝나야 검색 결과를 프롬프트에 붙여 `streamChat` 호출
   (`chat-panel.tsx:1163`) → CLI 프로세스를 새로 띄운다.

두 단계가 완전히 직렬이고, 1번이 끝날 때까지 화면에는 아무 토큰도 안 온다.

### 원인 (영향 큰 순서)

**① Gemini CLI는 구조적으로 스트리밍이 불가능하다**

`build_gemini_cli_args`가 `-o json`을 붙인다
(`src-tauri/src/commands/gemini_cli.rs:527-539`). 모듈 주석이 직접 밝힌다:

> Gemini CLI does not stream JSONL: with `-o json` it prints a single
> envelope (`{ session_id, response, stats, error }`) once the turn is
> finished … there is nothing to emit per line
> (`gemini_cli.rs:3-8`)

즉 gemini-cli에서는 답변이 **전부 생성된 뒤 한 번에** 도착한다. 사용자가 보는
"느림"의 가장 큰 몫이 여기일 가능성이 높다. 체감뿐 아니라 첫 글자까지의
시간이 곧 전체 생성 시간이다.

Gemini CLI에 스트리밍 출력 플래그가 있는지는 **확실하지 않다** — 설치된 CLI
버전으로 `gemini --help`를 확인해야 한다. 참고로 Claude CLI 쪽은
`--output-format stream-json`으로 실제 델타를 받고 있다
(`claude_cli.rs:429-436`, 파서는 `claude-cli-transport.ts:31`).

**② 턴마다 CLI 프로세스를 새로 띄우고, 세션을 재사용하지 않는다**

`streamClaudeCodeCli`은 호출마다 `streamId`를 새로 만들어
(`claude-cli-transport.ts:153`) `claude -p`를 새 프로세스로 spawn한다
(`claude_cli.rs:296-311`). `--resume` / `--continue`는 쓰지 않는다
(`claude_cli.rs` 전체에 해당 플래그 없음 — 주석 7줄에서 "--resume session
state"를 격리 대상으로만 언급).

결과: 턴마다 Node 부팅 + 설정 로드 + 전체 히스토리 재전송
(`maxHistoryMessages: 10`, `chat-store.ts:127`)을 다시 한다. 프롬프트 접두부가
매 턴 달라지므로 서버측 프롬프트 캐시도 사실상 못 맞춘다
(system 메시지만 고정, 그 뒤에 히스토리와 검색 결과가 옴 —
`chat-panel.tsx:1131-1138`).

**③ `localCliIsolation` 기본값이 꺼져 있다**

기본값 `false` (`src/stores/wiki-store.ts:458`, `:469`). 꺼져 있으면
`build_claude_cli_args`가 격리 플래그를 전혀 붙이지 않아
(`claude_cli.rs:438-466`) CLI가 사용자의 `~/.claude` 전체 — MCP 서버, 훅,
플러그인, 슬래시 명령 — 를 턴마다 로드한다. MCP 서버 기동은 첫 토큰 전에
끝나야 한다. 코드가 훅 출력이 stdout을 가득 채우는 걸 따로 방어하고 있는
것(`claude-cli-transport.ts:190`, `isHookNoise`)이 훅이 실제로 돈다는 증거다.

켜면 `--tools ""`, `--strict-mcp-config`, `--disable-slash-commands`,
`--no-session-persistence`가 붙어 기동 비용이 크게 줄어든다
(`claude_cli.rs:438-466`). 다만 CLI가 도구를 못 쓰게 되므로 기능 영향이 있다.

**④ CLI 경로는 검색 단계의 진행 상황을 전혀 안 보여준다**

HTTP 공급자는 `agent_start_turn_stream`을 쓰고 `agent-event`를 받아
도구 진행을 띄우지만 (`chat-panel.tsx:822`, `:981`), CLI 경로는 비스트리밍
`agent_start_turn`을 쓴다 (`chat-panel.tsx:1055`). 그래서 검색이 도는 동안
화면에는 깜빡이는 `▊` 하나뿐이다 (`chat-message.tsx:1332`).
→ 3번 항목(로딩 애니메이션)과 같은 뿌리다.

**⑤ CLI 경로에서는 검색을 건너뛰는 분기가 없다**

백엔드 라우터는 `should_search_wiki`를 항상 `false`로 두고
(`src-tauri/src/agent/router.rs:88`), 실제 결정은 모델 플래너
(`plan_tools_with_model`)가 한다. 그런데 플래너는 백엔드 HTTP LLM이 없으면
즉시 빈 계획을 돌려준다 (`runtime.rs:2187-2193`) — CLI 공급자가 정확히 그
경우다. 그러면 `should_fallback_wiki_search`가 참이 되어
(`runtime.rs:2651-2657`: 플래너 없음 && `tools.wiki` && 스킬 없음)
**모든 턴에 wiki.search가 무조건 실행된다.**

즉 "안녕"에도 질의 임베딩 + 벡터 검색이 돈다. 임베딩 HTTP 타임아웃은 8초
(`src-tauri/src/commands/search.rs:22`, `SEARCH_EMBEDDING_TIMEOUT_SECS`)라,
임베딩 엔드포인트가 느리거나 안 떠 있으면 생성 시작 전에 최대 8초가 날아간다.

이 용도로 쓰려고 만든 `isGreeting`
(`src/lib/greeting-detector.ts:45`, 주석에 "lets the chat path skip the wiki
retrieval pipeline"이라고 적혀 있다)이 **어디에서도 호출되지 않는다.**

### 제안 (비용 대비 효과 순)

| # | 조치 | 효과 | 위험 |
|---|---|---|---|
| A | CLI 경로를 `agent_start_turn_stream`으로 바꿔 검색 진행을 띄운다 | 체감 개선 큼, 실제 시간은 그대로 | 낮음 (HTTP 경로에 이미 있는 코드 재사용) |
| B | `isGreeting`을 연결해 인사성 입력은 검색을 건너뛴다 | 해당 턴에서 검색 비용 전부 제거 | 낮음 (순수 함수 + 테스트 이미 있음) |
| C | Gemini CLI 스트리밍 출력 가능 여부 확인 후 적용 | gemini-cli 사용 시 가장 큼 | 가능 여부 미확인 |
| D | Claude CLI `--resume`로 세션 재사용, 신규 턴만 전송 | 반복 턴에서 큼 | 중간 (세션 수명·동시성 관리 필요) |
| E | `localCliIsolation` 기본값을 켜거나, 설정에 속도 영향 설명 추가 | MCP/훅 많은 사용자에게 큼 | 중간 (CLI 도구 사용 불가) |
| F | 구간별 계측 로그 (검색 ms / spawn→첫 토큰 ms / 총 ms) | 추측을 측정으로 바꾼다 | 없음 |

**F를 먼저 하기를 권한다.** 위 ①~⑤는 모두 코드가 하는 일로 확인된 사실이지만,
어느 쪽이 실제로 몇 초를 먹는지는 측정 없이는 알 수 없고, 측정 없이 D나 E처럼
위험한 변경을 먼저 하는 것은 순서가 거꾸로다.

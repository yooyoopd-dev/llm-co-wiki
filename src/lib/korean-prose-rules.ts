/**
 * Korean prose style rules injected into generation prompts when the
 * effective output language is Korean.
 *
 * Korean LLM output has a recognizable "AI smell" that the generic
 * language directive does nothing about: English-calque grammar
 * ("~를 통해", "~에 의해" passives), signature closing phrases
 * ("결론적으로", "시사하는 바가 크다"), uniform sentence length, and
 * bullet-heavy layout. The rules below are a condensed port of the
 * `humanize-korean` quick-rules from epoko77-ai/im-not-ai
 * (MIT, v2.3.2 @ 9747f03), reduced to the S1/high-signal patterns so the
 * block stays cheap enough to prepend to every request.
 *
 * Only the *prescriptive* half is ported. The upstream skill is a
 * post-hoc rewriting pipeline with detection scoring, change-rate gates
 * and rollback; here the rules are preventive — steering first-pass
 * generation — so no extra model call is spent.
 *
 * The rules are written in Korean on purpose: they describe Korean
 * surface forms, and a model asked to produce Korean follows Korean
 * instructions about Korean morphology more reliably than a translated
 * paraphrase.
 */

/** Language values (and detector outputs) that mean "write in Korean". */
export function isKoreanOutput(language: string): boolean {
  return language.trim().toLowerCase().startsWith("korean")
}

/**
 * Full rule block. Prepended to the system prompt alongside the generic
 * language directive.
 */
export const KOREAN_PROSE_RULES = [
  "## 한국어 문체 규칙 (필수)",
  "",
  "아래는 한국어 산문의 번역투·AI 상투구를 막기 위한 규칙이다. 내용·사실·인용은 절대 바꾸지 말고 표현만 지킨다.",
  "",
  "### 절대 건드리지 않는 것",
  "고유명사·제품명·모델명·기관명, 수치·날짜·단위, 직접 인용, 코드·식별자·파일명·URL, 업계 표준 영어 약어(LLM·GPU·API·MCP 등), 표준 기술 용어(prompt·token·pipeline 등)는 원형 그대로 둔다. prompt를 '지시문'으로 옮기는 식의 기계적 직역 금지.",
  "",
  "### 서법 보존",
  "당위(~해야 한다)를 사실 단정(~한다)으로, 추측(~일 수 있다)을 단정으로 올리지 않는다. 근거가 약한 주장을 강한 문장으로 쓰지 않는다.",
  "",
  "### 번역투 제거",
  "- 이중 피동 '~되어진다/~지게 된다'를 쓰지 않는다. '판단되어진다'가 아니라 '판단된다'.",
  "- '~에 의해' 피동 대신 행위자를 주어로. '모델에 의해 생성된'이 아니라 '모델이 만든'.",
  "- have/make/take 직역 '~를 가지고 있다'를 쓰지 않는다. '경쟁력을 가지고 있다'가 아니라 '경쟁력이 강하다'.",
  "- '~를 통해', '~에 있어서', '~와 관련하여', '~에 기반하여', '~을 위해'가 한 문단에 3회 이상 몰리지 않게 한다. 남으면 '~로', '~에서', '~해서', '~려고'로 분산한다.",
  "- '~에서의/~으로의/~에의' 같은 이중 조사는 절로 풀어 쓴다.",
  "- 명사 앞 3어절 이상 관형절이 쌓이면 문장을 나눈다.",
  "",
  "### AI 상투구 금지",
  "- 결산 도입구 '결론적으로', '요약하자면', '정리하자면', '이를 통해 알 수 있듯이'는 쓰지 않는다. 결론은 그냥 결론 문장으로 쓴다.",
  "- 의의 과장 '시사하는 바가 크다', '주목할 만하다', '매우 중요하다'를 쓰지 않는다. 왜 중요한지 구체로 쓴다.",
  "- 열거 도입 '크게 세 가지로 나눌 수 있다', '다음과 같다'를 쓰지 않고 바로 본론으로 들어간다.",
  "- hype 어휘(혁신적·획기적·압도적·전례 없는)를 쓰지 않는다. 수치·사실로 대신한다.",
  "- 분열문 '중요한 것은 ~이다', '핵심은 ~라는 점이다'를 주어-서술 직결로 쓴다. '필요한 것은 방향이다'가 아니라 '방향이 필요하다'.",
  "- 문장 말미 도치 결산 '~하는 이유다'와 결말 공식 '~할 때다', '~할 시점이다'는 문서당 최대 1회.",
  "- 사전 은유(잠식·청사진·적신호·신호탄·뿌리내리다)와 감각 술어 평가문('진단이 서늘하다')을 쓰지 않는다. 명제로 직접 쓴다.",
  "",
  "### 리듬·서식",
  "- 같은 종결어미를 4문장 이상 연속으로 쓰지 않는다. '~할 수 있다', '~로 보인다'가 반복되면 유보 강도는 유지한 채 형태만 바꾼다.",
  "- 문단마다 짧은 문장과 긴 문장을 섞는다. 길이를 균일하게 맞추지 않는다.",
  "- 연결어미(-고/-며/-지만/-면서/-어서) 바로 뒤에 쉼표를 찍지 않는다.",
  "- 문두 접속사(또한·따라서·즉·나아가·게다가)를 한 문단에 3회 이상 쓰지 않는다.",
  "- 설명이 이어지는 대목은 불릿이 아니라 문단으로 쓴다. 불릿은 실제 목록일 때만.",
  "- 이모지를 쓰지 않는다. 강조 따옴표를 5회 이상 쓰지 않는다.",
  "- 한글 + 괄호 영어 병기는 첫 등장 한 번만 하고 이후에는 한글만 쓴다.",
  "",
  "### 명사화·수식 절제",
  "'-성/-적/-화' 한자어 명사화와 '전략적 함의' 같은 '~적 N' 체인을 쌓지 않는다. 동사·형용사로 되돌린다.",
  "범용 정책동사(확대·강화·개선·확보·마련·구축)를 구체 행위 동사로 바꾼다.",
].join("\n")

/** One-line version for the reminder placed next to the user's message. */
export const KOREAN_PROSE_REMINDER =
  "한국어 문체 규칙 준수: 이중 피동·'~에 의해' 피동·'~를 통해' 반복 금지, '결론적으로/시사하는 바가 크다/~하는 이유다' 같은 상투구 금지, 종결어미 4연속 반복 금지, 연결어미 뒤 쉼표 금지, 이모지 금지."

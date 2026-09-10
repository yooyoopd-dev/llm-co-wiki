/**
 * Changelog shown in Settings → Changelog. Hardcoded rather than
 * pulled from GitHub Releases so it works offline and stays under
 * version control with the code that ships the changes.
 *
 * Conventions:
 *   - Newest version first (the UI renders in array order).
 *   - Each entry has an `en` highlight list.
 *   - Only user-visible changes belong here. Internal refactors,
 *     CI tweaks, and pure test work go in commit messages, not
 *     here — keep this readable for end users.
 *   - When releasing a new version: prepend a new entry with the
 *     same shape, then bump package.json / tauri.conf.json /
 *     Cargo.toml / Cargo.lock as usual.
 */

export interface ChangelogEntry {
  version: string
  date: string // YYYY-MM-DD
  highlights: {
    en: string[]
  }
}

export const CHANGELOG: ChangelogEntry[] = [
  {
    version: "0.6.11",
    date: "2026-08-25",
    highlights: {
      en: [
        "Added configurable reasoning effort for Ingest tasks across supported models and providers.",
        "Fixed Claude Code CLI provider tests by preserving local isolation settings and passing MCP configuration arguments correctly.",
        "Made raw source file lists use consistent natural numeric ordering across the app.",
        "Prevented stale raw source entries from appearing when switching projects.",
        "Expanded source-build documentation and improved related tests, stability, and compatibility.",
      ],
    },
  },
  {
    version: "0.6.10",
    date: "2026-08-21",
    highlights: {
      en: [
        "Added source-based knowledge filtering.",
        "Added batch Deep Research for review items and support for rerunning completed or failed research tasks.",
        "Added support for MinerU 3.0-3.2 backend names and made image captions follow the configured output language.",
        "Added detailed reporting for files skipped during source import.",
        "Improved large duplicate scans and fixed Deep Research concurrency, file naming, vector indexing, and wikilink consistency.",
        "Improved Agent model routing and provider compatibility, and fixed language detection, retry behavior, and Windows CRLF data integrity issues.",
      ],
    },
  },
  {
    version: "0.6.9",
    date: "2026-08-14",
    highlights: {
      en: [
        "Added a single-page Wiki vector indexing API and MCP tool with safe incremental updates.",
        "Added an answer context details panel for inspecting context size, categorized references, and knowledge-graph evidence.",
        "Added streaming Chat API responses and concurrent Ingest processing for faster external integrations and bulk imports.",
        "Made file history opt-in and configurable, with bounded version retention.",
        "Expanded scheduled imports with cross-project monitoring and source name or path filtering.",
        "Added external source-file opening, a global Settings shortcut, and Russian and Italian interface translations.",
        "Added support for authenticated local MinerU and improved trusted proxy TLS options, CJK filenames, and structured data preservation during Ingest.",
        "Improved existing features and fixed stability, compatibility, indexing, and data-integrity issues.",
      ],
    },
  },
  {
    version: "0.6.8",
    date: "2026-08-07",
    highlights: {
      en: [
        "Integrated AnyDoc document parsing with broader Word, PowerPoint, Excel, OpenDocument, and RTF support, richer structure preservation, safe legacy fallback, and versioned extraction caches.",
        "Improved large knowledge graph loading, caching, and community analysis performance.",
        "Added file version history usage and cleanup controls.",
        "Improved scheduled import cleanup when source files are removed or excluded.",
        "Fixed incomplete Deep Research output being saved as successful and added retry support.",
        "Improved GPT-5, OpenAI o-series, and Azure model parameter compatibility.",
        "Improved existing features and fixed stability and compatibility issues.",
      ],
    },
  },
  {
    version: "0.6.6",
    date: "2026-07-27",
    highlights: {
      en: [
        "Added Bocha Web Search as an external search provider for Agent, Deep Research, API, and MCP workflows.",
        "Added targeted recovery for truncated Ingest output so missing Wiki files can be regenerated automatically.",
        "Improved cross-platform PDF preview support.",
        "Improved Windows scheduled imports, nested paths, drive-letter and UNC path handling, Clip Server recovery, and overall stability.",
      ],
    },
  },
  {
    version: "0.6.5",
    date: "2026-07-20",
    highlights: {
      en: [
        "Added project-specific model configuration, including separate model routing for Chat and Ingest tasks.",
        "Added multiple custom LLM providers, custom request headers, and a configurable streaming output option.",
        "Added batch URL import and native Org mode source ingestion.",
        "Added a Read Sources Only answer mode that grounds responses exclusively in original source material.",
        "Improved embedding indexing performance and wiki-link repair for large projects.",
        "Bound MCP sessions to their projects to prevent context from leaking between projects.",
        "Added secure LAN support and customizable keyboard shortcuts to the Chrome Clipper.",
        "Made Chat retrieval modes and Agent depth modes more compact and easier to switch.",
        "Improved existing features and fixed stability, compatibility, and error-handling issues.",
      ],
    },
  },
  {
    version: "0.6.4",
    date: "2026-07-16",
    highlights: {
      en: [
        "Added EPUB and MOBI source support so ebooks can be imported, previewed, and ingested into a project.",
        "Added support for the official local MinerU API, including configurable service endpoints and Pipeline mode.",
        "Added ZIP-based project export and import for migrating wiki content, source files, and project state.",
        "Added deterministic wiki index rebuilding from the pages currently stored in the project.",
        "Added configurable LLM request timeouts for long-running cloud models and local services.",
        "Expanded Firecrawl configuration with API key authentication and custom service URLs.",
        "Added a persistent collapsible knowledge sidebar that preserves more space for the active workspace.",
        "Added Czech as an AI output language option.",
        "Improved existing features and fixed bugs across document import, frontmatter handling, source links, knowledge graphs, missing-page checks, and cross-platform compatibility.",
      ],
    },
  },
  {
    version: "0.6.1",
    date: "2026-07-10",
    highlights: {
      en: [
        "Improved Agent context so selected files, Skills, project knowledge, and retrieval evidence remain available throughout a turn.",
        "Expanded Hybrid Search with adaptive keyword, vector, and knowledge-graph retrieval, including graph-aware references and an interactive local graph preview.",
        "Added Agent file activity with per-file change summaries, diffs, and guarded undo when the file has not changed again.",
        "Improved generated output handling with consolidated output browsing, automatic previews, enlarged viewing, and support for common document, image, and web formats.",
        "Added file history comparison and restore controls for recorded project file versions.",
        "Improved Agent loop convergence by limiting duplicate retrieval, budgeting tool iterations, and producing a final answer before the retrieval budget is exhausted.",
      ],
    },
  },
  {
    version: "0.6.0",
    date: "2026-07-08",
    highlights: {
      en: [
        "Rebuilt Chat Agent on the Rust backend for more reliable tool execution, session handling, cancellation, permissions, and LLM streaming.",
        "Added Agent tools and Skill workflows, including wiki/source/graph/web search, workspace file generation, shell execution, user input forms, skill discovery, and per-conversation skill selection.",
        "Improved generated output handling with a dedicated output panel, previews, enlarged modal viewing, and quick access to the output folder.",
        "Improved Chat and Skill UI with a dedicated Skill management entry, slash skill completion, Mermaid diagram rendering, and better conversation isolation.",
        "Strengthened path sandboxing, workspace restrictions, command approval, hidden/sensitive file filtering, and Windows/Linux path compatibility.",
        "Expanded test coverage across the Rust Agent, tools, skills, search providers, chat sessions, layout, and Mermaid rendering.",
      ],
    },
  },
  {
    version: "0.5.2",
    date: "2026-06-25",
    highlights: {
      en: [
        "Fixed knowledge graph node previews so clicked pages open in the graph-side preview panel instead of switching to the Wiki page.",
      ],
    },
  },
  {
    version: "0.5.1",
    date: "2026-06-24",
    highlights: {
      en: [
        "Added Chat Agent modes, persisted tool progress, and project file tools for local inspection.",
        "Improved reasoning-model handling so chat can recover when an endpoint returns thinking text but no final answer.",
      ],
    },
  },
  {
    version: "0.5.0",
    date: "2026-06-24",
    highlights: {
      en: [
        "Added the new chat Agent flow with query understanding, local/wiki graph tools, external search tools, and visible tool progress.",
        "Improved chat references with an in-chat preview panel, resizable preview width, source snippets, and persisted search toggles.",
        "Improved Agent routing by using each project overview to decide when local wiki search should be preferred over external search.",
        "Removed the Intel macOS release build from GitHub Actions.",
      ],
    },
  },
  {
    version: "0.4.26",
    date: "2026-06-23",
    highlights: {
      en: [
        "Merged recent community PR fixes and cleaned up release documentation.",
        "Fixed release build issues around bundled resources and PDFium binaries.",
        "Added Intel x86_64 macOS client support to the release build.",
      ],
    },
  },
  {
    version: "0.4.25",
    date: "2026-06-23",
    highlights: {
      en: [
        "Added Firecrawl as a Web Search provider with friendlier handling for anonymous search limits.",
        "Fixed a batch of reported UI, import, search, and provider compatibility bugs.",
        "Improved release build preparation for bundled MCP resources.",
      ],
    },
  },
  {
    version: "0.4.24",
    date: "2026-06-16",
    highlights: {
      en: [
        "Improved project creation visibility, lint repair suggestions, zoom controls, autosave, and review persistence across project switches.",
        "Fixed vector index cleanup, Unicode page IDs, duplicate scan prefiltering, and local embedding requests so indexes and rebuilds stay accurate.",
        "Improved MCP and local CLI provider reliability, including MCP version reporting and running Codex CLI from the project root.",
        "Improved language prompts so technical names, model names, tool names, and code identifiers are preserved more reliably.",
        "Hardened Windows startup with a native title bar, earlier API startup, and a visible startup-error fallback instead of a blank window.",
      ],
    },
  },
  {
    version: "0.4.23",
    date: "2026-06-08",
    highlights: {
      en: [
        "Added Doubao embedding compatibility and improved embedding rebuild safety.",
        "Fixed dedup scan hangs, Codex CLI PATH detection from login shells, and several ingest / scheduled import reliability issues.",
      ],
    },
  },
  {
    version: "0.4.22",
    date: "2026-06-08",
    highlights: {
      en: [
        "Improved MinerU PDF previews by extracting images from MinerU result archives and rewriting them into Markdown image links.",
        "Converted MinerU HTML tables inside Markdown output into Markdown tables for cleaner preview and ingest.",
        "Hardened MinerU image handling for spaces, parentheses, path traversal, duplicate names, and partial image-save failures.",
      ],
    },
  },
  {
    version: "0.4.21",
    date: "2026-06-07",
    highlights: {
      en: [
        "Improved chat image support with safer local image handling, MiniMax M3 provider compatibility, and GLM vision model compatibility.",
        "Improved MinerU PDF parsing, local CLI provider resolution, API/MCP settings, and source/image ingestion reliability.",
        "Closed a batch of fixed GitHub issues covering source monitoring, scrolling, long-document ingest, editing, and provider compatibility.",
      ],
    },
  },
  {
    version: "0.4.20",
    date: "2026-06-04",
    highlights: {
      en: [
        "Fixed the macOS titlebar so it keeps native window dragging while following light and dark mode.",
      ],
    },
  },
  {
    version: "0.4.19",
    date: "2026-06-03",
    highlights: {
      en: [
        "Fixed the macOS traffic-light titlebar drag area while keeping Windows and Linux on their native window controls.",
      ],
    },
  },
  {
    version: "0.4.18",
    date: "2026-06-03",
    highlights: {
      en: [
        "Fixed close-window behavior on macOS and restored a clear Quit / Hide Window confirmation when asking before close.",
        "Improved Linux compatibility so the window minimizes instead of hiding when system tray support is unavailable.",
      ],
    },
  },
  {
    version: "0.4.17",
    date: "2026-06-03",
    highlights: {
      en: [
        "Added a local MCP server for agent clients, using the same project, search, graph, and file APIs as the desktop app.",
        "Updated Settings to manage API + MCP access together, including token guidance and a copyable MCP client configuration.",
      ],
    },
  },
  {
    version: "0.4.16",
    date: "2026-05-29",
    highlights: {
      en: [
        "Improved knowledge graph performance for large projects with worker-based layout and lighter rendering updates.",
        "Fixed graph search rendering errors and stabilized graph controls during filtering and search.",
      ],
    },
  },
  {
    version: "0.4.15",
    date: "2026-05-28",
    highlights: {
      en: [
        "Added AnyTXT as an external information source for Chat and Deep Research, with source labels and snippet previews.",
        "Added legacy Word .doc support for source import, text extraction, ingest, and preview.",
        "Improved source import, monitoring, chat search controls, graph controls, wiki generation reliability, and Mermaid rendering stability.",
        "Fixed raw-source preview, scrolling, editing, embedding configuration, and lint persistence issues.",
      ],
    },
  },
  {
    version: "0.4.14",
    date: "2026-05-26",
    highlights: {
      en: [
        "Deep Research can now use AnyTXT local file search alongside web search, with configurable research sources.",
        "Improved long-document ingestion with more resilient chunked analysis and follow-up research suggestions.",
        "Fixed provider compatibility and Windows path handling issues.",
      ],
    },
  },
  {
    version: "0.4.13",
    date: "2026-05-24",
    highlights: {
      en: [
        "Improved local API and search reliability, including shared backend search behavior.",
        "Fixed source handling edge cases for nested folders, non-English paths, and Windows compatibility.",
        "Fixed search provider configuration and Codex CLI Windows behavior issues.",
      ],
    },
  },
  {
    version: "0.4.12",
    date: "2026-05-19",
    highlights: {
      en: [
        "Fixed SearXNG web search configuration so self-hosted instances work without requiring an API key.",
      ],
    },
  },
  {
    version: "0.4.11",
    date: "2026-05-19",
    highlights: {
      en: [
        "Added a local API server for project files, search, graph data, and source rescans, with configurable access control in Settings.",
        "Unified UI and API search on the Rust backend with keyword and vector retrieval.",
        "Added Knowledge Graph search with a compact expandable search control and improved empty-result stability.",
      ],
    },
  },
  {
    version: "0.4.10",
    date: "2026-05-14",
    highlights: {
      en: [
        "Added configurable source folder monitoring, manual source-folder refresh, and Gemini native embeddings support.",
        "Fixed source sync, embedding provider compatibility, and settings localization issues.",
      ],
    },
  },
  {
    version: "0.4.9",
    date: "2026-05-11",
    highlights: {
      en: ["Fixed Windows compatibility issues around file paths, source sync, and file deletion."],
    },
  },
  {
    version: "0.4.8",
    date: "2026-05-11",
    highlights: {
      en: [
        "Project file sync is more complete: external changes in raw sources can be detected, queued persistently, retried, and routed through the same source add/delete lifecycle as in-app actions.",
        "Source cleanup is more reliable when raw files are deleted outside the app: related wiki pages, index entries, wikilinks, and `related:` references are cleaned consistently, including path-style `.md` links.",
        "Web search adds SearXNG as a provider, with per-provider configuration and selectable SearXNG search categories.",
        "Large raw-source folders are easier to browse: the Sources page now renders the file tree progressively while scrolling.",
        "OpenAI GPT-5 / o-series ingest compatibility is improved by using the supported completion-token parameter shape and avoiding unsupported sampling knobs.",
      ],
    },
  },
  {
    version: "0.4.7",
    date: "2026-05-06",
    highlights: {
      en: [
        "Web search now supports multiple providers: Tavily and SerpApi can be configured separately, with independent API keys and SerpApi search-engine selection.",
        "Reasoning-model support is improved across providers: thinking controls are available in LLM settings, structured ingest avoids reasoning-only failures, and chat can show model thinking when an endpoint streams it.",
        "Knowledge graph exploration is cleaner with filters, structural-node hiding, right-click node hide, and reset controls.",
        "Persian (Farsi) is now available as an output language, with better auto-detection from Arabic, RTL rendering, and per-project target-language preferences.",
      ],
    },
  },
  {
    version: "0.4.6",
    date: "2026-05-01",
    highlights: {
      en: [
        "Right-click delete in the Knowledge tree for entity / concept pages, with full reference cleanup: every body `[[wikilink]]`, `index.md` listing entry, and `related:` frontmatter array pointing at the deleted page is rewritten in the same pass — no more dangling refs left behind for the FrontmatterPanel to flag with a warning icon.",
        "Mermaid diagrams now render in chat: any ` ```mermaid ` fenced code block in an LLM reply renders as an SVG (lazy-loaded so the diagram engine is only fetched when first encountered). Click a diagram to enlarge with zoom controls; Esc to close.",
        "Wiki pages whose frontmatter was wrapped in a stray ```yaml … ``` code fence now render correctly: the orphan closing ``` no longer hijacks the body into one giant un-formatted code block.",
        "Windows: Claude Code CLI provider works again. Detection and chat spawn now resolve through the same path lookup (claude.cmd → claude.exe → claude), so Settings showing \"installed\" matches what chat can actually spawn.",
        "Fixed: switching the UI language in Settings → Interface, saving, then editing any other settings field and saving again no longer silently reverts the UI back to the previous language.",
        "All file-delete paths (Sources view source delete, Lint view orphan delete, Knowledge tree right-click) now use the same cleanup helper, so deleting via any of them gets the full sweep — no more inconsistent behaviour where one path cleaned wikilinks but left `related:` frontmatter pointing at the void.",
      ],
    },
  },
  {
    version: "0.4.5",
    date: "2026-04-30",
    highlights: {
      en: [
        "Settings → Network: global HTTP/HTTPS proxy with live apply (no app restart needed). Local addresses bypass the proxy by default so Ollama / LM Studio / LAN-deployed LLMs keep working.",
        "Settings → Maintenance: new \"Detect duplicate entities / concepts\" tool. The LLM scans every wiki page and surfaces likely-duplicate groups (English vs Chinese name, plural vs singular, abbreviation vs full form). You confirm each group before merging; merges run through a persistent serial queue with up to 3 automatic retries, survives app restart, and supports cancel / retry from the UI.",
        "Re-ingesting an entity / concept page that already exists now preserves earlier contributions: an LLM merge step combines old + new bodies instead of clobbering, with length / structure sanity checks and a backup snapshot on fallback.",
        "Frontmatter tags / related fields are now union-merged across re-ingests (previously only sources was protected — earlier-contributed tags and links silently disappeared).",
        "Wiki pages whose frontmatter was wrapped in a stray ```yaml … ``` code fence now render correctly: the orphan closing ``` no longer hijacks the body into one giant un-formatted code block.",
        "Better Claude Code CLI error reporting: the bare \"exit 1\" message is replaced by the actual subprocess stderr / unparsed stdout, so authentication failures and other startup errors are visible instead of opaque.",
        "Better diagnostic when a model produces lots of \"thinking\" text but never any answer (some Kimi / Qwen-style endpoints stream `reasoning` only and emit no `content` — previously this surfaced as \"analysis Not available\" with no clue why).",
      ],
    },
  },
  {
    version: "0.4.4",
    date: "2026-04-28",
    highlights: {
      en: [
        "Native ARM64 Linux builds — .deb and .AppImage now ship for aarch64 (Raspberry Pi, ARM cloud instances, Apple Silicon Linux VMs).",
        "Visual frontmatter panel for wiki pages: type-coded chips for entity / concept / query, clickable source and related cards that navigate directly to the linked file or page.",
        "Read-mode default for wiki pages — Obsidian-style [[wikilinks]] render as proper clickable links instead of raw bracketed text. Edit toggle in the top-right keeps the WYSIWYG editor available when needed.",
        "LLM-generated wiki pages no longer get wrapped in a stray ```yaml ... ``` code fence (prompt rewrite + write-time sanitizer + read-time fallback).",
        "IME composition Enter no longer triggers chat / search / research submit when typing under a Chinese / Japanese / Korean input method.",
        'Selecting Claude Code CLI provider in Settings (the "no API key" option) now works across ingest, sweep, lint, chat, sources, and the clip watcher — previously it failed with "LLM not configured" everywhere.',
      ],
    },
  },
  {
    version: "0.4.3",
    date: "2026-04-28",
    highlights: {
      en: [
        "Fixed Ollama connection failure when configured to a LAN-deployed instance (e.g. http://192.168.x.x:11434). The Origin header is now sent as http://localhost regardless of server address, so Ollama's default OLLAMA_ORIGINS allowlist accepts it.",
      ],
    },
  },
  {
    version: "0.4.2",
    date: "2026-04-28",
    highlights: {
      en: [
        "Project creation dialog now requires picking an AI output language up front — the previous Auto default surprised users with mixed-language output.",
        "Deleting a project actually removes it from the recent list now (previously the auto-open flow re-added it on next launch).",
      ],
    },
  },
  {
    version: "0.4.1",
    date: "2026-04-27",
    highlights: {
      en: [
        "Polished the update-available notification banner; the download link now opens in the system browser.",
        "Settings gear and About row keep showing a small red dot when an update is available, even after dismissing the top banner.",
      ],
    },
  },
  {
    version: "0.4.0",
    date: "2026-04-26",
    highlights: {
      en: [
        "Multimodal ingest: extract embedded images from PDF / docx / pptx and caption them with a vision model so the wiki page references each image with semantic alt text instead of empty placeholders.",
        "Image-aware search: results page splits into Pages and Images sections, clicking a thumbnail opens a lightbox and a Jump-to-source button navigates directly into the original document at the right location.",
        "Folder import + recursive cascade delete with two-stage inline confirmation (no more accidental folder loss from a single misclick).",
      ],
    },
  },
]

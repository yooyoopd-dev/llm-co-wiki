import type { WikiState } from "@/stores/wiki-store"

export function getAppLayoutVisibility(
  activeView: WikiState["activeView"],
): { showLeftPanel: boolean } {
  const isStandalone = activeView === "chat" || activeView === "skills" || activeView === "settings"
  return { showLeftPanel: !isStandalone }
}

import type { PanelInput } from "@opencode/plugin/tui/context";

export const PANEL_NAME = "agent-chat";

export interface PanelContent {
  readonly root: string;
  readonly total: number;
  readonly text: string;
}

/**
 * Renders the full transcript into the session.panel slot.
 * Renders nothing unless the panel is showing the agent-chat content, so the
 * claim coexists with any other panel content. The content accessor is read
 * on every render, so re-opening with fresh content re-renders (refresh).
 */
export function panelRender(content: () => PanelContent | null) {
  return (panel: PanelInput) => {
    if (panel.name !== PANEL_NAME) return null;
    const c = content();
    if (c === null) return null;
    return (
      <box style={{ width: "100%", height: "100%" }} flexDirection="column">
        <text>{`agent-chat transcript for ${c.root} · ${c.total} messages`}</text>
        <scrollbox style={{ flexGrow: 1 }}>
          <text>{c.text}</text>
        </scrollbox>
      </box>
    );
  };
}

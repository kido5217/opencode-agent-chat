import { jsx } from "@opentui/solid/jsx-runtime";
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
 *
 * This module is deliberately written without JSX syntax. The host loads
 * published plugins with Bun's default transform (the npm cache carries no
 * tsconfig), which compiles JSX to `react/jsx-dev-runtime` and fails the
 * plugin load. These `jsx()` calls are exactly what the package's own tsconfig
 * transform would emit, and they resolve against the host's OpenTUI/Solid
 * runtime, so no JSX transform — and no react — is involved.
 */
export function panelRender(content: () => PanelContent | null) {
  return (panel: PanelInput) => {
    if (panel.name !== PANEL_NAME) return null;
    const c = content();
    if (c === null) return null;
    return jsx("box", {
      style: { width: "100%", height: "100%" },
      flexDirection: "column",
      children: [
        jsx("text", {
          children: `agent-chat transcript for ${c.root} · ${c.total} messages`,
        }),
        jsx("box", {
          style: { height: 1 },
          children: jsx("text", { children: "esc to close" }),
        }),
        jsx("scrollbox", {
          style: { flexGrow: 1 },
          children: jsx("text", { children: c.text }),
        }),
      ],
    });
  };
}

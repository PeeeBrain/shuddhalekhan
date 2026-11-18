import type { AgentToolApprovalPolicy } from '@shuddhalekhan/shared/mcp';

/**
 * Computer Use: the agent operates desktop apps through their accessibility trees, via a
 * pinned agent-desktop binary that main installs on request. Desktop-only; iOS has no sidecar.
 * The model sees these tools as `native-computer__<name>`; policies use the existing
 * Ask each time / Always allow / Disabled values, keyed by the bare tool name.
 */
export const COMPUTER_USE_SOURCE_ID = 'native-computer';
export const COMPUTER_USE_VERSION = '1.3.1';

export type ComputerUseToolGroup = 'observe' | 'act' | 'apps' | 'clipboard';

/** The reviewed subset of the pinned agent-desktop MCP catalog the model may call. Order is display order. */
export const COMPUTER_USE_TOOLS = [
  { name: 'desktop_list_apps', group: 'observe', label: 'List running apps', defaultPolicy: 'alwaysAsk' },
  { name: 'desktop_list_windows', group: 'observe', label: 'List windows', defaultPolicy: 'alwaysAsk' },
  { name: 'desktop_snapshot', group: 'observe', label: 'Read a window', defaultPolicy: 'alwaysAsk' },
  { name: 'desktop_find', group: 'observe', label: 'Find elements', defaultPolicy: 'alwaysAsk' },
  { name: 'desktop_get', group: 'observe', label: 'Read an element', defaultPolicy: 'alwaysAsk' },
  { name: 'desktop_is', group: 'observe', label: 'Check element state', defaultPolicy: 'alwaysAsk' },
  { name: 'desktop_wait', group: 'observe', label: 'Wait for an element', defaultPolicy: 'alwaysAsk' },
  { name: 'desktop_click', group: 'act', label: 'Click', defaultPolicy: 'alwaysAsk' },
  { name: 'desktop_right_click', group: 'act', label: 'Open context menu', defaultPolicy: 'alwaysAsk' },
  { name: 'desktop_set_value', group: 'act', label: 'Set a field', defaultPolicy: 'alwaysAsk' },
  { name: 'desktop_type', group: 'act', label: 'Type text', defaultPolicy: 'alwaysAsk' },
  { name: 'desktop_clear', group: 'act', label: 'Clear a field', defaultPolicy: 'alwaysAsk' },
  { name: 'desktop_select', group: 'act', label: 'Choose an option', defaultPolicy: 'alwaysAsk' },
  { name: 'desktop_toggle', group: 'act', label: 'Toggle', defaultPolicy: 'alwaysAsk' },
  { name: 'desktop_check', group: 'act', label: 'Check', defaultPolicy: 'alwaysAsk' },
  { name: 'desktop_uncheck', group: 'act', label: 'Uncheck', defaultPolicy: 'alwaysAsk' },
  { name: 'desktop_expand', group: 'act', label: 'Expand', defaultPolicy: 'alwaysAsk' },
  { name: 'desktop_collapse', group: 'act', label: 'Collapse', defaultPolicy: 'alwaysAsk' },
  { name: 'desktop_scroll_to', group: 'act', label: 'Scroll into view', defaultPolicy: 'alwaysAsk' },
  { name: 'desktop_launch', group: 'apps', label: 'Run a program by name', defaultPolicy: 'alwaysAsk' },
  { name: 'desktop_close_app', group: 'apps', label: 'Quit an app (X11 apps only)', defaultPolicy: 'alwaysAsk' },
  { name: 'desktop_clipboard_get', group: 'clipboard', label: 'Read the clipboard', defaultPolicy: 'disabled' },
  { name: 'desktop_clipboard_set', group: 'clipboard', label: 'Write the clipboard', defaultPolicy: 'disabled' },
  { name: 'desktop_clipboard_clear', group: 'clipboard', label: 'Clear the clipboard', defaultPolicy: 'disabled' },
] as const satisfies ReadonlyArray<{ name: string; group: ComputerUseToolGroup; label: string; defaultPolicy: AgentToolApprovalPolicy }>;

export type ComputerUseToolName = typeof COMPUTER_USE_TOOLS[number]['name'];

/** Persisted under `agent.computerUse`. Off for every existing profile. */
export interface ComputerUseConfig {
  enabled: boolean;
  /** Keyed by bare tool name; a missing entry means the tool's `defaultPolicy`. */
  toolPolicies: Partial<Record<ComputerUseToolName, AgentToolApprovalPolicy>>;
}

export const DEFAULT_COMPUTER_USE_CONFIG: ComputerUseConfig = { enabled: false, toolPolicies: {} };

export function computerUseToolPolicy(config: ComputerUseConfig | undefined, name: ComputerUseToolName): AgentToolApprovalPolicy {
  return config?.toolPolicies[name] ?? COMPUTER_USE_TOOLS.find(tool => tool.name === name)!.defaultPolicy;
}

/** The managed binary's state, owned by main. Whether the agent may use it is `ComputerUseConfig.enabled`. */
export type ComputerUseStatus =
  | { state: 'unsupported'; reason: string }
  | { state: 'absent' }
  | { state: 'installing'; receivedBytes: number; totalBytes: number }
  | { state: 'installed'; version: string }
  | { state: 'failed'; reason: string };

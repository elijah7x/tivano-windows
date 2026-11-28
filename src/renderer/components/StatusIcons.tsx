// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-28.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// P2-73: distinct icon vocabulary matching macOS 3.0.24+ — Full access uses
// a shield-with-exclamation icon (`exclamationmark.shield`) while independent
// review uses a checkmark-seal icon (`checkmark.seal`).

import type { RuntimeMode } from "../../shared/types";

export const RUNTIME_MODE_SYMBOL: Record<RuntimeMode, string> = {
  supervised: "hand.raised",
  autoAcceptEdits: "pencil.line",
  auto: "wand.and.sparkles",
  fullAccess: "exclamationmark.shield",
};

export const HYDRA_REVIEW_SYMBOL = "checkmark.seal" as const;

interface IconProps {
  size?: number;
  label?: string;
  className?: string;
}

function iconA11y(label?: string): {
  role?: "img";
  "aria-label"?: string;
  "aria-hidden"?: true;
  focusable: "false";
} {
  if (label) {
    return { role: "img", "aria-label": label, focusable: "false" };
  }
  return { "aria-hidden": true, focusable: "false" };
}

function joinClass(base: string, extra?: string): string {
  return extra ? `${base} ${extra}` : base;
}

/** Shield with exclamation mark (`exclamationmark.shield`) for Full access. */
export function FullAccessShieldIcon(props: IconProps): React.JSX.Element {
  const size = props.size ?? 14;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      className={joinClass("status-icon full-access-shield-icon", props.className)}
      data-icon={RUNTIME_MODE_SYMBOL.fullAccess}
      {...iconA11y(props.label)}
    >
      <path
        d="M8 1.5L13.2 3.5v4.2c0 3.3-2.2 5.6-5.2 6.8-3-1.2-5.2-3.5-5.2-6.8V3.5L8 1.5Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path
        d="M8 5v3.7"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <circle cx="8" cy="11.1" r="0.8" fill="currentColor" />
    </svg>
  );
}

/** Scalloped seal with checkmark (`checkmark.seal`) for Independent review. */
export function CheckmarkSealIcon(props: IconProps): React.JSX.Element {
  const size = props.size ?? 14;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      className={joinClass("status-icon checkmark-seal-icon", props.className)}
      data-icon={HYDRA_REVIEW_SYMBOL}
      {...iconA11y(props.label)}
    >
      <path
        d="M6.05 3.29Q8 1.3 9.95 3.29Q12.7 3.3 12.71 6.05Q14.7 8 12.71 9.95Q12.7 12.7 9.95 12.71Q8 14.7 6.05 12.71Q3.3 12.7 3.29 9.95Q1.3 8 3.29 6.05Q3.3 3.3 6.05 3.29Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path
        d="M5.5 8.2l1.7 1.7 3.4-3.6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Per-mode icon matching macOS `RuntimeMode.symbol`. */
export function RuntimeModeIcon(
  props: IconProps & { mode: RuntimeMode },
): React.JSX.Element {
  const size = props.size ?? 14;
  const symbol = RUNTIME_MODE_SYMBOL[props.mode];
  if (props.mode === "fullAccess") {
    return (
      <FullAccessShieldIcon
        size={size}
        {...(props.label !== undefined ? { label: props.label } : {})}
        className={joinClass("runtime-mode-icon", props.className)}
      />
    );
  }
  if (props.mode === "supervised") {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 16 16"
        className={joinClass("status-icon runtime-mode-icon", props.className)}
        data-icon={symbol}
        {...iconA11y(props.label)}
      >
        <path
          d="M5 8V4.2a.8.8 0 0 1 1.6 0V7m0-3.5a.8.8 0 0 1 1.6 0V7m0-3a.8.8 0 0 1 1.6 0v3.5m0-2.3a.8.8 0 0 1 1.6 0V9.6A3.6 3.6 0 0 1 7.8 13.2H7.2A3.6 3.6 0 0 1 3.7 10.2L3 7.9a.8.8 0 0 1 1.5-.5L5 8.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.25"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (props.mode === "autoAcceptEdits") {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 16 16"
        className={joinClass("status-icon runtime-mode-icon", props.className)}
        data-icon={symbol}
        {...iconA11y(props.label)}
      >
        <path
          d="M9.8 2.8l2.4 2.4-6.4 6.4-2.8.5.5-2.8 6.3-6.5Z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.25"
          strokeLinejoin="round"
        />
        <path
          d="M3 13.5h10"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      className={joinClass("status-icon runtime-mode-icon", props.className)}
      data-icon={symbol}
      {...iconA11y(props.label)}
    >
      <path
        d="M3 13L11.5 4.5M10 3l1.5 1.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
      <path
        d="M5 3v2M4 4h2M12.5 9v2M11.5 10h2M7.5 1.8v1.4M6.8 2.5h1.4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

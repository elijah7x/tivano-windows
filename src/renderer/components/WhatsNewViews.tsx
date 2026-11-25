// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-24.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// P2-55: Settings › Version "Updated to" banner and expandable "What's new"
// row (upstream VersionSettingsPage.swift + WhatsNewViews.swift).

import { useState } from "react";
import type { LanguageId, Settings, WhatsNewDigest, WhatsNewInfo } from "../../shared/types";
import {
  RELEASE_NOTE_CATEGORIES,
  hasWhatsNewContent,
  isWhatsNewUnread,
  whatsNewSummaryLine,
  type ReleaseNoteCategory,
} from "../../shared/whatsNew";
import { useT } from "../locale";
import { tryCall } from "../client";

export const RELEASES_PAGE_URL = "https://github.com/elijah7x/tivano-windows/releases";

const CATEGORY_META: Record<
  ReleaseNoteCategory,
  { titleKey: string; color: string }
> = {
  newFeatures: { titleKey: "New features", color: "rgb(23, 112, 217)" },
  bugFixes: { titleKey: "Bug fixes", color: "rgb(230, 77, 61)" },
  refinements: { titleKey: "Refinements", color: "rgb(110, 59, 184)" },
};

export function selectWhatsNewDigest(
  info: WhatsNewInfo | undefined,
  language: LanguageId,
): WhatsNewDigest | undefined {
  if (!info) return undefined;
  return language === "zh-Hans" ? info["zh-Hans"] : info.en;
}

export function WhatsNewBanner(props: {
  digest: WhatsNewDigest;
  onView: () => void;
  onDismiss: () => void;
}): React.JSX.Element {
  const t = useT();
  const summary = whatsNewSummaryLine(props.digest, t);

  return (
    <div className="whatsnew-banner" role="region" aria-label={t("Updated to %@", props.digest.displayVersion)}>
      <div className="whatsnew-banner-icon" aria-hidden="true">
        <svg viewBox="0 0 20 20" width="16" height="16" fill="currentColor">
          <path d="M10 1.5l1.9 5.1 5.1 1.9-5.1 1.9L10 15.5l-1.9-5.1L3 8.5l5.1-1.9L10 1.5zm5.2 11.2l.8 2.1 2.1.8-2.1.8-.8 2.1-.8-2.1-2.1-.8 2.1-.8.8-2.1zM4.2 12.5l.6 1.5 1.5.6-1.5.6-.6 1.5-.6-1.5-1.5-.6 1.5-.6.6-1.5z" />
        </svg>
      </div>
      <div className="whatsnew-banner-text">
        <div className="whatsnew-banner-title">
          {t("Updated to %@", props.digest.displayVersion)}
        </div>
        {summary && <div className="whatsnew-banner-summary">{summary}</div>}
      </div>
      <div className="whatsnew-banner-actions">
        <button type="button" className="choice active" onClick={props.onView}>
          {t("View")}
        </button>
        <button
          type="button"
          className="icon-btn whatsnew-dismiss"
          aria-label={t("Dismiss")}
          title={t("Dismiss")}
          onClick={props.onDismiss}
        >
          ×
        </button>
      </div>
    </div>
  );
}

export function WhatsNewRow(props: {
  digest: WhatsNewDigest;
  expanded: boolean;
  onToggle: () => void;
  onOpenReleases: () => void;
}): React.JSX.Element {
  const t = useT();
  const summary = whatsNewSummaryLine(props.digest, t);
  const nonEmptyCategories = RELEASE_NOTE_CATEGORIES.filter(
    (category) => props.digest.categories[category].length > 0,
  );

  return (
    <div className="whatsnew-row-wrap">
      <button
        type="button"
        className="whatsnew-row-btn"
        aria-expanded={props.expanded}
        aria-label={`${t("What's new in %@", props.digest.displayVersion)} (${t(props.expanded ? "Expanded" : "Collapsed")})`}
        onClick={props.onToggle}
      >
        <div className="whatsnew-row-copy">
          <div className="whatsnew-row-title">
            {t("What's new in %@", props.digest.displayVersion)}
          </div>
          {summary && <div className="whatsnew-row-detail">{summary}</div>}
        </div>
        <span
          className={`whatsnew-chevron${props.expanded ? " open" : ""}`}
          aria-hidden="true"
        >
          ▸
        </span>
      </button>

      {props.expanded && (
        <div className="whatsnew-body">
          {nonEmptyCategories.map((category) => {
            const meta = CATEGORY_META[category];
            const bullets = props.digest.categories[category];
            return (
              <div key={category} className="whatsnew-cat">
                <div className="whatsnew-cat-head">
                  <span
                    className="whatsnew-cat-dot"
                    style={{ background: meta.color }}
                    aria-hidden="true"
                  />
                  <span>{t(meta.titleKey)}</span>
                </div>
                <ul className="whatsnew-bullets">
                  {bullets.map((bullet, idx) => (
                    <li key={idx}>{bullet}</li>
                  ))}
                </ul>
              </div>
            );
          })}
          <div className="whatsnew-footer">
            {props.digest.versionCount > 1 && props.digest.oldestIncludedVersion && (
              <>
                <span className="whatsnew-footer-note">
                  {t(
                    "Includes %d versions since %@",
                    String(props.digest.versionCount),
                    props.digest.oldestIncludedVersion,
                  )}
                </span>
                <span className="whatsnew-footer-sep" aria-hidden="true">
                  ·
                </span>
              </>
            )}
            <button
              type="button"
              className="whatsnew-releases-link"
              title={t("View all releases on GitHub")}
              onClick={props.onOpenReleases}
            >
              {t("All release notes")} ↗
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function VersionSection(props: {
  appVersion: string;
  settings: Settings;
  whatsNew?: WhatsNewInfo | undefined;
  initialExpanded?: boolean;
  onMarkSeen?: (version: string) => void;
  onOpenReleases?: () => void;
}): React.JSX.Element {
  const t = useT();
  const [expanded, setExpanded] = useState(props.initialExpanded ?? false);
  const digest = selectWhatsNewDigest(props.whatsNew, props.settings.language);
  const hasContent = hasWhatsNewContent(digest);
  const unread = isWhatsNewUnread(digest, props.settings);

  const markSeen = (version: string) => {
    if (props.onMarkSeen) props.onMarkSeen(version);
    else tryCall("settings:set", { whatsNewSeenVersion: version });
  };

  const openReleases = () => {
    if (props.onOpenReleases) props.onOpenReleases();
    else tryCall("links:open-external", { url: RELEASES_PAGE_URL });
  };

  return (
    <div className="version-section">
      <h3>{t("Version")}</h3>
      {unread && digest && (
        <WhatsNewBanner
          digest={digest}
          onView={() => {
            markSeen(digest.displayVersion);
            setExpanded(true);
          }}
          onDismiss={() => {
            markSeen(digest.displayVersion);
          }}
        />
      )}
      <div className="version-card" aria-label={t("Version information")}>
        <div className="version-card-head">
          <div className="version-card-name">{t("Tivano Windows")}</div>
          <div className="version-card-ver mono">
            {t("Version %@", props.appVersion)}
          </div>
        </div>
        {hasContent && digest && (
          <WhatsNewRow
            digest={digest}
            expanded={expanded}
            onToggle={() => setExpanded((v) => !v)}
            onOpenReleases={openReleases}
          />
        )}
      </div>
    </div>
  );
}

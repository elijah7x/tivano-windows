// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-27.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// P1-03 Storage diagnostics: displays total and cleanable sizes per
// in-scope diagnostics category, surfaces measurement failures honestly
// instead of 0 B, and guards each category's cleanup behind its own
// confirmation step.

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  StorageDiagnosticsCategoryId,
  StorageDiagnosticsCategoryUsage,
  StorageDiagnosticsResult,
} from "../../shared/types";
import { api } from "../client";
import { useT } from "../locale";

/** Format a byte count concisely: 0 B / 512 B / 12 KB / 1.2 MB / 1.2 GB. */
export function formatDiagnosticsBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  if (n >= 1024 * 1024 * 1024) return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${Math.round(n)} B`;
}

const CATEGORY_COPY: Record<
  StorageDiagnosticsCategoryId,
  {
    title: string;
    protection: string;
    confirmTitle: string;
    confirmMessage: string;
  }
> = {
  recovery: {
    title: "Recovery files",
    protection: "Keeps the newest recovery file and live store.",
    confirmTitle: "Clean up recovery files?",
    confirmMessage:
      "Deletes only older store and turn recovery backups. Keeps the newest recovery file. Chats, attachments, worktrees and the live store are not removed.",
  },
};

export interface StorageDiagnosticsViewProps {
  categories: StorageDiagnosticsCategoryUsage[] | null;
  measuring: boolean;
  cleaningId: StorageDiagnosticsCategoryId | null;
  confirmingId: StorageDiagnosticsCategoryId | null;
  loadError: string | null;
  cleanupErrors: Partial<Record<StorageDiagnosticsCategoryId, string>>;
  onRefresh: () => void;
  onRequestConfirm: (id: StorageDiagnosticsCategoryId) => void;
  onCancelConfirm: () => void;
  onConfirmClean: (id: StorageDiagnosticsCategoryId) => void;
}

export function StorageDiagnosticsView(props: StorageDiagnosticsViewProps): React.JSX.Element {
  const t = useT();
  const {
    categories,
    measuring,
    cleaningId,
    confirmingId,
    loadError,
    cleanupErrors,
    onRefresh,
    onRequestConfirm,
    onCancelConfirm,
    onConfirmClean,
  } = props;

  return (
    <div className="diagnostics-section" data-testid="diagnostics-section">
      <div className="diagnostics-head">
        <h3>{t("Diagnostics")}</h3>
        <button
          type="button"
          className="choice"
          data-testid="diagnostics-refresh"
          disabled={measuring || cleaningId !== null}
          onClick={onRefresh}
        >
          {t("Refresh")}
        </button>
      </div>

      {loadError !== null && (
        <p className="diagnostics-error" role="alert" data-testid="diagnostics-load-error">
          {t("Could not measure these files. Not included in the measured total. %@", loadError)}
        </p>
      )}

      {loadError === null && measuring && categories === null && (
        <p className="codex-note" role="status" data-testid="diagnostics-measuring">
          {t("Measuring…")}
        </p>
      )}

      {categories && categories.length > 0 && (
        <div className="diagnostics-card">
          {categories.map((cat) => {
            const copy = CATEGORY_COPY[cat.id];
            const isCleaning = cleaningId === cat.id;
            const canClean =
              !measuring &&
              cleaningId === null &&
              !cat.error &&
              cat.cleanableBytes > 0;
            const cleanupErr = cleanupErrors[cat.id];
            const isConfirming = confirmingId === cat.id;

            let statusNode: React.ReactNode;
            if (isCleaning) {
              statusNode = <span data-testid={`diagnostics-status-${cat.id}`}>{t("Cleaning up…")}</span>;
            } else if (measuring) {
              statusNode = <span data-testid={`diagnostics-status-${cat.id}`}>{t("Measuring…")}</span>;
            } else if (cat.error) {
              statusNode = (
                <span
                  className="diagnostics-error"
                  role="alert"
                  data-testid={`diagnostics-status-${cat.id}`}
                >
                  {t(
                    "Could not measure these files. Not included in the measured total. %@",
                    cat.error,
                  )}
                </span>
              );
            } else {
              const summary = t(
                "Total: %@ · Cleanable: %@",
                formatDiagnosticsBytes(cat.totalBytes),
                formatDiagnosticsBytes(cat.cleanableBytes),
              );
              const detailSuffix =
                cat.totalBytes === 0
                  ? t("No files found.")
                  : cat.cleanableBytes === 0
                    ? t("Nothing to clean up.")
                    : null;
              statusNode = (
                <span data-testid={`diagnostics-status-${cat.id}`}>
                  {summary}
                  {detailSuffix ? ` · ${detailSuffix}` : ""}
                </span>
              );
            }

            return (
              <div
                className="diagnostics-row-wrap"
                key={cat.id}
                data-testid={`diagnostics-row-${cat.id}`}
                data-category={cat.id}
              >
                <div className="diagnostics-row">
                  <div className="diagnostics-main">
                    <div className="diagnostics-title">{t(copy.title)}</div>
                    <div className="diagnostics-note">{t(copy.protection)}</div>
                    <div className="diagnostics-status">{statusNode}</div>
                    {cleanupErr && (
                      <div
                        className="diagnostics-error"
                        role="alert"
                        data-testid={`diagnostics-clean-error-${cat.id}`}
                      >
                        {t(
                          "Cleanup did not finish. Some files may already have been removed. %@",
                          cleanupErr,
                        )}
                      </div>
                    )}
                  </div>
                  <div className="diagnostics-actions">
                    <button
                      type="button"
                      className="choice"
                      data-testid={`diagnostics-clean-${cat.id}`}
                      disabled={!canClean}
                      onClick={() => onRequestConfirm(cat.id)}
                    >
                      {t("Clean up…")}
                    </button>
                  </div>
                </div>

                {isConfirming && (
                  <div
                    className="diagnostics-confirm"
                    role="alertdialog"
                    aria-label={t(copy.confirmTitle)}
                    data-testid={`diagnostics-confirm-${cat.id}`}
                  >
                    <div className="diagnostics-confirm-title">{t(copy.confirmTitle)}</div>
                    <p className="diagnostics-confirm-message">{t(copy.confirmMessage)}</p>
                    <div className="diagnostics-confirm-actions">
                      <button
                        type="button"
                        className="choice"
                        data-testid={`diagnostics-cancel-${cat.id}`}
                        onClick={onCancelConfirm}
                      >
                        {t("Cancel")}
                      </button>
                      <button
                        type="button"
                        className="choice danger"
                        data-testid={`diagnostics-confirm-btn-${cat.id}`}
                        disabled={!canClean}
                        onClick={() => onConfirmClean(cat.id)}
                      >
                        {t("Clean up")}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export async function runCleanDiagnosticsAction(params: {
  category: StorageDiagnosticsCategoryId;
  invokeClean: (category: StorageDiagnosticsCategoryId) => Promise<StorageDiagnosticsResult>;
  remeasure: () => Promise<void>;
  isCurrent: () => boolean;
  setConfirmingId: (id: StorageDiagnosticsCategoryId | null) => void;
  setCleaningId: (id: StorageDiagnosticsCategoryId | null) => void;
  setCategories: (categories: StorageDiagnosticsCategoryUsage[]) => void;
  setCleanupError: (category: StorageDiagnosticsCategoryId, error: string | null) => void;
}): Promise<void> {
  params.setConfirmingId(null);
  params.setCleaningId(params.category);
  params.setCleanupError(params.category, null);
  try {
    const res = await params.invokeClean(params.category);
    if (!params.isCurrent()) return;
    params.setCategories(res.categories);
    if (res.cleanupError) {
      params.setCleanupError(params.category, res.cleanupError);
    }
  } catch (err) {
    if (!params.isCurrent()) return;
    const msg = err instanceof Error ? err.message : String(err);
    params.setCleanupError(params.category, msg);
    // Clear cleaning state before awaiting remeasurement so a rejected IPC
    // never leaves the row stuck on "Cleaning up…" with Refresh disabled.
    params.setCleaningId(null);
    await params.remeasure();
  } finally {
    if (params.isCurrent()) params.setCleaningId(null);
  }
}

export function StorageDiagnosticsSection(): React.JSX.Element {
  const [categories, setCategories] = useState<StorageDiagnosticsCategoryUsage[] | null>(null);
  const [measuring, setMeasuring] = useState(true);
  const [cleaningId, setCleaningId] = useState<StorageDiagnosticsCategoryId | null>(null);
  const [confirmingId, setConfirmingId] = useState<StorageDiagnosticsCategoryId | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [cleanupErrors, setCleanupErrors] = useState<
    Partial<Record<StorageDiagnosticsCategoryId, string>>
  >({});
  const mounted = useRef(true);
  const measureGen = useRef(0);
  const cleanGen = useRef(0);

  const measure = useCallback(async () => {
    const id = ++measureGen.current;
    setMeasuring(true);
    setLoadError(null);
    try {
      const res = (await api().invoke("storage:diagnostics", {})) as StorageDiagnosticsResult;
      if (!mounted.current || measureGen.current !== id) return;
      setCategories(res.categories);
    } catch (err) {
      if (!mounted.current || measureGen.current !== id) return;
      setCategories(null);
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mounted.current && measureGen.current === id) setMeasuring(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void measure();
    return () => {
      mounted.current = false;
    };
  }, [measure]);

  const cleanCategory = async (category: StorageDiagnosticsCategoryId) => {
    const id = ++cleanGen.current;
    await runCleanDiagnosticsAction({
      category,
      invokeClean: (cat) =>
        api().invoke("storage:clean-diagnostics", { category: cat }) as Promise<StorageDiagnosticsResult>,
      remeasure: measure,
      isCurrent: () => mounted.current && cleanGen.current === id,
      setConfirmingId,
      setCleaningId,
      setCategories: (cats) => setCategories(cats),
      setCleanupError: (cat, err) =>
        setCleanupErrors((prev) => {
          const next = { ...prev };
          if (err === null) delete next[cat];
          else next[cat] = err;
          return next;
        }),
    });
  };

  return (
    <StorageDiagnosticsView
      categories={categories}
      measuring={measuring}
      cleaningId={cleaningId}
      confirmingId={confirmingId}
      loadError={loadError}
      cleanupErrors={cleanupErrors}
      onRefresh={() => void measure()}
      onRequestConfirm={(id) => setConfirmingId(id)}
      onCancelConfirm={() => setConfirmingId(null)}
      onConfirmClean={(id) => void cleanCategory(id)}
    />
  );
}

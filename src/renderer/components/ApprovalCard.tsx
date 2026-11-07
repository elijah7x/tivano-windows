// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-23.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// Approval card mirroring the frozen baseline's RequestCards: warning-tinted
// surface, headline, monospaced payload, Deny + allow-scope buttons.

import type { ApprovalRequest } from "../../shared/types";
import { useT } from "../locale";
import { tryCall } from "../client";

export function ApprovalCard(props: {
  threadId: string;
  approval: ApprovalRequest;
}): React.JSX.Element {
  const t = useT();
  const { approval } = props;
  const pending = approval.status === "pending";
  const resolvedTitle = approval.options.find(
    (o) => o.id === approval.resolvedOptionId,
  )?.title;

  const resolve = (optionId: string) =>
    tryCall("approvals:resolve", {
      threadId: props.threadId,
      approvalId: approval.id,
      optionId,
    });

  return (
    <section className="approval" role="group" aria-label={t(approval.headline)}>
      <div className="headline">{t(approval.headline)}</div>
      {approval.kind === "command" ? (
        <pre className="cmd">{approval.title}</pre>
      ) : (
        <p>{t(approval.title)}</p>
      )}
      {approval.detail && <p className="detail">{t(approval.detail)}</p>}
      {approval.reason && <p className="reason">{t(approval.reason)}</p>}
      {pending ? (
        <div className="actions">
          {[...approval.options].reverse().map((o) =>
            o.role === "approve" ? (
              <button key={o.id} className="primary" onClick={() => resolve(o.id)}>
                {t(o.title)}
              </button>
            ) : (
              <button key={o.id} onClick={() => resolve(o.id)}>
                {t(o.title)}
              </button>
            ),
          )}
        </div>
      ) : (
        <p className="resolved">
          {approval.status === "expired"
            ? t("Interrupted")
            : approval.autoResolved
              ? `${t(resolvedTitle ?? "Approved")} · ${t("Auto-approved by an earlier grant")}`
              : t(resolvedTitle ?? "Approved")}
        </p>
      )}
    </section>
  );
}

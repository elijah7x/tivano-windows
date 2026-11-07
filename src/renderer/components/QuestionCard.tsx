// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-28.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// Question card mirroring the frozen baseline's QuestionTab: one page per
// question, radio choices (single-select — the pinned protocol never sets
// allowsMultiple), an optional free-text "Other" field (masked for secret
// questions), Skip and Send. The card only ever submits the opaque
// providerKey it was shown plus bounded answer strings.

import { useMemo, useState } from "react";
import type { CodexQuestionRequest } from "../../shared/types";
import { useT } from "../locale";
import { tryCall } from "../client";

/** Frozen parity: a choice whose label reads "recommended" is preselected. */
const RECOMMENDED = /recommend/i;

export function QuestionCard(props: {
  threadId: string;
  question: CodexQuestionRequest;
}): React.JSX.Element {
  const t = useT();
  const { question } = props;
  const pending = question.status === "pending";
  const [index, setIndex] = useState(0);
  const [selections, setSelections] = useState<Record<string, string[]>>(() => {
    const seed: Record<string, string[]> = {};
    for (const q of question.questions) {
      const rec = q.choices.find((c) => RECOMMENDED.test(c.label));
      if (rec) seed[q.id] = [rec.label];
    }
    return seed;
  });
  const [written, setWritten] = useState<Record<string, string>>({});
  const [sent, setSent] = useState(false);

  const current = question.questions[Math.min(index, question.questions.length - 1)];
  const total = question.questions.length;
  const answered = useMemo(
    () =>
      question.questions.filter(
        (q) => (selections[q.id]?.length ?? 0) > 0 || (written[q.id] ?? "").trim().length > 0,
      ).length,
    [question.questions, selections, written],
  );

  const choose = (qid: string, label: string) =>
    setSelections((prev) => ({ ...prev, [qid]: [label] }));
  const write = (qid: string, text: string) =>
    setWritten((prev) => ({ ...prev, [qid]: text }));

  const submit = (skip: boolean) => {
    if (sent) return;
    const answers: Record<string, string[]> = {};
    if (!skip) {
      for (const q of question.questions) {
        const values = [...(selections[q.id] ?? [])];
        const text = (written[q.id] ?? "").trim();
        if (text) values.push(text);
        answers[q.id] = values;
      }
    }
    setSent(true);
    tryCall("questions:answer", {
      threadId: props.threadId,
      providerKey: question.providerKey,
      answers,
    });
  };

  if (!current) return <></>;

  return (
    <section className="approval question" role="group" aria-label={t("Codex asks a question")}>
      <div className="headline">
        {t("Codex asks a question")}
        {total > 1 && (
          <span className="qcount">
            {" · "}
            {index + 1}/{total}
            {` · ${t("answered")} ${answered}/${total}`}
          </span>
        )}
      </div>
      {pending && !sent ? (
        <div className="qbody">
          {total > 1 && (
            <div className="qnav">
              <button disabled={index === 0} onClick={() => setIndex(index - 1)}>
                ‹
              </button>
              <span className="qnav-title">{current.header || current.prompt.slice(0, 40)}</span>
              <button disabled={index >= total - 1} onClick={() => setIndex(index + 1)}>
                ›
              </button>
            </div>
          )}
          {current.header && <p className="qheader">{current.header}</p>}
          {current.prompt && <p className="qprompt">{current.prompt}</p>}
          {current.choices.length > 0 && (
            <div className="qchoices" role="radiogroup" aria-label={current.prompt || current.header}>
              {current.choices.map((c) => (
                <label key={c.label} className="qchoice">
                  <input
                    type="radio"
                    name={`q-${question.providerKey}-${current.id}`}
                    checked={(selections[current.id] ?? []).includes(c.label)}
                    onChange={() => choose(current.id, c.label)}
                  />
                  <span className="qlabel">{c.label}</span>
                  {c.detail && <span className="qdetail">{c.detail}</span>}
                </label>
              ))}
            </div>
          )}
          {(current.allowsOther || current.choices.length === 0) && (
            <input
              className="qother"
              type={current.isSecret ? "password" : "text"}
              placeholder={t("Other…")}
              value={written[current.id] ?? ""}
              onChange={(e) => write(current.id, e.target.value)}
            />
          )}
          <div className="actions">
            <button onClick={() => submit(true)}>{t("Skip")}</button>
            {index < total - 1 ? (
              <button className="primary" onClick={() => setIndex(index + 1)}>
                {t("Next")}
              </button>
            ) : (
              <button className="primary" onClick={() => submit(false)}>
                {t("Send")}
              </button>
            )}
          </div>
        </div>
      ) : (
        <p className="resolved">
          {question.status === "expired" && !sent
            ? t("Interrupted")
            : t("Sent — waiting for Codex")}
        </p>
      )}
    </section>
  );
}

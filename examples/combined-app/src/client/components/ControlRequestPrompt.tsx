import { useState, useRef, useEffect } from "react";
import type { ControlRequestInner, ControlRequestOfSubtype } from "@runloop/remote-agents-sdk/claude";
import type { PendingControlRequest, ControlRequestQuestion } from "../types.js";

export type ControlResponseData =
  | { behavior: "allow"; updatedInput?: unknown }
  | { behavior: "deny" };

function isCanUseTool(req: ControlRequestInner): req is ControlRequestOfSubtype<"can_use_tool"> {
  return req.subtype === "can_use_tool";
}

export function ControlRequestPrompt({
  request,
  onRespond,
}: {
  request: PendingControlRequest;
  onRespond: (requestId: string, response: ControlResponseData) => void;
}) {
  const isAskUser = request.toolName === "AskUserQuestion";

  if (isAskUser && request.questions.length > 0) {
    return (
      <AskUserQuestionForm
        request={request}
        onRespond={onRespond}
      />
    );
  }

  const handleAllow = () => {
    const innerRequest = request.rawRequest.request;
    const updatedInput = isCanUseTool(innerRequest)
      ? innerRequest.input
      : undefined;
    onRespond(request.requestId, {
      behavior: "allow",
      ...(updatedInput !== undefined && { updatedInput }),
    });
  };

  const handleDeny = () => {
    onRespond(request.requestId, { behavior: "deny" });
  };

  return (
    <div className="elicitation-form">
      <div className="elicitation-message">
        Permission requested: <strong>{request.toolName}</strong>
      </div>
      {request.questions.length > 0 && (
        <div className="control-request-questions">
          {request.questions.map((q, i) => (
            <div key={i} className="control-request-question">
              <div className="control-request-header">{q.header}</div>
              <div className="control-request-body">{q.question}</div>
            </div>
          ))}
        </div>
      )}
      <div className="permission-actions">
        <button className="btn permission-btn permission-btn-allow" onClick={handleAllow}>
          Allow
        </button>
        <button className="btn permission-btn permission-btn-reject" onClick={handleDeny}>
          Deny
        </button>
      </div>
    </div>
  );
}

function AskUserQuestionForm({
  request,
  onRespond,
}: {
  request: PendingControlRequest;
  onRespond: (requestId: string, response: ControlResponseData) => void;
}) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [selections, setSelections] = useState<Map<number, Set<string>>>(() => new Map());
  const [freeText, setFreeText] = useState<Map<number, string>>(() => new Map());
  const totalQuestions = request.questions.length;

  const toggleOption = (qIndex: number, label: string, multiSelect: boolean) => {
    setSelections((prev) => {
      const next = new Map(prev);
      const current = new Set(next.get(qIndex) ?? []);
      if (multiSelect) {
        current.has(label) ? current.delete(label) : current.add(label);
      } else {
        current.clear();
        current.add(label);
      }
      next.set(qIndex, current);
      return next;
    });
  };

  const updateFreeText = (qIndex: number, text: string) => {
    setFreeText((prev) => {
      const next = new Map(prev);
      next.set(qIndex, text);
      return next;
    });
  };

  const isQuestionAnswered = (i: number) => {
    const hasSelection = (selections.get(i)?.size ?? 0) > 0;
    const hasText = (freeText.get(i)?.trim().length ?? 0) > 0;
    return hasSelection || hasText;
  };

  const allAnswered = request.questions.every((_, i) => isQuestionAnswered(i));

  const handleSubmit = () => {
    const answers: Record<string, string> = {};
    request.questions.forEach((q, i) => {
      const text = freeText.get(i)?.trim();
      const selected = selections.get(i);
      if (text) {
        const selectedLabels = selected && selected.size > 0 ? Array.from(selected) : [];
        answers[q.question] = selectedLabels.length > 0
          ? `${selectedLabels.join(", ")}, ${text}`
          : text;
      } else if (selected && selected.size > 0) {
        answers[q.question] = Array.from(selected).join(", ");
      }
    });

    // updatedInput must still satisfy the tool's input schema (questions
    // requires >=1 items), so echo the original questions back with answers.
    const innerRequest = request.rawRequest.request;
    const originalInput = isCanUseTool(innerRequest) ? innerRequest.input : {};
    onRespond(request.requestId, {
      behavior: "allow",
      updatedInput: { ...originalInput, answers },
    });
  };

  const handleDeny = () => {
    onRespond(request.requestId, { behavior: "deny" });
  };

  const canGoNext = activeIndex < totalQuestions - 1 && isQuestionAnswered(activeIndex);
  const canGoBack = activeIndex > 0;
  const isLastQuestion = activeIndex === totalQuestions - 1;

  return (
    <div className="ask-form">
      {totalQuestions > 1 && (
        <div className="ask-form-progress">
          {request.questions.map((_, i) => (
            <button
              key={i}
              className={`ask-form-step ${i === activeIndex ? "active" : ""} ${isQuestionAnswered(i) ? "answered" : ""}`}
              onClick={() => setActiveIndex(i)}
              aria-label={`Question ${i + 1}`}
            >
              {isQuestionAnswered(i) ? (
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                  <path d="M2 5L4.5 7.5L8 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              ) : (
                <span>{i + 1}</span>
              )}
            </button>
          ))}
        </div>
      )}

      <div className="ask-form-carousel">
        {request.questions.map((q, qIndex) => (
          <div
            key={qIndex}
            className={`ask-form-slide ${qIndex === activeIndex ? "active" : ""}`}
            aria-hidden={qIndex !== activeIndex}
          >
            <QuestionCard
              question={q}
              selected={selections.get(qIndex) ?? new Set()}
              freeTextValue={freeText.get(qIndex) ?? ""}
              onToggle={(label) => toggleOption(qIndex, label, q.multiSelect)}
              onFreeTextChange={(text) => updateFreeText(qIndex, text)}
            />
          </div>
        ))}
      </div>

      <div className="ask-form-actions">
        {totalQuestions > 1 ? (
          <>
            <button
              className="btn btn-ghost"
              onClick={() => setActiveIndex((i) => i - 1)}
              disabled={!canGoBack}
            >
              Back
            </button>
            <div className="ask-form-actions-spacer" />
            {isLastQuestion ? (
              <button
                className="btn ask-form-submit"
                onClick={handleSubmit}
                disabled={!allAnswered}
              >
                Submit
              </button>
            ) : (
              <button
                className="btn ask-form-next"
                onClick={() => setActiveIndex((i) => i + 1)}
                disabled={!canGoNext}
              >
                Next
              </button>
            )}
            <button className="btn btn-ghost" onClick={handleDeny}>
              Dismiss
            </button>
          </>
        ) : (
          <>
            <button
              className="btn ask-form-submit"
              onClick={handleSubmit}
              disabled={!allAnswered}
            >
              Submit
            </button>
            <button className="btn btn-ghost" onClick={handleDeny}>
              Dismiss
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function QuestionCard({
  question,
  selected,
  freeTextValue,
  onToggle,
  onFreeTextChange,
}: {
  question: ControlRequestQuestion;
  selected: Set<string>;
  freeTextValue: string;
  onToggle: (label: string) => void;
  onFreeTextChange: (text: string) => void;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
    }
  }, [freeTextValue]);

  return (
    <div className="ask-card">
      {question.header && (
        <div className="ask-card-header">{question.header}</div>
      )}
      <div className="ask-card-question">{question.question}</div>
      {question.multiSelect && (
        <div className="ask-card-hint">Select all that apply</div>
      )}
      <div className="ask-card-options">
        {question.options.map((opt, i) => {
          const isSelected = selected.has(opt.label);
          return (
            <button
              key={opt.label}
              className={`ask-card-option ${isSelected ? "selected" : ""}`}
              onClick={() => onToggle(opt.label)}
            >
              <span className="ask-card-option-radio">
                {question.multiSelect ? (
                  <span className={`ask-card-checkbox ${isSelected ? "checked" : ""}`}>
                    {isSelected && (
                      <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                        <path d="M2 5L4.5 7.5L8 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                    )}
                  </span>
                ) : (
                  <span className={`ask-card-radio ${isSelected ? "checked" : ""}`} />
                )}
              </span>
              <span className="ask-card-option-body">
                <span className="ask-card-option-label">
                  {opt.label}
                  {i === 0 && !question.multiSelect && (
                    <span className="ask-card-recommended">Recommended</span>
                  )}
                </span>
                {opt.description && (
                  <span className="ask-card-option-desc">{opt.description}</span>
                )}
              </span>
            </button>
          );
        })}
      </div>
      <div className="ask-card-freetext">
        <textarea
          ref={textareaRef}
          className="ask-card-textarea"
          placeholder="Or type your own answer..."
          value={freeTextValue}
          onChange={(e) => onFreeTextChange(e.target.value)}
          rows={1}
        />
      </div>
    </div>
  );
}

import { useState } from "react";
import type { PendingUserInput, UserInputQuestion } from "../types.js";

interface QuestionAnswer {
  selected?: string;
  other: string;
}

// A question with no options must accept typed text even if isOther is unset,
// or it would be unanswerable.
function allowsFreeText(question: UserInputQuestion): boolean {
  return question.isOther || !question.options || question.options.length === 0;
}

function answerValue(question: UserInputQuestion, answer: QuestionAnswer | undefined): string | null {
  if (!answer) return null;
  if (answer.selected != null) return answer.selected;
  if (allowsFreeText(question) && answer.other.trim()) return answer.other.trim();
  return null;
}

export function UserInputPrompt({
  userInput,
  onRespond,
}: {
  userInput: PendingUserInput;
  onRespond: (requestId: string, answers: Record<string, string[]>) => void;
}) {
  const [answers, setAnswers] = useState<Record<string, QuestionAnswer>>({});

  const setAnswer = (questionId: string, patch: Partial<QuestionAnswer>) => {
    setAnswers((prev) => ({
      ...prev,
      [questionId]: { ...(prev[questionId] ?? { other: "" }), ...patch },
    }));
  };

  const complete = userInput.questions.every((q) => answerValue(q, answers[q.id]) != null);

  const submit = () => {
    const result: Record<string, string[]> = {};
    for (const q of userInput.questions) {
      const value = answerValue(q, answers[q.id]);
      if (value != null) result[q.id] = [value];
    }
    onRespond(userInput.requestId, result);
  };

  return (
    <div className="elicitation-form">
      {userInput.questions.map((q) => {
        const answer = answers[q.id];
        return (
          <div key={q.id} className="user-input-question">
            <div className="elicitation-message">
              <strong>{q.header}</strong> — {q.question}
            </div>
            {q.options && q.options.length > 0 && (
              <div className="permission-actions">
                {q.options.map((opt) => (
                  <button
                    key={opt.label}
                    className={`btn permission-btn ${
                      answer?.selected === opt.label ? "permission-btn-allow" : ""
                    }`}
                    title={opt.description}
                    onClick={() => setAnswer(q.id, { selected: opt.label, other: "" })}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            )}
            {allowsFreeText(q) && (
              <input
                className="elicitation-input"
                type={q.isSecret ? "password" : "text"}
                placeholder={q.options && q.options.length > 0 ? "Other…" : "Type your answer…"}
                value={answer?.other ?? ""}
                onChange={(e) =>
                  setAnswer(q.id, { other: e.target.value, selected: undefined })
                }
              />
            )}
          </div>
        );
      })}
      <div className="permission-actions">
        <button className="btn permission-btn permission-btn-allow" disabled={!complete} onClick={submit}>
          Submit
        </button>
      </div>
    </div>
  );
}

import type { PendingApproval } from "../types.js";

export function ApprovalPrompt({
  approval,
  onRespond,
}: {
  approval: PendingApproval;
  onRespond: (requestId: string, approve: boolean) => void;
}) {
  return (
    <div className="elicitation-form">
      <div className="elicitation-message">
        Approval requested: <strong>{approval.summary}</strong>
      </div>
      <pre className="permission-raw-input">
        {JSON.stringify(approval.rawRequest.params, null, 2)}
      </pre>
      <div className="permission-actions">
        <button
          className="btn permission-btn permission-btn-allow"
          onClick={() => onRespond(approval.requestId, true)}
        >
          Approve
        </button>
        <button
          className="btn permission-btn permission-btn-reject"
          onClick={() => onRespond(approval.requestId, false)}
        >
          Decline
        </button>
      </div>
    </div>
  );
}

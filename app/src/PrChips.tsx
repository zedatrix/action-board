import type { PrFeedItem } from "./feedTypes";
import { CI_LABEL, commentsText, labelTint, openReasons } from "./prFeed";

// GitHub review, check, label, comment and diff chips. Each chip conveys its meaning in text.
// Modeled on the row chips in Agent Board (MIT), LiveLists.tsx.
export function PrChips({ pr }: { pr: PrFeedItem }) {
  const reasons = openReasons(pr);
  return (
    <span className="pr-chips">
      {reasons.map((r) => (
        <span key={r} className="chip reason-chip">
          {r}
        </span>
      ))}
      {pr.ci !== "none" && <span className={`chip ci-chip ci-${pr.ci}`}>{CI_LABEL[pr.ci]}</span>}
      {pr.labels.map((l) => (
        <span key={l.name} className="chip label-chip" style={labelTint(l.color)}>
          {l.name}
        </span>
      ))}
      {pr.comments > 0 && <span className="chip comments-chip">{commentsText(pr.comments)}</span>}
      {pr.additions + pr.deletions > 0 && (
        <span className="chip lines-chip" aria-label={`${pr.additions} lines added, ${pr.deletions} removed`}>
          <span className="add">+{pr.additions}</span> <span className="del">{`−${pr.deletions}`}</span>
        </span>
      )}
    </span>
  );
}

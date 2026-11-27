import { githubUrl, type PrFeedItem, type PrReviewer } from "./feedTypes";
import { reviewerName } from "./prFeed";

const REVIEW_STATES = {
  CHANGES_REQUESTED: { order: 0, label: "changes requested" },
  REQUESTED: { order: 1, label: "review requested" },
  COMMENTED: { order: 2, label: "commented" },
  APPROVED: { order: 3, label: "approved" },
  DISMISSED: { order: 4, label: "dismissed" },
};

function reviewerLine(r: PrReviewer): string {
  const notes: string[] = [];
  if (!r.on_head && r.commit) notes.push(`on older head ${r.commit}`);
  if (r.requested && r.state !== "REQUESTED") notes.push("re-review requested");
  return `${reviewerName(r.login)}: ${REVIEW_STATES[r.state].label}${notes.length ? ` (${notes.join(", ")})` : ""}`;
}

// GitHub text is escaped by React. The thread list is modeled on LiveLists.tsx in Agent Board (MIT).
export function PrDetail({ pr, id }: { pr: PrFeedItem; id: string }) {
  const reviewers = [...pr.reviewers].sort((a, b) => REVIEW_STATES[a.state].order - REVIEW_STATES[b.state].order);
  const showThreads = pr.unresolved_count > 0 || pr.unresolved_more;
  const more = pr.unresolved_count - pr.unresolved.length;
  return (
    <div className="pr-detail" id={id}>
      {reviewers.length > 0 && (
        <>
          <h4>Reviewers</h4>
          <ul className="pr-reviewers">
            {reviewers.map((r) => <li key={r.login}>{reviewerLine(r)}</li>)}
          </ul>
        </>
      )}
      {showThreads && (
        <>
          <h4>
            Open threads{" "}
            <span className="n">
              {pr.unresolved_count}
              {pr.unresolved_more ? "+" : ""}
            </span>
          </h4>
          <ul className="pr-threads">
            {pr.unresolved.map((t, i) => {
              const url = githubUrl(t.url);
              return (
                <li key={i}>
                  <p className="pr-thread-head">
                    <b>{t.author || "someone"}</b> on <code>{t.path || "the PR"}</code>
                    {url && (
                      <>
                        {" · "}
                        <a href={url} target="_blank" rel="noopener noreferrer">
                          View on GitHub
                        </a>
                      </>
                    )}
                  </p>
                  <p className="pr-text">{t.body}</p>
                </li>
              );
            })}
          </ul>
          {more > 0 && <p className="pr-empty">{more} more on GitHub.</p>}
        </>
      )}
      {reviewers.length === 0 && !showThreads && <p className="pr-empty">No human reviews or open threads.</p>}
    </div>
  );
}

import { normalizePr } from "../server/feed";
import type { PrFeed } from "../src/feedTypes";
import fixture from "../test/fixtures/sample-pr.json";

const at = new Date().toISOString();
const { viewer, pullRequest, threadNodes } = fixture;
const comments = new Map(threadNodes.map(({ id, comments }) => [id, comments.nodes[0]]));

export const samplePrFeed: PrFeed = {
  fetched_at: at,
  github: { ok: true, login: viewer.login, error: null, last_ok: at },
  rate_limit: null,
  prs: [normalizePr(pullRequest, viewer.login, comments)],
};

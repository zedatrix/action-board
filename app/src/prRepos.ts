// Accept only complete owner/repo names before using them in a GitHub search.
export function parsePrRepos(value: string | undefined): string[] {
  return [...new Set((value ?? "").toLowerCase().split(",").map((repo) => repo.trim())
    .filter((repo) => /^[a-z0-9-]+\/[a-z0-9._-]+$/.test(repo)))];
}

export const GITHUB_PULL_URL = /^https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+\/pull\/\d+\/?(?:[?#]\S*)?$/;

#!/usr/bin/env bash
# Publishes what sync-data.mjs wrote. Run by .github/workflows/sync-data.yml.
#
#   publish-sync.sh publish <report-file>   commit to main, which deploys the site
#   publish-sync.sh review <report-file>    leave the live site alone and ask for a review
set -euo pipefail

status=$1
report=$2
review_branch=data-sync-review
data_paths=(fusion-data.json craft-recipes.json enchants.json game-data.json data-manifest.json shardIcons)

git config user.name 'github-actions[bot]'
git config user.email '41898282+github-actions[bot]@users.noreply.github.com'
git add "${data_paths[@]}"

if git diff --cached --quiet; then
    echo 'Nothing to publish.'
    exit 0
fi

open_review_pr() {
    gh pr list --head "$review_branch" --state open --json number --jq '.[0].number // empty'
}

if [ "$status" = publish ]; then
    git commit -F "$report"
    git pull --rebase origin main
    git push origin HEAD:main

    # A newer good sync makes any review still waiting out of date.
    stale_pr=$(open_review_pr)
    if [ -n "$stale_pr" ]; then
        gh pr close "$stale_pr" --delete-branch --comment 'Closed automatically: a newer data sync passed its checks and went live.'
    fi
    exit 0
fi

git switch -C "$review_branch"
git commit -F "$report"
git push --force origin "$review_branch"

if [ -n "$(open_review_pr)" ]; then
    echo 'Updated the review PR that was already open.'
    exit 0
fi

title='Data sync needs review'
if gh pr create --base main --head "$review_branch" --title "$title" --body-file "$report"; then
    exit 0
fi

# GitHub stops Actions opening PRs unless that's enabled in the repo settings, so fall back to an issue.
if [ -z "$(gh issue list --state open --search "\"$title\" in:title" --json number --jq '.[0].number // empty')" ]; then
    compare="https://github.com/${GITHUB_REPOSITORY}/compare/main...${review_branch}?expand=1"
    {
        echo "The new data was held back from the live site. [Review and open a PR]($compare)."
        echo
        cat "$report"
    } | gh issue create --title "$title" --body-file -
fi

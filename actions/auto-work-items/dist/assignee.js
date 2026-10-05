"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveLatestCommitAssignee = resolveLatestCommitAssignee;
exports.syncAssignee = syncAssignee;
const utils_1 = require("./utils");
async function resolveLatestCommitAssignee({ github, core, config, }) {
    try {
        const { data: commits } = await github.rest.repos.listCommits({
            owner: config.owner,
            repo: config.repo,
            sha: config.branch,
            per_page: 1,
        });
        const latest = commits[0];
        if (!latest) {
            core.warning(`No commits found for branch '${config.branch}'. Skipping assignee sync.`);
            return null;
        }
        const assignee = latest.author?.login || latest.committer?.login || null;
        if (!assignee) {
            core.warning(`Latest commit on branch '${config.branch}' has no linked GitHub user. Skipping assignee sync.`);
            return null;
        }
        return assignee;
    }
    catch (error) {
        core.warning(`Could not resolve latest commit author: ${(0, utils_1.getErrorMessage)(error)}`);
        return null;
    }
}
async function syncAssignee({ github, core, config, issueNumber, assignee, }) {
    if (!assignee)
        return;
    try {
        await github.rest.issues.update({
            owner: config.owner,
            repo: config.repo,
            issue_number: issueNumber,
            assignees: [assignee],
        });
    }
    catch (error) {
        core.warning(`Could not set assignee '${assignee}' on #${issueNumber}: ${(0, utils_1.getErrorMessage)(error)}`);
    }
}

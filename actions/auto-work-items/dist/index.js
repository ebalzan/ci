"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const assignee_1 = require("./assignee");
const config_1 = require("./config");
const describe_1 = require("./describe");
const issue_1 = require("./issue");
const labels_1 = require("./labels");
const milestone_1 = require("./milestone");
const pr_1 = require("./pr");
const project_1 = require("./project");
const sharedVars_1 = require("./sharedVars");
async function runAutoWorkItems({ github, context, core, }) {
    (0, sharedVars_1.applySharedVars)({ core, env: process.env });
    const config = (0, config_1.buildConfig)({ context, core, env: process.env });
    if (config.skip)
        return;
    await (0, labels_1.ensureLabels)({
        github,
        core,
        config,
        labels: Array.from(new Set([...config.issueLabels, ...config.prLabels])),
    });
    const milestoneNumber = await (0, milestone_1.resolveMilestoneNumber)({ github, core, config });
    const digest = await (0, describe_1.collectBranchDigest)({ github, core, config });
    const description = digest ? await (0, describe_1.generateDescription)({ core, config, digest }) : null;
    const issue = await (0, issue_1.upsertIssue)({ github, core, config, milestoneNumber, description });
    const pr = await (0, pr_1.upsertPr)({
        github,
        core,
        config,
        issueNumber: issue.number,
        milestoneNumber,
        description,
    });
    const assignee = await (0, assignee_1.resolveLatestCommitAssignee)({ github, core, config });
    await (0, assignee_1.syncAssignee)({ github, core, config, issueNumber: issue.number, assignee });
    await (0, assignee_1.syncAssignee)({ github, core, config, issueNumber: pr.number, assignee });
    await (0, project_1.syncProjectMetadata)({ github, core, config, issue, pr });
    core.notice(`Issue #${issue.number} and PR #${pr.number} are synced for branch '${config.branch}'.`);
}
exports.default = runAutoWorkItems;

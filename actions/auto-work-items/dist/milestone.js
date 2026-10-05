"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveMilestoneNumber = resolveMilestoneNumber;
const utils_1 = require("./utils");
async function resolveMilestoneNumber({ github, core, config, }) {
    const milestoneNumberRaw = (config.env.AUTO_MILESTONE_NUMBER || '').trim();
    if (milestoneNumberRaw) {
        const n = Number(milestoneNumberRaw);
        if (!Number.isInteger(n) || n <= 0) {
            core.warning(`Invalid AUTO_MILESTONE_NUMBER '${milestoneNumberRaw}'. Use a positive integer, or unset AUTO_MILESTONE_NUMBER and set AUTO_MILESTONE_TITLE.`);
        }
        try {
            const { data: milestone } = await github.rest.issues.getMilestone({
                owner: config.owner,
                repo: config.repo,
                milestone_number: n,
            });
            if ((milestone.state || '').toLowerCase() !== 'open') {
                core.warning(`AUTO_MILESTONE_NUMBER '${n}' points to closed milestone '${milestone.title}'. Use an open milestone, or unset AUTO_MILESTONE_NUMBER and set AUTO_MILESTONE_TITLE.`);
            }
            return n;
        }
        catch (error) {
            if ((0, utils_1.getErrorStatus)(error) === 404) {
                core.warning(`AUTO_MILESTONE_NUMBER '${n}' was not found in ${config.owner}/${config.repo}. Set a valid milestone number, or unset AUTO_MILESTONE_NUMBER and set AUTO_MILESTONE_TITLE.`);
            }
            core.warning(`Could not resolve milestone number '${n}': ${(0, utils_1.getErrorMessage)(error)}`);
        }
    }
    const milestoneTitle = (config.env.AUTO_MILESTONE_TITLE || '').trim();
    if (!milestoneTitle)
        return null;
    const { data: milestones } = await github.rest.issues.listMilestones({
        owner: config.owner,
        repo: config.repo,
        state: 'all',
        per_page: 100,
    });
    const match = milestones.find(milestone => milestone.title.trim().toLowerCase() === milestoneTitle.toLowerCase());
    if (!match) {
        core.warning(`AUTO_MILESTONE_TITLE '${milestoneTitle}' was not found in ${config.owner}/${config.repo}.`);
    }
    if (match && (match.state || '').toLowerCase() !== 'open') {
        core.warning(`AUTO_MILESTONE_TITLE '${milestoneTitle}' points to a closed milestone.`);
    }
    return match?.number || null;
}

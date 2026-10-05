"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ensureLabels = ensureLabels;
const config_1 = require("./config");
const utils_1 = require("./utils");
const PRIORITY_COLOR_MAP = {
    p0: 'B60205',
    p1: 'D93F0B',
    p2: 'FBCA04',
    p3: '0E8A16',
    p4: '1D76DB',
};
const DEFAULT_LABEL_COLORS = [
    'B60205',
    'D93F0B',
    'FBCA04',
    '0E8A16',
    '1D76DB',
    '5319E7',
    '0052CC',
    'C5DEF5',
    'E99695',
    'F9D0C4',
    'C2E0C6',
];
function normalizeLabelColor(color) {
    return color.replace('#', '').trim().toUpperCase();
}
function buildTypeDefinitions() {
    const definitions = {};
    for (const type of Object.values(config_1.TYPE_CONFIG)) {
        if (!definitions[type.label]) {
            definitions[type.label] = {
                color: normalizeLabelColor(type.color),
                description: `Changes for '${type.prefix}' branches`,
            };
        }
    }
    return definitions;
}
function hashText(value) {
    let hash = 0;
    for (const char of value) {
        hash = (hash * 31 + char.charCodeAt(0)) % 2147483647;
    }
    return Math.abs(hash);
}
function resolveDefaultLabelColor(label) {
    const normalized = label.trim().toLowerCase();
    const priorityMatch = normalized.match(/^priority:\s*(p[0-4])$/) ?? normalized.match(/^(p[0-4])$/);
    if (priorityMatch) {
        return PRIORITY_COLOR_MAP[priorityMatch[1]];
    }
    return DEFAULT_LABEL_COLORS[hashText(normalized) % DEFAULT_LABEL_COLORS.length];
}
async function ensureLabel({ github, core, owner, repo, name, color, description, }) {
    const normalizedColor = normalizeLabelColor(color);
    try {
        const { data: existingLabel } = await github.rest.issues.getLabel({ owner, repo, name });
        const existingColor = normalizeLabelColor(existingLabel.color);
        const existingDescription = (existingLabel.description || '').trim();
        if (existingColor !== normalizedColor || existingDescription !== description) {
            await github.rest.issues.updateLabel({
                owner,
                repo,
                name,
                color: normalizedColor,
                description,
            });
            core.info(`Updated label '${name}'`);
        }
    }
    catch (error) {
        if ((0, utils_1.getErrorStatus)(error) === 404) {
            try {
                await github.rest.issues.createLabel({
                    owner,
                    repo,
                    name,
                    color: normalizedColor,
                    description,
                });
                core.info(`Created label '${name}'`);
            }
            catch (createError) {
                // Another concurrent run may create the label first.
                if ((0, utils_1.getErrorStatus)(createError) !== 422) {
                    throw createError;
                }
            }
            return;
        }
        throw error;
    }
}
async function ensureLabels({ github, core, config, labels, }) {
    const definitions = {
        ...buildTypeDefinitions(),
        [config.typeLabel]: {
            color: config.selectedType.color,
            description: `Changes for '${config.branchType}' branches`,
        },
    };
    for (const label of labels) {
        const definition = definitions[label] || {
            color: resolveDefaultLabelColor(label),
            description: 'Managed label',
        };
        await ensureLabel({
            github,
            core,
            owner: config.owner,
            repo: config.repo,
            name: label,
            color: definition.color,
            description: definition.description,
        });
    }
}

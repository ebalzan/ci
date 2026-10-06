"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseEnvFile = parseEnvFile;
exports.applyRepoVars = applyRepoVars;
exports.applySharedVars = applySharedVars;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
// The shared variables, read from the copy of tracebim-ci the runner downloaded
// for `uses: ebalzan/tracebim-ci/actions/auto-work-items@<ref>` (the whole repo
// at that ref; dist/ → auto-work-items/ → actions/ → repo root). Nothing copies
// them onto the calling repos, so a shared value changes by moving the ref.
// scripts/release/promote-dev-to-main.mjs reads the same file the same way.
const SHARED_VARS_FILE = (0, node_path_1.join)(__dirname, '..', '..', '..', 'config', 'actions.env');
// KEY=VALUE lines; blank lines and `#` comments skipped, one pair of
// surrounding quotes stripped — the dotenv subset bin/_lib.sh reads.
function parseEnvFile(text) {
    const vars = {};
    for (const line of text.split(/\r?\n/)) {
        if (/^\s*(#|$)/.test(line))
            continue;
        const i = line.indexOf('=');
        if (i < 1)
            continue;
        let value = line.slice(i + 1);
        if (value.length >= 2 && /^(["']).*\1$/.test(value))
            value = value.slice(1, -1);
        vars[line.slice(0, i).trim()] = value;
    }
    return vars;
}
// The caller repo's variables, passed whole by the workflows as
// `REPO_VARS_JSON: ${{ toJSON(vars) }}` — so a repo can set any AUTO_* knob,
// including ones added later, without a workflow edit. Only AUTO_* keys are
// taken; a key the job env already sets (AUTO_BASE_BRANCH, from an input) wins.
function applyRepoVars({ core, env, }) {
    const raw = (env.REPO_VARS_JSON ?? '').trim();
    if (!raw)
        return;
    let vars;
    try {
        vars = JSON.parse(raw);
    }
    catch {
        core.warning('REPO_VARS_JSON is not valid JSON; ignoring repo variables.');
        return;
    }
    if (!vars || typeof vars !== 'object' || Array.isArray(vars))
        return;
    const applied = [];
    for (const [key, value] of Object.entries(vars)) {
        if (!key.startsWith('AUTO_') || typeof value !== 'string' || !value.trim())
            continue;
        if ((env[key] ?? '').trim())
            continue;
        env[key] = value;
        applied.push(key);
    }
    if (applied.length > 0) {
        core.info(`Repo variables: ${applied.join(', ')}`);
    }
}
// Repo variables first, then every AUTO_* knob still unset from
// config/actions.env. A repo variable always wins; the code defaults still
// apply to keys neither layer sets.
function applySharedVars({ core, env, file = SHARED_VARS_FILE, }) {
    applyRepoVars({ core, env });
    if (!(0, node_fs_1.existsSync)(file)) {
        core.warning(`Shared variables file not found at ${file}; using repo variables only.`);
        return;
    }
    const applied = [];
    for (const [key, value] of Object.entries(parseEnvFile((0, node_fs_1.readFileSync)(file, 'utf8')))) {
        if ((env[key] ?? '').trim())
            continue;
        env[key] = value;
        applied.push(key);
    }
    if (applied.length > 0) {
        core.info(`Shared variables from config/actions.env: ${applied.join(', ')}`);
    }
}

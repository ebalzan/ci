"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseCsv = parseCsv;
exports.parseJsonMap = parseJsonMap;
exports.isRecord = isRecord;
exports.getErrorStatus = getErrorStatus;
exports.getErrorMessage = getErrorMessage;
exports.getErrorList = getErrorList;
exports.asDateOffset = asDateOffset;
exports.toISODate = toISODate;
exports.addDays = addDays;
exports.normalizeScope = normalizeScope;
function parseCsv(value) {
    if (!value)
        return [];
    return value
        .split(/[\n,;]+/)
        .map(s => s.trim())
        .filter(Boolean);
}
function parseJsonMap(value, warn, variableName = 'AUTO_PRIORITY_MAP_JSON') {
    if (!value)
        return {};
    try {
        const parsed = JSON.parse(value);
        if (!isRecord(parsed))
            return {};
        const mapped = {};
        for (const [key, rawValue] of Object.entries(parsed)) {
            if (typeof rawValue === 'string') {
                mapped[key] = rawValue;
            }
        }
        return mapped;
    }
    catch (error) {
        const message = getErrorMessage(error);
        warn(`Invalid ${variableName}, ignoring. ${message}`);
        return {};
    }
}
function isRecord(value) {
    return typeof value === 'object' && value !== null;
}
function getErrorStatus(error) {
    if (!isRecord(error))
        return undefined;
    return typeof error.status === 'number' ? error.status : undefined;
}
function getErrorMessage(error) {
    if (error instanceof Error)
        return error.message;
    return String(error);
}
function getErrorList(error) {
    if (!isRecord(error))
        return [];
    return Array.isArray(error.errors) ? error.errors : [];
}
function asDateOffset(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}
function toISODate(date) {
    const yyyy = date.getUTCFullYear();
    const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(date.getUTCDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
}
function addDays(date, days) {
    const next = new Date(date.getTime());
    next.setUTCDate(next.getUTCDate() + days);
    return next;
}
function normalizeScope(value) {
    return value.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
}

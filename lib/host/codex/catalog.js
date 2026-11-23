import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
/**
 * `/responses` 端点认的强度词表。
 *
 * 2026-11-23 实测：目录缓存（Codex CLI 写的 models_cache.json）里给一半型号标了
 * `ultra`，端点一律不认，回 400 `invalid_request_error`
 * （"Invalid value: 'ultra'. Supported values are: 'none', 'minimal', 'low',
 * 'medium', 'high', 'xhigh', and 'max'."）。缓存比端点新，不等于端点认了它——
 * 把 `ultra` 摆进选择器，用户一点就报错。
 *
 * `none` / `minimal` 只有部分型号认（实测 gpt-6-luna 认 none、三个型号都不认
 * minimal），所以按词表过滤之后还要按型号：哪个型号给，就用哪个型号给的。
 */
export const API_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
/**
 * Load the model catalog from `~/.codex/models_cache.json`.
 * Filters to visible, API-supported models, and to the efforts the endpoint accepts.
 *
 * Falls back to {@link BUILTIN_MODELS} when the cache is missing or malformed:
 * the CLI rewrites that file in place, so a read can land mid-write. An empty
 * list would empty the runtime ledger, drop the current model out of the
 * catalog, and leave the composer without a reasoning axis.
 */
export async function loadCatalog(options) {
    const home = options?.home ?? homedir();
    const cachePath = join(home, '.codex', 'models_cache.json');
    let raw;
    try {
        raw = await readFile(cachePath, 'utf8');
    }
    catch {
        return BUILTIN_MODELS;
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        return BUILTIN_MODELS;
    }
    if (!Array.isArray(parsed.models))
        return BUILTIN_MODELS;
    const models = parsed.models
        .filter(m => m.visibility === 'list' && m.supported_in_api === true && m.slug)
        .map(m => ({
        id: m.slug,
        name: m.display_name ?? m.slug,
        description: m.description,
        contextWindow: m.context_window ?? 0,
        efforts: (m.supported_reasoning_levels ?? [])
            .map(l => l.effort)
            .filter((e) => e !== undefined && API_EFFORTS.includes(e)),
    }));
    // 缓存里一个可见型号都没有：多半是文件正在被改写，别把清单清空。
    return models.length > 0 ? models : BUILTIN_MODELS;
}
/**
 * Static fallback model list — verified from the 2026-11-10 investigation.
 * Used when models_cache.json is unavailable.
 *
 * The efforts here are the ones the endpoint accepts for every model
 * (see {@link API_EFFORTS}); the older per-variant split is gone with `ultra`.
 */
const FULL_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
export const BUILTIN_MODELS = [
    { id: 'gpt-6.1-sol', name: 'GPT-6.1-Sol', description: '最新旗舰 · 500k 上下文', contextWindow: 500000, efforts: FULL_EFFORTS },
    { id: 'gpt-6.1-terra', name: 'GPT-6.1-Terra', contextWindow: 500000, efforts: FULL_EFFORTS },
    { id: 'gpt-6-astra', name: 'GPT-6-Astra', contextWindow: 272000, efforts: FULL_EFFORTS },
    { id: 'gpt-6-sol', name: 'GPT-6-Sol', contextWindow: 272000, efforts: FULL_EFFORTS },
    { id: 'gpt-6-luna', name: 'GPT-6-Luna', contextWindow: 272000, efforts: FULL_EFFORTS },
    { id: 'gpt-5.6-sol', name: 'GPT-5.6-Sol', contextWindow: 272000, efforts: FULL_EFFORTS },
    { id: 'gpt-5.6-terra', name: 'GPT-5.6-Terra', contextWindow: 272000, efforts: FULL_EFFORTS },
    { id: 'gpt-5.6-luna', name: 'GPT-5.6-Luna', contextWindow: 272000, efforts: FULL_EFFORTS },
];

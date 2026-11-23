/**
 * 用户勾了哪些 Codex 模型。
 *
 * 勾选结果落在 `${DSH_HOME}/codex/selection.json`（与 dsh-qoder 同一套规矩：
 * 有文件就以它为准，没有就用默认那一份——「装上就有默认的一套，用户可以在设置里改」）。
 *
 * 内存里留一份快照：模型行发布清单是同步路径（`modelsFor`），而读文件是异步的；
 * 设置里改完勾选要立刻生效，所以改完既落盘也换快照，再让模型行重新发布一次。
 */
import { readSelection, writeSelection, clearSelection } from "../modelkit/selection.js";
/** 勾选结果的作用域（决定落盘路径：`${DSH_HOME}/codex/selection.json`）。 */
export const CODEX_SELECTION_SCOPE = 'codex';
/**
 * 当前生效的勾选。
 *
 * `undefined` = 用户没勾过（用默认那一份，全都在）；
 * 数组 = 用户勾的那几个（可能为空数组：一个都不选）。
 */
let current;
/**
 * 读出当前勾选（内存快照；还没加载过是 undefined）。
 */
export function currentSelection() {
    return current;
}
/**
 * 把勾选写进内存快照（不落盘）。
 * @param ids - 用户勾的 id；`undefined` 表示回到默认那一份。
 */
export function setCurrentSelection(ids) {
    current = ids === undefined ? undefined : [...ids];
}
/**
 * 从磁盘把勾选读进内存快照。
 *
 * 开机时调一次：模型行第一次发布清单之前就该知道用户勾了哪些。
 * @returns 读到的勾选；没有文件是 `undefined`。
 */
export async function loadSelection() {
    const stored = await readSelection(CODEX_SELECTION_SCOPE).catch(() => undefined);
    setCurrentSelection(stored);
    return stored;
}
/**
 * 保存勾选：落盘 + 换内存快照。
 * @param ids - 用户勾的 id。
 */
export async function saveSelection(ids) {
    await writeSelection(CODEX_SELECTION_SCOPE, ids);
    setCurrentSelection(ids);
}
/**
 * 回到默认那一份：删掉落盘文件 + 清掉内存快照。
 */
export async function resetSelection() {
    await clearSelection(CODEX_SELECTION_SCOPE);
    setCurrentSelection(undefined);
}
/**
 * 按勾选过滤模型清单。
 *
 * 用户没勾过（`undefined`）→ 原样返回（默认那一份全都在）；
 * 勾过 → 只留勾中的那几个；勾了一个都不剩 → 留空（用户就是这么选的）。
 *
 * @param models - 整份模型清单。
 * @param selection - 勾选；`undefined` 表示没勾过。
 * @returns 过滤后的清单。
 */
export function applySelection(models, selection = current) {
    if (selection === undefined)
        return models;
    const wanted = new Set(selection);
    return models.filter(model => wanted.has(model.id));
}

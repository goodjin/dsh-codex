/**
 * dsh-codex: Codex 模型行——DSH 真正加载的那一行。
 *
 * Codex 是**模型**，不是外部 agent——DSH 自己的循环已经会读文件、跑命令、请求
 * 批准、取消、写会话了，这一行只回答「向模型要下一句话」：解出 Codex 凭据、
 * 把这一轮的历史与工具发出去、把回来的文本/推理/工具调用交回循环。
 *
 * 登录、清单、请求、配额都在 `codex/*` 里；浏览器侧的账号设置与模型勾选
 * 是另一套（见 `./client`）。
 */
import Schema from '@deepseek-ai/schemastery';
import { modelRowAdapter, providerRoute, runtimeModels } from "./modelkit/index.js";
import { codexModelStream } from "./codex-model.js";
export const name = '@goodjin2/dsh-codex';
export const inject = ['llm'];
/** 一个模型在目录/选择器里怎么显示。 */
const Model = Schema.object({
    id: Schema.string().required(),
    name: Schema.string().required(),
    description: Schema.string(),
    contextWindow: Schema.number(),
});
/** 一档推理强度。 */
const Effort = Schema.object({
    id: Schema.string().required(),
    name: Schema.string(),
});
export const Config = Schema.object({
    /**
     * 这一行所属的 preset id。宿主把 preset 路由成 `acp:<presetId>`，目录与运行时
     * 账本都按它认这一行。
     */
    presetId: Schema.string().required(),
    /** 用哪个 agent 的方言；Codex 这一行恒为 `codex-global`。 */
    agent: Schema.string().required(),
    /** 这一行声明要提供哪些模型（白名单）。 */
    models: Schema.array(Model),
    /**
     * 是否把同 base 的 `[effort]` 折成一条。
     */
    collapseEfforts: Schema.boolean(),
    /**
     * 名册过滤标记。
     */
    hideFromRoster: Schema.boolean(),
    /** 兜底强度档位；折叠不到强度时用来给每个模型挂强度轴。 */
    efforts: Schema.array(Effort),
});
/**
 * 把 Codex 这一行接进宿主的模型目录。
 */
export function apply(ctx, config) {
    const presets = {
        presets: {
            [config.presetId]: {
                agent: config.agent,
                ...(config.models === undefined ? {} : { models: config.models }),
            },
        },
    };
    // 运行时账本：登录后站点给的清单写进它，选择器以它为准；拉不到就用挂载行声明的兜底。
    const ledger = runtimeModels();
    const onRuntimeModels = (presetId, models) => {
        ledger.record(presetId, models);
    };
    // 图片附件读取口：宿主 attachments 服务，缺了就当没有（图片降级为占位文本）。
    const attachmentsOf = () => {
        try {
            const getter = ctx;
            if (typeof getter.get === 'function')
                return getter.get.call(ctx, 'attachments');
            return ctx.attachments;
        }
        catch {
            return undefined;
        }
    };
    const adapter = modelRowAdapter({
        presetId: config.presetId,
        displayName: 'Codex (Direct)',
        declaredModels: config.models ?? [],
        runtimeModelsOf: (presetId) => ledger.modelsOf(presetId),
        modelStream: codexModelStream(presets, { onRuntimeModels, attachmentsOf }),
        collapseEfforts: config.collapseEfforts,
        efforts: config.efforts,
    });
    const registry = registryOf(ctx);
    if (registry === undefined) {
        process.stderr.write(`[codex] no host model directory; the ${config.presetId} row is registered but invisible to the picker\n`);
        return;
    }
    registry.registerAdapter([providerRoute(config.presetId)], adapter);
}
/**
 * 读宿主的 LLM 模型目录，或 `undefined`（这台宿主没有目录）。
 */
function registryOf(ctx) {
    if (typeof ctx !== 'object' || ctx === null)
        return undefined;
    const getter = ctx;
    let llm;
    if (typeof getter.get === 'function') {
        // 宿主 cordis 语义：读未在 inject 里声明的服务会当场抛错（2026-11-10 现场：
        // 这条抛错穿透 apply，整行激活失败）。llm 缺席是预期内的优雅降级
        // （行注册但选择器不可见），所以两条访问路径都要接住。
        try {
            llm = getter.get.call(ctx, 'llm');
        }
        catch {
            return undefined;
        }
    }
    else {
        try {
            llm = ctx.llm;
        }
        catch {
            return undefined;
        }
    }
    if (typeof llm !== 'object' || llm === null)
        return undefined;
    const register = llm.registerAdapter;
    return typeof register === 'function' ? llm : undefined;
}

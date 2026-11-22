/**
 * Build the Codex /responses request body from a DSH ModelTurnRequest.
 *
 * Maps DSH messages to the Codex input format:
 * - user messages → content: [{ type: 'input_text', text }]
 * - assistant messages → content: [{ type: 'output_text', text }]
 * - system prompt → instructions
 * - reasoning effort → reasoning: { effort, summary: 'auto' }
 */
export function buildResponsesBody(input) {
    const body = {
        model: input.model,
        stream: true,
        store: false,
        input: input.messages
            .filter(m => m.role !== 'system')
            .map(m => {
            // Tool result messages → function_call_output items
            if (m.role === 'tool') {
                const raw = m;
                const toolCallId = raw['toolCallId'] ?? raw['tool_call_id'];
                const output = typeof m.content === 'string'
                    ? m.content
                    : Array.isArray(m.content)
                        ? m.content.map(p => {
                            if (typeof p === 'string')
                                return p;
                            if (typeof p === 'object' && p !== null) {
                                const pp = p;
                                if (typeof pp['text'] === 'string')
                                    return pp['text'];
                            }
                            return '';
                        }).join('')
                        : String(m.content ?? '');
                return [{
                        type: 'function_call_output',
                        call_id: typeof toolCallId === 'string' ? toolCallId : '',
                        output,
                    }];
            }
            // Preserve assistant tool calls for stateless Responses replay.
            if (m.role === 'assistant' && Array.isArray(m.content) && m.content.some(p => p?.type === 'tool-call')) {
                return m.content.flatMap((part) => {
                    if (part?.type === 'tool-call') {
                        return [{ type: 'function_call', call_id: part.id, name: part.name, arguments: part.arguments }];
                    }
                    if (part?.type === 'text') {
                        return [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: part.text }] }];
                    }
                    return [];
                });
            }
            // Regular messages
            let text;
            if (typeof m.content === 'string') {
                text = m.content;
            }
            else if (Array.isArray(m.content)) {
                text = m.content.map(part => {
                    if (typeof part === 'string')
                        return part;
                    if (typeof part === 'object' && part !== null) {
                        const p = part;
                        const textVal = p['text'];
                        if (typeof textVal === 'string')
                            return textVal;
                        if (Array.isArray(textVal)) {
                            return textVal.map(t => typeof t === 'string' ? t : '').join('');
                        }
                        if (Array.isArray(p['content'])) {
                            return p['content'].map(c => {
                                if (typeof c === 'string')
                                    return c;
                                if (typeof c === 'object' && c !== null) {
                                    return String(c['text'] ?? '');
                                }
                                return '';
                            }).join('');
                        }
                    }
                    return '';
                }).join('');
            }
            else {
                text = String(m.content ?? '');
            }
            const textType = m.role === 'assistant' ? 'output_text' : 'input_text';
            const content = [];
            if (text)
                content.push({ type: textType, text });
            // resolveImageParts() reads attachment bytes into a data URL; send it as input_image.
            if (Array.isArray(m.content)) {
                for (const part of m.content) {
                    if (part !== null && typeof part === 'object' && part.type === 'image' && typeof part.dataUrl === 'string') {
                        content.push({ type: 'input_image', image_url: part.dataUrl });
                    }
                }
            }
            return [{
                    type: 'message',
                    role: m.role,
                    content: content.length ? content : [{ type: textType, text: '' }],
                }];
        })
            .flat(),
    };
    if (input.system !== undefined) {
        body.instructions = input.system;
    }
    if (input.reasoningEffort !== undefined) {
        body.reasoning = { effort: input.reasoningEffort, summary: 'auto' };
    }
    if (input.tools !== undefined && input.tools.length > 0) {
        body.tools = input.tools
            .filter(t => t != null)
            .map(t => {
            const params = normalizeSchema(t.parameters, t.name);
            // DSH tools include optional fields and open objects. Responses otherwise
            // attempts strict normalization, which changes/rejects these schemas.
            return { type: 'function', name: t.name, description: t.description, parameters: params, strict: false };
        });
    }
    if (input.maxTokens !== undefined) {
        body.max_output_tokens = input.maxTokens;
    }
    return body;
}
/**
 * Normalize a JSON Schema to meet Codex API requirements:
 * - Top level must have type: "object"
 * - No oneOf/anyOf/allOf/enum/const/not at top level
 */
function normalizeSchema(schema, toolName) {
    if (schema === undefined || schema === null) {
        return { type: 'object', properties: {} };
    }
    // Never wrap arguments in a synthetic `value` field or replace allOf/oneOf
    // with anyOf: the host executes the original tool contract, not that wrapper.
    const forbidden = ['oneOf', 'anyOf', 'allOf', 'enum', 'const', 'not'];
    const keyword = forbidden.find(key => Object.hasOwn(schema, key));
    if (keyword !== undefined || (schema.type !== undefined && schema.type !== 'object')) {
        throw Object.assign(new Error(`Codex tool "${toolName}" requires an object parameter schema without top-level ${keyword ?? `type ${JSON.stringify(schema.type)}`}`), { code: 'unsupported-tool-schema' });
    }
    // Some raw DSH tools require metadata keys without declaring their schema.
    // Codex rejects those (even in non-strict mode) with a misleading root-type
    // error. Keep the key required and declare an unconstrained value; do not
    // guess its type or remove it from required.
    const properties = { ...schema.properties };
    if (Array.isArray(schema.required)) {
        for (const key of schema.required) {
            if (typeof key === 'string' && !Object.hasOwn(properties, key)) {
                Object.defineProperty(properties, key, { value: {}, enumerable: true, configurable: true, writable: true });
            }
        }
    }
    return { ...schema, type: 'object', properties };
}

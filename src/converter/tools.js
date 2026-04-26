/**
 * Convert OpenAI tool definitions to JB parameters.data format
 */
function openaiToolsToJB(tools) {
  if (!tools || tools.length === 0) return [];

  const jbTools = tools
    .filter(t => t.type === 'function')
    .map(t => ({
      name: t.function.name,
      description: t.function.description || '',
      parameters: { schema: t.function.parameters || {} },
    }));

  if (jbTools.length === 0) return [];

  return [
    { type: 'json', fqdn: 'llm.parameters.tools' },
    { type: 'json', value: JSON.stringify(jbTools) },
  ];
}

/**
 * Convert Anthropic tool definitions to JB parameters.data format
 */
function anthropicToolsToJB(tools) {
  if (!tools || tools.length === 0) return [];

  const jbTools = tools.map(t => ({
    name: t.name,
    description: t.description || '',
    parameters: { schema: t.input_schema || {} },
  }));

  if (jbTools.length === 0) return [];

  return [
    { type: 'json', fqdn: 'llm.parameters.tools' },
    { type: 'json', value: JSON.stringify(jbTools) },
  ];
}

/**
 * Build common LLM parameters (temperature, top_p, max_tokens, stop).
 * JB API uses fqdn-value pairs in parameters.data.
 *
 * Note: JB API does not allow temperature and top_p simultaneously.
 * When both are provided we prefer temperature and drop top_p.
 *
 * @param {{ temperature?: number, top_p?: number, max_tokens?: number, stop?: string|string[], hasTools?: boolean }} opts
 * @returns {Array}
 */
function buildCommonParams(opts = {}) {
  const params = [];

  // max_tokens → llm.parameters.length
  // When tools are present and client didn't specify max_tokens, set a high
  // default (16384) to prevent tool call arguments (e.g. file content for the
  // write tool) from being truncated mid-JSON, which causes client parse failures.
  let maxTokens = opts.max_tokens;
  if ((maxTokens === undefined || maxTokens === null) && opts.hasTools) {
    maxTokens = 16384;
  }
  if (maxTokens !== undefined && maxTokens !== null) {
    params.push(
      { type: 'int', fqdn: 'llm.parameters.length' },
      { type: 'int', value: maxTokens },
    );
  }

  // temperature / top_p (mutually exclusive on JB side)
  if (opts.temperature !== undefined && opts.temperature !== null) {
    params.push(
      { type: 'double', fqdn: 'llm.parameters.temperature' },
      { type: 'double', value: opts.temperature },
    );
  } else if (opts.top_p !== undefined && opts.top_p !== null) {
    params.push(
      { type: 'double', fqdn: 'llm.parameters.top-p' },
      { type: 'double', value: opts.top_p },
    );
  }

  // stop sequences → llm.parameters.stop-token (JB only supports one)
  if (opts.stop !== undefined && opts.stop !== null) {
    const stopVal = Array.isArray(opts.stop) ? opts.stop[0] : opts.stop;
    if (typeof stopVal === 'string' && stopVal) {
      params.push(
        { type: 'text', fqdn: 'llm.parameters.stop-token' },
        { type: 'text', value: stopVal },
      );
    }
  }

  return params;
}

/**
 * Convert OpenAI tool_choice to a system-message hint that instructs the model
 * to call the specified tool. JB Grazie API does not have a native tool_choice
 * parameter, so we inject a strong prompt instruction instead.
 *
 * @param {*} toolChoice  - OpenAI tool_choice value:
 *   "auto" | "none" | "required" | { type: "function", function: { name: string } }
 * @param {Array} tools   - The tool definitions (for listing available names)
 * @returns {{ hint: string|null, forceToolUse: boolean }}
 *   hint: system message text to inject (null if not needed)
 *   forceToolUse: whether tool use is required (for client-side retry logic)
 */
function buildToolChoiceHint(toolChoice, tools) {
  if (!toolChoice || toolChoice === 'auto') {
    return { hint: null, forceToolUse: false };
  }

  if (toolChoice === 'none') {
    return {
      hint: 'IMPORTANT: Do NOT call any tools in this response. Respond with text only.',
      forceToolUse: false,
    };
  }

  if (toolChoice === 'required') {
    const names = (tools || [])
      .filter(t => t.type === 'function')
      .map(t => t.function?.name || t.name)
      .filter(Boolean);
    const nameList = names.length > 0 ? ` Available tools: ${names.join(', ')}.` : '';
    return {
      hint: `IMPORTANT: You MUST call one of the available tools in this response. Do NOT respond with plain text — you must produce a tool call.${nameList}`,
      forceToolUse: true,
    };
  }

  // Specific function: { type: "function", function: { name: "xxx" } }
  if (typeof toolChoice === 'object' && toolChoice.function?.name) {
    const funcName = toolChoice.function.name;
    return {
      hint: `IMPORTANT: You MUST call the tool "${funcName}" in this response. Do NOT respond with plain text — you must produce a tool call to "${funcName}".`,
      forceToolUse: true,
    };
  }

  // Anthropic-style: { type: "tool", name: "xxx" }
  if (typeof toolChoice === 'object' && toolChoice.type === 'tool' && toolChoice.name) {
    const funcName = toolChoice.name;
    return {
      hint: `IMPORTANT: You MUST call the tool "${funcName}" in this response. Do NOT respond with plain text — you must produce a tool call to "${funcName}".`,
      forceToolUse: true,
    };
  }

  // Anthropic-style: { type: "any" }
  if (typeof toolChoice === 'object' && toolChoice.type === 'any') {
    const names = (tools || []).map(t => t.name).filter(Boolean);
    const nameList = names.length > 0 ? ` Available tools: ${names.join(', ')}.` : '';
    return {
      hint: `IMPORTANT: You MUST call one of the available tools in this response. Do NOT respond with plain text — you must produce a tool call.${nameList}`,
      forceToolUse: true,
    };
  }

  return { hint: null, forceToolUse: false };
}

/**
 * Build JB parameters.data array from tool data, common params, and extra params.
 */
function buildParametersData(toolsData, commonParams = [], extraParams = []) {
  return [...toolsData, ...commonParams, ...extraParams];
}

module.exports = {
  openaiToolsToJB,
  anthropicToolsToJB,
  buildCommonParams,
  buildToolChoiceHint,
  buildParametersData,
};

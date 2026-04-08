import type { OnlineProviderSettings } from "./storage";

export type CompatibleMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: CompatibleToolCall[];
};

export type CompatibleToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

type CompatibleToolDefinition = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, unknown>;
      required?: string[];
      additionalProperties?: boolean;
    };
  };
};

export const OPENAI_COMPATIBLE_TOOLS: CompatibleToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "读取本地文件内容。",
      parameters: {
        type: "object",
        properties: {
          filePath: { type: "string", description: "要读取的文件路径" },
        },
        required: ["filePath"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "将内容写入本地文件，如果目录不存在会自动创建。",
      parameters: {
        type: "object",
        properties: {
          filePath: { type: "string", description: "要写入的文件路径" },
          content: { type: "string", description: "要写入的内容" },
        },
        required: ["filePath", "content"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_directory",
      description: "列出指定目录下的文件和子目录。",
      parameters: {
        type: "object",
        properties: {
          dirPath: { type: "string", description: "目录路径" },
        },
        required: ["dirPath"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_file",
      description: "删除指定路径的文件。",
      parameters: {
        type: "object",
        properties: {
          filePath: { type: "string", description: "要删除的文件路径" },
        },
        required: ["filePath"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_files",
      description: "在指定目录中按文件名关键词搜索文件。",
      parameters: {
        type: "object",
        properties: {
          dirPath: { type: "string", description: "要搜索的目录路径" },
          keyword: { type: "string", description: "文件名关键词" },
        },
        required: ["dirPath", "keyword"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_current_time",
      description: "获取当前日期和时间，可指定时区和语言区域。",
      parameters: {
        type: "object",
        properties: {
          timezone: { type: "string", description: "时区，例如 Asia/Shanghai" },
          locale: { type: "string", description: "语言区域，例如 zh-CN" },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "calculator",
      description: "计算数学表达式。",
      parameters: {
        type: "object",
        properties: {
          expression: { type: "string", description: "数学表达式" },
        },
        required: ["expression"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "unit_convert",
      description: "单位换算，支持长度、重量、体积和温度。",
      parameters: {
        type: "object",
        properties: {
          value: { type: "number", description: "要换算的数值" },
          fromUnit: { type: "string", description: "原始单位" },
          toUnit: { type: "string", description: "目标单位" },
        },
        required: ["value", "fromUnit", "toUnit"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "clipboard_copy",
      description: "将文本复制到系统剪贴板。",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "要复制的文本" },
        },
        required: ["text"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description: "联网搜索公开网页信息。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "搜索关键词" },
          maxResults: { type: "number", description: "返回结果条数" },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_weather_current",
      description: "查询指定地点的当前天气情况。",
      parameters: {
        type: "object",
        properties: {
          location: { type: "string", description: "地点名称" },
          lang: { type: "string", description: "返回语言，例如 zh 或 en" },
        },
        required: ["location"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fetch_url",
      description: "抓取网页标题和清洗后的正文摘要。",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "网页链接" },
          maxLength: { type: "number", description: "返回正文最大长度" },
        },
        required: ["url"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "currency_convert",
      description: "进行货币汇率换算。",
      parameters: {
        type: "object",
        properties: {
          amount: { type: "number", description: "金额" },
          fromCurrency: { type: "string", description: "原始货币代码" },
          toCurrency: { type: "string", description: "目标货币代码" },
        },
        required: ["amount", "fromCurrency", "toCurrency"],
        additionalProperties: false,
      },
    },
  },
];

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "");
}

function limitMessages(
  messages: CompatibleMessage[],
  maxNonSystemMessages = 8,
): CompatibleMessage[] {
  const systemMessages = messages.filter((item) => item.role === "system");
  const nonSystemMessages = messages.filter((item) => item.role !== "system");

  if (nonSystemMessages.length <= maxNonSystemMessages) {
    return messages;
  }

  const containsToolChain = nonSystemMessages.some(
    (item) =>
      item.role === "tool" ||
      (item.role === "assistant" && item.tool_calls?.length),
  );

  if (containsToolChain) {
    return messages;
  }

  return [...systemMessages, ...nonSystemMessages.slice(-maxNonSystemMessages)];
}

function getProviderHint(settings: OnlineProviderSettings): string {
  return `${settings.provider || ""} ${settings.baseUrl || ""}`.toLowerCase();
}

function ensureOnlineSettings(
  settings: OnlineProviderSettings,
  model?: string,
): {
  baseUrl: string;
  apiKey: string;
  model: string;
} {
  const baseUrl = normalizeBaseUrl(settings.baseUrl || "");
  const apiKey = (settings.apiKey || "").trim();
  const resolvedModel = (model || "").trim();

  if (!baseUrl) {
    throw new Error("在线模型未配置 Base URL");
  }
  if (!apiKey) {
    throw new Error("在线模型未配置 API Key");
  }
  if (!resolvedModel) {
    throw new Error("在线模型名称为空，请先在设置中填写模型名");
  }

  return { baseUrl, apiKey, model: resolvedModel };
}

function buildHeaders(apiKey: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };
}

async function extractErrorMessage(response: Response): Promise<string> {
  const raw = await response.text();
  try {
    const data = JSON.parse(raw) as {
      error?: { message?: string };
      message?: string;
    };
    return data.error?.message || data.message || `HTTP ${response.status}`;
  } catch {
    return raw || `HTTP ${response.status}`;
  }
}

function withProviderErrorHint(
  message: string,
  settings: OnlineProviderSettings,
  model: string,
): string {
  const providerHint = getProviderHint(settings);
  const isZhipu =
    providerHint.includes("智谱") || providerHint.includes("bigmodel");
  const balanceLikeError =
    /(余额不足|insufficient\s*balance|quota|bill|credit)/i.test(message);

  if (isZhipu && balanceLikeError) {
    return `${message}\n提示：智谱在 Agent 模式下会附带工具描述和上下文，消耗会比普通聊天高。建议优先将 Agent 模型切换为 \`glm-4-flash\` 或 \`glm-4-air\`，避免使用 \`glm-4-plus\` 这类更高成本模型。`;
  }

  return message;
}

async function tryFetchBalance(
  settings: OnlineProviderSettings,
  headers: Record<string, string>,
): Promise<string> {
  const providerHint =
    `${settings.provider || ""} ${settings.baseUrl || ""}`.toLowerCase();

  if (providerHint.includes("openrouter")) {
    try {
      const baseUrl = normalizeBaseUrl(settings.baseUrl || "");
      const response = await fetch(`${baseUrl}/credits`, {
        method: "GET",
        headers,
      });

      if (!response.ok) {
        return "余额接口暂不可用";
      }

      const data = (await response.json()) as {
        data?: {
          total_credits?: number;
          total_usage?: number;
        };
      };

      const total = data.data?.total_credits;
      const used = data.data?.total_usage;
      if (typeof total === "number" && typeof used === "number") {
        const remain = Math.max(total - used, 0);
        return `约 $${remain.toFixed(2)}（总额 $${total.toFixed(2)}）`;
      }

      return "已连接，但未返回余额数据";
    } catch {
      return "余额查询失败";
    }
  }

  return "当前服务暂不支持自动查询余额";
}

export async function invokeOpenAICompatibleChat(options: {
  settings: OnlineProviderSettings;
  model: string;
  messages: CompatibleMessage[];
  tools?: CompatibleToolDefinition[];
  signal?: AbortSignal;
}): Promise<{ content: string; toolCalls: CompatibleToolCall[] }> {
  const { settings, model, messages, tools, signal } = options;
  const resolved = ensureOnlineSettings(settings, model);
  const hasTools = Boolean(tools && tools.length > 0);
  const hasActiveToolMessages = messages.some(
    (item) =>
      item.role === "tool" ||
      (item.role === "assistant" && item.tool_calls?.length),
  );
  const trimmedMessages = hasActiveToolMessages
    ? messages
    : limitMessages(messages, hasTools ? 8 : 10);
  const providerHint = getProviderHint(settings);
  const isZhipu =
    providerHint.includes("智谱") || providerHint.includes("bigmodel");
  const maxTokens = hasTools ? (isZhipu ? 1024 : 1400) : isZhipu ? 1200 : 1800;

  const response = await fetch(`${resolved.baseUrl}/chat/completions`, {
    method: "POST",
    headers: buildHeaders(resolved.apiKey),
    body: JSON.stringify({
      model: resolved.model,
      messages: trimmedMessages,
      tools,
      tool_choice: hasTools ? "auto" : undefined,
      stream: false,
      temperature: 0.2,
      max_tokens: maxTokens,
    }),
    signal,
  });

  if (!response.ok) {
    throw new Error(
      withProviderErrorHint(
        await extractErrorMessage(response),
        settings,
        resolved.model,
      ),
    );
  }

  const data = (await response.json()) as {
    choices?: Array<{
      message?: {
        content?: string | null;
        tool_calls?: CompatibleToolCall[];
      };
    }>;
  };

  const message = data.choices?.[0]?.message;
  return {
    content: message?.content || "",
    toolCalls: message?.tool_calls || [],
  };
}

export async function streamOpenAICompatibleChat(options: {
  settings: OnlineProviderSettings;
  model: string;
  messages: CompatibleMessage[];
  onToken: (token: string) => void;
  signal?: AbortSignal;
}): Promise<string> {
  const { settings, model, messages, onToken, signal } = options;
  const resolved = ensureOnlineSettings(settings, model);
  const providerHint = getProviderHint(settings);
  const isZhipu =
    providerHint.includes("智谱") || providerHint.includes("bigmodel");
  const trimmedMessages = limitMessages(messages, 10);

  const response = await fetch(`${resolved.baseUrl}/chat/completions`, {
    method: "POST",
    headers: buildHeaders(resolved.apiKey),
    body: JSON.stringify({
      model: resolved.model,
      messages: trimmedMessages,
      stream: true,
      temperature: 0.3,
      max_tokens: isZhipu ? 1200 : 1800,
    }),
    signal,
  });

  if (!response.ok) {
    throw new Error(
      withProviderErrorHint(
        await extractErrorMessage(response),
        settings,
        resolved.model,
      ),
    );
  }

  if (!response.body) {
    const fallback = (await response.json()) as {
      choices?: Array<{
        message?: {
          content?: string;
        };
      }>;
    };
    const content = fallback.choices?.[0]?.message?.content || "";
    if (content) onToken(content);
    return content;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullResponse = "";

  while (true) {
    signal?.throwIfAborted();
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split(/\r?\n\r?\n/);
    buffer = events.pop() || "";

    for (const event of events) {
      const lines = event.split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;

        const payload = trimmed.slice(5).trim();
        if (!payload) continue;
        if (payload === "[DONE]") return fullResponse;

        try {
          const data = JSON.parse(payload) as {
            choices?: Array<{
              delta?: {
                content?: string;
                reasoning_content?: string;
              };
            }>;
          };
          const delta = data.choices?.[0]?.delta;
          const token = delta?.content || delta?.reasoning_content || "";
          if (token) {
            onToken(token);
            fullResponse += token;
          }
        } catch {
          // 忽略非 JSON 心跳包
        }
      }
    }
  }

  return fullResponse;
}

export async function testOpenAICompatibleApi(options: {
  settings: OnlineProviderSettings;
  model?: string;
}): Promise<{
  ok: boolean;
  message: string;
  models: string[];
  latencyMs?: number;
  balanceInfo?: string;
  testedAt?: number;
}> {
  const { settings, model } = options;
  const baseUrl = normalizeBaseUrl(settings.baseUrl || "");
  const apiKey = (settings.apiKey || "").trim();

  if (!baseUrl) {
    return { ok: false, message: "请先填写 Base URL", models: [] };
  }
  if (!apiKey) {
    return { ok: false, message: "请先填写 API Key", models: [] };
  }

  const headers = buildHeaders(apiKey);

  try {
    const startedAt = Date.now();
    const response = await fetch(`${baseUrl}/models`, {
      headers,
      method: "GET",
    });
    const latencyMs = Date.now() - startedAt;

    if (response.ok) {
      const data = (await response.json()) as {
        data?: Array<{ id?: string }>;
      };
      const models = (data.data || [])
        .map((item) => item.id || "")
        .filter(Boolean)
        .slice(0, 30);
      const balanceInfo = await tryFetchBalance(settings, headers);

      return {
        ok: true,
        message:
          models.length > 0
            ? `API 连通正常，已获取 ${models.length} 个模型。`
            : "API 连通正常，但未返回模型列表。",
        models,
        latencyMs,
        balanceInfo,
        testedAt: Date.now(),
      };
    }

    const fallbackModel = (model || "").trim();
    if (!fallbackModel) {
      return {
        ok: false,
        message: await extractErrorMessage(response),
        models: [],
        latencyMs,
        testedAt: Date.now(),
      };
    }

    const chatStartedAt = Date.now();
    const chatResponse = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: fallbackModel,
        messages: [{ role: "user", content: "Reply with OK only." }],
        stream: false,
        max_tokens: 8,
      }),
    });
    const chatLatency = Date.now() - chatStartedAt;

    if (!chatResponse.ok) {
      return {
        ok: false,
        message: await extractErrorMessage(chatResponse),
        models: [],
        latencyMs: chatLatency,
        testedAt: Date.now(),
      };
    }

    const balanceInfo = await tryFetchBalance(settings, headers);

    return {
      ok: true,
      message: `API 连通正常，模型 ${fallbackModel} 可访问。`,
      models: [fallbackModel],
      latencyMs: chatLatency,
      balanceInfo,
      testedAt: Date.now(),
    };
  } catch (error: any) {
    return {
      ok: false,
      message: error?.message || "API 测试失败",
      models: [],
      testedAt: Date.now(),
    };
  }
}

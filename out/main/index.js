"use strict";
const electron = require("electron");
const path = require("path");
const utils = require("@electron-toolkit/utils");
const ollama = require("@langchain/ollama");
const messages = require("@langchain/core/messages");
const tools = require("@langchain/core/tools");
const zod = require("zod");
const fs = require("fs");
function _interopNamespaceDefault(e) {
  const n = Object.create(null, { [Symbol.toStringTag]: { value: "Module" } });
  if (e) {
    for (const k in e) {
      if (k !== "default") {
        const d = Object.getOwnPropertyDescriptor(e, k);
        Object.defineProperty(n, k, d.get ? d : {
          enumerable: true,
          get: () => e[k]
        });
      }
    }
  }
  n.default = e;
  return Object.freeze(n);
}
const path__namespace = /* @__PURE__ */ _interopNamespaceDefault(path);
const fs__namespace = /* @__PURE__ */ _interopNamespaceDefault(fs);
const readFileTool = tools.tool(
  async ({ filePath }) => {
    try {
      const resolvedPath = path__namespace.resolve(filePath);
      const content = fs__namespace.readFileSync(resolvedPath, "utf-8");
      const lines = content.split("\n").length;
      return `文件读取成功 (${lines} 行):
\`\`\`
${content}
\`\`\``;
    } catch (e) {
      return `读取文件失败: ${e.message}`;
    }
  },
  {
    name: "read_file",
    description: "读取本地文件内容。输入文件的绝对路径或相对路径。",
    schema: zod.z.object({
      filePath: zod.z.string().describe("要读取的文件路径")
    })
  }
);
const writeFileTool = tools.tool(
  async ({ filePath, content }) => {
    try {
      const resolvedPath = path__namespace.resolve(filePath);
      const dir = path__namespace.dirname(resolvedPath);
      if (!fs__namespace.existsSync(dir)) {
        fs__namespace.mkdirSync(dir, { recursive: true });
      }
      fs__namespace.writeFileSync(resolvedPath, content, "utf-8");
      return `文件写入成功: ${resolvedPath}`;
    } catch (e) {
      return `写入文件失败: ${e.message}`;
    }
  },
  {
    name: "write_file",
    description: "将内容写入本地文件。如果目录不存在会自动创建。",
    schema: zod.z.object({
      filePath: zod.z.string().describe("要写入的文件路径"),
      content: zod.z.string().describe("要写入的内容")
    })
  }
);
const listDirectoryTool = tools.tool(
  async ({ dirPath }) => {
    try {
      const resolvedPath = path__namespace.resolve(dirPath);
      const entries = fs__namespace.readdirSync(resolvedPath, { withFileTypes: true });
      const result = entries.map((entry) => {
        const type = entry.isDirectory() ? "[目录]" : "[文件]";
        const size = entry.isFile() ? ` (${fs__namespace.statSync(path__namespace.join(resolvedPath, entry.name)).size} bytes)` : "";
        return `${type} ${entry.name}${size}`;
      });
      return `目录 "${resolvedPath}" 的内容:
${result.join("\n")}`;
    } catch (e) {
      return `列出目录失败: ${e.message}`;
    }
  },
  {
    name: "list_directory",
    description: "列出指定目录下的所有文件和子目录。",
    schema: zod.z.object({
      dirPath: zod.z.string().describe("要列出内容的目录路径")
    })
  }
);
const deleteFileTool = tools.tool(
  async ({ filePath }) => {
    try {
      const resolvedPath = path__namespace.resolve(filePath);
      if (!fs__namespace.existsSync(resolvedPath)) {
        return `文件不存在: ${resolvedPath}`;
      }
      fs__namespace.unlinkSync(resolvedPath);
      return `文件删除成功: ${resolvedPath}`;
    } catch (e) {
      return `删除文件失败: ${e.message}`;
    }
  },
  {
    name: "delete_file",
    description: "删除指定路径的文件。",
    schema: zod.z.object({
      filePath: zod.z.string().describe("要删除的文件路径")
    })
  }
);
const searchFilesTool = tools.tool(
  async ({ dirPath, keyword }) => {
    try {
      const resolvedPath = path__namespace.resolve(dirPath);
      const results = [];
      const searchDir = (dir) => {
        if (results.length >= 50) return;
        try {
          const entries = fs__namespace.readdirSync(dir, { withFileTypes: true });
          for (const entry of entries) {
            const fullPath = path__namespace.join(dir, entry.name);
            if (entry.isDirectory()) {
              if (!entry.name.startsWith(".") && entry.name !== "node_modules") {
                searchDir(fullPath);
              }
            } else if (entry.name.toLowerCase().includes(keyword.toLowerCase())) {
              results.push(fullPath);
            }
          }
        } catch {
        }
      };
      searchDir(resolvedPath);
      if (results.length === 0)
        return `在 "${resolvedPath}" 中未找到包含 "${keyword}" 的文件`;
      return `找到 ${results.length} 个文件:
${results.join("\n")}`;
    } catch (e) {
      return `搜索失败: ${e.message}`;
    }
  },
  {
    name: "search_files",
    description: "在指定目录中按文件名关键词搜索文件。",
    schema: zod.z.object({
      dirPath: zod.z.string().describe("要搜索的目录路径"),
      keyword: zod.z.string().describe("文件名中要搜索的关键词")
    })
  }
);
function isSafeMathExpression(expression) {
  return /^[0-9+\-*/%().,\s^]+$/.test(expression);
}
const UNIT_DEFINITIONS = {
  length: {
    m: 1,
    km: 1e3,
    cm: 0.01,
    mm: 1e-3,
    in: 0.0254,
    ft: 0.3048,
    yd: 0.9144,
    mi: 1609.344
  },
  weight: {
    kg: 1,
    g: 1e-3,
    mg: 1e-6,
    lb: 0.45359237,
    oz: 0.028349523125
  },
  volume: {
    l: 1,
    ml: 1e-3,
    m3: 1e3,
    gal: 3.785411784,
    qt: 0.946352946
  }
};
function findUnitCategory(unit) {
  const normalized = unit.toLowerCase();
  for (const category of Object.keys(UNIT_DEFINITIONS)) {
    if (normalized in UNIT_DEFINITIONS[category]) {
      return category;
    }
  }
  return null;
}
function convertTemperature(value, fromUnit, toUnit) {
  const fromNormalized = fromUnit.toLowerCase();
  const toNormalized = toUnit.toLowerCase();
  const toCelsius = (input, unit) => {
    if (unit === "c") return input;
    if (unit === "f") return (input - 32) * 5 / 9;
    if (unit === "k") return input - 273.15;
    return null;
  };
  const fromCelsius = (input, unit) => {
    if (unit === "c") return input;
    if (unit === "f") return input * 9 / 5 + 32;
    if (unit === "k") return input + 273.15;
    return null;
  };
  const celsius = toCelsius(value, fromNormalized);
  if (celsius === null) return null;
  return fromCelsius(celsius, toNormalized);
}
const currentTimeTool = tools.tool(
  async ({ timezone, locale }) => {
    try {
      const now = /* @__PURE__ */ new Date();
      const formatter = new Intl.DateTimeFormat(locale || "zh-CN", {
        dateStyle: "full",
        timeStyle: "medium",
        timeZone: timezone || "Asia/Shanghai"
      });
      return [
        `当前时间: ${formatter.format(now)}`,
        `时区: ${timezone || "Asia/Shanghai"}`,
        `ISO: ${now.toISOString()}`
      ].join("\n");
    } catch (e) {
      return `获取时间失败: ${e.message}`;
    }
  },
  {
    name: "get_current_time",
    description: "获取当前日期和时间，可指定时区和语言区域。",
    schema: zod.z.object({
      timezone: zod.z.string().optional().describe("IANA 时区，例如 Asia/Shanghai、America/New_York"),
      locale: zod.z.string().optional().describe("语言区域，例如 zh-CN、en-US")
    })
  }
);
const calculatorTool = tools.tool(
  async ({ expression }) => {
    try {
      const sanitized = expression.replace(/,/g, ".").replace(/\^/g, "**").trim();
      if (!sanitized) return "计算失败: 表达式为空";
      if (!isSafeMathExpression(expression)) {
        return "计算失败: 表达式包含不允许的字符，仅支持数字和 + - * / % ( ) ^";
      }
      const result = Function(`"use strict"; return (${sanitized});`)();
      if (typeof result !== "number" || !Number.isFinite(result)) {
        return "计算失败: 结果不是有限数字";
      }
      return `表达式: ${expression}
结果: ${result}`;
    } catch (e) {
      return `计算失败: ${e.message}`;
    }
  },
  {
    name: "calculator",
    description: "计算数学表达式，支持 + - * / % () 和 ^ 幂运算。",
    schema: zod.z.object({
      expression: zod.z.string().describe("要计算的数学表达式，例如 (12.5+3)*2^3")
    })
  }
);
const unitConvertTool = tools.tool(
  async ({ value, fromUnit, toUnit }) => {
    try {
      const fromNormalized = fromUnit.toLowerCase();
      const toNormalized = toUnit.toLowerCase();
      const temperatureResult = convertTemperature(
        value,
        fromNormalized,
        toNormalized
      );
      if (temperatureResult !== null) {
        return [
          `数值: ${value}`,
          `从: ${fromNormalized}`,
          `到: ${toNormalized}`,
          `结果: ${temperatureResult}`
        ].join("\n");
      }
      const fromCategory = findUnitCategory(fromNormalized);
      const toCategory = findUnitCategory(toNormalized);
      if (!fromCategory || !toCategory) {
        return "单位换算失败: 不支持的单位。当前支持长度、重量、体积和温度单位。";
      }
      if (fromCategory !== toCategory) {
        return `单位换算失败: ${fromNormalized} 与 ${toNormalized} 不属于同一量纲`;
      }
      const baseValue = value * UNIT_DEFINITIONS[fromCategory][fromNormalized];
      const convertedValue = baseValue / UNIT_DEFINITIONS[toCategory][toNormalized];
      return [
        `数值: ${value}`,
        `单位类型: ${fromCategory}`,
        `从: ${fromNormalized}`,
        `到: ${toNormalized}`,
        `结果: ${convertedValue}`
      ].join("\n");
    } catch (e) {
      return `单位换算失败: ${e.message}`;
    }
  },
  {
    name: "unit_convert",
    description: "单位换算工具，支持长度、重量、体积和温度换算。",
    schema: zod.z.object({
      value: zod.z.number().describe("要换算的数值"),
      fromUnit: zod.z.string().describe("原始单位，例如 km、m、kg、lb、l、ml、c、f、k"),
      toUnit: zod.z.string().describe("目标单位，例如 mi、cm、g、oz、gal、c、f、k")
    })
  }
);
const clipboardCopyTool = tools.tool(
  async ({ text }) => {
    try {
      electron.clipboard.writeText(text);
      return `已复制到剪贴板，共 ${text.length} 个字符`;
    } catch (e) {
      return `复制到剪贴板失败: ${e.message}`;
    }
  },
  {
    name: "clipboard_copy",
    description: "将指定文本复制到系统剪贴板。",
    schema: zod.z.object({
      text: zod.z.string().describe("要复制到系统剪贴板的文本内容")
    })
  }
);
const systemTools = [
  currentTimeTool,
  calculatorTool,
  unitConvertTool,
  clipboardCopyTool
];
function normalizeText(text) {
  return text.replace(/\s+/g, " ").trim();
}
function stripHtml(text) {
  return normalizeText(
    text.replace(/<[^>]+>/g, " ").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  );
}
function decodeHtmlEntities(text) {
  return text.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ");
}
const webSearchTool = tools.tool(
  async ({ query, maxResults }) => {
    try {
      const limit = Math.min(Math.max(maxResults ?? 5, 1), 10);
      const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
      const res = await fetch(url, {
        headers: {
          "user-agent": "Mozilla/5.0"
        }
      });
      if (!res.ok) {
        return `联网搜索失败: HTTP ${res.status}`;
      }
      const html = await res.text();
      const matches = [
        ...html.matchAll(
          /<a[^>]*class=\"result__a\"[^>]*href=\"([^\"]+)\"[^>]*>([\s\S]*?)<\/a>/g
        )
      ];
      if (matches.length === 0) {
        return `未找到与“${query}”相关的搜索结果`;
      }
      const results = matches.slice(0, limit).map((match, index) => {
        const rawUrl = match[1];
        const title = stripHtml(match[2]);
        const decodedUrl = (() => {
          try {
            const parsed = new URL(rawUrl, "https://html.duckduckgo.com");
            return parsed.searchParams.get("uddg") || rawUrl;
          } catch {
            return rawUrl;
          }
        })();
        return `${index + 1}. ${title}
${decodedUrl}`;
      });
      return `搜索关键词: ${query}

${results.join("\n\n")}`;
    } catch (e) {
      return `联网搜索失败: ${e.message}`;
    }
  },
  {
    name: "web_search",
    description: "联网搜索公开网页信息，返回若干条搜索结果标题和链接。",
    schema: zod.z.object({
      query: zod.z.string().describe("搜索关键词"),
      maxResults: zod.z.number().int().min(1).max(10).optional().describe("返回结果条数，默认 5")
    })
  }
);
const currentWeatherTool = tools.tool(
  async ({ location, lang }) => {
    try {
      const locale = lang || "zh";
      const url = `https://wttr.in/${encodeURIComponent(location)}?format=j1&lang=${encodeURIComponent(locale)}`;
      const res = await fetch(url, {
        headers: {
          "user-agent": "curl/8.0"
        }
      });
      if (!res.ok) {
        return `天气查询失败: HTTP ${res.status}`;
      }
      const data = await res.json();
      const current = data.current_condition?.[0];
      if (!current) {
        return `天气查询失败: 未获取到 ${location} 的天气数据`;
      }
      return [
        `位置: ${location}`,
        `天气: ${current.weatherDesc?.[0]?.value || "未知"}`,
        `温度: ${current.temp_C || "?"}°C`,
        `体感: ${current.FeelsLikeC || "?"}°C`,
        `湿度: ${current.humidity || "?"}%`,
        `风速: ${current.windspeedKmph || "?"} km/h`,
        `风向: ${current.winddir16Point || "未知"}`
      ].join("\n");
    } catch (e) {
      return `天气查询失败: ${e.message}`;
    }
  },
  {
    name: "get_weather_current",
    description: "查询指定地点的当前天气情况。",
    schema: zod.z.object({
      location: zod.z.string().describe("地点名称，例如 北京、Shanghai、New York"),
      lang: zod.z.string().optional().describe("返回语言，例如 zh、en")
    })
  }
);
const fetchUrlTool = tools.tool(
  async ({ url, maxLength }) => {
    try {
      const limit = Math.min(Math.max(maxLength ?? 4e3, 500), 12e3);
      const res = await fetch(url, {
        headers: {
          "user-agent": "Mozilla/5.0"
        }
      });
      if (!res.ok) {
        return `网页抓取失败: HTTP ${res.status}`;
      }
      const html = await res.text();
      const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      const title = titleMatch ? normalizeText(decodeHtmlEntities(stripHtml(titleMatch[1]))) : "无标题";
      const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
      const bodyText = normalizeText(
        decodeHtmlEntities(
          stripHtml(bodyMatch ? bodyMatch[1] : html).replace(
            /(script|style)[\s\S]*?(script|style)/gi,
            " "
          )
        )
      );
      if (!bodyText) {
        return `网页标题: ${title}
链接: ${url}

未提取到正文内容`;
      }
      const excerpt = bodyText.slice(0, limit);
      const truncated = bodyText.length > excerpt.length ? "\n\n[内容已截断]" : "";
      return `网页标题: ${title}
链接: ${url}

正文:
${excerpt}${truncated}`;
    } catch (e) {
      return `网页抓取失败: ${e.message}`;
    }
  },
  {
    name: "fetch_url",
    description: "抓取指定网页内容，返回标题和清洗后的正文摘要。",
    schema: zod.z.object({
      url: zod.z.string().url().describe("要抓取的网页链接"),
      maxLength: zod.z.number().int().min(500).max(12e3).optional().describe("返回正文最大长度，默认 4000")
    })
  }
);
const currencyConvertTool = tools.tool(
  async ({ amount, fromCurrency, toCurrency }) => {
    try {
      const from = fromCurrency.toUpperCase();
      const to = toCurrency.toUpperCase();
      const url = `https://open.er-api.com/v6/latest/${encodeURIComponent(from)}`;
      const res = await fetch(url, {
        headers: {
          "user-agent": "Mozilla/5.0"
        }
      });
      if (!res.ok) {
        return `汇率换算失败: HTTP ${res.status}`;
      }
      const data = await res.json();
      if (data.result !== "success" || !data.rates) {
        return "汇率换算失败: 汇率服务未返回有效数据";
      }
      const rate = data.rates[to];
      if (typeof rate !== "number") {
        return `汇率换算失败: 不支持 ${to} 货币代码`;
      }
      const converted = amount * rate;
      return [
        `金额: ${amount} ${from}`,
        `目标货币: ${to}`,
        `汇率: 1 ${from} = ${rate} ${to}`,
        `结果: ${converted} ${to}`,
        `更新时间: ${data.time_last_update_utc || "未知"}`
      ].join("\n");
    } catch (e) {
      return `汇率换算失败: ${e.message}`;
    }
  },
  {
    name: "currency_convert",
    description: "货币汇率换算工具，支持常见国际货币代码。",
    schema: zod.z.object({
      amount: zod.z.number().describe("要换算的金额"),
      fromCurrency: zod.z.string().describe("原始货币代码，例如 CNY、USD、EUR"),
      toCurrency: zod.z.string().describe("目标货币代码，例如 USD、JPY、HKD")
    })
  }
);
const webTools = [
  webSearchTool,
  currentWeatherTool,
  fetchUrlTool,
  currencyConvertTool
];
const allTools = [
  readFileTool,
  writeFileTool,
  listDirectoryTool,
  deleteFileTool,
  searchFilesTool,
  ...systemTools,
  ...webTools
];
let currentModel = "qwen2.5:3b";
function setModel(modelName) {
  currentModel = modelName;
}
function getModel() {
  return currentModel;
}
function buildLLM(streaming = false) {
  return new ollama.ChatOllama({
    model: currentModel,
    baseUrl: "http://localhost:11434",
    streaming
    // verbose: true, // 在主进程终端打印请求/响应详情
  });
}
async function fetchOllamaModels() {
  try {
    const res = await fetch("http://localhost:11434/api/tags");
    if (!res.ok) return [];
    const data = await res.json();
    return data.models.map((m) => m.name);
  } catch {
    return [];
  }
}
function toLC(msg) {
  if (msg.role === "user") return new messages.HumanMessage(msg.content);
  if (msg.role === "assistant") return new messages.AIMessage(msg.content);
  return new messages.SystemMessage(msg.content);
}
const SYSTEM_PROMPT = `你是一个智能助手，可以帮助用户对话、分析问题、联网查询信息，以及操作本地文件系统。
你拥有以下工具：
- read_file: 读取文件内容
- write_file: 写入文件
- list_directory: 列出目录内容
- delete_file: 删除文件
- search_files: 按文件名搜索文件
- get_current_time: 获取当前日期和时间
- calculator: 计算数学表达式
- unit_convert: 进行单位换算
- clipboard_copy: 复制文本到系统剪贴板
- web_search: 联网搜索公开网页信息
- fetch_url: 抓取网页标题和正文摘要
- get_weather_current: 查询当前天气
- currency_convert: 进行汇率换算

当用户需要操作文件、查询时间、做数学计算、单位换算、复制文本、联网获取信息、抓取网页内容、查询天气、汇率换算时，优先使用对应的工具。
回答尽量简洁清晰，使用 Markdown 格式。`;
async function chatWithAgent(history, userMessage, onToken, onToolCall, onToolResult, signal) {
  const llm = buildLLM(false);
  const llmWithTools = llm.bindTools(allTools);
  const streamingLLM = buildLLM(true);
  const messages$1 = [
    new messages.SystemMessage(SYSTEM_PROMPT),
    ...history.map(toLC),
    new messages.HumanMessage(userMessage)
  ];
  let fullResponse = "";
  for (let i = 0; i < 5; i++) {
    signal?.throwIfAborted();
    const response = await llmWithTools.invoke(messages$1, { signal });
    if (response.tool_calls && response.tool_calls.length > 0) {
      messages$1.push(response);
      for (const toolCall of response.tool_calls) {
        signal?.throwIfAborted();
        const tool = allTools.find((t) => t.name === toolCall.name);
        if (!tool) continue;
        onToolCall(toolCall.name, toolCall.args);
        const result = await tool.invoke(toolCall.args);
        const resultStr = String(result);
        onToolResult(toolCall.name, resultStr);
        messages$1.push({
          role: "tool",
          content: resultStr,
          tool_call_id: toolCall.id ?? ""
        });
      }
    } else {
      break;
    }
  }
  const stream = await streamingLLM.stream(messages$1, { signal });
  for await (const chunk of stream) {
    signal?.throwIfAborted();
    const token = typeof chunk.content === "string" ? chunk.content : "";
    if (token) {
      onToken(token);
      fullResponse += token;
    }
  }
  return fullResponse;
}
async function chatStream(history, userMessage, onToken, signal) {
  const llm = buildLLM(true);
  const messages$1 = [
    new messages.SystemMessage(SYSTEM_PROMPT),
    ...history.map(toLC),
    new messages.HumanMessage(userMessage)
  ];
  let fullResponse = "";
  const stream = await llm.stream(messages$1, { signal });
  for await (const chunk of stream) {
    signal?.throwIfAborted();
    const token = typeof chunk.content === "string" ? chunk.content : "";
    if (token) {
      onToken(token);
      fullResponse += token;
    }
  }
  return fullResponse;
}
function getDataDir() {
  const dir = path.join(electron.app.getPath("userData"), "ai-agent");
  if (!fs__namespace.existsSync(dir)) fs__namespace.mkdirSync(dir, { recursive: true });
  return dir;
}
function getConvDir() {
  const dir = path.join(getDataDir(), "conversations");
  if (!fs__namespace.existsSync(dir)) fs__namespace.mkdirSync(dir, { recursive: true });
  return dir;
}
const INDEX_FILE = () => path.join(getDataDir(), "index.json");
const ACTIVE_FILE = () => path.join(getDataDir(), "active.json");
function readJSON(filePath, fallback) {
  try {
    if (!fs__namespace.existsSync(filePath)) return fallback;
    return JSON.parse(fs__namespace.readFileSync(filePath, "utf-8"));
  } catch {
    return fallback;
  }
}
function writeJSON(filePath, data) {
  fs__namespace.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}
function listConversations() {
  return readJSON(INDEX_FILE(), []).sort(
    (a, b) => b.updatedAt - a.updatedAt
  );
}
function saveIndex(metas) {
  writeJSON(INDEX_FILE(), metas);
}
function loadConversation(id) {
  const file = path.join(getConvDir(), `${id}.json`);
  return readJSON(file, []);
}
function saveConversation(meta, messages2) {
  const metas = readJSON(INDEX_FILE(), []);
  const idx = metas.findIndex((m) => m.id === meta.id);
  if (idx >= 0) {
    metas[idx] = meta;
  } else {
    metas.unshift(meta);
  }
  saveIndex(metas);
  const file = path.join(getConvDir(), `${meta.id}.json`);
  writeJSON(file, messages2);
}
function deleteConversation(id) {
  const metas = readJSON(INDEX_FILE(), []);
  saveIndex(metas.filter((m) => m.id !== id));
  const file = path.join(getConvDir(), `${id}.json`);
  if (fs__namespace.existsSync(file)) fs__namespace.unlinkSync(file);
}
function updateConversationMeta(meta) {
  const metas = readJSON(INDEX_FILE(), []);
  const idx = metas.findIndex((m) => m.id === meta.id);
  if (idx >= 0) {
    metas[idx] = meta;
    saveIndex(metas);
  }
}
function getActiveId() {
  return readJSON(ACTIVE_FILE(), { id: null }).id;
}
function setActiveId(id) {
  writeJSON(ACTIVE_FILE(), { id });
}
let currentAbortController = null;
let currentWebContents = null;
function shouldUseAgentTools(message) {
  const text = message.toLowerCase();
  const toolIntentRegex = /(读取文件|读文件|写文件|删除文件|列出目录|搜索文件|当前时间|几点|计算|换算|单位|汇率|天气|联网|搜索|网页|链接|url|clipboard|copy|read file|write file|delete file|list directory|search files|time|calculate|calculator|unit convert|currency|weather|web search|fetch)/;
  return toolIntentRegex.test(text);
}
function createWindow() {
  const mainWindow = new electron.BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: "hiddenInset",
    backgroundColor: "#212121",
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow.on("ready-to-show", () => {
    mainWindow.show();
  });
  mainWindow.webContents.setWindowOpenHandler((details) => {
    electron.shell.openExternal(details.url);
    return { action: "deny" };
  });
  if (utils.is.dev && process.env["ELECTRON_RENDERER_URL"]) {
    mainWindow.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
}
electron.ipcMain.handle(
  "chat:send",
  async (event, {
    history,
    message,
    useAgent
  }) => {
    const webContents = event.sender;
    currentAbortController?.abort();
    const controller = new AbortController();
    currentAbortController = controller;
    currentWebContents = webContents;
    const { signal } = controller;
    try {
      const useTools = useAgent && shouldUseAgentTools(message);
      if (useTools) {
        await chatWithAgent(
          history,
          message,
          (token) => {
            webContents.send("chat:token", token);
          },
          (toolName, input) => {
            webContents.send("chat:tool-call", { toolName, input });
          },
          (toolName, result) => {
            webContents.send("chat:tool-result", { toolName, result });
          },
          signal
        );
      } else {
        await chatStream(
          history,
          message,
          (token) => {
            webContents.send("chat:token", token);
          },
          signal
        );
      }
      webContents.send("chat:done");
    } catch (err) {
      if (err?.name === "AbortError" || signal.aborted) {
        webContents.send("chat:done");
      } else {
        webContents.send("chat:error", err.message || "未知错误");
      }
    } finally {
      if (currentAbortController === controller) {
        currentAbortController = null;
        currentWebContents = null;
      }
    }
  }
);
electron.ipcMain.on("chat:abort", () => {
  if (currentWebContents && !currentWebContents.isDestroyed()) {
    currentWebContents.send("chat:done");
  }
  currentAbortController?.abort();
  currentAbortController = null;
  currentWebContents = null;
});
electron.ipcMain.handle("models:list", async () => {
  return fetchOllamaModels();
});
electron.ipcMain.handle("models:set", async (_event, modelName) => {
  setModel(modelName);
  return getModel();
});
electron.ipcMain.handle("models:get", async () => {
  return getModel();
});
electron.ipcMain.handle("storage:list", () => {
  return listConversations();
});
electron.ipcMain.handle("storage:load", (_event, id) => {
  return loadConversation(id);
});
electron.ipcMain.handle(
  "storage:save",
  (_event, meta, messages2) => {
    saveConversation(meta, messages2);
  }
);
electron.ipcMain.handle("storage:update-meta", (_event, meta) => {
  updateConversationMeta(meta);
});
electron.ipcMain.handle("storage:delete", (_event, id) => {
  deleteConversation(id);
});
electron.ipcMain.handle("storage:get-active", () => {
  return getActiveId();
});
electron.ipcMain.handle("storage:set-active", (_event, id) => {
  setActiveId(id);
});
electron.app.whenReady().then(() => {
  createWindow();
  electron.app.on("activate", function() {
    if (electron.BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
electron.app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    electron.app.quit();
  }
});
//# sourceMappingURL=index.js.map

"use strict";
const electron = require("electron");
const path = require("path");
const utils = require("@electron-toolkit/utils");
const ollama = require("@langchain/ollama");
const messages = require("@langchain/core/messages");
const node_crypto = require("node:crypto");
const promises = require("node:fs/promises");
const node_path = require("node:path");
const text_splitter = require("langchain/text_splitter");
const memory = require("langchain/vectorstores/memory");
const mammoth = require("mammoth");
const pdf = require("pdf-parse");
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
const embeddings = new ollama.OllamaEmbeddings({
  model: "nomic-embed-text",
  baseUrl: "http://localhost:11434"
});
const ragEntries = /* @__PURE__ */ new Map();
function normalizeText$2(text) {
  return text.replace(/\u0000/g, "").replace(/\r\n/g, "\n").trim();
}
async function extractTextFromFile(filePath) {
  const ext = node_path.extname(filePath).toLowerCase();
  if (ext === ".pdf") {
    const buffer = await promises.readFile(filePath);
    const result = await pdf(buffer);
    return normalizeText$2(result.text || "");
  }
  if (ext === ".docx") {
    const result = await mammoth.extractRawText({ path: filePath });
    return normalizeText$2(result.value || "");
  }
  const content = await promises.readFile(filePath, "utf-8");
  return normalizeText$2(content);
}
function toMeta(entry) {
  return {
    id: entry.id,
    name: entry.name,
    path: entry.path,
    chunks: entry.chunks,
    uploadedAt: entry.uploadedAt
  };
}
async function ingestFile(filePath) {
  const existing = [...ragEntries.values()].find(
    (item) => item.path === filePath
  );
  if (existing) {
    return toMeta(existing);
  }
  const text = await extractTextFromFile(filePath);
  if (!text) {
    throw new Error("文件内容为空，无法建立索引");
  }
  const splitter = new text_splitter.RecursiveCharacterTextSplitter({
    chunkSize: 900,
    chunkOverlap: 150
  });
  const docs = await splitter.createDocuments(
    [text],
    [
      {
        source: filePath,
        sourceName: node_path.basename(filePath)
      }
    ]
  );
  const store = await memory.MemoryVectorStore.fromDocuments(docs, embeddings);
  const entry = {
    id: node_crypto.randomUUID(),
    name: node_path.basename(filePath),
    path: filePath,
    chunks: docs.length,
    uploadedAt: Date.now(),
    store,
    docs: docs.map((doc) => ({
      pageContent: doc.pageContent,
      metadata: doc.metadata
    }))
  };
  ragEntries.set(entry.id, entry);
  return toMeta(entry);
}
function listRagFiles() {
  return [...ragEntries.values()].sort((a, b) => b.uploadedAt - a.uploadedAt).map(toMeta);
}
function removeRagFile(id) {
  return ragEntries.delete(id);
}
async function retrieveRelevantChunks(fileIds, query) {
  const docs = [];
  const normalizedQuery = query.trim().toLowerCase();
  const wantsOverview = /总结|概括|概述|全文|内容|讲了什么|说了什么|主要内容|描述|介绍|分析一下|看一下|看看/i.test(
    query
  );
  for (const fileId of fileIds) {
    const entry = ragEntries.get(fileId);
    if (!entry) continue;
    const baseName = entry.name.replace(/\.[^.]+$/, "").toLowerCase();
    const fileNameMatched = normalizedQuery.includes(entry.name.toLowerCase()) || normalizedQuery.includes(baseName);
    const matches = await entry.store.similaritySearch(
      query,
      wantsOverview || fileIds.length === 1 ? 6 : 4
    );
    docs.push(...matches);
    if ((wantsOverview || fileNameMatched || fileIds.length === 1) && entry.docs.length > 0) {
      docs.push(...entry.docs.slice(0, Math.min(4, entry.docs.length)));
    }
  }
  const uniqueDocs = docs.filter((doc, index, arr) => {
    const source = String(doc.metadata.sourceName || doc.metadata.source || "未知来源");
    const key = `${source}::${doc.pageContent}`;
    return arr.findIndex((item) => {
      const itemSource = String(
        item.metadata.sourceName || item.metadata.source || "未知来源"
      );
      return `${itemSource}::${item.pageContent}` === key;
    }) === index;
  });
  return uniqueDocs.slice(0, 6).map((doc, index) => ({
    index: index + 1,
    source: String(
      doc.metadata.sourceName || doc.metadata.source || "未知来源"
    ),
    content: doc.pageContent
  }));
}
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
function formatExpressionForDisplay(expression) {
  return expression.trim().replace(/[=？?]+$/g, "").replace(/\*/g, " × ").replace(/\//g, " ÷ ").replace(/\^/g, " ^ ").replace(/\s+/g, " ").trim();
}
function formatResultNumber(value) {
  if (Number.isInteger(value)) {
    return new Intl.NumberFormat("en-US").format(value);
  }
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 12
  }).format(value);
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
      const displayExpression = formatExpressionForDisplay(expression);
      const displayResult = formatResultNumber(result);
      return `计算结果: ${displayExpression} = ${displayResult}`;
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
function normalizeText$1(text) {
  return text.replace(/\s+/g, " ").trim();
}
function stripHtml(text) {
  return normalizeText$1(
    text.replace(/<[^>]+>/g, " ").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  );
}
function decodeHtmlEntities(text) {
  return text.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ");
}
function stripCdata(text) {
  return text.replace(/^<!\[CDATA\[|\]\]>$/g, "");
}
async function searchWithDuckDuckGo(query, limit) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0",
      "accept-language": "zh-CN,zh;q=0.9,en;q=0.8"
    },
    signal: AbortSignal.timeout(15e3)
  });
  if (!res.ok) {
    throw new Error(`DuckDuckGo HTTP ${res.status}`);
  }
  const html = await res.text();
  const matches = [
    ...html.matchAll(
      /<a[^>]*class=\"result__a\"[^>]*href=\"([^\"]+)\"[^>]*>([\s\S]*?)<\/a>/g
    )
  ];
  if (matches.length === 0) {
    throw new Error("DuckDuckGo 未返回可解析结果");
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
}
async function searchWithBing(query, limit) {
  const url = `https://www.bing.com/search?format=rss&q=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0",
      "accept-language": "zh-CN,zh;q=0.9,en;q=0.8"
    },
    signal: AbortSignal.timeout(15e3)
  });
  if (!res.ok) {
    throw new Error(`Bing HTTP ${res.status}`);
  }
  const xml = await res.text();
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, limit).map((match, index) => {
    const item = match[1];
    const title = normalizeText$1(
      decodeHtmlEntities(
        stripCdata(
          (item.match(/<title>([\s\S]*?)<\/title>/)?.[1] || "").trim()
        )
      )
    );
    const link = decodeHtmlEntities(
      (item.match(/<link>([\s\S]*?)<\/link>/)?.[1] || "").trim()
    );
    const description = normalizeText$1(
      decodeHtmlEntities(
        stripHtml(
          stripCdata(
            (item.match(/<description>([\s\S]*?)<\/description>/)?.[1] || "").trim()
          )
        )
      )
    );
    return title ? `${index + 1}. ${title}
${link}${description ? `
${description}` : ""}` : null;
  }).filter((entry) => Boolean(entry));
  if (items.length === 0) {
    throw new Error("Bing 未返回可解析结果");
  }
  return `搜索关键词: ${query}

${items.join("\n\n")}`;
}
const webSearchTool = tools.tool(
  async ({ query, maxResults }) => {
    const limit = Math.min(Math.max(maxResults ?? 5, 1), 10);
    try {
      return await searchWithDuckDuckGo(query, limit);
    } catch (duckError) {
      try {
        const fallback = await searchWithBing(query, limit);
        return `${fallback}

[说明] 默认搜索源暂时不可达，已自动切换到 Bing。`;
      } catch (bingError) {
        return `联网搜索失败: 默认搜索源（DuckDuckGo）不可达，备用搜索源（Bing）也不可达。DuckDuckGo: ${duckError?.message || "未知错误"}；Bing: ${bingError?.message || "未知错误"}`;
      }
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
      const title = titleMatch ? normalizeText$1(decodeHtmlEntities(stripHtml(titleMatch[1]))) : "无标题";
      const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
      const bodyText = normalizeText$1(
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
const OPENAI_COMPATIBLE_TOOLS = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "读取本地文件内容。",
      parameters: {
        type: "object",
        properties: {
          filePath: { type: "string", description: "要读取的文件路径" }
        },
        required: ["filePath"],
        additionalProperties: false
      }
    }
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
          content: { type: "string", description: "要写入的内容" }
        },
        required: ["filePath", "content"],
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "list_directory",
      description: "列出指定目录下的文件和子目录。",
      parameters: {
        type: "object",
        properties: {
          dirPath: { type: "string", description: "目录路径" }
        },
        required: ["dirPath"],
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "delete_file",
      description: "删除指定路径的文件。",
      parameters: {
        type: "object",
        properties: {
          filePath: { type: "string", description: "要删除的文件路径" }
        },
        required: ["filePath"],
        additionalProperties: false
      }
    }
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
          keyword: { type: "string", description: "文件名关键词" }
        },
        required: ["dirPath", "keyword"],
        additionalProperties: false
      }
    }
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
          locale: { type: "string", description: "语言区域，例如 zh-CN" }
        },
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "calculator",
      description: "计算数学表达式。",
      parameters: {
        type: "object",
        properties: {
          expression: { type: "string", description: "数学表达式" }
        },
        required: ["expression"],
        additionalProperties: false
      }
    }
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
          toUnit: { type: "string", description: "目标单位" }
        },
        required: ["value", "fromUnit", "toUnit"],
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "clipboard_copy",
      description: "将文本复制到系统剪贴板。",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "要复制的文本" }
        },
        required: ["text"],
        additionalProperties: false
      }
    }
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
          maxResults: { type: "number", description: "返回结果条数" }
        },
        required: ["query"],
        additionalProperties: false
      }
    }
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
          lang: { type: "string", description: "返回语言，例如 zh 或 en" }
        },
        required: ["location"],
        additionalProperties: false
      }
    }
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
          maxLength: { type: "number", description: "返回正文最大长度" }
        },
        required: ["url"],
        additionalProperties: false
      }
    }
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
          toCurrency: { type: "string", description: "目标货币代码" }
        },
        required: ["amount", "fromCurrency", "toCurrency"],
        additionalProperties: false
      }
    }
  }
];
function normalizeBaseUrl(baseUrl) {
  return baseUrl.trim().replace(/\/+$/, "");
}
function limitMessages(messages2, maxNonSystemMessages = 8) {
  const systemMessages = messages2.filter((item) => item.role === "system");
  const nonSystemMessages = messages2.filter((item) => item.role !== "system");
  if (nonSystemMessages.length <= maxNonSystemMessages) {
    return messages2;
  }
  const containsToolChain = nonSystemMessages.some(
    (item) => item.role === "tool" || item.role === "assistant" && item.tool_calls?.length
  );
  if (containsToolChain) {
    return messages2;
  }
  return [...systemMessages, ...nonSystemMessages.slice(-maxNonSystemMessages)];
}
function getProviderHint(settings) {
  return `${settings.provider || ""} ${settings.baseUrl || ""}`.toLowerCase();
}
function ensureOnlineSettings(settings, model) {
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
function buildHeaders(apiKey) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`
  };
}
async function extractErrorMessage(response) {
  const raw = await response.text();
  try {
    const data = JSON.parse(raw);
    return data.error?.message || data.message || `HTTP ${response.status}`;
  } catch {
    return raw || `HTTP ${response.status}`;
  }
}
function withProviderErrorHint(message, settings, model) {
  const providerHint = getProviderHint(settings);
  const isZhipu = providerHint.includes("智谱") || providerHint.includes("bigmodel");
  const balanceLikeError = /(余额不足|insufficient\s*balance|quota|bill|credit)/i.test(message);
  if (isZhipu && balanceLikeError) {
    return `${message}
提示：智谱在 Agent 模式下会附带工具描述和上下文，消耗会比普通聊天高。建议优先将 Agent 模型切换为 \`glm-4-flash\` 或 \`glm-4-air\`，避免使用 \`glm-4-plus\` 这类更高成本模型。`;
  }
  return message;
}
async function tryFetchBalance(settings, headers) {
  const providerHint = `${settings.provider || ""} ${settings.baseUrl || ""}`.toLowerCase();
  if (providerHint.includes("openrouter")) {
    try {
      const baseUrl = normalizeBaseUrl(settings.baseUrl || "");
      const response = await fetch(`${baseUrl}/credits`, {
        method: "GET",
        headers
      });
      if (!response.ok) {
        return "余额接口暂不可用";
      }
      const data = await response.json();
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
async function invokeOpenAICompatibleChat(options) {
  const { settings, model, messages: messages2, tools: tools2, signal } = options;
  const resolved = ensureOnlineSettings(settings, model);
  const hasTools = Boolean(tools2 && tools2.length > 0);
  const hasActiveToolMessages = messages2.some(
    (item) => item.role === "tool" || item.role === "assistant" && item.tool_calls?.length
  );
  const trimmedMessages = hasActiveToolMessages ? messages2 : limitMessages(messages2, hasTools ? 8 : 10);
  const providerHint = getProviderHint(settings);
  const isZhipu = providerHint.includes("智谱") || providerHint.includes("bigmodel");
  const maxTokens = hasTools ? isZhipu ? 1024 : 1400 : isZhipu ? 1200 : 1800;
  const response = await fetch(`${resolved.baseUrl}/chat/completions`, {
    method: "POST",
    headers: buildHeaders(resolved.apiKey),
    body: JSON.stringify({
      model: resolved.model,
      messages: trimmedMessages,
      tools: tools2,
      tool_choice: hasTools ? "auto" : void 0,
      stream: false,
      temperature: 0.2,
      max_tokens: maxTokens
    }),
    signal
  });
  if (!response.ok) {
    throw new Error(
      withProviderErrorHint(
        await extractErrorMessage(response),
        settings
      )
    );
  }
  const data = await response.json();
  const message = data.choices?.[0]?.message;
  return {
    content: message?.content || "",
    toolCalls: message?.tool_calls || []
  };
}
async function streamOpenAICompatibleChat(options) {
  const { settings, model, messages: messages2, onToken, signal } = options;
  const resolved = ensureOnlineSettings(settings, model);
  const providerHint = getProviderHint(settings);
  const isZhipu = providerHint.includes("智谱") || providerHint.includes("bigmodel");
  const trimmedMessages = limitMessages(messages2, 10);
  const response = await fetch(`${resolved.baseUrl}/chat/completions`, {
    method: "POST",
    headers: buildHeaders(resolved.apiKey),
    body: JSON.stringify({
      model: resolved.model,
      messages: trimmedMessages,
      stream: true,
      temperature: 0.3,
      max_tokens: isZhipu ? 1200 : 1800
    }),
    signal
  });
  if (!response.ok) {
    throw new Error(
      withProviderErrorHint(
        await extractErrorMessage(response),
        settings
      )
    );
  }
  if (!response.body) {
    const fallback = await response.json();
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
          const data = JSON.parse(payload);
          const delta = data.choices?.[0]?.delta;
          const token = delta?.content || delta?.reasoning_content || "";
          if (token) {
            onToken(token);
            fullResponse += token;
          }
        } catch {
        }
      }
    }
  }
  return fullResponse;
}
async function testOpenAICompatibleApi(options) {
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
      method: "GET"
    });
    const latencyMs = Date.now() - startedAt;
    if (response.ok) {
      const data = await response.json();
      const models = (data.data || []).map((item) => item.id || "").filter(Boolean).slice(0, 30);
      const balanceInfo2 = await tryFetchBalance(settings, headers);
      return {
        ok: true,
        message: models.length > 0 ? `API 连通正常，已获取 ${models.length} 个模型。` : "API 连通正常，但未返回模型列表。",
        models,
        latencyMs,
        balanceInfo: balanceInfo2,
        testedAt: Date.now()
      };
    }
    const fallbackModel = (model || "").trim();
    if (!fallbackModel) {
      return {
        ok: false,
        message: await extractErrorMessage(response),
        models: [],
        latencyMs,
        testedAt: Date.now()
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
        max_tokens: 8
      })
    });
    const chatLatency = Date.now() - chatStartedAt;
    if (!chatResponse.ok) {
      return {
        ok: false,
        message: await extractErrorMessage(chatResponse),
        models: [],
        latencyMs: chatLatency,
        testedAt: Date.now()
      };
    }
    const balanceInfo = await tryFetchBalance(settings, headers);
    return {
      ok: true,
      message: `API 连通正常，模型 ${fallbackModel} 可访问。`,
      models: [fallbackModel],
      latencyMs: chatLatency,
      balanceInfo,
      testedAt: Date.now()
    };
  } catch (error) {
    return {
      ok: false,
      message: error?.message || "API 测试失败",
      models: [],
      testedAt: Date.now()
    };
  }
}
function normalizeText(value) {
  return value.trim().toLowerCase();
}
function uniqueKeywords(keywords) {
  return Array.from(
    new Set(
      keywords.map((item) => item.trim()).filter(Boolean).map((item) => item.toLowerCase())
    )
  );
}
function sortSkills(skills) {
  return [...skills].sort(
    (a, b) => b.priority - a.priority || b.updatedAt - a.updatedAt
  );
}
function buildSkillPrompt(skill) {
  if (!skill?.enabled) return "";
  const lines = [`当前已激活本地技能：${skill.name}。`];
  if (skill.description.trim()) {
    lines.push(`技能说明：${skill.description.trim()}`);
  }
  if (skill.systemPrompt.trim()) {
    lines.push(`请额外遵循以下技能要求：
${skill.systemPrompt.trim()}`);
  }
  lines.push(
    "如果当前问题与该技能直接相关，请优先采用该技能的表达方式、结构和约束；如果不相关，则保持自然、准确、简洁地回答。"
  );
  return lines.join("\n");
}
function matchSkillForInput(message, skills) {
  const text = normalizeText(message);
  if (!text) return null;
  let best = null;
  for (const skill of sortSkills(skills)) {
    if (!skill.enabled) continue;
    const skillName = normalizeText(skill.name);
    const keywords = uniqueKeywords(skill.keywords);
    const matchedKeywords = keywords.filter(
      (keyword) => keyword.length >= 2 && text.includes(keyword)
    );
    const explicitMatch = skillName.length >= 2 && [text.includes(`#${skillName}`), text.includes(`【${skillName}】`)].some(
      Boolean
    );
    const nameMatch = skillName.length >= 2 && text.includes(skillName);
    let score = 0;
    if (explicitMatch) score += 1e3;
    if (nameMatch) score += 30;
    score += matchedKeywords.length * 12;
    if (score === 0) continue;
    score += Math.max(0, Math.min(skill.priority, 100)) / 100;
    const reason = explicitMatch ? `用户消息中显式指定了技能“${skill.name}”` : matchedKeywords.length > 0 ? `命中关键词：${matchedKeywords.join("、")}` : `命中技能名：${skill.name}`;
    if (!best || score > best.score) {
      best = { skill, score, matchedKeywords, reason };
    }
  }
  if (!best) return null;
  return {
    skill: best.skill,
    matchedKeywords: best.matchedKeywords,
    reason: best.reason
  };
}
const DEFAULT_ONLINE_SETTINGS = {
  name: "默认在线配置",
  provider: "OpenAI",
  baseUrl: "https://api.openai.com/v1",
  apiKey: ""
};
const modelConfig = {
  chat: { provider: "ollama", model: "qwen2.5:3b" },
  agent: { provider: "ollama", model: "qwen2.5:3b" },
  rag: { provider: "ollama", model: "qwen2.5:3b" },
  online: { ...DEFAULT_ONLINE_SETTINGS },
  onlineProfiles: [],
  activeOnlineProfileId: null
};
function pickPreferredModel(models, matchers) {
  for (const matcher of matchers) {
    const found = models.find((model) => matcher.test(model));
    if (found) return found;
  }
  return models[0] ?? null;
}
function autoConfigureModels(models) {
  const textModels = models.filter((model) => !/embed/i.test(model));
  if (textModels.length === 0) return;
  const chatCandidate = pickPreferredModel(textModels, [
    /qwen.*(1\.5b|3b)|phi|mini|small|gemma.*2b/i,
    /(1\.5b|2b|3b)/i
  ]) ?? textModels[0];
  const advancedCandidate = pickPreferredModel(textModels, [
    /7b|8b|14b|32b|70b|coder|instruct|deepseek|llama3|qwq/i,
    /qwen/i
  ]) ?? chatCandidate;
  if (modelConfig.chat.provider === "ollama" && !textModels.includes(modelConfig.chat.model)) {
    modelConfig.chat.model = chatCandidate;
  }
  if (modelConfig.agent.provider === "ollama" && !textModels.includes(modelConfig.agent.model)) {
    modelConfig.agent.model = advancedCandidate;
  }
  if (modelConfig.rag.provider === "ollama" && !textModels.includes(modelConfig.rag.model)) {
    modelConfig.rag.model = advancedCandidate;
  }
}
function applyModelSettings(settings) {
  if (settings.chatModel) modelConfig.chat.model = settings.chatModel;
  if (settings.agentModel) modelConfig.agent.model = settings.agentModel;
  if (settings.ragModel) modelConfig.rag.model = settings.ragModel;
  if (settings.chatProvider) modelConfig.chat.provider = settings.chatProvider;
  if (settings.agentProvider)
    modelConfig.agent.provider = settings.agentProvider;
  if (settings.ragProvider) modelConfig.rag.provider = settings.ragProvider;
  if (settings.online) {
    modelConfig.online = {
      ...modelConfig.online,
      ...settings.online
    };
  }
  if (Array.isArray(settings.onlineProfiles)) {
    modelConfig.onlineProfiles = settings.onlineProfiles;
  }
  if ("activeOnlineProfileId" in settings) {
    modelConfig.activeOnlineProfileId = settings.activeOnlineProfileId ?? null;
  }
}
function getModelSettingsSnapshot() {
  return {
    chatModel: modelConfig.chat.model,
    agentModel: modelConfig.agent.model,
    ragModel: modelConfig.rag.model,
    chatProvider: modelConfig.chat.provider,
    agentProvider: modelConfig.agent.provider,
    ragProvider: modelConfig.rag.provider,
    online: { ...modelConfig.online },
    onlineProfiles: [...modelConfig.onlineProfiles],
    activeOnlineProfileId: modelConfig.activeOnlineProfileId
  };
}
function setChatModel(modelName) {
  modelConfig.chat.model = modelName;
}
function getChatModel() {
  return modelConfig.chat.model;
}
function setAgentModel(modelName) {
  modelConfig.agent.model = modelName;
}
function getAgentModel() {
  return modelConfig.agent.model;
}
function setRagModel(modelName) {
  modelConfig.rag.model = modelName;
}
function getRagModel() {
  return modelConfig.rag.model;
}
function getChatProvider() {
  return modelConfig.chat.provider;
}
function getAgentProvider() {
  return modelConfig.agent.provider;
}
function describeRouteModel(routeKey) {
  const route = modelConfig[routeKey];
  if (route.provider === "ollama") {
    return `${route.model} · Ollama`;
  }
  const activeProfile = modelConfig.onlineProfiles.find(
    (profile) => profile.id === modelConfig.activeOnlineProfileId
  );
  const providerLabel = activeProfile?.name || modelConfig.online.provider || "在线 API";
  return `${providerLabel} · ${route.model}`;
}
function buildLLM(modelName, streaming = false) {
  return new ollama.ChatOllama({
    model: modelName,
    baseUrl: "http://localhost:11434",
    streaming
  });
}
async function streamFromOllama(modelName, messages2, onToken, signal) {
  const llm = buildLLM(modelName, true);
  let fullResponse = "";
  const stream = await llm.stream(messages2, { signal });
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
async function fetchOllamaModels() {
  try {
    const res = await fetch("http://localhost:11434/api/tags");
    if (!res.ok) return [];
    const data = await res.json();
    const models = data.models.map((m) => m.name);
    autoConfigureModels(models);
    return models;
  } catch {
    return [];
  }
}
function toLC(msg) {
  if (msg.role === "user") return new messages.HumanMessage(msg.content);
  if (msg.role === "assistant") return new messages.AIMessage(msg.content);
  return new messages.SystemMessage(msg.content);
}
function toCompatibleMessage(msg) {
  return {
    role: msg.role,
    content: msg.content
  };
}
function parseToolArguments(raw) {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}
const BASE_SYSTEM_PROMPT = `你是一个智能助手，可以帮助用户对话、分析问题、联网查询信息，以及操作本地文件系统。
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
对于明确的算式或数学表达式，请优先调用 calculator 工具，不要凭心算直接猜。
回答尽量简洁清晰，使用 Markdown 格式；输出数学结果时请使用普通文本符号（如 ×、÷、=），不要输出 LaTeX 写法如 	imes。`;
function buildRuntimeContextPrompt() {
  const now = /* @__PURE__ */ new Date();
  const display = new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "full",
    timeStyle: "medium",
    timeZone: "Asia/Shanghai"
  }).format(now);
  return `当前系统时间参考：${display}（Asia/Shanghai），ISO：${now.toISOString()}。
如果用户询问“今天是哪天 / 今天几号 / 星期几 / 现在几点 / 当前日期”等实时问题，必须优先依据这个时间参考或调用 get_current_time 工具回答，不能凭训练记忆猜测。`;
}
function buildSystemPrompt(skill) {
  const skillPrompt = buildSkillPrompt(skill);
  return [BASE_SYSTEM_PROMPT, buildRuntimeContextPrompt(), skillPrompt].filter(Boolean).join("\n\n");
}
async function chatWithAgent(history, userMessage, onToken, onToolCall, onToolResult, signal, skill) {
  const route = modelConfig.agent;
  if (route.provider === "openai-compatible") {
    const messages2 = [
      { role: "system", content: buildSystemPrompt(skill) },
      ...history.map(toCompatibleMessage),
      { role: "user", content: userMessage }
    ];
    for (let i = 0; i < 5; i++) {
      signal?.throwIfAborted();
      const response = await invokeOpenAICompatibleChat({
        settings: modelConfig.online,
        model: route.model,
        messages: messages2,
        tools: OPENAI_COMPATIBLE_TOOLS,
        signal
      });
      if (response.toolCalls.length > 0) {
        messages2.push({
          role: "assistant",
          content: response.content || "",
          tool_calls: response.toolCalls
        });
        for (const toolCall of response.toolCalls) {
          signal?.throwIfAborted();
          const tool = allTools.find(
            (item) => item.name === toolCall.function.name
          );
          if (!tool) continue;
          const args = parseToolArguments(toolCall.function.arguments);
          onToolCall(toolCall.function.name, args);
          const result = await tool.invoke(args);
          const resultStr = String(result);
          onToolResult(toolCall.function.name, resultStr);
          messages2.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: resultStr
          });
        }
        continue;
      }
      if (response.content) {
        onToken(response.content);
        return response.content;
      }
    }
    return streamOpenAICompatibleChat({
      settings: modelConfig.online,
      model: route.model,
      messages: messages2,
      onToken,
      signal
    });
  }
  const llm = buildLLM(route.model, false);
  const llmWithTools = llm.bindTools(allTools);
  const messages$1 = [
    new messages.SystemMessage(buildSystemPrompt(skill)),
    ...history.map(toLC),
    new messages.HumanMessage(userMessage)
  ];
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
  return streamFromOllama(route.model, messages$1, onToken, signal);
}
async function chatWithRag(history, userMessage, fileIds, onToken, signal, skill) {
  const route = modelConfig.rag;
  const chunks = await retrieveRelevantChunks(fileIds, userMessage);
  const activeFileNames = listRagFiles().filter((file) => fileIds.includes(file.id)).map((file) => file.name);
  const contextText = chunks.length ? chunks.map(
    (chunk) => `【片段 ${chunk.index}｜${chunk.source}】
${chunk.content}`
  ).join("\n\n") : "未检索到可用文档片段。";
  const scopedHistory = history.filter((msg) => msg.role === "user").slice(-4);
  const fileScopeText = activeFileNames.length ? activeFileNames.join("、") : "当前没有激活的文档";
  const skillPrompt = buildSkillPrompt(skill);
  const ragPrompt = `你是一个文档分析助手。当前有效文档仅限：${fileScopeText}。
请优先依据“检索上下文”回答问题，并尽量给出简洁结论。
如果用户之前聊过其他文件、旧版本文件或已移除的文件，你必须忽略那些历史内容，不能沿用旧文件信息。
如果当前只有一个已上传文件，而用户问“这个文件讲了什么 / 具体内容是什么 / 帮我总结一下”，应将其理解为对该文件整体内容的概括请求。
只要已经检索到片段，就要先基于片段进行总结、概括或引用；只有在完全没有检索到片段时，才明确说明“在当前已上传文件中未找到明确依据”，不要轻易直接拒答。${skillPrompt ? `

${skillPrompt}` : ""}`;
  if (route.provider === "openai-compatible") {
    return streamOpenAICompatibleChat({
      settings: modelConfig.online,
      model: route.model,
      messages: [
        { role: "system", content: ragPrompt },
        { role: "system", content: `检索上下文：
${contextText}` },
        ...scopedHistory.map(toCompatibleMessage),
        { role: "user", content: userMessage }
      ],
      onToken,
      signal
    });
  }
  const messages$1 = [
    new messages.SystemMessage(ragPrompt),
    new messages.SystemMessage(`检索上下文：
${contextText}`),
    ...scopedHistory.map(toLC),
    new messages.HumanMessage(userMessage)
  ];
  return streamFromOllama(route.model, messages$1, onToken, signal);
}
async function chatStream(history, userMessage, onToken, signal, modelName = modelConfig.chat.model, provider = modelConfig.chat.provider, skill) {
  const route = {
    provider,
    model: modelName || modelConfig.chat.model
  };
  if (route.provider === "openai-compatible") {
    return streamOpenAICompatibleChat({
      settings: modelConfig.online,
      model: route.model,
      messages: [
        { role: "system", content: buildSystemPrompt(skill) },
        ...history.map(toCompatibleMessage),
        { role: "user", content: userMessage }
      ],
      onToken,
      signal
    });
  }
  const messages$1 = [
    new messages.SystemMessage(buildSystemPrompt(skill)),
    ...history.map(toLC),
    new messages.HumanMessage(userMessage)
  ];
  return streamFromOllama(route.model, messages$1, onToken, signal);
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
const SETTINGS_FILE = () => path.join(getDataDir(), "settings.json");
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
function getModelSettings() {
  return readJSON(SETTINGS_FILE(), {});
}
function saveModelSettings(settings) {
  const prev = getModelSettings();
  writeJSON(SETTINGS_FILE(), { ...prev, ...settings });
}
function getSkills() {
  const settings = getModelSettings();
  return Array.isArray(settings.skills) ? settings.skills : [];
}
function saveSkills(skills) {
  saveModelSettings({ skills });
}
let currentAbortController = null;
let currentWebContents = null;
function shouldUseAgentTools(message) {
  const text = message.toLowerCase();
  const toolIntentRegex = /(读取文件|读文件|写文件|删除文件|列出目录|搜索文件|当前时间|当前日期|今天几号|今天是几号|今天几月几号|今天星期几|今天周几|今天是哪天|几号|几月几号|星期几|周几|日期|几点|计算|换算|单位|汇率|天气|联网|搜索|网页|链接|url|clipboard|copy|read file|write file|delete file|list directory|search files|time|date|today|day of week|calculate|calculator|unit convert|currency|weather|web search|fetch)/;
  return toolIntentRegex.test(text);
}
function shouldUseRealtimeTool(message) {
  const text = message.toLowerCase();
  const realtimeIntentRegex = /(今天|现在|当前|今日).*(日期|时间|几点|几号|星期几|周几|哪天)|((what|which)\s+day\s+is\s+it)|(today'?s?\s+date)|current\s+(date|time)/;
  return realtimeIntentRegex.test(text);
}
function shouldUseAdvancedModel(message) {
  const text = message.toLowerCase();
  const advancedIntentRegex = /(代码|编程|函数|组件|报错|错误|bug|调试|修复|重构|优化|架构|设计|分析|方案|总结|脚本|sql|正则|code|debug|fix|refactor|optimi[sz]e|architecture|analy[sz]e|plan)/;
  return advancedIntentRegex.test(text) || message.length > 120 || /\n/.test(message);
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
    useAgent,
    fileIds
  }) => {
    const webContents = event.sender;
    currentAbortController?.abort();
    const controller = new AbortController();
    currentAbortController = controller;
    currentWebContents = webContents;
    const { signal } = controller;
    try {
      const useRag = Array.isArray(fileIds) && fileIds.length > 0;
      const matchedSkill = matchSkillForInput(message, getSkills());
      const preferredScene = matchedSkill?.skill.preferredScene ?? "auto";
      const useRealtimeTool = !useRag && shouldUseRealtimeTool(message);
      let useTools = !useRag && (useRealtimeTool || useAgent && shouldUseAgentTools(message));
      let useAdvancedModel = !useRag && (useTools || shouldUseAdvancedModel(message));
      if (!useRag && preferredScene === "chat" && !useRealtimeTool) {
        useTools = false;
        useAdvancedModel = false;
      } else if (!useRag && preferredScene === "agent") {
        useTools = true;
        useAdvancedModel = true;
      }
      const effectiveHistory = useRealtimeTool ? [] : history;
      const modelInfo = useRag ? {
        model: describeRouteModel("rag"),
        scene: "RAG",
        skill: matchedSkill?.skill.name
      } : useTools ? {
        model: describeRouteModel("agent"),
        scene: "Agent/工具",
        skill: matchedSkill?.skill.name
      } : useAdvancedModel ? {
        model: describeRouteModel("agent"),
        scene: "复杂任务",
        skill: matchedSkill?.skill.name
      } : {
        model: describeRouteModel("chat"),
        scene: "普通对话",
        skill: matchedSkill?.skill.name
      };
      webContents.send("chat:model-info", modelInfo);
      if (useRag) {
        await chatWithRag(
          effectiveHistory,
          message,
          fileIds,
          (token) => {
            webContents.send("chat:token", token);
          },
          signal,
          matchedSkill?.skill
        );
      } else if (useTools) {
        await chatWithAgent(
          effectiveHistory,
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
          signal,
          matchedSkill?.skill
        );
      } else {
        await chatStream(
          effectiveHistory,
          message,
          (token) => {
            webContents.send("chat:token", token);
          },
          signal,
          useAdvancedModel ? getAgentModel() : getChatModel(),
          useAdvancedModel ? getAgentProvider() : getChatProvider(),
          matchedSkill?.skill
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
electron.ipcMain.handle("settings:get-model-config", async () => {
  return getModelSettingsSnapshot();
});
electron.ipcMain.handle(
  "settings:save-model-config",
  async (_event, settings) => {
    applyModelSettings(settings);
    const snapshot = getModelSettingsSnapshot();
    saveModelSettings(snapshot);
    return snapshot;
  }
);
electron.ipcMain.handle(
  "settings:test-online",
  async (_event, payload) => {
    return testOpenAICompatibleApi({
      settings: payload.online,
      model: payload.model
    });
  }
);
electron.ipcMain.handle("skills:list", async () => {
  return getSkills();
});
electron.ipcMain.handle("skills:save", async (_event, skills) => {
  saveSkills(skills);
  return getSkills();
});
electron.ipcMain.handle("rag:pick-files", async (event) => {
  const result = await electron.dialog.showOpenDialog({
    properties: ["openFile", "multiSelections"],
    filters: [
      {
        name: "Documents",
        extensions: ["txt", "md", "pdf", "docx", "csv", "json", "ts", "js"]
      },
      { name: "All Files", extensions: ["*"] }
    ]
  });
  if (result.canceled || result.filePaths.length === 0) {
    event.sender.send("rag:status", { status: "idle", message: "" });
    return [];
  }
  const total = result.filePaths.length;
  const uploaded = [];
  try {
    event.sender.send("rag:status", {
      status: "processing",
      current: 0,
      total,
      message: total > 1 ? `已选择 ${total} 个文件，正在依次解析并建立索引...` : "文件已选择，正在解析并建立索引..."
    });
    for (let i = 0; i < total; i++) {
      const filePath = result.filePaths[i];
      event.sender.send("rag:status", {
        status: "processing",
        current: i + 1,
        total,
        fileName: path.basename(filePath),
        message: `正在分析 ${path.basename(filePath)}（${i + 1}/${total}）...`
      });
      uploaded.push(await ingestFile(filePath));
    }
    event.sender.send("rag:status", {
      status: "completed",
      current: total,
      total,
      message: total > 1 ? `已完成 ${total} 个文件的分析，现在可以开始提问。` : "文件分析完成，现在可以开始提问。"
    });
    return uploaded;
  } catch (error) {
    event.sender.send("rag:status", {
      status: "error",
      current: uploaded.length,
      total,
      message: error?.message || "文档分析失败，请稍后重试。"
    });
    throw new Error(
      error?.message || "文档解析或向量化失败，请确认 Ollama 已安装并可用 `nomic-embed-text` 模型。"
    );
  }
});
electron.ipcMain.handle("rag:list", () => {
  return listRagFiles();
});
electron.ipcMain.handle("rag:remove", (_event, id) => {
  return removeRagFile(id);
});
electron.ipcMain.handle("models:set", async (_event, modelName) => {
  setChatModel(modelName);
  saveModelSettings({ chatModel: getChatModel() });
  return getChatModel();
});
electron.ipcMain.handle("models:set-chat", async (_event, modelName) => {
  setChatModel(modelName);
  saveModelSettings({ chatModel: getChatModel() });
  return getChatModel();
});
electron.ipcMain.handle("models:get", async () => {
  return getChatModel();
});
electron.ipcMain.handle("models:get-chat", async () => {
  return getChatModel();
});
electron.ipcMain.handle("models:set-agent", async (_event, modelName) => {
  setAgentModel(modelName);
  saveModelSettings({ agentModel: getAgentModel() });
  return getAgentModel();
});
electron.ipcMain.handle("models:get-agent", async () => {
  return getAgentModel();
});
electron.ipcMain.handle("models:set-rag", async (_event, modelName) => {
  setRagModel(modelName);
  saveModelSettings({ ragModel: getRagModel() });
  return getRagModel();
});
electron.ipcMain.handle("models:get-rag", async () => {
  return getRagModel();
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
electron.app.whenReady().then(async () => {
  const savedSettings = getModelSettings();
  applyModelSettings(savedSettings);
  await fetchOllamaModels();
  saveModelSettings(getModelSettingsSnapshot());
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

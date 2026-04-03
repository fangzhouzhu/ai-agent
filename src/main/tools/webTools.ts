import { tool, type DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function stripHtml(text: string): string {
  return normalizeText(
    text
      .replace(/<[^>]+>/g, " ")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">"),
  );
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");
}

export const webSearchTool = tool(
  async ({ query, maxResults }) => {
    try {
      const limit = Math.min(Math.max(maxResults ?? 5, 1), 10);
      const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
      const res = await fetch(url, {
        headers: {
          "user-agent": "Mozilla/5.0",
        },
      });

      if (!res.ok) {
        return `联网搜索失败: HTTP ${res.status}`;
      }

      const html = await res.text();
      const matches = [
        ...html.matchAll(
          /<a[^>]*class=\"result__a\"[^>]*href=\"([^\"]+)\"[^>]*>([\s\S]*?)<\/a>/g,
        ),
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

        return `${index + 1}. ${title}\n${decodedUrl}`;
      });

      return `搜索关键词: ${query}\n\n${results.join("\n\n")}`;
    } catch (e: any) {
      return `联网搜索失败: ${e.message}`;
    }
  },
  {
    name: "web_search",
    description: "联网搜索公开网页信息，返回若干条搜索结果标题和链接。",
    schema: z.object({
      query: z.string().describe("搜索关键词"),
      maxResults: z
        .number()
        .int()
        .min(1)
        .max(10)
        .optional()
        .describe("返回结果条数，默认 5"),
    }),
  },
);

export const currentWeatherTool = tool(
  async ({ location, lang }) => {
    try {
      const locale = lang || "zh";
      const url = `https://wttr.in/${encodeURIComponent(location)}?format=j1&lang=${encodeURIComponent(locale)}`;
      const res = await fetch(url, {
        headers: {
          "user-agent": "curl/8.0",
        },
      });

      if (!res.ok) {
        return `天气查询失败: HTTP ${res.status}`;
      }

      const data = (await res.json()) as {
        current_condition?: Array<{
          temp_C?: string;
          FeelsLikeC?: string;
          humidity?: string;
          windspeedKmph?: string;
          winddir16Point?: string;
          weatherDesc?: Array<{ value?: string }>;
        }>;
      };

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
        `风向: ${current.winddir16Point || "未知"}`,
      ].join("\n");
    } catch (e: any) {
      return `天气查询失败: ${e.message}`;
    }
  },
  {
    name: "get_weather_current",
    description: "查询指定地点的当前天气情况。",
    schema: z.object({
      location: z.string().describe("地点名称，例如 北京、Shanghai、New York"),
      lang: z.string().optional().describe("返回语言，例如 zh、en"),
    }),
  },
);

export const fetchUrlTool = tool(
  async ({ url, maxLength }) => {
    try {
      const limit = Math.min(Math.max(maxLength ?? 4000, 500), 12000);
      const res = await fetch(url, {
        headers: {
          "user-agent": "Mozilla/5.0",
        },
      });

      if (!res.ok) {
        return `网页抓取失败: HTTP ${res.status}`;
      }

      const html = await res.text();
      const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      const title = titleMatch
        ? normalizeText(decodeHtmlEntities(stripHtml(titleMatch[1])))
        : "无标题";

      const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
      const bodyText = normalizeText(
        decodeHtmlEntities(
          stripHtml(bodyMatch ? bodyMatch[1] : html).replace(
            /(script|style)[\s\S]*?(script|style)/gi,
            " ",
          ),
        ),
      );

      if (!bodyText) {
        return `网页标题: ${title}\n链接: ${url}\n\n未提取到正文内容`;
      }

      const excerpt = bodyText.slice(0, limit);
      const truncated =
        bodyText.length > excerpt.length ? "\n\n[内容已截断]" : "";

      return `网页标题: ${title}\n链接: ${url}\n\n正文:\n${excerpt}${truncated}`;
    } catch (e: any) {
      return `网页抓取失败: ${e.message}`;
    }
  },
  {
    name: "fetch_url",
    description: "抓取指定网页内容，返回标题和清洗后的正文摘要。",
    schema: z.object({
      url: z.string().url().describe("要抓取的网页链接"),
      maxLength: z
        .number()
        .int()
        .min(500)
        .max(12000)
        .optional()
        .describe("返回正文最大长度，默认 4000"),
    }),
  },
);

export const currencyConvertTool = tool(
  async ({ amount, fromCurrency, toCurrency }) => {
    try {
      const from = fromCurrency.toUpperCase();
      const to = toCurrency.toUpperCase();
      const url = `https://open.er-api.com/v6/latest/${encodeURIComponent(from)}`;
      const res = await fetch(url, {
        headers: {
          "user-agent": "Mozilla/5.0",
        },
      });

      if (!res.ok) {
        return `汇率换算失败: HTTP ${res.status}`;
      }

      const data = (await res.json()) as {
        result?: string;
        base_code?: string;
        time_last_update_utc?: string;
        rates?: Record<string, number>;
      };

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
        `更新时间: ${data.time_last_update_utc || "未知"}`,
      ].join("\n");
    } catch (e: any) {
      return `汇率换算失败: ${e.message}`;
    }
  },
  {
    name: "currency_convert",
    description: "货币汇率换算工具，支持常见国际货币代码。",
    schema: z.object({
      amount: z.number().describe("要换算的金额"),
      fromCurrency: z.string().describe("原始货币代码，例如 CNY、USD、EUR"),
      toCurrency: z.string().describe("目标货币代码，例如 USD、JPY、HKD"),
    }),
  },
);

export const webTools: DynamicStructuredTool[] = [
  webSearchTool,
  currentWeatherTool,
  fetchUrlTool,
  currencyConvertTool,
];

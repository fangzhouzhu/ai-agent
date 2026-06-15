import { tool, type DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function normalizeWeatherLocation(raw: string): string {
  return raw
    .trim()
    .replace(/^(查|看|问|帮我查|帮我看|请查一下|请问一下)/, "")
    .replace(/(今天|明天|后天|现在|当前|此刻|实时)+$/g, "")
    .replace(/(天气|气温|温度|下雨|下雪|阴晴|风力|怎么样|如何|多少)+$/g, "")
    .replace(/(的|地区)+$/g, "")
    .trim();
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

function stripCdata(text: string): string {
  return text.replace(/^<!\[CDATA\[|\]\]>$/g, "");
}

function isFinanceQuery(query: string): boolean {
  return /(股市|a股|港股|美股|股票|大盘|指数|行情|上证|深证|创业板|财经|财报|资金流向)/i.test(
    query,
  );
}

function isPhoneLaunchQuery(query: string): boolean {
  return /(手机|新机|发布会|发布|参数|配置|影像|售价|开售|真机图|渲染图|样张|厂商|品牌)/i.test(
    query,
  );
}

function extractPhoneBrands(text: string): string[] {
  const brandPatterns: Array<[string, RegExp]> = [
    ["华为", /华为|\bhuawei\b/i],
    ["荣耀", /荣耀|\bhonor\b/i],
    ["小米", /小米|\bxiaomi\b|\bredmi\b/i],
    ["vivo", /\bvivo\b/i],
    ["OPPO", /\boppo\b/i],
    ["iQOO", /\biqoo\b/i],
    ["一加", /一加|\boneplus\b/i],
    ["realme", /\brealme\b/i],
  ];

  return brandPatterns
    .filter(([, pattern]) => pattern.test(text))
    .map(([brand]) => brand);
}

function appendMissingKeywords(base: string, keywords: string[]): string {
  const missing = keywords.filter((keyword) => !base.includes(keyword));
  return missing.length > 0 ? `${base} ${missing.join(" ")}` : base;
}

function enhanceSearchQuery(query: string): string {
  const normalized = query.trim();
  if (/site:/i.test(normalized)) {
    return normalized;
  }
  if (isFinanceQuery(normalized)) {
    return `${normalized} 东方财富 新浪财经 同花顺 上证指数 深证成指 创业板指`;
  }

  if (isPhoneLaunchQuery(normalized)) {
    const brands = extractPhoneBrands(normalized);
    const withTopicKeywords = appendMissingKeywords(normalized, [
      "新机",
      "发布",
      "参数",
      "图片",
    ]);
    return appendMissingKeywords(
      withTopicKeywords,
      brands.length > 0
        ? [...brands, "手机中国", "中关村在线", "IT之家"]
        : ["国产手机", "发布会", "手机中国", "中关村在线", "IT之家"],
    );
  }

  return normalized;
}

function isClearlyIrrelevantFinanceResult(result: string): boolean {
  const lower = result.toLowerCase();
  const badMatches = (
    lower.match(
      /support\.microsoft|oxfordlearnersdictionaries|collinsdictionary/g,
    ) || []
  ).length;
  const goodMatches = (
    lower.match(
      /eastmoney|finance\.sina|10jqka|cnstock|stcn|cs\.com\.cn|finance\.qq/g,
    ) || []
  ).length;

  return badMatches >= 2 && goodMatches === 0;
}

function isClearlyIrrelevantPhoneResult(result: string): boolean {
  const lower = result.toLowerCase();
  const badMatches = (
    lower.match(
      /gov\.cn|s\.gov\.cn|holiday|日历|节假日|东盟|政策|国务院|放假|校历|农历/g,
    ) || []
  ).length;
  const goodMatches = (
    lower.match(
      /手机|新机|发布|发布会|参数|配置|影像|it之家|mydrivers|zol|pconline|cnmo|xiaomi|huawei|honor|oppo|vivo|iqoo|oneplus|realme|meizu|smartisan|nubia|redmi|一加|荣耀|华为|小米|真机图|渲染图/g,
    ) || []
  ).length;

  return badMatches >= 2 && goodMatches <= 2;
}

function hasPreferredPhoneSources(result: string): boolean {
  return /(ithome|mydrivers|zol|pconline|cnmo|gsmarena|91mobiles|techweb|搜狐数码|太平洋科技|中关村在线|手机中国|oppo\.com|vivo\.com|huawei\.com|honor\.com|mi\.com|xiaomi\.com|iqoo\.com|oneplus\.com|realme\.com)/i.test(
    result,
  );
}

function hasPreferredPhoneSourceUrl(url: string): boolean {
  return /(ithome\.com|mydrivers\.com|zol\.com(\.cn)?|pconline\.com(\.cn)?|cnmo\.com|gsmarena\.com|91mobiles\.com|techweb\.com|oppo\.com(\.cn)?|vivo\.com(\.cn)?|huawei\.com|consumer\.huawei\.com|honor\.com|honor\.cn|mi\.com|xiaomi\.com|iqoo\.com(\.cn)?|oneplus\.com(\.cn)?|realme\.com(\.cn)?)/i.test(
    url,
  );
}

function isBlockedPhoneSourceUrl(url: string): boolean {
  return /(gov\.cn|calendar|festival|holiday|ncaa\.com|baibaidu\.com|baike\.baidu\.com|wikipedia\.org|sports|travel|weather)/i.test(
    url,
  );
}

function filterPhoneSearchResults(rawResult: string): string {
  const blocks = rawResult
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean);

  if (blocks.length <= 1) {
    return rawResult;
  }

  const [header, ...entries] = blocks;
  const filteredEntries = entries.filter((entry) => {
    const lines = entry.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const url = lines.find((line) => /^https?:\/\//i.test(line));
    if (!url) return false;
    if (isBlockedPhoneSourceUrl(url)) return false;

    const haystack = entry.toLowerCase();
    const hasPhoneKeywords =
      /鎵嬫満|鏂版満|鍙戝竷|鍙傛暟|閰嶇疆|褰卞儚|鍥剧墖|huawei|honor|xiaomi|redmi|vivo|oppo|iqoo|oneplus|realme|meizu|nubia/i.test(
        haystack,
      );

    return hasPreferredPhoneSourceUrl(url) || hasPhoneKeywords;
  });

  if (filteredEntries.length === 0) {
    return header;
  }

  return [header, ...filteredEntries].join("\n\n");
}

function hasSearchResultEntries(result: string): boolean {
  return /^\d+\.\s+/m.test(result);
}

async function searchWithDuckDuckGo(
  query: string,
  limit: number,
): Promise<string> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0",
      "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
    },
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    throw new Error(`DuckDuckGo HTTP ${res.status}`);
  }

  const html = await res.text();
  const matches = [
    ...html.matchAll(
      /<a[^>]*class=\"result__a\"[^>]*href=\"([^\"]+)\"[^>]*>([\s\S]*?)<\/a>/g,
    ),
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

    return `${index + 1}. ${title}\n${decodedUrl}`;
  });

  return `搜索关键词: ${query}\n\n${results.join("\n\n")}`;
}

async function searchWithBing(query: string, limit: number): Promise<string> {
  const url = `https://www.bing.com/search?format=rss&q=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0",
      "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
    },
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    throw new Error(`Bing HTTP ${res.status}`);
  }

  const xml = await res.text();
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)]
    .slice(0, limit)
    .map((match, index) => {
      const item = match[1];
      const title = normalizeText(
        decodeHtmlEntities(
          stripCdata(
            (item.match(/<title>([\s\S]*?)<\/title>/)?.[1] || "").trim(),
          ),
        ),
      );
      const link = decodeHtmlEntities(
        (item.match(/<link>([\s\S]*?)<\/link>/)?.[1] || "").trim(),
      );
      const description = normalizeText(
        decodeHtmlEntities(
          stripHtml(
            stripCdata(
              (
                item.match(/<description>([\s\S]*?)<\/description>/)?.[1] || ""
              ).trim(),
            ),
          ),
        ),
      );

      return title
        ? `${index + 1}. ${title}\n${link}${description ? `\n${description}` : ""}`
        : null;
    })
    .filter((entry): entry is string => Boolean(entry));

  if (items.length === 0) {
    throw new Error("Bing 未返回可解析结果");
  }

  return `搜索关键词: ${query}\n\n${items.join("\n\n")}`;
}

function extractJinaMarkdownContent(text: string): string {
  const marker = "Markdown Content:";
  const index = text.indexOf(marker);
  return index >= 0 ? text.slice(index + marker.length).trim() : text.trim();
}

function isLikelyPhoneSearchEntry(title: string, body: string): boolean {
  const haystack = `${title} ${body}`.toLowerCase();
  if (
    /(背景调查|鉴贤|员工|招聘|风控|调查公司|holiday|calendar|weather|sports)/i.test(
      haystack,
    )
  ) {
    return false;
  }

  return /(手机|新机|发布|参数|配置|图|影像|华为|荣耀|小米|真我|一加|huawei|honor|xiaomi|redmi|vivo|oppo|iqoo|oneplus|realme|ithome|zol|pconline)/i.test(
    haystack,
  );
}

async function searchWithSo360ViaJina(
  query: string,
  limit: number,
): Promise<string> {
  const url = `https://r.jina.ai/http://www.so.com/s?q=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0",
      accept: "text/plain",
    },
    signal: AbortSignal.timeout(20000),
  });

  if (!res.ok) {
    throw new Error(`360 via Jina HTTP ${res.status}`);
  }

  const raw = await res.text();
  const markdown = extractJinaMarkdownContent(raw);
  const entryPattern =
    /\*\s+###\s+\[([^\]]+)\]\((https?:\/\/[^\)]+)\)\s*([\s\S]*?)(?=\n\*\s+###\s+\[|\n###\s+相关搜索|\n\|\s+---|\s*$)/g;
  const entries: Array<{ title: string; url: string; body: string }> = [];

  for (const match of markdown.matchAll(entryPattern)) {
    const title = normalizeText(match[1] || "");
    const targetUrl = normalizeText(match[2] || "");
    const body = normalizeText(
      (match[3] || "").replace(/\[[^\]]+\]\([^)]+\)/g, " "),
    );

    if (!targetUrl || !isLikelyPhoneSearchEntry(title, body)) {
      continue;
    }

    entries.push({ title, url: targetUrl, body });
    if (entries.length >= limit) {
      break;
    }
  }

  if (entries.length === 0) {
    throw new Error("360 via Jina 未返回可用的手机搜索结果");
  }

  const results = entries.map((entry, index) => {
    const snippet = entry.body ? `\n${entry.body.slice(0, 200)}` : "";
    return `${index + 1}. ${entry.title}\n${entry.url}${snippet}`;
  });

  return `搜索关键字: ${query}\n\n${results.join("\n\n")}`;
}

export const webSearchTool = tool(
  async ({ query, maxResults }) => {
    const limit = Math.min(Math.max(maxResults ?? 5, 1), 10);
    const originalQuery = query.trim();
    const effectiveQuery = enhanceSearchQuery(originalQuery);

    if (isPhoneLaunchQuery(originalQuery) && /site:/i.test(originalQuery)) {
      try {
        const soResult = await searchWithSo360ViaJina(effectiveQuery, limit);
        if (hasSearchResultEntries(soResult)) {
          return `${soResult}\n\n[说明] 手机新品定向搜索已优先使用 360 + Jina 代理结果。`;
        }
      } catch {
        // fall through to the legacy fallback chain below
      }
    }

    if (isPhoneLaunchQuery(originalQuery) && /site:/i.test(originalQuery)) {
      try {
        const duckResult = filterPhoneSearchResults(
          await searchWithDuckDuckGo(effectiveQuery, limit),
        );
        if (hasSearchResultEntries(duckResult)) {
          return `${duckResult}\n\n[璇存槑] 鎵嬫満鏂板搧瀹氬悜婧愭煡璇㈠凡浼樺厛浣跨敤 DuckDuckGo銆俙`;
        }

        const bingResult = filterPhoneSearchResults(
          await searchWithBing(effectiveQuery, limit),
        );
        return `${bingResult}\n\n[璇存槑] DuckDuckGo 缁撴灉涓虹┖锛屽凡鍒囨崲鍒?Bing 鍏滃簳銆俙`;
      } catch (duckError: any) {
        try {
          const bingResult = filterPhoneSearchResults(
            await searchWithBing(effectiveQuery, limit),
          );
          return `${bingResult}\n\n[璇存槑] DuckDuckGo 涓嶅彲杈撅紝宸插垏鎹?Bing銆俙`;
        } catch (bingError: any) {
          return `鑱旂綉鎼滅储澶辫触: 鎵嬫満瀹氬悜婧愭煡璇㈢殑 DuckDuckGo 涓?Bing 鍧囦笉鍙揪銆侱uckDuckGo: ${duckError?.message || "鏈煡閿欒"}锛汢ing: ${bingError?.message || "鏈煡閿欒"}`;
        }
      }
    }

    if (isPhoneLaunchQuery(originalQuery)) {
      try {
        const bingResult = filterPhoneSearchResults(
          await searchWithBing(effectiveQuery, limit),
        );
        if (!isClearlyIrrelevantPhoneResult(bingResult) || hasPreferredPhoneSources(bingResult)) {
          return `${bingResult}\n\n[说明] 手机新品类查询已优先使用 Bing。`;
        }

        const duckResult = filterPhoneSearchResults(
          await searchWithDuckDuckGo(effectiveQuery, limit),
        );
        return `${duckResult}\n\n[说明] Bing 结果相关性不足，已切换 DuckDuckGo 兜底。`;
      } catch (bingError: any) {
        try {
          const duckResult = filterPhoneSearchResults(
            await searchWithDuckDuckGo(effectiveQuery, limit),
          );
          return `${duckResult}\n\n[说明] Bing 不可达，已切换 DuckDuckGo。`;
        } catch (duckError: any) {
          return `联网搜索失败: 手机新品查询的 Bing 与 DuckDuckGo 均不可达。Bing: ${bingError?.message || "未知错误"}；DuckDuckGo: ${duckError?.message || "未知错误"}`;
        }
      }
    }

    try {
      let result = await searchWithDuckDuckGo(effectiveQuery, limit);
      if (
        isFinanceQuery(originalQuery) &&
        isClearlyIrrelevantFinanceResult(result)
      ) {
        const fallback = await searchWithBing(effectiveQuery, limit);
        return `${fallback}\n\n[说明] 已针对财经信息自动优化搜索关键词。`;
      }
      if (
        isPhoneLaunchQuery(originalQuery) &&
        isClearlyIrrelevantPhoneResult(result)
      ) {
        const fallback = filterPhoneSearchResults(
          await searchWithBing(effectiveQuery, limit),
        );
        return `${fallback}\n\n[说明] 已针对手机新品信息自动优化搜索关键词。`;
      }
      return isPhoneLaunchQuery(originalQuery)
        ? filterPhoneSearchResults(result)
        : result;
    } catch (duckError: any) {
      try {
        const fallback = isPhoneLaunchQuery(originalQuery)
          ? filterPhoneSearchResults(
              await searchWithBing(effectiveQuery, limit),
            )
          : await searchWithBing(effectiveQuery, limit);
        return `${fallback}\n\n[说明] 默认搜索源暂时不可达，已自动切换到 Bing。`;
      } catch (bingError: any) {
        return `联网搜索失败: 默认搜索源（DuckDuckGo）不可达，备用搜索源（Bing）也不可达。DuckDuckGo: ${duckError?.message || "未知错误"}；Bing: ${bingError?.message || "未知错误"}`;
      }
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

const OPEN_METEO_WEATHER_CODES: Record<number, string> = {
  0: "晴天",
  1: "晴间多云",
  2: "部分多云",
  3: "阴天",
  45: "雾",
  48: "冻雾",
  51: "小毛毛雨",
  53: "中毛毛雨",
  55: "大毛毛雨",
  61: "小雨",
  63: "中雨",
  65: "大雨",
  71: "小雪",
  73: "中雪",
  75: "大雪",
  77: "雪粒",
  80: "阵雨",
  81: "中阵雨",
  82: "强阵雨",
  85: "阵雪",
  86: "强阵雪",
  95: "雷暴",
  96: "雷暴伴小冰雹",
  99: "雷暴伴大冰雹",
};

async function fetchWeatherFromWttr(location: string): Promise<string> {
  const url = `https://wttr.in/${encodeURIComponent(location)}?format=j1&lang=zh`;
  const res = await fetch(url, {
    headers: { "user-agent": "curl/8.0" },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`wttr.in HTTP ${res.status}`);

  const data = (await res.json()) as {
    current_condition?: Array<{
      temp_C?: string;
      FeelsLikeC?: string;
      humidity?: string;
      windspeedKmph?: string;
      winddir16Point?: string;
      weatherDesc?: Array<{ value?: string }>;
    }>;
    weather?: Array<{
      maxtempC?: string;
      mintempC?: string;
      date?: string;
    }>;
    nearest_area?: Array<{
      areaName?: Array<{ value?: string }>;
    }>;
  };

  const cur = data.current_condition?.[0];
  if (!cur) throw new Error("wttr.in 未返回天气数据");

  const today = data.weather?.[0];
  const lines = [
    `位置: ${location}`,
    `天气: ${cur.weatherDesc?.[0]?.value || "未知"}`,
    `温度: ${cur.temp_C ?? "?"}°C（体感 ${cur.FeelsLikeC ?? "?"}°C）`,
  ];
  if (today?.maxtempC !== undefined && today?.mintempC !== undefined) {
    lines.push(`今日: 最高 ${today.maxtempC}°C / 最低 ${today.mintempC}°C`);
  }
  lines.push(
    `湿度: ${cur.humidity ?? "?"}%`,
    `风速: ${cur.windspeedKmph ?? "?"} km/h ${cur.winddir16Point ?? ""}`,
  );
  return lines.join("\n");
}

async function fetchWeatherFromOpenMeteo(location: string): Promise<string> {
  const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1&language=zh&format=json`;
  const geoRes = await fetch(geoUrl, { signal: AbortSignal.timeout(8000) });
  if (!geoRes.ok) throw new Error(`Geocoding HTTP ${geoRes.status}`);

  const geoData = (await geoRes.json()) as {
    results?: Array<{
      latitude: number;
      longitude: number;
      name: string;
      country: string;
    }>;
  };
  const place = geoData.results?.[0];
  if (!place) throw new Error(`未找到城市: ${location}`);

  const weatherUrl =
    `https://api.open-meteo.com/v1/forecast` +
    `?latitude=${place.latitude}&longitude=${place.longitude}` +
    `&current=temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,weather_code` +
    `&daily=temperature_2m_max,temperature_2m_min` +
    `&timezone=auto&wind_speed_unit=kmh&forecast_days=1`;
  const weatherRes = await fetch(weatherUrl, {
    signal: AbortSignal.timeout(8000),
  });
  if (!weatherRes.ok) throw new Error(`Open-Meteo HTTP ${weatherRes.status}`);

  const weatherData = (await weatherRes.json()) as {
    current?: {
      temperature_2m?: number;
      apparent_temperature?: number;
      relative_humidity_2m?: number;
      wind_speed_10m?: number;
      weather_code?: number;
    };
    daily?: {
      temperature_2m_max?: number[];
      temperature_2m_min?: number[];
    };
  };
  const cur = weatherData.current;
  if (!cur) throw new Error("未获取到天气数据");

  const desc = OPEN_METEO_WEATHER_CODES[cur.weather_code ?? -1] ?? "未知";
  const maxT = weatherData.daily?.temperature_2m_max?.[0];
  const minT = weatherData.daily?.temperature_2m_min?.[0];
  const lines = [
    `位置: ${place.name}，${place.country}（数值预报模型）`,
    `天气: ${desc}`,
    `温度: ${cur.temperature_2m ?? "?"}°C（体感 ${cur.apparent_temperature ?? "?"}°C）`,
  ];
  if (maxT !== undefined && minT !== undefined) {
    lines.push(`今日: 最高 ${maxT}°C / 最低 ${minT}°C`);
  }
  lines.push(
    `湿度: ${cur.relative_humidity_2m ?? "?"}%`,
    `风速: ${cur.wind_speed_10m ?? "?"} km/h`,
  );
  return lines.join("\n");
}

async function fetchWeatherFallback(location: string): Promise<string> {
  const query = `${location} 今日天气 气温`;
  const result = await searchWithDuckDuckGo(query, 3).catch(() =>
    searchWithBing(query, 3),
  );
  return `[天气 API 不可达，已改用搜索结果]\n${result}`;
}

export const currentWeatherTool = tool(
  async ({ location }) => {
    const normalizedLocation = normalizeWeatherLocation(location) || location;
    // 优先 wttr.in（真实气象站数据）
    try {
      return await fetchWeatherFromWttr(normalizedLocation);
    } catch {
      // 备用 Open-Meteo（数值预报模型，精度稍低）
      try {
        return await fetchWeatherFromOpenMeteo(normalizedLocation);
      } catch {
        // 最终兜底：搜索引擎
        try {
          return await fetchWeatherFallback(normalizedLocation);
        } catch (e: any) {
          return `天气查询失败: ${e.message}`;
        }
      }
    }
  },
  {
    name: "get_weather_current",
    description: "查询指定地点的当前天气情况。",
    schema: z.object({
      location: z.string().describe("地点名称，例如 北京、Shanghai、New York"),
    }),
  },
);

async function fetchUrlViaJina(url: string, limit: number): Promise<string> {
  const proxyUrl = `https://r.jina.ai/http://${url.replace(/^https?:\/\//i, "")}`;
  const res = await fetch(proxyUrl, {
    headers: {
      "user-agent": "Mozilla/5.0",
      accept: "text/plain",
    },
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) {
    throw new Error(`Jina HTTP ${res.status}`);
  }

  const text = await res.text();
  const content = extractJinaMarkdownContent(text);
  if (!content.trim()) {
    throw new Error("Jina 未返回正文内容");
  }

  const titleMatch = text.match(/Title:\s*(.+)/);
  const title = normalizeText(titleMatch?.[1] || "网页内容");
  const excerpt = normalizeText(content).slice(0, limit);
  const truncated = content.length > excerpt.length ? "\n\n[内容已截断]" : "";

  return `网页标题: ${title}\n链接: ${url}\n\n正文:\n${excerpt}${truncated}`;
}

export const fetchUrlTool = tool(
  async ({ url, maxLength }) => {
    const limit = Math.min(Math.max(maxLength ?? 4000, 500), 12000);
    try {
      const res = await fetch(url, {
        headers: {
          "user-agent": "Mozilla/5.0",
        },
        signal: AbortSignal.timeout(30000),
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

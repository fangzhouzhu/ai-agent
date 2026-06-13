import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { tool, type DynamicStructuredTool } from "@langchain/core/tools";
import { clipboard } from "electron";
import { z } from "zod";

function isSafeMathExpression(expression: string): boolean {
  return /^[0-9+\-*/%().,\s^]+$/.test(expression);
}

function formatExpressionForDisplay(expression: string): string {
  return expression
    .trim()
    .replace(/[=\s]+$/g, "")
    .replace(/\*/g, " * ")
    .replace(/\//g, " / ")
    .replace(/\^/g, " ^ ")
    .replace(/\s+/g, " ")
    .trim();
}

function formatResultNumber(value: number): string {
  if (Number.isInteger(value)) {
    return new Intl.NumberFormat("en-US").format(value);
  }

  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 12,
  }).format(value);
}

const UNIT_DEFINITIONS = {
  length: {
    m: 1,
    km: 1000,
    cm: 0.01,
    mm: 0.001,
    in: 0.0254,
    ft: 0.3048,
    yd: 0.9144,
    mi: 1609.344,
  },
  weight: {
    kg: 1,
    g: 0.001,
    mg: 0.000001,
    lb: 0.45359237,
    oz: 0.028349523125,
  },
  volume: {
    l: 1,
    ml: 0.001,
    m3: 1000,
    gal: 3.785411784,
    qt: 0.946352946,
  },
} as const;

type UnitCategory = keyof typeof UNIT_DEFINITIONS;
type SpecialFolder =
  | "desktop"
  | "documents"
  | "downloads"
  | "pictures"
  | "music"
  | "videos";

type RunningAppRecord = {
  ProcessName?: string;
  MainWindowTitle?: string;
};

type OsInfoRecord = {
  Caption?: string;
  Version?: string;
  BuildNumber?: string;
  OSArchitecture?: string;
};

function findUnitCategory(unit: string): UnitCategory | null {
  const normalized = unit.toLowerCase();
  for (const category of Object.keys(UNIT_DEFINITIONS) as UnitCategory[]) {
    if (normalized in UNIT_DEFINITIONS[category]) {
      return category;
    }
  }
  return null;
}

function convertTemperature(
  value: number,
  fromUnit: string,
  toUnit: string,
): number | null {
  const fromNormalized = fromUnit.toLowerCase();
  const toNormalized = toUnit.toLowerCase();

  const toCelsius = (input: number, unit: string): number | null => {
    if (unit === "c") return input;
    if (unit === "f") return ((input - 32) * 5) / 9;
    if (unit === "k") return input - 273.15;
    return null;
  };

  const fromCelsius = (input: number, unit: string): number | null => {
    if (unit === "c") return input;
    if (unit === "f") return (input * 9) / 5 + 32;
    if (unit === "k") return input + 273.15;
    return null;
  };

  const celsius = toCelsius(value, fromNormalized);
  if (celsius === null) return null;
  return fromCelsius(celsius, toNormalized);
}

function execFileUtf8(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        windowsHide: true,
        maxBuffer: 1024 * 1024,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error((stderr || error.message || "").trim()));
          return;
        }
        resolve(String(stdout || "").trim());
      },
    );
  });
}

function resolveSpecialFolder(folder: SpecialFolder): { label: string; path: string } {
  const home = os.homedir();
  switch (folder) {
    case "desktop":
      return { label: "桌面", path: path.join(home, "Desktop") };
    case "documents":
      return { label: "文档", path: path.join(home, "Documents") };
    case "downloads":
      return { label: "下载", path: path.join(home, "Downloads") };
    case "pictures":
      return { label: "图片", path: path.join(home, "Pictures") };
    case "music":
      return { label: "音乐", path: path.join(home, "Music") };
    case "videos":
      return { label: "视频", path: path.join(home, "Videos") };
  }
}

function formatDirectoryEntries(
  targetPath: string,
  label: string,
  limit: number,
  includeHidden = false,
): string {
  if (!fs.existsSync(targetPath)) {
    return `${label}目录不存在：${targetPath}`;
  }

  const entries = fs
    .readdirSync(targetPath, { withFileTypes: true })
    .filter((entry) => includeHidden || !entry.name.startsWith("."))
    .sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name, "zh-CN");
    });

  if (entries.length === 0) {
    return `${label}目前是空的。`;
  }

  const lines = entries.slice(0, limit).map((entry) => {
    const fullPath = path.join(targetPath, entry.name);
    if (entry.isDirectory()) {
      return `- [文件夹] ${entry.name}`;
    }

    try {
      const stat = fs.statSync(fullPath);
      return `- [文件] ${entry.name} (${stat.size} 字节)`;
    } catch {
      return `- [文件] ${entry.name}`;
    }
  });

  if (entries.length > limit) {
    lines.push(`- 还有 ${entries.length - limit} 项未显示`);
  }

  return [`${label}包含以下内容：`, ...lines].join("\n");
}

async function getRunningApps(limit: number): Promise<string> {
  const safeLimit = Math.max(1, Math.min(limit, 50));
  const script = [
    "$OutputEncoding = [System.Text.UTF8Encoding]::new($false);",
    "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false);",
    `$apps = Get-Process | Where-Object { $_.MainWindowTitle -and $_.ProcessName -notmatch '^(Idle|System)$' } |`,
    "  Sort-Object ProcessName |",
    "  Select-Object ProcessName, MainWindowTitle -Unique |",
    `  Select-Object -First ${safeLimit};`,
    "if (-not $apps) {",
    `  $apps = Get-Process | Sort-Object ProcessName | Select-Object ProcessName -Unique | Select-Object -First ${safeLimit};`,
    "}",
    "$apps | ConvertTo-Json -Depth 3 -Compress",
  ].join(" ");

  const stdout = await execFileUtf8("powershell.exe", [
    "-NoProfile",
    "-Command",
    script,
  ]);

  if (!stdout) {
    return "暂时没有查到正在运行的应用。";
  }

  let parsed: RunningAppRecord[] = [];
  try {
    const raw = JSON.parse(stdout) as RunningAppRecord | RunningAppRecord[];
    parsed = Array.isArray(raw) ? raw : [raw];
  } catch {
    const fallbackLines = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, safeLimit)
      .map((line) => `- ${line}`);

    return fallbackLines.length > 0
      ? ["当前正在运行的应用：", ...fallbackLines].join("\n")
      : "暂时没有查到正在运行的应用。";
  }

  const lines = parsed
    .map((item) => {
      const processName = String(item.ProcessName ?? "").trim();
      const title = String(item.MainWindowTitle ?? "")
        .replace(/\s+/g, " ")
        .trim();

      if (!processName) return "";
      return title ? `- ${processName} (${title})` : `- ${processName}`;
    })
    .filter(Boolean);

  return lines.length > 0
    ? ["当前正在运行的应用：", ...lines].join("\n")
    : "暂时没有查到正在运行的应用。";
}

async function getOsInfo(): Promise<string> {
  const fallbackLines = [
    `\u7cfb\u7edf\uff1a${os.type()}`,
    `\u7248\u672c\uff1a${os.release()}`,
    `\u67b6\u6784\uff1a${os.arch()}`,
    `\u4e3b\u673a\u540d\uff1a${os.hostname()}`,
  ];

  try {
    const script = [
      "$OutputEncoding = [System.Text.UTF8Encoding]::new($false);",
      "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false);",
      "$osInfo = Get-CimInstance Win32_OperatingSystem |",
      "  Select-Object Caption, Version, BuildNumber, OSArchitecture;",
      "$osInfo | ConvertTo-Json -Depth 3 -Compress",
    ].join(" ");

    const stdout = await execFileUtf8("powershell.exe", [
      "-NoProfile",
      "-Command",
      script,
    ]);

    if (!stdout) {
      return fallbackLines.join("\n");
    }

    const parsed = JSON.parse(stdout) as OsInfoRecord;
    return [
      `\u7cfb\u7edf\uff1a${parsed.Caption || os.type()}`,
      `\u7248\u672c\uff1a${parsed.Version || os.release()}`,
      `Build\uff1a${parsed.BuildNumber || "\u672a\u77e5"}`,
      `\u67b6\u6784\uff1a${parsed.OSArchitecture || os.arch()}`,
      `\u4e3b\u673a\u540d\uff1a${os.hostname()}`,
    ].join("\n");
  } catch {
    return fallbackLines.join("\n");
  }
}

export const osInfoTool = tool(
  async () => {
    try {
      return await getOsInfo();
    } catch (e: any) {
      return `\u83b7\u53d6\u64cd\u4f5c\u7cfb\u7edf\u4fe1\u606f\u5931\u8d25\uff1a${e.message}`;
    }
  },
  {
    name: "get_os_info",
    description:
      "\u83b7\u53d6\u5f53\u524d\u7535\u8111\u7684\u64cd\u4f5c\u7cfb\u7edf\u540d\u79f0\u3001\u7248\u672c\u3001Build \u548c\u67b6\u6784\u4fe1\u606f\uff0c\u9002\u5408\u56de\u7b54\u201c\u6211\u7684\u7535\u8111\u7cfb\u7edf\u662f\u4ec0\u4e48\u201d\u8fd9\u7c7b\u95ee\u9898\u3002",
    schema: z.object({}),
  },
);

export const currentTimeTool = tool(
  async ({ timezone, locale }) => {
    try {
      const now = new Date();
      const formatter = new Intl.DateTimeFormat(locale || "zh-CN", {
        dateStyle: "full",
        timeStyle: "medium",
        timeZone: timezone || "Asia/Shanghai",
      });

      return [
        `当前时间：${formatter.format(now)}`,
        `时区：${timezone || "Asia/Shanghai"}`,
        `ISO：${now.toISOString()}`,
      ].join("\n");
    } catch (e: any) {
      return `获取时间失败：${e.message}`;
    }
  },
  {
    name: "get_current_time",
    description: "获取当前日期和时间，可指定时区和语言区域。",
    schema: z.object({
      timezone: z
        .string()
        .optional()
        .describe("IANA 时区，例如 Asia/Shanghai 或 America/New_York"),
      locale: z.string().optional().describe("语言区域，例如 zh-CN 或 en-US"),
    }),
  },
);

export const calculatorTool = tool(
  async ({ expression }) => {
    try {
      const sanitized = expression.replace(/,/g, ".").replace(/\^/g, "**").trim();
      if (!sanitized) return "计算失败：表达式为空。";
      if (!isSafeMathExpression(expression)) {
        return "计算失败：表达式包含不允许的字符，仅支持数字和 + - * / % ( ) ^";
      }

      const result = Function(`"use strict"; return (${sanitized});`)();
      if (typeof result !== "number" || !Number.isFinite(result)) {
        return "计算失败：结果不是有限数字。";
      }

      const displayExpression = formatExpressionForDisplay(expression);
      const displayResult = formatResultNumber(result);
      return `计算结果：${displayExpression} = ${displayResult}`;
    } catch (e: any) {
      return `计算失败：${e.message}`;
    }
  },
  {
    name: "calculator",
    description: "计算数学表达式，支持 + - * / % () 和 ^ 运算。",
    schema: z.object({
      expression: z.string().describe("要计算的数学表达式，例如 (12.5+3)*2^3"),
    }),
  },
);

export const unitConvertTool = tool(
  async ({ value, fromUnit, toUnit }) => {
    try {
      const fromNormalized = fromUnit.toLowerCase();
      const toNormalized = toUnit.toLowerCase();

      const temperatureResult = convertTemperature(
        value,
        fromNormalized,
        toNormalized,
      );
      if (temperatureResult !== null) {
        return [
          `数值：${value}`,
          `从：${fromNormalized}`,
          `到：${toNormalized}`,
          `结果：${temperatureResult}`,
        ].join("\n");
      }

      const fromCategory = findUnitCategory(fromNormalized);
      const toCategory = findUnitCategory(toNormalized);

      if (!fromCategory || !toCategory) {
        return "单位换算失败：暂不支持该单位。当前支持长度、重量、体积和温度。";
      }

      if (fromCategory !== toCategory) {
        return `单位换算失败：${fromNormalized} 和 ${toNormalized} 不属于同一类单位。`;
      }

      const baseValue =
        value *
        UNIT_DEFINITIONS[fromCategory][
          fromNormalized as keyof (typeof UNIT_DEFINITIONS)[typeof fromCategory]
        ];
      const convertedValue =
        baseValue /
        UNIT_DEFINITIONS[toCategory][
          toNormalized as keyof (typeof UNIT_DEFINITIONS)[typeof toCategory]
        ];

      return [
        `数值：${value}`,
        `单位类型：${fromCategory}`,
        `从：${fromNormalized}`,
        `到：${toNormalized}`,
        `结果：${convertedValue}`,
      ].join("\n");
    } catch (e: any) {
      return `单位换算失败：${e.message}`;
    }
  },
  {
    name: "unit_convert",
    description: "单位换算工具，支持长度、重量、体积和温度换算。",
    schema: z.object({
      value: z.number().describe("要换算的数值"),
      fromUnit: z
        .string()
        .describe("原始单位，例如 km、m、kg、lb、l、ml、c、f、k"),
      toUnit: z.string().describe("目标单位，例如 mi、cm、g、oz、gal、c、f、k"),
    }),
  },
);

export const clipboardCopyTool = tool(
  async ({ text }) => {
    try {
      clipboard.writeText(text);
      return `已复制到剪贴板，共 ${text.length} 个字符。`;
    } catch (e: any) {
      return `复制到剪贴板失败：${e.message}`;
    }
  },
  {
    name: "clipboard_copy",
    description: "将指定文本复制到系统剪贴板。",
    schema: z.object({
      text: z.string().describe("要复制到系统剪贴板的文本内容"),
    }),
  },
);

export const listRunningAppsTool = tool(
  async ({ limit }) => {
    try {
      return await getRunningApps(limit ?? 20);
    } catch (e: any) {
      return `获取运行中的应用失败：${e.message}`;
    }
  },
  {
    name: "list_running_apps",
    description:
      "列出当前电脑上正在运行的桌面应用或进程名称，适合回答“我现在开了哪些软件”之类的问题。",
    schema: z.object({
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe("最多返回多少个应用，默认 20"),
    }),
  },
);

export const listSpecialFolderTool = tool(
  async ({ folder, limit, includeHidden }) => {
    try {
      const resolved = resolveSpecialFolder(folder);
      return formatDirectoryEntries(
        resolved.path,
        resolved.label,
        limit ?? 50,
        includeHidden ?? false,
      );
    } catch (e: any) {
      return `获取目录内容失败：${e.message}`;
    }
  },
  {
    name: "list_special_folder",
    description:
      "列出桌面、下载、文档等常用系统目录的内容，适合回答“我桌面上有什么文件”之类的问题。",
    schema: z.object({
      folder: z
        .enum(["desktop", "documents", "downloads", "pictures", "music", "videos"])
        .describe("要查看的系统目录"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe("最多返回多少项，默认 50"),
      includeHidden: z.boolean().optional().describe("是否包含隐藏项，默认 false"),
    }),
  },
);

export const systemTools: DynamicStructuredTool[] = [
  osInfoTool,
  currentTimeTool,
  calculatorTool,
  unitConvertTool,
  clipboardCopyTool,
  listRunningAppsTool,
  listSpecialFolderTool,
];

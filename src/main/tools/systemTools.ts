import { tool, type DynamicStructuredTool } from "@langchain/core/tools";
import { clipboard } from "electron";
import { z } from "zod";

function isSafeMathExpression(expression: string): boolean {
  return /^[0-9+\-*/%().,\s^]+$/.test(expression);
}

function formatExpressionForDisplay(expression: string): string {
  return expression
    .trim()
    .replace(/[=？?]+$/g, "")
    .replace(/\*/g, " × ")
    .replace(/\//g, " ÷ ")
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
        `当前时间: ${formatter.format(now)}`,
        `时区: ${timezone || "Asia/Shanghai"}`,
        `ISO: ${now.toISOString()}`,
      ].join("\n");
    } catch (e: any) {
      return `获取时间失败: ${e.message}`;
    }
  },
  {
    name: "get_current_time",
    description: "获取当前日期和时间，可指定时区和语言区域。",
    schema: z.object({
      timezone: z
        .string()
        .optional()
        .describe("IANA 时区，例如 Asia/Shanghai、America/New_York"),
      locale: z.string().optional().describe("语言区域，例如 zh-CN、en-US"),
    }),
  },
);

export const calculatorTool = tool(
  async ({ expression }) => {
    try {
      const sanitized = expression
        .replace(/,/g, ".")
        .replace(/\^/g, "**")
        .trim();
      if (!sanitized) return "计算失败: 表达式为空";
      if (!isSafeMathExpression(expression)) {
        return "计算失败: 表达式包含不允许的字符，仅支持数字和 + - * / % ( ) ^";
      }

      const result = Function(`\"use strict\"; return (${sanitized});`)();
      if (typeof result !== "number" || !Number.isFinite(result)) {
        return "计算失败: 结果不是有限数字";
      }

      const displayExpression = formatExpressionForDisplay(expression);
      const displayResult = formatResultNumber(result);
      return `计算结果: ${displayExpression} = ${displayResult}`;
    } catch (e: any) {
      return `计算失败: ${e.message}`;
    }
  },
  {
    name: "calculator",
    description: "计算数学表达式，支持 + - * / % () 和 ^ 幂运算。",
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
          `数值: ${value}`,
          `从: ${fromNormalized}`,
          `到: ${toNormalized}`,
          `结果: ${temperatureResult}`,
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
        `数值: ${value}`,
        `单位类型: ${fromCategory}`,
        `从: ${fromNormalized}`,
        `到: ${toNormalized}`,
        `结果: ${convertedValue}`,
      ].join("\n");
    } catch (e: any) {
      return `单位换算失败: ${e.message}`;
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
      return `已复制到剪贴板，共 ${text.length} 个字符`;
    } catch (e: any) {
      return `复制到剪贴板失败: ${e.message}`;
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

export const systemTools: DynamicStructuredTool[] = [
  currentTimeTool,
  calculatorTool,
  unitConvertTool,
  clipboardCopyTool,
];

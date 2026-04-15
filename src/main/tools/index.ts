import { type DynamicStructuredTool } from "@langchain/core/tools";
import {
  deleteFileTool,
  listDirectoryTool,
  readFileTool,
  searchFilesTool,
  writeFileTool,
} from "./fileTools";
import {
  calculatorTool,
  clipboardCopyTool,
  currentTimeTool,
  systemTools,
  unitConvertTool,
} from "./systemTools";
import {
  currentWeatherTool,
  currencyConvertTool,
  fetchUrlTool,
  webSearchTool,
  webTools,
} from "./webTools";
import { generatePdfTool, generatePptxTool, reportTools } from "./reportTools";

export {
  readFileTool,
  writeFileTool,
  listDirectoryTool,
  deleteFileTool,
  searchFilesTool,
  currentTimeTool,
  calculatorTool,
  unitConvertTool,
  clipboardCopyTool,
  webSearchTool,
  currentWeatherTool,
  fetchUrlTool,
  currencyConvertTool,
  generatePdfTool,
  generatePptxTool,
};

export const allTools: DynamicStructuredTool[] = [
  readFileTool,
  writeFileTool,
  listDirectoryTool,
  deleteFileTool,
  searchFilesTool,
  ...systemTools,
  ...webTools,
  ...reportTools,
];

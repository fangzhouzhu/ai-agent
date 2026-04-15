import { tool, type DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import PDFDocument from "pdfkit";
import PptxGenJS from "pptxgenjs";

// ─── 工具函数 ─────────────────────────────────────────────────────────────────

function resolveOutputPath(filePath: string): string {
  const resolved = path.resolve(filePath);
  const dir = path.dirname(resolved);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return resolved;
}

/**
 * 查找可用的 CJK 字体文件（优先 Windows 系统字体）。
 * 返回字体文件绝对路径，未找到则返回 null。
 */
function findCjkFont(): string | null {
  const candidates = [
    // Windows 系统字体
    "C:\\Windows\\Fonts\\msyh.ttc", // 微软雅黑
    "C:\\Windows\\Fonts\\simsun.ttc", // 宋体
    "C:\\Windows\\Fonts\\simhei.ttf", // 黑体
    // 项目内置字体（如有放置）
    path.join(__dirname, "../../assets/fonts/NotoSansSC-Regular.ttf"),
    path.join(__dirname, "../../../build/fonts/NotoSansSC-Regular.ttf"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * 将 Markdown 风格的文本解析为结构化行，用于 PDF 渲染。
 * 支持：# 标题（H1/H2/H3）、- / * / • 无序列表、普通段落。
 */
function parseMarkdownLines(
  text: string,
): Array<{ type: "h1" | "h2" | "h3" | "bullet" | "paragraph"; text: string }> {
  return text
    .split("\n")
    .map((raw) => {
      const line = raw.trimEnd();
      if (/^###\s+/.test(line))
        return { type: "h3" as const, text: line.replace(/^###\s+/, "") };
      if (/^##\s+/.test(line))
        return { type: "h2" as const, text: line.replace(/^##\s+/, "") };
      if (/^#\s+/.test(line))
        return { type: "h1" as const, text: line.replace(/^#\s+/, "") };
      if (/^[-*•]\s+/.test(line))
        return { type: "bullet" as const, text: line.replace(/^[-*•]\s+/, "") };
      return { type: "paragraph" as const, text: line };
    })
    .filter((l) => l.text.trim() !== "");
}

// ─── PDF 生成工具 ─────────────────────────────────────────────────────────────

export const generatePdfTool = tool(
  async ({ filePath, title, content }) => {
    try {
      const outputPath = resolveOutputPath(
        filePath.endsWith(".pdf") ? filePath : `${filePath}.pdf`,
      );
      const fontPath = findCjkFont();
      const hasCjkFont = fontPath !== null;

      await new Promise<void>((resolve, reject) => {
        const doc = new PDFDocument({ margin: 60, size: "A4" });
        const stream = fs.createWriteStream(outputPath);
        doc.pipe(stream);

        // 注册中文字体（如存在）
        if (hasCjkFont && fontPath) {
          doc.registerFont("CJK", fontPath);
        }

        const bodyFont = hasCjkFont ? "CJK" : "Helvetica";
        const boldFont = hasCjkFont ? "CJK" : "Helvetica-Bold";

        // 封面标题
        if (title) {
          doc
            .font(boldFont)
            .fontSize(26)
            .fillColor("#1a2650")
            .text(title, { align: "center" })
            .moveDown(0.5);
          doc
            .moveTo(60, doc.y)
            .lineTo(doc.page.width - 60, doc.y)
            .strokeColor("#3b82f6")
            .lineWidth(2)
            .stroke()
            .moveDown(1);
        }

        // 正文
        const lines = parseMarkdownLines(content);
        for (const line of lines) {
          switch (line.type) {
            case "h1":
              doc
                .font(boldFont)
                .fontSize(18)
                .fillColor("#1a2650")
                .text(line.text)
                .moveDown(0.4);
              break;
            case "h2":
              doc
                .font(boldFont)
                .fontSize(14)
                .fillColor("#1f42d1")
                .text(line.text)
                .moveDown(0.3);
              break;
            case "h3":
              doc
                .font(boldFont)
                .fontSize(12)
                .fillColor("#4a5a88")
                .text(line.text)
                .moveDown(0.2);
              break;
            case "bullet":
              doc
                .font(bodyFont)
                .fontSize(11)
                .fillColor("#1a2650")
                .text(`• ${line.text}`, { indent: 20 })
                .moveDown(0.1);
              break;
            default:
              doc
                .font(bodyFont)
                .fontSize(11)
                .fillColor("#333333")
                .text(line.text)
                .moveDown(0.2);
          }
        }

        // 页脚
        const pages = doc.bufferedPageRange();
        for (let i = pages.start; i < pages.start + pages.count; i++) {
          doc.switchToPage(i);
          doc
            .font(bodyFont)
            .fontSize(9)
            .fillColor("#8a9ab8")
            .text(
              `第 ${i - pages.start + 1} / ${pages.count} 页`,
              60,
              doc.page.height - 40,
              { align: "center" },
            );
        }

        doc.end();
        stream.on("finish", resolve);
        stream.on("error", reject);
      });

      return `PDF 已生成：${outputPath}`;
    } catch (e: any) {
      return `生成 PDF 失败：${e.message}`;
    }
  },
  {
    name: "generate_pdf",
    description:
      "根据提供的标题和 Markdown 格式内容，生成一份 PDF 报告文件。支持 # 标题、- 列表、普通段落。返回生成文件的路径。",
    schema: z.object({
      filePath: z
        .string()
        .describe("PDF 文件的保存路径，例如 C:/reports/股票分析.pdf"),
      title: z.string().describe("报告标题，显示在封面"),
      content: z
        .string()
        .describe("报告正文，支持 Markdown 格式（# 标题、- 列表项、普通段落）"),
    }),
  },
);

// ─── PPTX 生成工具 ────────────────────────────────────────────────────────────

export const generatePptxTool = tool(
  async ({ filePath, title, slides }) => {
    try {
      const outputPath = resolveOutputPath(
        filePath.endsWith(".pptx") ? filePath : `${filePath}.pptx`,
      );

      const pptx = new PptxGenJS();
      pptx.layout = "LAYOUT_16x9";
      pptx.author = "AI Agent";
      pptx.title = title;

      // ── 封面幻灯片 ────────────────────────────────────────────────────────
      const cover = pptx.addSlide();
      cover.background = { color: "1a2650" };
      cover.addText(title, {
        x: "5%",
        y: "35%",
        w: "90%",
        h: "30%",
        fontSize: 36,
        bold: true,
        color: "FFFFFF",
        align: "center",
        valign: "middle",
        fontFace: "Arial",
      });
      cover.addText(`由 AI Agent 自动生成`, {
        x: "5%",
        y: "70%",
        w: "90%",
        h: "10%",
        fontSize: 14,
        color: "8a9ab8",
        align: "center",
        fontFace: "Arial",
      });

      // ── 内容幻灯片 ────────────────────────────────────────────────────────
      for (const slide of slides) {
        const s = pptx.addSlide();
        s.background = { color: "FFFFFF" };

        // 左侧蓝色装饰条
        s.addShape(pptx.ShapeType.rect, {
          x: 0,
          y: 0,
          w: "1%",
          h: "100%",
          fill: { color: "3b82f6" },
          line: { color: "3b82f6" },
        });

        // 幻灯片标题
        s.addText(slide.title, {
          x: "3%",
          y: "5%",
          w: "94%",
          h: "15%",
          fontSize: 22,
          bold: true,
          color: "1a2650",
          fontFace: "Arial",
        });

        // 分隔线
        s.addShape(pptx.ShapeType.line, {
          x: "3%",
          y: "22%",
          w: "94%",
          h: 0,
          line: { color: "3b82f6", width: 1.5 },
        });

        // 内容区：将文本拆成逐行项目符号
        const lines = slide.content
          .split("\n")
          .map((l) => l.replace(/^[-*•]\s*/, "").trim())
          .filter(Boolean);

        const textItems = lines.map((text) => ({
          text: `• ${text}`,
          options: {
            fontSize: 14,
            color: "333333",
            fontFace: "Arial",
            paraSpaceAfter: 6,
          },
        }));

        if (textItems.length > 0) {
          s.addText(textItems, {
            x: "3%",
            y: "26%",
            w: "94%",
            h: "68%",
            valign: "top",
          });
        }
      }

      await pptx.writeFile({ fileName: outputPath });
      return `PPT 已生成：${outputPath}`;
    } catch (e: any) {
      return `生成 PPT 失败：${e.message}`;
    }
  },
  {
    name: "generate_pptx",
    description:
      "根据标题和多张幻灯片内容，生成一份 PowerPoint（.pptx）演示文稿文件。返回生成文件的路径。",
    schema: z.object({
      filePath: z
        .string()
        .describe("PPTX 文件的保存路径，例如 C:/reports/股票分析.pptx"),
      title: z.string().describe("演示文稿的总标题"),
      slides: z
        .array(
          z.object({
            title: z.string().describe("幻灯片标题"),
            content: z
              .string()
              .describe("幻灯片正文，每行一个要点，支持 - 开头的列表格式"),
          }),
        )
        .min(1)
        .describe("幻灯片数组，每个元素代表一张幻灯片"),
    }),
  },
);

export const reportTools: DynamicStructuredTool[] = [
  generatePdfTool,
  generatePptxTool,
];

declare module "pdf-parse" {
  type PdfParseResult = {
    text: string;
    numpages?: number;
    numrender?: number;
    info?: unknown;
    metadata?: unknown;
    version?: string;
  };

  export default function pdf(
    dataBuffer: Uint8Array | Buffer,
  ): Promise<PdfParseResult>;
}

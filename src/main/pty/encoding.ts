import iconv from "iconv-lite";
import type { PtyEncoding } from "../../shared/contracts";

const codePages: Record<PtyEncoding, string> = {
  auto: "65001",
  utf8: "65001",
  gbk: "936",
  gb18030: "54936",
  big5: "950",
  shiftjis: "932",
  euckr: "949",
  utf16le: "1200",
};

const iconvEncodings: Partial<Record<PtyEncoding, string>> = {
  gbk: "gbk",
  gb18030: "gb18030",
  big5: "big5",
  shiftjis: "shift_jis",
  euckr: "euc-kr",
  utf16le: "utf16le",
};

export function getWindowsCodePage(encoding: PtyEncoding): string {
  return codePages[encoding] ?? codePages.utf8;
}

export function getNodePtyEncoding(encoding: PtyEncoding): string | null {
  return encoding === "auto" || encoding === "utf8" ? "utf8" : null;
}

export function decodePtyData(data: string | Buffer, encoding: PtyEncoding): string {
  if (typeof data === "string") {
    return data;
  }

  const iconvEncoding = iconvEncodings[encoding];
  if (!iconvEncoding) {
    return data.toString("utf8");
  }

  return iconv.decode(data, iconvEncoding);
}

export function encodePtyInput(data: string, encoding: PtyEncoding): string | Buffer {
  const iconvEncoding = iconvEncodings[encoding];
  if (!iconvEncoding) {
    return data;
  }

  return iconv.encode(data, iconvEncoding);
}

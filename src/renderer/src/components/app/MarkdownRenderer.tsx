import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface MarkdownRendererProps {
  content: string;
  className?: string;
}

function renderInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/gu;
  let cursor = 0;
  let index = 0;

  for (const match of text.matchAll(pattern)) {
    const token = match[0];
    const start = match.index ?? 0;
    if (start > cursor) {
      nodes.push(text.slice(cursor, start));
    }

    if (token.startsWith("**")) {
      nodes.push(
        <strong className="font-semibold text-foreground" key={`strong-${index}`}>
          {token.slice(2, -2)}
        </strong>,
      );
    } else if (token.startsWith("`")) {
      nodes.push(
        <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.92em]" key={`code-${index}`}>
          {token.slice(1, -1)}
        </code>,
      );
    } else {
      const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/u);
      nodes.push(
        <a
          className="font-medium text-primary underline decoration-primary/30 underline-offset-2"
          href={link?.[2] ?? "#"}
          key={`link-${index}`}
          rel="noreferrer"
          target="_blank"
        >
          {link?.[1] ?? token}
        </a>,
      );
    }

    cursor = start + token.length;
    index += 1;
  }

  if (cursor < text.length) {
    nodes.push(text.slice(cursor));
  }

  return nodes.length > 0 ? nodes : [text];
}

export function MarkdownRenderer({ content, className }: MarkdownRendererProps): React.JSX.Element {
  const lines = content.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let paragraph: string[] = [];
  let listItems: string[] = [];
  let codeLines: string[] | null = null;

  const flushParagraph = (): void => {
    if (paragraph.length === 0) {
      return;
    }

    blocks.push(
      <p className="leading-7 text-foreground/82" key={`p-${blocks.length}`}>
        {renderInline(paragraph.join(" "))}
      </p>,
    );
    paragraph = [];
  };

  const flushList = (): void => {
    if (listItems.length === 0) {
      return;
    }

    blocks.push(
      <ul className="list-disc space-y-1.5 pl-5 text-foreground/82" key={`ul-${blocks.length}`}>
        {listItems.map((item, index) => (
          <li className="leading-7" key={`${item}-${index}`}>
            {renderInline(item)}
          </li>
        ))}
      </ul>,
    );
    listItems = [];
  };

  const flushCode = (): void => {
    if (!codeLines) {
      return;
    }

    blocks.push(
      <pre className="overflow-x-auto rounded-md bg-muted/80 p-3 font-mono text-xs leading-relaxed text-foreground/80" key={`pre-${blocks.length}`}>
        {codeLines.join("\n")}
      </pre>,
    );
    codeLines = null;
  };

  for (const line of lines) {
    if (line.trim().startsWith("```")) {
      if (codeLines) {
        flushCode();
      } else {
        flushParagraph();
        flushList();
        codeLines = [];
      }
      continue;
    }

    if (codeLines) {
      codeLines.push(line);
      continue;
    }

    const trimmed = line.trim();
    if (!trimmed) {
      flushParagraph();
      flushList();
      continue;
    }

    if (/^[-*_]{3,}$/u.test(trimmed)) {
      flushParagraph();
      flushList();
      blocks.push(<hr className="border-border/70" key={`hr-${blocks.length}`} />);
      continue;
    }

    const heading = trimmed.match(/^(#{1,4})\s+(.+)$/u);
    if (heading) {
      flushParagraph();
      flushList();
      const level = heading[1].length;
      const text = heading[2];
      const headingClass =
        level === 1
          ? "text-xl font-semibold"
          : level === 2
            ? "text-base font-semibold"
            : "text-sm font-semibold";
      blocks.push(
        <h3 className={cn("pt-2 leading-tight text-foreground", headingClass)} key={`h-${blocks.length}`}>
          {renderInline(text)}
        </h3>,
      );
      continue;
    }

    const list = trimmed.match(/^[-*]\s+(.+)$/u) ?? trimmed.match(/^\d+[.)]\s+(.+)$/u);
    if (list) {
      flushParagraph();
      listItems.push(list[1]);
      continue;
    }

    const quote = trimmed.match(/^>\s+(.+)$/u);
    if (quote) {
      flushParagraph();
      flushList();
      blocks.push(
        <blockquote className="border-l-2 border-primary/40 pl-3 text-sm leading-7 text-muted-foreground" key={`quote-${blocks.length}`}>
          {renderInline(quote[1])}
        </blockquote>,
      );
      continue;
    }

    paragraph.push(trimmed);
  }

  flushParagraph();
  flushList();
  flushCode();

  return <div className={cn("space-y-3 text-sm", className)}>{blocks}</div>;
}

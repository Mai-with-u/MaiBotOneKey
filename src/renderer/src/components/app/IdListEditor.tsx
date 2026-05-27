import { Plus, X } from "lucide-react";
import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export interface IdListEditorProps {
  label: string;
  values: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  emptyHint?: string;
  inputMode?: React.HTMLAttributes<HTMLInputElement>["inputMode"];
  disabled?: boolean;
  className?: string;
  itemAriaLabel?: (value: string, index: number) => string;
}

const SPLIT_RE = /[\s,，;；]+/;

function splitDraft(value: string): string[] {
  const out: string[] = [];
  for (const piece of value.split(SPLIT_RE)) {
    const text = piece.trim();
    if (text) out.push(text);
  }
  return out;
}

function appendUnique(existing: string[], incoming: string[]): string[] {
  const seen = new Set(existing);
  const next = [...existing];
  for (const value of incoming) {
    if (seen.has(value)) continue;
    seen.add(value);
    next.push(value);
  }
  return next;
}

export function IdListEditor({
  label,
  values,
  onChange,
  placeholder = "输入后回车添加",
  emptyHint = "尚未添加任何条目",
  inputMode = "numeric",
  disabled = false,
  className,
  itemAriaLabel,
}: IdListEditorProps): React.JSX.Element {
  const [draft, setDraft] = useState("");

  const commitDraft = useCallback(
    (raw: string): boolean => {
      const pieces = splitDraft(raw);
      if (pieces.length === 0) return false;
      const next = appendUnique(values, pieces);
      if (next.length !== values.length) {
        onChange(next);
      }
      return true;
    },
    [onChange, values],
  );

  const handleAdd = useCallback(() => {
    if (commitDraft(draft)) setDraft("");
  }, [commitDraft, draft]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter") {
        event.preventDefault();
        if (commitDraft(draft)) setDraft("");
        return;
      }
      if (
        event.key === "Backspace" &&
        draft.length === 0 &&
        values.length > 0 &&
        !event.nativeEvent.isComposing
      ) {
        event.preventDefault();
        const next = values.slice(0, -1);
        onChange(next);
      }
    },
    [commitDraft, draft, onChange, values],
  );

  const handleChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const next = event.target.value;
      // Auto-split on separator characters (comma / semicolon / whitespace).
      if (SPLIT_RE.test(next) && next.trim().length > 0) {
        const pieces = splitDraft(next);
        if (pieces.length > 0) {
          const merged = appendUnique(values, pieces);
          if (merged.length !== values.length) onChange(merged);
        }
        setDraft("");
        return;
      }
      setDraft(next);
    },
    [onChange, values],
  );

  const removeItem = useCallback(
    (index: number) => {
      const next = values.filter((_, idx) => idx !== index);
      onChange(next);
    },
    [onChange, values],
  );

  const commitItemEdit = useCallback(
    (index: number, raw: string) => {
      const trimmed = raw.trim();
      if (trimmed === values[index]) return;
      if (trimmed.length === 0) {
        removeItem(index);
        return;
      }
      if (values.some((entry, idx) => idx !== index && entry === trimmed)) {
        removeItem(index);
        return;
      }
      const next = [...values];
      next[index] = trimmed;
      onChange(next);
    },
    [onChange, removeItem, values],
  );

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[12px] font-medium text-foreground">{label}</span>
        <span
          className={cn(
            "rounded-sm border border-transparent px-2 py-0.5 text-[10.5px] font-medium tabular-nums",
            values.length > 0
              ? "border-primary/25 bg-primary/10 text-primary"
              : "border-border bg-muted/60 text-muted-foreground",
          )}
        >
          {values.length} 项
        </span>
      </div>

      {values.length === 0 ? (
        <p className="rounded-md border border-dashed border-border bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
          {emptyHint}
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {values.map((value, index) => (
            <li
              className="flex items-center gap-1.5"
              // eslint-disable-next-line react/no-array-index-key -- list items have no stable id; index + value combo keeps reorder-safe enough for this UX
              key={`${value}-${index}`}
            >
              <Input
                aria-label={itemAriaLabel?.(value, index) ?? `${label} #${index + 1}`}
                disabled={disabled}
                inputMode={inputMode}
                monospace
                onBlur={(event) => commitItemEdit(index, event.target.value)}
                onChange={(event) => {
                  const next = [...values];
                  next[index] = event.target.value;
                  onChange(next);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    (event.target as HTMLInputElement).blur();
                  }
                }}
                value={value}
              />
              <Button
                aria-label={`移除 ${value}`}
                disabled={disabled}
                onClick={() => removeItem(index)}
                size="icon-sm"
                type="button"
                variant="ghost"
              >
                <X />
              </Button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex items-center gap-1.5">
        <Input
          aria-label={`新增${label}`}
          disabled={disabled}
          inputMode={inputMode}
          monospace
          onBlur={() => {
            if (commitDraft(draft)) setDraft("");
          }}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          value={draft}
        />
        <Button
          aria-label={`添加${label}`}
          disabled={disabled || draft.trim().length === 0}
          onClick={handleAdd}
          size="icon-sm"
          type="button"
          variant="secondary"
        >
          <Plus />
        </Button>
      </div>
      <p className="text-[10.5px] leading-relaxed text-muted-foreground">
        支持回车添加、粘贴含逗号 / 空格 / 分号的批量内容会自动拆分；清空输入框时按删除键可移除最后一项。
      </p>
    </div>
  );
}

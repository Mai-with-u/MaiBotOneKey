import { AsyncLocalStorage } from "node:async_hooks";
import { EventEmitter } from "node:events";

export class RuntimeOperationLock extends EventEmitter {
  private readonly owner = new AsyncLocalStorage<symbol>();
  private activeOwner?: symbol;
  private starts = 0;
  private readonly nested = new Set<Promise<unknown>>();
  label: string | null = null;

  assertCanStart(): void {
    if (this.label) throw new Error(`正在${this.label}，请完成或取消后再启动服务。`);
  }

  async serviceStart<T>(action: () => Promise<T>): Promise<T> {
    this.assertCanStart();
    return this.shared(action);
  }

  async shared<T>(action: () => Promise<T>): Promise<T> {
    if (this.label) throw new Error(`正在${this.label}，请完成或取消目录操作后再修改运行配置。`);
    this.starts += 1;
    try { return await action(); } finally { this.starts -= 1; }
  }

  waitForIdle(): Promise<void> {
    if (!this.label) return Promise.resolve();
    return new Promise((resolve) => {
      const listener = (label: string | null): void => {
        if (label === null) { this.off("change", listener); resolve(); }
      };
      this.on("change", listener);
    });
  }

  async exclusive<T>(label: string, assertStopped: () => void, action: () => Promise<T>): Promise<T> {
    if (this.activeOwner && this.owner.getStore() === this.activeOwner) {
      const pending = action(); this.nested.add(pending);
      void pending.then(() => this.nested.delete(pending), () => this.nested.delete(pending));
      return pending;
    }
    if (this.label || this.starts) throw new Error("另一个路径操作、服务启动或运行配置操作正在进行，请稍后重试。");
    assertStopped();
    const token = Symbol(label);
    this.activeOwner = token;
    this.label = label;
    this.emit("change", label);
    try { return await this.owner.run(token, action); }
    finally {
      while (this.nested.size) await Promise.allSettled([...this.nested]);
      this.label = null;
      this.activeOwner = undefined;
      this.emit("change", null);
    }
  }
}

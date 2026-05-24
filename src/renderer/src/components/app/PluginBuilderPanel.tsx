import {
  Boxes,
  Braces,
  Code2,
  Download,
  FileJson,
  FolderOpen,
  Hammer,
  Link2,
  Loader2,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  RefreshCw,
  Redo2,
  Save,
  Settings2,
  TerminalSquare,
  Trash2,
  Undo2,
  Upload,
  Workflow,
  Wrench,
} from "lucide-react";
import type {
  MaiBotPluginBlueprint,
  MaiBotPluginBlueprintComponent,
  MaiBotPluginBlueprintComponentKind,
  MaiBotPluginBlueprintConfigField,
  MaiBotPluginBlueprintFlowEdge,
  MaiBotPluginBlueprintFlowNode,
  MaiBotPluginBlueprintFlowNodeKind,
  MaiBotPluginBlueprintFile,
  MaiBotPluginBuilderLibraryItem,
  MaiBotPluginBuilderLibraryListResult,
  MaiBotPluginBlueprintParameter,
  MaiBotPluginBlueprintScalarType,
} from "@shared/contracts";
import {
  buildMaiBotPluginBlueprintFiles,
  defaultMaiBotPluginFolderName,
  validateMaiBotPluginBlueprint,
} from "@shared/plugin-blueprint";
import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  createMaiBotPluginFromBlueprint,
  deletePluginBuilderLibrary,
  exportPluginBuilderBlueprint,
  fetchInstalledPlugins,
  importPluginBuilderBlueprint,
  listPluginBuilderLibrary,
  loadPluginBuilderLibrary,
  openPluginBuilderLibrary,
  parseMaiBotPluginToBlueprint,
  savePluginBuilderLibrary,
  type InstalledPlugin,
  type PluginBlueprintCreateResponse,
} from "@/lib/maibot-plugin-api";
import { cn } from "@/lib/utils";

const scalarTypes: Array<{ value: MaiBotPluginBlueprintScalarType; label: string }> = [
  { value: "string", label: "文本" },
  { value: "integer", label: "整数" },
  { value: "float", label: "小数" },
  { value: "boolean", label: "布尔值" },
];

const legacyFlowNodeTypes: Array<{ value: MaiBotPluginBlueprintFlowNodeKind; label: string }> = [
  { value: "send_text", label: "发送文本" },
  { value: "read_config", label: "读取配置" },
  { value: "return_success", label: "成功返回" },
];

const capabilityLibrary = [
  { value: "send.text", label: "发送文本", description: "允许插件发送文字消息" },
  { value: "config.get", label: "读取配置", description: "允许插件读取自己的配置项" },
  { value: "storage.local", label: "本地存储", description: "声明插件会使用本地存储" },
  { value: "event.message", label: "消息事件", description: "声明插件会处理消息事件" },
  { value: "tool.call", label: "工具调用", description: "声明插件提供可调用 Tool" },
] as const;

const flowNodeLibraryGroups: Array<{
  title: string;
  items: Array<{ value: MaiBotPluginBlueprintFlowNodeKind; label: string; description: string }>;
}> = [
  {
    title: "入口",
    items: [
      { value: "comment", label: "备注", description: "给流程加说明，不影响运行" },
    ],
  },
  {
    title: "消息与配置",
    items: [
      { value: "send_text", label: "回复文本", description: "向当前会话发送一段文字" },
      { value: "read_config", label: "读取配置", description: "读取 config.toml 中的配置值" },
      { value: "join_text", label: "拼接文本", description: "把两段文字拼成一个结果" },
    ],
  },
  {
    title: "控制",
    items: [
      { value: "if_condition", label: "如果条件", description: "条件不满足时提前结束流程" },
      { value: "loop", label: "重复执行", description: "按次数或列表重复执行基础逻辑" },
      { value: "wait", label: "等待", description: "暂停几秒后继续" },
    ],
  },
  {
    title: "逻辑",
    items: [
      { value: "compare", label: "比较", description: "比较两个值并得到 True/False" },
      { value: "boolean_logic", label: "与 / 或 / 非", description: "组合多个布尔条件" },
    ],
  },
  {
    title: "变量与计算",
    items: [
      { value: "set_variable", label: "设置变量", description: "保存一个值给后续积木使用" },
      { value: "math_operation", label: "数学运算", description: "计算并保存结果" },
      { value: "guard_config", label: "配置判断", description: "配置不匹配时提前停止" },
    ],
  },
  {
    title: "调试与结束",
    items: [
      { value: "log_info", label: "记录日志", description: "向 MaiBot 日志写入一行信息" },
      { value: "return_success", label: "成功结束", description: "成功结束当前流程" },
    ],
  },
];
const flowNodeTypes = flowNodeLibraryGroups.flatMap((group) => group.items);

const hookEventTypes = ["ON_MESSAGE", "ON_START", "ON_STOP"];
const BLUEPRINT_HISTORY_LIMIT = 50;
const COMPONENT_DRAG_MIME = "application/x-maibot-builder-component-kind";
const FLOW_NODE_DRAG_MIME = "application/x-maibot-builder-flow-node-kind";

interface BlueprintIssue {
  id: string;
  level: "error" | "warning";
  title: string;
  detail: string;
  componentId?: string;
  nodeId?: string;
}

type BlueprintTemplateId = "hello_command" | "config_greeting" | "keyword_hook";

const blueprintTemplates: Array<{ id: BlueprintTemplateId; label: string; description: string }> = [
  { id: "hello_command", label: "Hello World 示例插件", description: "用户输入 /hello 时自动回复" },
  { id: "config_greeting", label: "读取配置问候", description: "从 config.toml 读取回复文本" },
  { id: "keyword_hook", label: "关键词 Hook", description: "收到消息事件时按关键词回复" },
];

function nextId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function createFlowNode(kind: MaiBotPluginBlueprintFlowNodeKind): MaiBotPluginBlueprintFlowNode {
  if (kind === "read_config") {
    return {
      id: nextId("flow"),
      kind,
      label: "读取配置",
      configPath: "greeting.message",
    };
  }
  if (kind === "log_info") {
    return {
      id: nextId("flow"),
      kind,
      label: "记录日志",
      value: "Plugin flow failed",
    };
  }
  if (kind === "set_variable") {
    return {
      id: nextId("flow"),
      kind,
      label: "设置变量",
      configPath: "result",
      value: "ok",
    };
  }
  if (kind === "if_condition") {
    return {
      id: nextId("flow"),
      kind,
      label: "如果条件",
      value: "True",
      rightValue: "Condition not met",
    };
  }
  if (kind === "compare") {
    return {
      id: nextId("flow"),
      kind,
      label: "比较",
      leftValue: "1",
      operator: "==",
      rightValue: "1",
      targetName: "compare_result",
    };
  }
  if (kind === "boolean_logic") {
    return {
      id: nextId("flow"),
      kind,
      label: "??",
      leftValue: "True",
      operator: "and",
      rightValue: "False",
      targetName: "logic_result",
    };
  }
  if (kind === "math_operation") {
    return {
      id: nextId("flow"),
      kind,
      label: "数学运算",
      leftValue: "1",
      operator: "+",
      rightValue: "1",
      targetName: "math_result",
    };
  }
  if (kind === "join_text") {
    return {
      id: nextId("flow"),
      kind,
      label: "拼接文本",
      leftValue: "Hello ",
      rightValue: "MaiBot",
      targetName: "message",
    };
  }
  if (kind === "guard_config") {
    return {
      id: nextId("flow"),
      kind,
      label: "配置判断",
      configPath: "plugin.enabled",
      value: "true",
    };
  }
  if (kind === "loop") {
    return {
      id: nextId("flow"),
      kind,
      label: "循环",
      configPath: "item",
      value: "range(3)",
    };
  }
  if (kind === "wait") {
    return {
      id: nextId("flow"),
      kind,
      label: "等待",
      value: "1",
    };
  }
  if (kind === "comment") {
    return {
      id: nextId("flow"),
      kind,
      label: "备注",
      value: "在这里写流程备注",
    };
  }
  if (kind === "return_success") {
    return {
      id: nextId("flow"),
      kind,
      label: "成功返回",
    };
  }
  return {
    id: nextId("flow"),
    kind,
    label: "发送文本",
    value: "你好，插件正在运行。",
  };
}

function inspectBlueprintIssues(blueprint: MaiBotPluginBlueprint, validationErrors: string[]): BlueprintIssue[] {
  const issues: BlueprintIssue[] = validationErrors.map((error, index) => ({
    id: `manifest-error-${index}`,
    level: "error",
    title: "Manifest 需要处理",
    detail: error,
  }));

  if (blueprint.components.length === 0) {
    issues.push({
      id: "no-components",
      level: "warning",
      title: "还没有入口组件",
      detail: "至少添加一个 Tool、Command 或 Hook，插件才能运行。",
    });
  }

  for (const component of blueprint.components) {
    const nodes = component.flowNodes ?? [];
    const edges = component.flowEdges ?? [];
    if (nodes.length === 0) {
      issues.push({
        id: `${component.id}-no-nodes`,
        level: "warning",
        title: `${component.name} 没有积木`,
        detail: "打开子蓝图，添加回复文本或其他基础积木。",
        componentId: component.id,
      });
      continue;
    }
    if (!nodes.some((node) => node.kind === "return_success")) {
      issues.push({
        id: `${component.id}-no-return`,
        level: "warning",
        title: `${component.name} 没有结束节点`,
        detail: "在流程末尾连接成功结束积木，让结果更清晰。",
        componentId: component.id,
      });
    }
    for (const node of nodes) {
      const hasNext = edges.some((edge) => edge.fromNodeId === node.id);
      if (!hasNext && node.kind !== "return_success") {
        issues.push({
          id: `${component.id}-${node.id}-no-next`,
          level: "warning",
          title: `${node.label || flowNodeLabel(node.kind)} 没有下一步`,
          detail: "如果这不是最后一步，请从右侧圆点拖到下一个积木。",
          componentId: component.id,
          nodeId: node.id,
        });
      }
      if (node.kind === "read_config" && !node.configPath?.trim()) {
        issues.push({
          id: `${component.id}-${node.id}-config-path`,
          level: "error",
          title: "读取设置缺少路径",
          detail: "填写类似 greeting.message 的配置路径。",
          componentId: component.id,
          nodeId: node.id,
        });
      }
      if ((node.kind === "set_variable" || node.kind === "math_operation" || node.kind === "compare") && !(node.targetName || node.configPath)?.trim()) {
        issues.push({
          id: `${component.id}-${node.id}-target`,
          level: "warning",
          title: "结果没有命名",
          detail: "给结果起一个简单变量名，方便后续积木使用。",
          componentId: component.id,
          nodeId: node.id,
        });
      }
    }
  }

  return issues;
}

function createDefaultBlueprint(): MaiBotPluginBlueprint {
  const pluginId = "com.example.visual-plugin";
  return {
    manifest: {
      pluginId,
      folderName: defaultMaiBotPluginFolderName(pluginId),
      name: "Visual Plugin",
      version: "1.0.0",
      description: "一个由节点编写器生成的 MaiBot 插件",
      authorName: "MaiBot Developer",
      authorUrl: "https://example.com",
      license: "MIT",
      repositoryUrl: "https://example.com/maibot-plugin",
      minHostVersion: "1.0.0",
      maxHostVersion: "1.99.99",
      minSdkVersion: "2.0.0",
      maxSdkVersion: "2.99.99",
      capabilities: ["send.text", "config.get"],
    },
    components: [
      {
        id: nextId("command"),
        kind: "command",
        name: "hello",
        description: "Send a greeting message",
        trigger: "^/hello$",
        responseText: "Hello, the plugin is running.",
        flowNodes: [
          { id: "hello-send", kind: "send_text", label: "发送问候", value: "你好，很高兴认识你。" },
          { id: "hello-return", kind: "return_success", label: "成功返回" },
        ],
        flowEdges: [{ id: "hello-edge", fromNodeId: "hello-send", toNodeId: "hello-return" }],
      },
      {
        id: nextId("tool"),
        kind: "tool",
        name: "send_greeting",
        description: "Send a greeting to current chat",
        detail: "Call this when you want to greet the user.",
        responseText: "Hello, nice to meet you.",
        parameters: [
          {
            id: nextId("param"),
            name: "stream_id",
            type: "string",
            description: "Chat ID",
            required: true,
            defaultValue: "",
          },
        ],
        flowNodes: [
          { id: "greeting-send", kind: "send_text", label: "Send greeting", value: "Hello, nice to meet you." },
          { id: "greeting-return", kind: "return_success", label: "成功返回" },
        ],
        flowEdges: [{ id: "greeting-edge", fromNodeId: "greeting-send", toNodeId: "greeting-return" }],
      },
    ],
    configFields: [
      {
        id: nextId("field"),
        section: "greeting",
        name: "message",
        type: "string",
        label: "问语",
        description: "Default greeting text",
        defaultValue: "Hello, nice to meet you.",
      },
    ],
  };
}

function createTemplateBlueprint(templateId: BlueprintTemplateId): MaiBotPluginBlueprint {
  const blueprint = createDefaultBlueprint();
  if (templateId === "hello_command") {
    return {
      ...blueprint,
      manifest: {
        ...blueprint.manifest,
        pluginId: "com.example.hello-command",
        folderName: "com_example_hello_command",
        name: "Hello Command",
        description: "Command plugin that replies to /hello",
        capabilities: ["send.text"],
      },
      components: [
        {
          id: nextId("command"),
          kind: "command",
          name: "hello",
          description: "Reply when user enters /hello",
          trigger: "^/hello$",
          responseText: "Hello, I am ready.",
          flowNodes: [
            { id: "tpl-hello-send", kind: "send_text", label: "Reply greeting", value: "Hello, I am ready." },
            { id: "tpl-hello-return", kind: "return_success", label: "Finish success" },
          ],
          flowEdges: [{ id: "tpl-hello-edge", fromNodeId: "tpl-hello-send", toNodeId: "tpl-hello-return" }],
        },
      ],
      configFields: [],
    };
  }
  if (templateId === "config_greeting") {
    return {
      ...blueprint,
      manifest: {
        ...blueprint.manifest,
        pluginId: "com.example.config-greeting",
        folderName: "com_example_config_greeting",
        name: "Config Greeting",
        description: "Read greeting from config and send it",
        capabilities: ["send.text", "config.get"],
      },
      components: [
        {
          id: nextId("command"),
          kind: "command",
          name: "greeting",
          description: "输入 /greeting 后读取配置问候语",
          trigger: "^/greeting$",
          responseText: "你好",
          flowNodes: [
            { id: "tpl-config-read", kind: "read_config", label: "读取问语设置", configPath: "greeting.message" },
            { id: "tpl-config-send", kind: "send_text", label: "发问候语", value: "你好" },
            { id: "tpl-config-return", kind: "return_success", label: "Finish success" },
          ],
          flowEdges: [
            { id: "tpl-config-edge-1", fromNodeId: "tpl-config-read", toNodeId: "tpl-config-send" },
            { id: "tpl-config-edge-2", fromNodeId: "tpl-config-send", toNodeId: "tpl-config-return" },
          ],
        },
      ],
      configFields: [
        {
          id: nextId("field"),
          section: "greeting",
          name: "message",
          type: "string",
          label: "问语",
          description: "Greeting text replied by the bot",
          defaultValue: "Hello, nice to meet you.",
        },
      ],
    };
  }
  return {
    ...blueprint,
    manifest: {
      ...blueprint.manifest,
      pluginId: "com.example.keyword-reply",
      folderName: "com_example_keyword_reply",
      name: "Keyword Reply",
      description: "收到消息事件后执行关键词回复流程",
      capabilities: ["send.text", "event.message"],
    },
    components: [
      {
        id: nextId("hook"),
        kind: "hook",
        name: "keyword_reply",
        description: "收到消息后执行回复辑",
        eventType: "ON_MESSAGE",
        responseText: "关键词已收到",
        flowNodes: [
          { id: "tpl-keyword-note", kind: "comment", label: "??", value: "Add keyword checks here" },
          { id: "tpl-keyword-send", kind: "send_text", label: "Reply message", value: "Keyword received." },
          { id: "tpl-keyword-return", kind: "return_success", label: "Finish success" },
        ],
        flowEdges: [
          { id: "tpl-keyword-edge-1", fromNodeId: "tpl-keyword-note", toNodeId: "tpl-keyword-send" },
          { id: "tpl-keyword-edge-2", fromNodeId: "tpl-keyword-send", toNodeId: "tpl-keyword-return" },
        ],
      },
    ],
    configFields: [],
  };
}

export function PluginBuilderPanel(): React.JSX.Element {
  const [blueprint, setBlueprintState] = useState<MaiBotPluginBlueprint>(() => createDefaultBlueprint());
  const [blueprintPast, setBlueprintPast] = useState<MaiBotPluginBlueprint[]>([]);
  const [blueprintFuture, setBlueprintFuture] = useState<MaiBotPluginBlueprint[]>([]);
  const [overwrite, setOverwrite] = useState(false);
  const [saving, setSaving] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [libraryBusy, setLibraryBusy] = useState(false);
  const [installedPlugins, setInstalledPlugins] = useState<InstalledPlugin[]>([]);
  const [builderLibrary, setBuilderLibrary] = useState<MaiBotPluginBuilderLibraryListResult | null>(null);
  const [selectedBuilderPluginId, setSelectedBuilderPluginId] = useState("");
  const [selectedPluginId, setSelectedPluginId] = useState("");
  const [lastResult, setLastResult] = useState<PluginBlueprintCreateResponse | null>(null);
  const [activeFile, setActiveFile] = useState("_manifest.json");
  const [isManifestPanelOpen, setIsManifestPanelOpen] = useState(true);
  const [isFilePreviewOpen, setIsFilePreviewOpen] = useState(false);
  const [activeComponentId, setActiveComponentId] = useState<string | null>(null);
  const [focusedFlowNodeId, setFocusedFlowNodeId] = useState<string | null>(null);

  const setBlueprint = useCallback((action: React.SetStateAction<MaiBotPluginBlueprint>) => {
    setBlueprintState((current) => {
      const next = typeof action === "function"
        ? (action as (value: MaiBotPluginBlueprint) => MaiBotPluginBlueprint)(current)
        : action;
      if (next === current) {
        return current;
      }
      setBlueprintPast((past) => [...past.slice(-(BLUEPRINT_HISTORY_LIMIT - 1)), current]);
      setBlueprintFuture([]);
      return next;
    });
  }, []);

  const undoBlueprint = useCallback(() => {
    setBlueprintPast((past) => {
      if (past.length === 0) {
        return past;
      }
      const previous = past[past.length - 1];
      setBlueprintState((current) => {
        setBlueprintFuture((future) => [current, ...future].slice(0, BLUEPRINT_HISTORY_LIMIT));
        return previous;
      });
      return past.slice(0, -1);
    });
  }, []);

  const redoBlueprint = useCallback(() => {
    setBlueprintFuture((future) => {
      if (future.length === 0) {
        return future;
      }
      const next = future[0];
      setBlueprintState((current) => {
        setBlueprintPast((past) => [...past.slice(-(BLUEPRINT_HISTORY_LIMIT - 1)), current]);
        return next;
      });
      return future.slice(1);
    });
  }, []);

  const files = useMemo(() => buildMaiBotPluginBlueprintFiles(blueprint), [blueprint]);
  const errors = useMemo(() => validateMaiBotPluginBlueprint(blueprint), [blueprint]);
  const blueprintIssues = useMemo(() => inspectBlueprintIssues(blueprint, errors), [blueprint, errors]);
  const selectedFile = files.find((file) => file.relativePath === activeFile) ?? files[0];
  const existingPlugin = useMemo(() => {
    const pluginId = blueprint.manifest.pluginId.trim();
    const folderName = (blueprint.manifest.folderName ?? defaultMaiBotPluginFolderName(pluginId)).trim();
    return installedPlugins.find((plugin) =>
      plugin.id === pluginId
      || plugin.manifest.id === pluginId
      || plugin.path.split(/[\\/]+/u).at(-1) === folderName
    );
  }, [blueprint.manifest.folderName, blueprint.manifest.pluginId, installedPlugins]);
  const saveButtonText = existingPlugin ? "Update and overwrite" : "Generate plugin";
  const localBuilderPlugin = useMemo(() => {
    const pluginId = blueprint.manifest.pluginId.trim();
    const folderName = (blueprint.manifest.folderName ?? defaultMaiBotPluginFolderName(pluginId)).trim();
    return builderLibrary?.plugins.find((plugin) => plugin.pluginId === pluginId || plugin.folderName === folderName);
  }, [blueprint.manifest.folderName, blueprint.manifest.pluginId, builderLibrary]);
  const selectedBuilderPlugin = useMemo(
    () => builderLibrary?.plugins.find((plugin) => plugin.pluginId === selectedBuilderPluginId) ?? null,
    [builderLibrary, selectedBuilderPluginId],
  );
  const activeComponent = useMemo(
    () => blueprint.components.find((component) => component.id === activeComponentId) ?? null,
    [activeComponentId, blueprint.components],
  );
  const canSave = !saving && errors.length === 0 && (!existingPlugin || overwrite);

  useEffect(() => {
    if (!selectedFile && files[0]) {
      setActiveFile(files[0].relativePath);
    }
  }, [files, selectedFile]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, select, [contenteditable='true']")) {
        return;
      }
      if (!(event.ctrlKey || event.metaKey)) {
        return;
      }
      if (event.key.toLowerCase() === "z" && !event.shiftKey) {
        event.preventDefault();
        undoBlueprint();
      } else if (event.key.toLowerCase() === "y" || (event.key.toLowerCase() === "z" && event.shiftKey)) {
        event.preventDefault();
        redoBlueprint();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [redoBlueprint, undoBlueprint]);

  const loadInstalledPlugins = useCallback(async () => {
    try {
      const installed = await fetchInstalledPlugins();
      setInstalledPlugins(installed);
      setSelectedPluginId((current) => current || installed[0]?.id || "");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }, []);

  useEffect(() => {
    void loadInstalledPlugins();
  }, [loadInstalledPlugins]);

  const loadBuilderLibrary = useCallback(async () => {
    try {
      const library = await listPluginBuilderLibrary();
      setBuilderLibrary(library);
      setSelectedBuilderPluginId((current) => current || library.plugins[0]?.pluginId || "");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }, []);

  useEffect(() => {
    void loadBuilderLibrary();
  }, [loadBuilderLibrary]);

  const updateManifest = useCallback((patch: Partial<MaiBotPluginBlueprint["manifest"]>) => {
    setBlueprint((current) => ({
      ...current,
      manifest: { ...current.manifest, ...patch },
    }));
  }, []);

  const updatePluginId = useCallback((pluginId: string) => {
    setBlueprint((current) => {
      const previousDefaultFolder = defaultMaiBotPluginFolderName(current.manifest.pluginId);
      const nextDefaultFolder = defaultMaiBotPluginFolderName(pluginId);
      const keepCustomFolder =
        current.manifest.folderName && current.manifest.folderName !== previousDefaultFolder;
      return {
        ...current,
        manifest: {
          ...current.manifest,
          pluginId,
          folderName: keepCustomFolder ? current.manifest.folderName : nextDefaultFolder,
        },
      };
    });
  }, []);

  const addComponent = useCallback((kind: MaiBotPluginBlueprintComponentKind) => {
    setBlueprint((current) => ({
      ...current,
      components: [
        ...current.components,
        kind === "tool"
          ? {
              id: nextId("tool"),
              kind: "tool",
              name: "new_tool",
              description: "新的工具节点",
              detail: "工具的详细说明",
              responseText: "工具已执行。",
              parameters: [],
              flowNodes: [
                createFlowNode("send_text"),
                createFlowNode("return_success"),
              ],
            }
          : kind === "command"
            ? {
              id: nextId("command"),
              kind: "command",
              name: "new_command",
              description: "新的命令节点",
              trigger: "^/new_command$",
              responseText: "命令已执行。",
              flowNodes: [
                createFlowNode("send_text"),
                createFlowNode("return_success"),
              ],
            }
            : {
              id: nextId("hook"),
              kind: "hook",
              name: "message_hook",
              description: "收到消息时触发",
              eventType: "ON_MESSAGE",
              responseText: "Hook 已触发。",
              flowNodes: [
                createFlowNode("send_text"),
                createFlowNode("return_success"),
              ],
            },
      ],
    }));
  }, []);

  const updateComponent = useCallback((id: string, patch: Partial<MaiBotPluginBlueprintComponent>) => {
    setBlueprint((current) => ({
      ...current,
      components: current.components.map((component) =>
        component.id === id ? { ...component, ...patch } : component,
      ),
    }));
  }, []);

  const removeComponent = useCallback((id: string) => {
    setBlueprint((current) => ({
      ...current,
      components: current.components.filter((component) => component.id !== id),
    }));
    setActiveComponentId((current) => (current === id ? null : current));
  }, []);

  const addParameter = useCallback((componentId: string) => {
    setBlueprint((current) => ({
      ...current,
      components: current.components.map((component) =>
        component.id === componentId
          ? {
              ...component,
              parameters: [
                ...(component.parameters ?? []),
                {
                  id: nextId("param"),
                  name: "value",
                  type: "string",
                  description: "参数说明",
                  required: false,
                  defaultValue: "",
                },
              ],
            }
          : component,
      ),
    }));
  }, []);

  const updateParameter = useCallback((
    componentId: string,
    parameterId: string,
    patch: Partial<MaiBotPluginBlueprintParameter>,
  ) => {
    setBlueprint((current) => ({
      ...current,
      components: current.components.map((component) =>
        component.id === componentId
          ? {
              ...component,
              parameters: (component.parameters ?? []).map((parameter) =>
                parameter.id === parameterId ? { ...parameter, ...patch } : parameter,
              ),
            }
          : component,
      ),
    }));
  }, []);

  const removeParameter = useCallback((componentId: string, parameterId: string) => {
    setBlueprint((current) => ({
      ...current,
      components: current.components.map((component) =>
        component.id === componentId
          ? {
              ...component,
              parameters: (component.parameters ?? []).filter((parameter) => parameter.id !== parameterId),
            }
          : component,
      ),
    }));
  }, []);

  const addFlowNode = useCallback((componentId: string, kind: MaiBotPluginBlueprintFlowNodeKind) => {
    const node = createFlowNode(kind);
    setBlueprint((current) => ({
      ...current,
      components: current.components.map((component) =>
        component.id === componentId
          ? {
              ...component,
              flowNodes: [...(component.flowNodes ?? []), node],
            }
          : component,
      ),
    }));
  }, []);

  const updateFlowNode = useCallback((
    componentId: string,
    nodeId: string,
    patch: Partial<MaiBotPluginBlueprintFlowNode>,
  ) => {
    setBlueprint((current) => ({
      ...current,
      components: current.components.map((component) =>
        component.id === componentId
          ? {
              ...component,
              flowNodes: (component.flowNodes ?? []).map((node) =>
                node.id === nodeId ? { ...node, ...patch } : node,
              ),
            }
          : component,
      ),
    }));
  }, []);

  const removeFlowNode = useCallback((componentId: string, nodeId: string) => {
    setBlueprint((current) => ({
      ...current,
      components: current.components.map((component) =>
        component.id === componentId
          ? {
              ...component,
              flowNodes: (component.flowNodes ?? []).filter((node) => node.id !== nodeId),
              flowEdges: (component.flowEdges ?? []).filter((edge) =>
                edge.fromNodeId !== nodeId && edge.toNodeId !== nodeId
              ),
            }
          : component,
      ),
    }));
  }, []);

  const connectFlowNode = useCallback((componentId: string, fromNodeId: string, toNodeId: string) => {
    setBlueprint((current) => ({
      ...current,
      components: current.components.map((component) => {
        if (component.id !== componentId) {
          return component;
        }
        const edges = (component.flowEdges ?? []).filter((edge) => edge.fromNodeId !== fromNodeId);
        return {
          ...component,
          flowEdges: toNodeId
            ? [...edges, { id: nextId("edge"), fromNodeId, toNodeId }]
            : edges,
        };
      }),
    }));
  }, []);

  const addConfigField = useCallback(() => {
    setBlueprint((current) => ({
      ...current,
      configFields: [
        ...current.configFields,
        {
          id: nextId("field"),
          section: "settings",
          name: "value",
          type: "string",
          label: "??",
          description: "配置说明",
          defaultValue: "",
        },
      ],
    }));
  }, []);

  const updateConfigField = useCallback((id: string, patch: Partial<MaiBotPluginBlueprintConfigField>) => {
    setBlueprint((current) => ({
      ...current,
      configFields: current.configFields.map((field) => (field.id === id ? { ...field, ...patch } : field)),
    }));
  }, []);

  const removeConfigField = useCallback((id: string) => {
    setBlueprint((current) => ({
      ...current,
      configFields: current.configFields.filter((field) => field.id !== id),
    }));
  }, []);

  const savePlugin = useCallback(async () => {
    if (errors.length > 0) {
      toast.error(errors[0]);
      return;
    }
    setSaving(true);
    try {
      const result = await createMaiBotPluginFromBlueprint(blueprint, overwrite);
      setLastResult(result);
      toast.success(result.overwritten ? "插件已更新并覆盖" : "插件已生成");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }, [blueprint, errors, overwrite]);

  const parseExistingPlugin = useCallback(async () => {
    if (!selectedPluginId) {
      toast.error("请选择要解析的插件");
      return;
    }
    setParsing(true);
    try {
      const result = await parseMaiBotPluginToBlueprint(selectedPluginId);
      setBlueprint(result.blueprint);
      setOverwrite(true);
      setLastResult(null);
      setActiveFile("_manifest.json");
      const unsupported = result.parsed.unsupportedDecorators.length > 0
        ? `，暂未节点化：${result.parsed.unsupportedDecorators.join(", ")}`
        : "";
      toast.success(
        `已解析 ${result.parsed.tools} 个 Tool、${result.parsed.commands} 个 Command、${result.parsed.configFields} 个配置项${unsupported}`,
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setParsing(false);
    }
  }, [selectedPluginId]);

  const saveToBuilderLibrary = useCallback(async () => {
    if (errors.length > 0) {
      toast.error(errors[0]);
      return;
    }
    setLibraryBusy(true);
    try {
      const result = await savePluginBuilderLibrary(blueprint, true);
      await loadBuilderLibrary();
      setSelectedBuilderPluginId(result.item.pluginId);
      toast.success(result.overwritten ? "已更新编写器本地插件" : "已保存到编写器本地插件库");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setLibraryBusy(false);
    }
  }, [blueprint, errors, loadBuilderLibrary]);

  const loadFromBuilderLibrary = useCallback(async () => {
    if (!selectedBuilderPluginId) {
      toast.error("请择本地插件");
      return;
    }
    setLibraryBusy(true);
    try {
      const result = await loadPluginBuilderLibrary(selectedBuilderPluginId);
      setBlueprint(result.blueprint);
      setSelectedBuilderPluginId(result.item.pluginId);
      setOverwrite(true);
      setLastResult(null);
      setActiveFile("_manifest.json");
      toast.success(`已打弢 ${result.item.name}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setLibraryBusy(false);
    }
  }, [selectedBuilderPluginId]);

  const deleteFromBuilderLibrary = useCallback(async () => {
    if (!selectedBuilderPluginId) {
      toast.error("请择本地插件");
      return;
    }
    setLibraryBusy(true);
    try {
      const result = await deletePluginBuilderLibrary(selectedBuilderPluginId);
      setSelectedBuilderPluginId("");
      await loadBuilderLibrary();
      toast.success(`已删除 ${result.pluginId}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setLibraryBusy(false);
    }
  }, [loadBuilderLibrary, selectedBuilderPluginId]);

  const createNewBuilderProject = useCallback(() => {
    setBlueprint(createDefaultBlueprint());
    setSelectedBuilderPluginId("");
    setOverwrite(false);
    setLastResult(null);
    setActiveFile("_manifest.json");
    setActiveComponentId(null);
    setFocusedFlowNodeId(null);
    setIsManifestPanelOpen(true);
    toast.success("Created a new plugin blueprint");
  }, []);

  const applyBlueprintTemplate = useCallback((templateId: BlueprintTemplateId) => {
    setBlueprint(createTemplateBlueprint(templateId));
    setSelectedBuilderPluginId("");
    setOverwrite(false);
    setLastResult(null);
    setActiveFile("_manifest.json");
    setActiveComponentId(null);
    setFocusedFlowNodeId(null);
    toast.success("Applied plugin template");
  }, []);

  const selectBlueprintIssue = useCallback((issue: BlueprintIssue) => {
    if (issue.componentId) {
      setActiveComponentId(issue.componentId);
      setFocusedFlowNodeId(issue.nodeId ?? null);
      setIsManifestPanelOpen(true);
      return;
    }
    setActiveComponentId(null);
    setFocusedFlowNodeId(null);
    setIsManifestPanelOpen(true);
  }, []);

  const duplicateCurrentBuilderProject = useCallback(() => {
    const suffix = Date.now().toString(36).slice(-4);
    const basePluginId = blueprint.manifest.pluginId.replace(/\.copy(?:-[a-z0-9]+)?$/u, "");
    const nextPluginId = `${basePluginId}.copy-${suffix}`;
    setBlueprint((current) => ({
      ...current,
      manifest: {
        ...current.manifest,
        pluginId: nextPluginId,
        folderName: defaultMaiBotPluginFolderName(nextPluginId),
        name: `${current.manifest.name || "Visual Plugin"} Copy`,
      },
    }));
    setSelectedBuilderPluginId("");
    setOverwrite(false);
    setLastResult(null);
    toast.success("已复制为新蓝图，保存后会成为独立本地项目");
  }, [blueprint.manifest.pluginId]);

  const exportCurrentBuilderBlueprint = useCallback(async () => {
    if (errors.length > 0) {
      toast.error(errors[0]);
      return;
    }
    setLibraryBusy(true);
    try {
      const result = await exportPluginBuilderBlueprint(blueprint);
      if (result) {
        toast.success(`已导出蓝图：${result.filePath}`);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setLibraryBusy(false);
    }
  }, [blueprint, errors]);

  const importBuilderBlueprintFile = useCallback(async () => {
    setLibraryBusy(true);
    try {
      const result = await importPluginBuilderBlueprint();
      if (!result) {
        return;
      }
      await loadBuilderLibrary();
      setBlueprint(result.blueprint);
      setSelectedBuilderPluginId(result.item.pluginId);
      setOverwrite(true);
      setLastResult(null);
      setActiveFile("_manifest.json");
      setActiveComponentId(null);
      toast.success(result.overwritten ? "已导入并覆盖本地蓝图" : "已导入到编写器本地库");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setLibraryBusy(false);
    }
  }, [loadBuilderLibrary]);

  const openBuilderLibraryDirectory = useCallback(() => {
    void openPluginBuilderLibrary();
  }, []);

  const openLastDirectory = useCallback(() => {
    if (lastResult) {
      void window.maibotDesktop?.openPath(lastResult.pluginPath);
    }
  }, [lastResult]);

  const openDocs = useCallback(() => {
    void window.maibotDesktop?.openExternal("https://docs.mai-mai.org/develop/plugin-dev/");
  }, []);

  return (
    <div className="h-full min-h-0 overflow-hidden bg-background">
      <div className="flex h-full min-h-0 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-5">
          <div className="grid size-8 place-items-center rounded-md bg-secondary text-secondary-foreground">
            <Workflow className="size-4" />
          </div>
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold">插件编写器</h2>
            <p className="truncate text-[11px] text-muted-foreground">{blueprint.manifest.pluginId}</p>
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <Button onClick={openDocs} size="sm" variant="secondary">
              <Braces />
              SDK 文档
            </Button>
            {lastResult ? (
              <Button onClick={openLastDirectory} size="sm" variant="secondary">
                <FolderOpen />
                生成目录
              </Button>
            ) : null}
            <Button
              aria-expanded={isFilePreviewOpen}
              onClick={() => setIsFilePreviewOpen((open) => !open)}
              size="sm"
              variant="secondary"
            >
              {isFilePreviewOpen ? <PanelRightClose /> : <PanelRightOpen />}
              {isFilePreviewOpen ? "收起文件" : "文件预览"}
            </Button>
            <Button disabled={!canSave} onClick={() => void savePlugin()} size="sm">
              {saving ? <Loader2 className="animate-spin" /> : <Save />}
              {saveButtonText}
            </Button>
          </div>
        </header>

        <PluginBuilderProjectBar
          builderLibrary={builderLibrary}
          currentProject={localBuilderPlugin ?? null}
          installedPlugins={installedPlugins}
          libraryBusy={libraryBusy}
          parsing={parsing}
          selectedBuilderPlugin={selectedBuilderPlugin}
          selectedBuilderPluginId={selectedBuilderPluginId}
          selectedPluginId={selectedPluginId}
          canExport={errors.length === 0}
          canRedo={blueprintFuture.length > 0}
          canUndo={blueprintPast.length > 0}
          issues={blueprintIssues}
          onApplyTemplate={applyBlueprintTemplate}
          onCreateNew={createNewBuilderProject}
          onDelete={() => void deleteFromBuilderLibrary()}
          onDuplicate={duplicateCurrentBuilderProject}
          onExport={() => void exportCurrentBuilderBlueprint()}
          onImport={() => void importBuilderBlueprintFile()}
          onIssueSelect={selectBlueprintIssue}
          onLoad={() => void loadFromBuilderLibrary()}
          onOpenLibrary={openBuilderLibraryDirectory}
          onParse={() => void parseExistingPlugin()}
          onRedo={redoBlueprint}
          onSave={() => void saveToBuilderLibrary()}
          onSelectBuilderPlugin={setSelectedBuilderPluginId}
          onSelectInstalledPlugin={setSelectedPluginId}
          onUndo={undoBlueprint}
        />

        <div
          className={cn(
            "grid min-h-0 flex-1 overflow-hidden",
            isManifestPanelOpen && isFilePreviewOpen && "grid-cols-[340px_minmax(520px,1fr)_minmax(360px,0.85fr)]",
            isManifestPanelOpen && !isFilePreviewOpen && "grid-cols-[340px_minmax(520px,1fr)]",
            !isManifestPanelOpen && isFilePreviewOpen && "grid-cols-[52px_minmax(520px,1fr)_minmax(360px,0.85fr)]",
            !isManifestPanelOpen && !isFilePreviewOpen && "grid-cols-[52px_minmax(520px,1fr)]",
          )}
        >
          <aside className="min-h-0 overflow-auto border-r border-border bg-card">
            {isManifestPanelOpen ? (
              <div className="flex min-h-full flex-col">
                <div className="sticky top-0 z-20 flex h-10 shrink-0 items-center gap-2 border-b border-border bg-card px-3">
                  <FileJson className="size-4 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate text-xs font-semibold">
                    {activeComponent ? "组件元信息" : "Manifest"}
                  </span>
                  <Button
                    aria-label="折叠左侧元信息面板"
                    onClick={() => setIsManifestPanelOpen(false)}
                    size="icon-sm"
                    type="button"
                    variant="ghost"
                  >
                    <PanelLeftClose className="size-3.5" />
                  </Button>
                </div>
                <div className="grid gap-4 p-4">
                  {activeComponent ? (
                    <ComponentMetaEditor
                      component={activeComponent}
                      onAddParameter={addParameter}
                      onBack={() => setActiveComponentId(null)}
                      onChange={updateComponent}
                      onParameterChange={updateParameter}
                      onParameterRemove={removeParameter}
                      onRemove={removeComponent}
                    />
                  ) : (
                    <ManifestEditor
                      blueprint={blueprint}
                      errors={errors}
                      onManifestChange={updateManifest}
                      onPluginIdChange={updatePluginId}
                      onOverwriteChange={setOverwrite}
                      overwrite={overwrite}
                      existingPluginName={existingPlugin?.manifest.name ?? existingPlugin?.id}
                    />
                  )}
                </div>
              </div>
            ) : (
              <button
                aria-label="展开左侧元信息面板"
                className="grid h-full w-full place-items-start justify-center p-2 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
                onClick={() => setIsManifestPanelOpen(true)}
                type="button"
              >
                <PanelLeftOpen className="mt-2 size-4" />
              </button>
            )}
          </aside>

          <section className={cn("min-h-0 overflow-hidden bg-background", isFilePreviewOpen && "border-r border-border")}>
            <FreeBlueprintCanvas
              activeComponentId={activeComponentId}
              blueprint={blueprint}
              focusedFlowNodeId={focusedFlowNodeId}
              onAddComponent={addComponent}
              onAddConfigField={addConfigField}
              onAddFlowNode={addFlowNode}
              onAddParameter={addParameter}
              onComponentChange={updateComponent}
              onComponentRemove={removeComponent}
              onConfigFieldChange={updateConfigField}
              onConfigFieldRemove={removeConfigField}
              onConnectFlowNode={connectFlowNode}
              onFlowNodeChange={updateFlowNode}
              onFlowNodeRemove={removeFlowNode}
              onOpenComponent={(componentId) => setActiveComponentId(componentId)}
              onFlowNodeFocused={() => setFocusedFlowNodeId(null)}
              onParameterChange={updateParameter}
              onParameterRemove={removeParameter}
              onReturnToPlugin={() => setActiveComponentId(null)}
            />
          </section>

          {isFilePreviewOpen ? (
            <section className="min-h-0 overflow-hidden bg-card">
              <FilePreviewPanel
                activeFile={selectedFile}
                blueprint={blueprint}
                files={files}
                onCollapse={() => setIsFilePreviewOpen(false)}
                onSelect={setActiveFile}
              />
            </section>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function PluginBuilderProjectBar({
  builderLibrary,
  canExport,
  canRedo,
  canUndo,
  currentProject,
  installedPlugins,
  issues,
  libraryBusy,
  parsing,
  selectedBuilderPlugin,
  selectedBuilderPluginId,
  selectedPluginId,
  onApplyTemplate,
  onCreateNew,
  onDelete,
  onDuplicate,
  onExport,
  onImport,
  onIssueSelect,
  onLoad,
  onOpenLibrary,
  onParse,
  onRedo,
  onSave,
  onSelectBuilderPlugin,
  onSelectInstalledPlugin,
  onUndo,
}: {
  builderLibrary: MaiBotPluginBuilderLibraryListResult | null;
  canExport: boolean;
  canRedo: boolean;
  canUndo: boolean;
  currentProject: MaiBotPluginBuilderLibraryItem | null;
  installedPlugins: InstalledPlugin[];
  issues: BlueprintIssue[];
  libraryBusy: boolean;
  parsing: boolean;
  selectedBuilderPlugin: MaiBotPluginBuilderLibraryItem | null;
  selectedBuilderPluginId: string;
  selectedPluginId: string;
  onApplyTemplate: (templateId: BlueprintTemplateId) => void;
  onCreateNew: () => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onExport: () => void;
  onImport: () => void;
  onIssueSelect: (issue: BlueprintIssue) => void;
  onLoad: () => void;
  onOpenLibrary: () => void;
  onParse: () => void;
  onRedo: () => void;
  onSave: () => void;
  onSelectBuilderPlugin: (pluginId: string) => void;
  onSelectInstalledPlugin: (pluginId: string) => void;
  onUndo: () => void;
}): React.JSX.Element {
  const projectCount = builderLibrary?.plugins.length ?? 0;
  const errorCount = issues.filter((issue) => issue.level === "error").length;
  const [selectedTemplateId, setSelectedTemplateId] = useState<BlueprintTemplateId>("hello_command");
  const [detailsOpen, setDetailsOpen] = useState(false);
  const selectedTemplate = blueprintTemplates.find((template) => template.id === selectedTemplateId);

  return (
    <section className="grid shrink-0 gap-2 border-b border-border bg-card/70 px-4 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <Boxes className="size-4 text-muted-foreground" />
        <Badge variant="secondary">{projectCount} local</Badge>
        <div className="min-w-[220px] max-w-[360px] flex-1">
          <select
            className="h-9 w-full rounded-md border border-input bg-background px-2 text-xs outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-ring/40"
            disabled={libraryBusy}
            onChange={(event) => onSelectBuilderPlugin(event.target.value)}
            value={selectedBuilderPluginId}
          >
            <option value="">未保存的新蓝图</option>
            {projectCount > 0 ? (
              builderLibrary!.plugins.map((plugin) => (
                <option key={plugin.pluginId} value={plugin.pluginId}>
                  {plugin.name || plugin.pluginId}
                </option>
              ))
            ) : (
              <option disabled value="__empty">暂无本地蓝图</option>
            )}
          </select>
        </div>

        <Button disabled={libraryBusy || !selectedBuilderPluginId} onClick={onLoad} size="sm" type="button" variant="secondary">
          {libraryBusy ? <Loader2 className="animate-spin" /> : <FolderOpen />}
          打开
        </Button>
        <Button onClick={onCreateNew} size="sm" type="button" variant="secondary">
          <Plus />
          新建
        </Button>
        <Button disabled={libraryBusy} onClick={onSave} size="sm" type="button" variant="secondary">
          {libraryBusy ? <Loader2 className="animate-spin" /> : <Save />}
          保存
        </Button>
        <Button disabled={libraryBusy || !canExport} onClick={onExport} size="sm" type="button" variant="secondary">
          <Download />
          导出
        </Button>
        <Button disabled={libraryBusy} onClick={onImport} size="sm" type="button" variant="secondary">
          <Upload />
          导入
        </Button>
        <Button disabled={!canUndo} onClick={onUndo} size="icon-sm" type="button" variant="secondary" aria-label="Undo">
          <Undo2 />
        </Button>
        <Button disabled={!canRedo} onClick={onRedo} size="icon-sm" type="button" variant="secondary" aria-label="Redo">
          <Redo2 />
        </Button>

        <div className="ml-auto flex items-center gap-2">
          <Badge variant={errorCount > 0 ? "danger" : issues.length > 0 ? "secondary" : "success"}>
            {issues.length === 0 ? "OK" : `${issues.length} issues`}
          </Badge>
          <Button onClick={() => setDetailsOpen((value) => !value)} size="sm" type="button" variant="ghost">
            {detailsOpen ? "收起工具" : "更多工具"}
          </Button>
        </div>
      </div>

      {detailsOpen ? (
        <div className="grid gap-2 rounded-md border border-border bg-background/60 p-2 lg:grid-cols-[minmax(240px,1fr)_minmax(240px,1fr)_minmax(260px,1fr)]">
          <div className="grid gap-2">
            <p className="truncate text-[11px] text-muted-foreground">
              {selectedBuilderPlugin
                ? `${selectedBuilderPlugin.pluginId} / v${selectedBuilderPlugin.version} / ${formatBuilderDate(selectedBuilderPlugin.updatedAt)}`
                : builderLibrary?.root ?? "Blueprints are stored in an independent builder resource folder."}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button disabled={libraryBusy} onClick={onDuplicate} size="sm" type="button" variant="secondary">
                <FileJson />
                复制
              </Button>
              <Button disabled={libraryBusy || !selectedBuilderPluginId} onClick={onDelete} size="sm" type="button" variant="secondary">
                <Trash2 />
                删除
              </Button>
              <Button onClick={onOpenLibrary} size="sm" type="button" variant="secondary">
                <FolderOpen />
                目录
              </Button>
            </div>
          </div>

          <div className="grid gap-2">
            <div className="grid grid-cols-[1fr_auto] gap-2">
              <select
                className="h-9 min-w-0 rounded-md border border-input bg-background px-2 text-xs outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-ring/40"
                onChange={(event) => setSelectedTemplateId(event.target.value as BlueprintTemplateId)}
                value={selectedTemplateId}
              >
                {blueprintTemplates.map((template) => (
                  <option key={template.id} value={template.id}>{template.label}</option>
                ))}
              </select>
              <Button onClick={() => onApplyTemplate(selectedTemplateId)} size="sm" type="button" variant="secondary">
                套用
              </Button>
            </div>
            <p className="truncate text-[11px] text-muted-foreground">{selectedTemplate?.description}</p>
          </div>

          <div className="grid gap-2">
            <div className="grid grid-cols-[1fr_auto] gap-2">
              <select
                className="h-9 min-w-0 rounded-md border border-input bg-background px-2 text-xs outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-ring/40"
                disabled={parsing || installedPlugins.length === 0}
                onChange={(event) => onSelectInstalledPlugin(event.target.value)}
                value={selectedPluginId}
              >
                {installedPlugins.length === 0 ? (
                  <option value="">暂无已安装插件</option>
                ) : (
                  installedPlugins.map((plugin) => (
                    <option key={plugin.id} value={plugin.id}>
                      {plugin.manifest.name || plugin.id}
                    </option>
                  ))
                )}
              </select>
              <Button disabled={parsing || installedPlugins.length === 0} onClick={onParse} size="sm" type="button" variant="secondary">
                {parsing ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                解析
              </Button>
            </div>
            <div className="max-h-28 overflow-auto rounded-md border border-border bg-background/70 p-2">
              {issues.length === 0 ? (
                <p className="text-[11px] text-muted-foreground">蓝图检查通过。</p>
              ) : (
                <div className="grid gap-1">
                  {issues.slice(0, 8).map((issue) => (
                    <button
                      className="grid w-full gap-0.5 rounded-md px-1.5 py-1 text-left text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                      key={issue.id}
                      onClick={() => onIssueSelect(issue)}
                      title={issue.detail}
                      type="button"
                    >
                      <span className={cn("font-semibold", issue.level === "error" ? "text-danger" : "text-warning-foreground")}>
                        {issue.level === "error" ? "错误" : "提示"}
                      </span>
                      <span className="truncate">{issue.title}</span>
                      <span className="line-clamp-2 text-[10px] leading-snug text-muted-foreground">{issue.detail}</span>
                    </button>
                  ))}
                  {issues.length > 8 ? <p className="text-[11px] text-muted-foreground">+{issues.length - 8} more</p> : null}
                </div>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function formatBuilderDate(value: number | undefined): string {
  if (!value) {
    return "未保存";
  }
  try {
    return new Intl.DateTimeFormat(undefined, {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(value));
  } catch {
    return new Date(value).toLocaleString();
  }
}

function explainPreviewFile(blueprint: MaiBotPluginBlueprint, relativePath: string): { title: string; detail: string } {
  if (relativePath === "_manifest.json") {
    return {
      title: "Manifest：插件身份信息",
      detail: `声明插件 ID、名称、版本、作者和能力。当前插件 ID 是 ${blueprint.manifest.pluginId || "未填写"}。`,
    };
  }
  if (relativePath === "config.toml") {
    return {
      title: "config.toml：给用户修改的设置",
      detail: blueprint.configFields.length > 0
        ? `这里会生成 ${blueprint.configFields.length} 个配置项，读取配置积木会从这里取值。`
        : "当前还没有配置项，可以在左侧 Manifest 元信息里添加。",
    };
  }
  if (relativePath === "plugin.py") {
    const components = blueprint.components.map((component) =>
      `${componentKindLabel(component.kind)} ${component.name}: ${(component.flowNodes ?? []).map((node) => flowNodeLabel(node.kind)).join(" -> ") || "默认流程"}`
    );
    return {
      title: "plugin.py：真正运行的插件代码",
      detail: components.length > 0
        ? components.slice(0, 3).join("；")
        : "当前还没有入口组件，生成后会只有基础插件结构。",
    };
  }
  return {
    title: "生成文件",
    detail: "这是编写器根据蓝图自动生成的文件内容。",
  };
}

function buildPreviewSteps(blueprint: MaiBotPluginBlueprint, relativePath: string): string[] {
  if (relativePath === "_manifest.json") {
    return [
      `插件 ID：${blueprint.manifest.pluginId || "未填写"}`,
      `声明能力：${blueprint.manifest.capabilities.length > 0 ? blueprint.manifest.capabilities.join("、") : "暂无"}`,
      `入口组件：${blueprint.components.length} 个`,
    ];
  }
  if (relativePath === "config.toml") {
    if (blueprint.configFields.length === 0) {
      return ["还没有配置项，可以在左侧元信息面板添加。"];
    }
    return blueprint.configFields.slice(0, 6).map((field) => `${field.label || field.name || field.id} = ${String(field.defaultValue ?? "")}`);
  }
  if (relativePath === "plugin.py") {
    const lines = blueprint.components.flatMap((component) => {
      const flow = component.flowNodes ?? [];
      if (flow.length === 0) {
        return [`${component.name} 还没有积木流程`];
      }
      return [`${component.name}：${flow.slice(0, 5).map((node) => flowNodeLabel(node.kind)).join(" -> ")}`];
    });
    return lines.length > 0 ? lines.slice(0, 6) : ["还没有可生成的入口组件。"];
  }
  return ["选择文件后，这里会解释它在插件中的作用。"];
}

function ManifestEditor({
  blueprint,
  errors,
  existingPluginName,
  overwrite,
  onManifestChange,
  onOverwriteChange,
  onPluginIdChange,
}: {
  blueprint: MaiBotPluginBlueprint;
  errors: string[];
  existingPluginName?: string;
  overwrite: boolean;
  onManifestChange: (patch: Partial<MaiBotPluginBlueprint["manifest"]>) => void;
  onOverwriteChange: (value: boolean) => void;
  onPluginIdChange: (value: string) => void;
}): React.JSX.Element {
  const updateCapability = (index: number, value: string): void => {
    onManifestChange({
      capabilities: blueprint.manifest.capabilities.map((capability, itemIndex) =>
        itemIndex === index ? value : capability,
      ),
    });
  };
  const addCapability = (capability: string): void => {
    if (!capability || blueprint.manifest.capabilities.includes(capability)) {
      return;
    }
    onManifestChange({ capabilities: [...blueprint.manifest.capabilities, capability] });
  };
  const removeCapability = (index: number): void => {
    onManifestChange({
      capabilities: blueprint.manifest.capabilities.filter((_, itemIndex) => itemIndex !== index),
    });
  };

  return (
    <section className="grid gap-3">
      <SectionTitle icon={<FileJson />} title="Manifest" trailing={<Badge variant={errors.length ? "danger" : "secondary"}>{errors.length ? "需要处理" : "有效"}</Badge>} />
      <Field label="插件 ID">
        <Input monospace onChange={(event) => onPluginIdChange(event.target.value)} value={blueprint.manifest.pluginId} />
      </Field>
      <Field label="目录名">
        <Input monospace onChange={(event) => onManifestChange({ folderName: event.target.value })} value={blueprint.manifest.folderName ?? ""} />
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label="名称">
          <Input onChange={(event) => onManifestChange({ name: event.target.value })} value={blueprint.manifest.name} />
        </Field>
        <Field label="版本">
          <Input monospace onChange={(event) => onManifestChange({ version: event.target.value })} value={blueprint.manifest.version} />
        </Field>
      </div>
      <Field label="描述">
        <textarea
          className="min-h-20 rounded-md border border-input bg-background px-3 py-2 text-sm outline-none transition-shadow focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-ring/40"
          onChange={(event) => onManifestChange({ description: event.target.value })}
          value={blueprint.manifest.description}
        />
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label="作者">
          <Input onChange={(event) => onManifestChange({ authorName: event.target.value })} value={blueprint.manifest.authorName} />
        </Field>
        <Field label="许可证">
          <Input monospace onChange={(event) => onManifestChange({ license: event.target.value })} value={blueprint.manifest.license} />
        </Field>
      </div>
      <Field label="作者 URL">
        <Input monospace onChange={(event) => onManifestChange({ authorUrl: event.target.value })} value={blueprint.manifest.authorUrl} />
      </Field>
      <Field label="仓库地址">
        <Input monospace onChange={(event) => onManifestChange({ repositoryUrl: event.target.value })} value={blueprint.manifest.repositoryUrl} />
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label="MaiBot 最低版本">
          <Input monospace onChange={(event) => onManifestChange({ minHostVersion: event.target.value })} value={blueprint.manifest.minHostVersion} />
        </Field>
        <Field label="MaiBot 最高版本">
          <Input monospace onChange={(event) => onManifestChange({ maxHostVersion: event.target.value })} value={blueprint.manifest.maxHostVersion} />
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Field label="SDK 最低版本">
          <Input monospace onChange={(event) => onManifestChange({ minSdkVersion: event.target.value })} value={blueprint.manifest.minSdkVersion} />
        </Field>
        <Field label="SDK 最高版本">
          <Input monospace onChange={(event) => onManifestChange({ maxSdkVersion: event.target.value })} value={blueprint.manifest.maxSdkVersion} />
        </Field>
      </div>
      <Field label="能力">
        <div className="grid gap-2 rounded-md border border-border bg-background p-2">
          {(blueprint.manifest.capabilities.length ? blueprint.manifest.capabilities : [""]).map((capability, index) => (
            <div className="grid grid-cols-[1fr_32px] gap-2" key={`${index}-${capability}`}>
              <Input
                monospace
                onChange={(event) => updateCapability(index, event.target.value)}
                placeholder="send.text"
                value={capability}
              />
              <Button
                aria-label="移除能力"
                disabled={blueprint.manifest.capabilities.length <= 1}
                onClick={() => removeCapability(index)}
                size="icon-sm"
                type="button"
                variant="ghost"
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          ))}
          <select
            className="h-8 rounded-md border border-input bg-card px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            onChange={(event) => {
              addCapability(event.target.value);
              event.target.value = "";
            }}
            value=""
          >
            <option value="">添加能力</option>
            {capabilityLibrary.map((capability) => (
              <option
                disabled={blueprint.manifest.capabilities.includes(capability.value)}
                key={capability.value}
                value={capability.value}
              >
                {capability.label} - {capability.value}
              </option>
            ))}
          </select>
          <Button className="hidden" onClick={() => addCapability("send.text")} size="sm" type="button" variant="secondary" aria-hidden tabIndex={-1}>
            <Plus className="size-3.5" />
            添加能力
          </Button>
        </div>
      </Field>
      <label className="flex items-center justify-between gap-3 rounded-md border border-border bg-background px-3 py-2 text-xs">
        <span className="min-w-0">
          <span className="block truncate font-medium">{existingPluginName ? "更新并覆盖已有插件" : "覆盖已有目录"}</span>
          {existingPluginName ? (
            <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">{existingPluginName}</span>
          ) : null}
        </span>
        <Checkbox checked={overwrite} onCheckedChange={(checked) => onOverwriteChange(checked === true)} />
      </label>
      {errors.length > 0 ? (
        <div className="grid gap-1 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {errors.slice(0, 3).map((error) => <span key={error}>{error}</span>)}
        </div>
      ) : null}
    </section>
  );
}

function ComponentMetaEditor({
  component,
  onAddParameter,
  onBack,
  onChange,
  onParameterChange,
  onParameterRemove,
  onRemove,
}: {
  component: MaiBotPluginBlueprintComponent;
  onAddParameter: (componentId: string) => void;
  onBack: () => void;
  onChange: (id: string, patch: Partial<MaiBotPluginBlueprintComponent>) => void;
  onParameterChange: (componentId: string, parameterId: string, patch: Partial<MaiBotPluginBlueprintParameter>) => void;
  onParameterRemove: (componentId: string, parameterId: string) => void;
  onRemove: (id: string) => void;
}): React.JSX.Element {
  return (
    <section className="grid gap-3">
      <SectionTitle
        icon={component.kind === "tool" ? <Wrench /> : component.kind === "command" ? <TerminalSquare /> : <MessageSquare />}
        title={componentKindLabel(component.kind)}
        trailing={
          <Button onClick={onBack} size="sm" type="button" variant="secondary">
            返回
          </Button>
        }
      />
      <Field label="类型">
        <select
          className="h-9 rounded-md border border-input bg-card px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          onChange={(event) => onChange(component.id, { kind: event.target.value as MaiBotPluginBlueprintComponentKind })}
          value={component.kind}
        >
          <option value="tool">Tool</option>
          <option value="command">Command</option>
          <option value="hook">Hook</option>
        </select>
      </Field>
      <Field label="名称">
        <Input monospace onChange={(event) => onChange(component.id, { name: event.target.value })} value={component.name} />
      </Field>
      <Field label="描述">
        <Input onChange={(event) => onChange(component.id, { description: event.target.value })} value={component.description} />
      </Field>
      {component.kind === "command" ? (
        <Field label="触发正则">
          <Input monospace onChange={(event) => onChange(component.id, { trigger: event.target.value })} value={component.trigger ?? ""} />
        </Field>
      ) : component.kind === "hook" ? (
        <Field label="事件类型">
          <select
            className="h-9 rounded-md border border-input bg-card px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            onChange={(event) => onChange(component.id, { eventType: event.target.value })}
            value={component.eventType ?? "ON_MESSAGE"}
          >
            {hookEventTypes.map((eventType) => (
              <option key={eventType} value={eventType}>{eventType}</option>
            ))}
          </select>
        </Field>
      ) : (
        <Field label="详情">
          <Input onChange={(event) => onChange(component.id, { detail: event.target.value })} value={component.detail ?? ""} />
        </Field>
      )}
      <Field label="默认返回文本">
        <Input onChange={(event) => onChange(component.id, { responseText: event.target.value })} value={component.responseText ?? ""} />
      </Field>
      {component.kind === "tool" ? (
        <div className="grid gap-2 rounded-md border border-border bg-background p-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium">参数</span>
            <Button onClick={() => onAddParameter(component.id)} size="icon-sm" type="button" variant="secondary">
              <Plus className="size-3.5" />
            </Button>
          </div>
          {(component.parameters ?? []).map((parameter) => (
            <ParameterRow
              key={parameter.id}
              parameter={parameter}
              onChange={(patch) => onParameterChange(component.id, parameter.id, patch)}
              onRemove={() => onParameterRemove(component.id, parameter.id)}
            />
          ))}
        </div>
      ) : null}
      <Button onClick={() => onRemove(component.id)} type="button" variant="destructive">
        <Trash2 className="size-4" />
        删除节点
      </Button>
    </section>
  );
}

function ComponentEditor({
  onAdd,
}: {
  onAdd: (kind: MaiBotPluginBlueprintComponentKind) => void;
}): React.JSX.Element {
  return (
    <section className="grid gap-3">
      <SectionTitle
        icon={<Boxes />}
        title="组件库"
      />
      <ComponentLibrarySection title="入口组件">
        <ComponentLibraryButton
          description="给 AI 可以调用的小工具"
          dragData={{ mime: COMPONENT_DRAG_MIME, value: "tool" }}
          icon={<Wrench className="size-3.5" />}
          label="工具 Tool"
          onClick={() => onAdd("tool")}
        />
        <ComponentLibraryButton
          description="用户输入 /hello 这类命令时触发"
          dragData={{ mime: COMPONENT_DRAG_MIME, value: "command" }}
          icon={<TerminalSquare className="size-3.5" />}
          label="命令 Command"
          onClick={() => onAdd("command")}
        />
        <ComponentLibraryButton
          description="收到消息等事件发生时自动触发"
          dragData={{ mime: COMPONENT_DRAG_MIME, value: "hook" }}
          icon={<MessageSquare className="size-3.5" />}
          label="事件 Hook"
          onClick={() => onAdd("hook")}
        />
      </ComponentLibrarySection>
    </section>
  );
}

function ComponentLibraryButton({
  description,
  disabled = false,
  dragData,
  icon,
  label,
  onClick,
}: {
  description: string;
  disabled?: boolean;
  dragData?: { mime: string; value: string };
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}): React.JSX.Element {
  return (
    <button
      className="group relative grid grid-cols-[32px_1fr_auto] items-center gap-2 rounded-md border border-border bg-card px-2 py-2 text-left transition-colors hover:border-primary/50 hover:bg-accent/60 disabled:cursor-not-allowed disabled:opacity-55"
      disabled={disabled}
      draggable={Boolean(dragData) && !disabled}
      onClick={onClick}
      onDragStart={(event) => {
        if (!dragData) return;
        event.dataTransfer.effectAllowed = "copy";
        event.dataTransfer.setData(dragData.mime, dragData.value);
      }}
      title={`${label}\n${description}\n可以点击添加，也可以拖到画布。`}
      type="button"
    >
      <span className="grid size-8 place-items-center rounded-md bg-secondary text-secondary-foreground">{icon}</span>
      <span className="min-w-0">
        <span className="block truncate text-xs font-semibold">{label}</span>
        <span className="block truncate text-[11px] text-muted-foreground">{description}</span>
      </span>
      <Plus className="size-3.5 text-muted-foreground" />
      <span className="pointer-events-none absolute left-2 right-2 top-full z-30 mt-1 hidden rounded-md border border-border bg-popover px-2 py-1.5 text-[11px] leading-relaxed text-popover-foreground shadow-md group-hover:block">
        {description}
      </span>
    </button>
  );
}

function ComponentLibrarySection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}): React.JSX.Element {
  if (!children) {
    return <></>;
  }
  return (
    <div className="grid gap-2 rounded-lg border border-border bg-background p-2">
      <p className="px-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{title}</p>
      {children}
    </div>
  );
}

function FlowNodeEditor({
  component,
  onAdd,
  onChange,
  onConnect,
  onRemove,
}: {
  component: MaiBotPluginBlueprintComponent;
  onAdd: (kind: MaiBotPluginBlueprintFlowNodeKind) => void;
  onChange: (nodeId: string, patch: Partial<MaiBotPluginBlueprintFlowNode>) => void;
  onConnect: (fromNodeId: string, toNodeId: string) => void;
  onRemove: (nodeId: string) => void;
}): React.JSX.Element {
  const nodes = component.flowNodes ?? [];
  const nextById = useMemo(() => new Map((component.flowEdges ?? []).map((edge) => [edge.fromNodeId, edge.toNodeId])), [component.flowEdges]);
  const [draggingNodeId, setDraggingNodeId] = useState<string | null>(null);
  const [dragOverNodeId, setDragOverNodeId] = useState<string | null>(null);

  const startDrag = useCallback((event: React.DragEvent<HTMLButtonElement>, nodeId: string) => {
    setDraggingNodeId(nodeId);
    event.dataTransfer.effectAllowed = "link";
    event.dataTransfer.setData("application/x-maibot-flow-node", nodeId);
  }, []);

  const finishDrag = useCallback(() => {
    setDraggingNodeId(null);
    setDragOverNodeId(null);
  }, []);

  const dropOnNode = useCallback((event: React.DragEvent<HTMLElement>, nodeId: string) => {
    event.preventDefault();
    const fromNodeId = event.dataTransfer.getData("application/x-maibot-flow-node") || draggingNodeId;
    if (fromNodeId && fromNodeId !== nodeId) {
      onConnect(fromNodeId, nodeId);
    }
    finishDrag();
  }, [draggingNodeId, finishDrag, onConnect]);

  return (
    <div className="grid gap-2 rounded-md border border-border bg-card p-2">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-xs font-medium">
          <Link2 className="size-3.5 text-muted-foreground" />
          积木流程
        </span>
        <select
          className="h-7 rounded-md border border-input bg-background px-2 text-[11px] outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          onChange={(event) => {
            if (event.target.value) {
              onAdd(event.target.value as MaiBotPluginBlueprintFlowNodeKind);
              event.target.value = "";
            }
          }}
          value=""
        >
          <option value="">添加积木</option>
          {flowNodeLibraryGroups.map((group) => (
            <optgroup key={group.title} label={group.title}>
              {group.items.map((type) => (
                <option key={type.value} value={type.value}>{type.label}</option>
              ))}
            </optgroup>
          ))}
        </select>
      </div>

      {nodes.length === 0 ? (
        <div className="rounded-md border border-dashed border-border px-3 py-3 text-center text-[11px] text-muted-foreground">
          添加“发送文本”或“成功返回”积木，就能像拼流程一样生成代码。
        </div>
      ) : (
        <div className="grid gap-2">
          <p className="rounded-md bg-muted/45 px-2 py-1.5 text-[11px] text-muted-foreground">
            拖动积木右侧圆点到另一个积木上，即可设置下一步。
          </p>
          {nodes.map((node) => (
            <div
              className={cn(
                "grid gap-2 rounded-md border bg-background p-2 transition-colors",
                dragOverNodeId === node.id && draggingNodeId !== node.id
                  ? "border-primary bg-primary/5"
                  : "border-border",
                draggingNodeId === node.id && "opacity-70",
              )}
              key={node.id}
              onDragLeave={() => setDragOverNodeId((current) => (current === node.id ? null : current))}
              onDragOver={(event) => {
                if (draggingNodeId && draggingNodeId !== node.id) {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "link";
                  setDragOverNodeId(node.id);
                }
              }}
              onDrop={(event) => dropOnNode(event, node.id)}
            >
              <div className="grid grid-cols-[96px_1fr_32px_32px] gap-2">
                <select
                  className="h-8 rounded-md border border-input bg-card px-2 text-[11px] outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                  onChange={(event) => onChange(node.id, { kind: event.target.value as MaiBotPluginBlueprintFlowNodeKind })}
                  value={node.kind}
                >
                  {flowNodeLibraryGroups.map((group) => (
                    <optgroup key={group.title} label={group.title}>
                      {group.items.map((type) => (
                        <option key={type.value} value={type.value}>{type.label}</option>
                      ))}
                    </optgroup>
                  ))}
                </select>
                <Input className="h-8 text-xs" onChange={(event) => onChange(node.id, { label: event.target.value })} value={node.label} />
                <Button aria-label="移除积木" onClick={() => onRemove(node.id)} size="icon-sm" type="button" variant="ghost">
                  <Trash2 className="size-3.5" />
                </Button>
                <button
                  aria-label={`拖拽连接 ${node.label || flowNodeLabel(node.kind)}`}
                  className="grid size-8 cursor-grab place-items-center rounded-md border border-border bg-card text-muted-foreground transition-colors hover:border-primary hover:text-primary active:cursor-grabbing"
                  draggable
                  onDragEnd={finishDrag}
                  onDragStart={(event) => startDrag(event, node.id)}
                  title="拖动到另一个积木上进行连接"
                  type="button"
                >
                  <span className="size-2.5 rounded-full bg-current" />
                </button>
              </div>

              {node.kind === "send_text" || node.kind === "log_info" || node.kind === "comment" ? (
                <Input className="h-8 text-xs" onChange={(event) => onChange(node.id, { value: event.target.value })} value={node.value ?? ""} />
              ) : node.kind === "read_config" ? (
                <Input
                  className="h-8 text-xs"
                  monospace
                  onChange={(event) => onChange(node.id, { configPath: event.target.value })}
                  placeholder="greeting.message"
                  value={node.configPath ?? ""}
                />
              ) : node.kind === "set_variable" || node.kind === "guard_config" || node.kind === "loop" ? (
                <div className="grid grid-cols-[1fr_1fr] gap-2">
                  <Input
                    className="h-8 text-xs"
                    monospace
                    onChange={(event) => onChange(node.id, { configPath: event.target.value })}
                    placeholder={node.kind === "set_variable" ? "result" : node.kind === "loop" ? "item" : "plugin.enabled"}
                    value={node.configPath ?? ""}
                  />
                  <Input
                    className="h-8 text-xs"
                    onChange={(event) => onChange(node.id, { value: event.target.value })}
                    placeholder={node.kind === "set_variable" ? "ok" : node.kind === "loop" ? "range(3)" : "true"}
                    value={node.value ?? ""}
                  />
                </div>
              ) : (
                <div className="rounded-md bg-muted/45 px-2 py-1.5 text-[11px] text-muted-foreground">
                  结束当前流程并告诉 MaiBot 执行成功。
                </div>
              )}

              <label className="grid grid-cols-[48px_1fr] items-center gap-2 text-[11px] text-muted-foreground">
                <span>下一</span>
                <select
                  className="h-8 rounded-md border border-input bg-card px-2 text-[11px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                  onChange={(event) => onConnect(node.id, event.target.value)}
                  value={nextById.get(node.id) ?? ""}
                >
                  <option value=""></option>
                  {nodes.filter((item) => item.id !== node.id).map((item) => (
                    <option key={item.id} value={item.id}>{item.label || flowNodeLabel(item.kind)}</option>
                  ))}
                </select>
              </label>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function componentKindLabel(kind: MaiBotPluginBlueprintComponentKind): string {
  if (kind === "tool") return "Tool";
  if (kind === "command") return "Command";
  return "Hook";
}

function flowNodeLabel(kind: MaiBotPluginBlueprintFlowNodeKind): string {
  return flowNodeTypes.find((type) => type.value === kind)?.label ?? kind;
}

function flowNodePlainDescription(kind: MaiBotPluginBlueprintFlowNodeKind): string {
  return flowNodeTypes.find((type) => type.value === kind)?.description ?? flowNodeLabel(kind);
}

function flowNodeFriendlySummary(node: MaiBotPluginBlueprintFlowNode): string {
  if (node.kind === "send_text") return `发送：${node.value || "一段文字"}`;
  if (node.kind === "read_config") return `读取设置：${node.configPath || "未填写路径"}`;
  if (node.kind === "log_info") return `日志：${node.value || "一条日志"}`;
  if (node.kind === "set_variable") return `记住 ${node.targetName || node.configPath || "变量"} = ${node.value || "值"}`;
  if (node.kind === "if_condition") return `如果不满足：${node.value || "条件"}，就停止`;
  if (node.kind === "compare") return `${node.leftValue || "左值"} ${node.operator || "=="} ${node.rightValue || "右值"} -> ${node.targetName || "结果"}`;
  if (node.kind === "boolean_logic") {
    const operatorLabel = node.operator === "or" ? "或者" : node.operator === "not" ? "不是" : "并且";
    return node.operator === "not"
      ? `${operatorLabel} ${node.leftValue || "条件"} -> ${node.targetName || "结果"}`
      : `${node.leftValue || "条件 A"} ${operatorLabel} ${node.rightValue || "条件 B"} -> ${node.targetName || "结果"}`;
  }
  if (node.kind === "math_operation") return `${node.leftValue || "数字 A"} ${node.operator || "+"} ${node.rightValue || "数字 B"} -> ${node.targetName || "结果"}`;
  if (node.kind === "join_text") return `"${node.leftValue ?? ""}" + "${node.rightValue ?? ""}" -> ${node.targetName || "文本"}`;
  if (node.kind === "guard_config") return `检查 ${node.configPath || "配置项"} 是否为 ${node.value || "true"}`;
  if (node.kind === "loop") return `重复：for ${node.configPath || "item"} in ${node.value || "range(3)"}`;
  if (node.kind === "wait") return `等待 ${node.value || "1"} 秒`;
  if (node.kind === "comment") return node.value || "只是一句说明";
  if (node.kind === "return_success") return "告诉 MaiBot：流程已经成功结束";
  return flowNodeLabel(node.kind);
}

function flowNodeBeginnerTip(kind: MaiBotPluginBlueprintFlowNodeKind): string {
  if (kind === "send_text") return "最常用的积木：让机器人回复一段文字，可以放在命令或 Hook 流程里。";
  if (kind === "read_config") return "从 config.toml 读取设置，适合把回复文案、开关、数字交给用户修改。";
  if (kind === "log_info") return "调试用积木：把当前执行到哪里写进日志，方便排查问题。";
  if (kind === "set_variable") return "把一个值存起来，后面的积木可以继续使用这个变量名。";
  if (kind === "if_condition") return "像 Scratch 的如果积木：条件不成立时提前停止后续流程。";
  if (kind === "compare") return "比较两个值，例如 1 == 1 会得到 True。";
  if (kind === "boolean_logic") return "组合多个条件，例如管理员并且开关已启用。";
  if (kind === "math_operation") return "做简单加减乘除，并把结果保存成变量。";
  if (kind === "join_text") return "把两段文字拼起来，例如问候语加上用户名。";
  if (kind === "guard_config") return "检查某个配置是否符合预期，不符合就停止。";
  if (kind === "loop") return "重复执行一段逻辑，例如 range(3) 表示执行 3 次。";
  if (kind === "wait") return "暂停几秒再继续，适合做延迟回复。";
  if (kind === "comment") return "只给自己看的说明，不会影响插件运行。";
  if (kind === "return_success") return "流程结束积木，通常放在 Tool 或 Command 的最后。";
  return "选择积木后，在这里填写它需要的内容。";
}

function flowNodeExample(kind: MaiBotPluginBlueprintFlowNodeKind): string {
  if (kind === "send_text") return "例：你好，我已经收到。";
  if (kind === "read_config") return "例：greeting.message";
  if (kind === "log_info") return "例：开始执行 hello 命令";
  if (kind === "set_variable") return "例：变量 result，值 ok";
  if (kind === "if_condition") return "例：plugin_enabled == true";
  if (kind === "compare") return "例：message == hello";
  if (kind === "boolean_logic") return "例：is_admin and enabled";
  if (kind === "math_operation") return "例：1 + 2 -> total";
  if (kind === "join_text") return "例：你好 + 世界 -> text";
  if (kind === "guard_config") return "例：plugin.enabled == true";
  if (kind === "loop") return "例：range(3)";
  if (kind === "wait") return "例：1";
  if (kind === "comment") return "例：这里开始检查用户权限";
  return "通常连接在流程最后";
}

function ParameterRow({
  parameter,
  onChange,
  onRemove,
}: {
  parameter: MaiBotPluginBlueprintParameter;
  onChange: (patch: Partial<MaiBotPluginBlueprintParameter>) => void;
  onRemove: () => void;
}): React.JSX.Element {
  return (
    <div className="grid gap-2 rounded-md border border-border bg-background p-2">
      <div className="grid grid-cols-[1fr_92px_32px] gap-2">
        <Input monospace onChange={(event) => onChange({ name: event.target.value })} value={parameter.name} />
        <TypeSelect onChange={(type) => onChange({ type })} value={parameter.type} />
        <Button aria-label="移除参数" onClick={onRemove} size="icon-sm" type="button" variant="ghost">
          <Trash2 className="size-3.5" />
        </Button>
      </div>
      <Input onChange={(event) => onChange({ description: event.target.value })} value={parameter.description} />
      <div className="grid grid-cols-[1fr_auto] gap-2">
        <Input monospace onChange={(event) => onChange({ defaultValue: event.target.value })} value={parameter.defaultValue} />
        <label className="flex h-9 items-center gap-2 rounded-md border border-border bg-card px-2 text-xs">
          <Checkbox checked={parameter.required} onCheckedChange={(checked) => onChange({ required: checked === true })} />
          必填
        </label>
      </div>
    </div>
  );
}

function ConfigFieldEditor({
  fields,
  onAdd,
  onChange,
  onRemove,
}: {
  fields: MaiBotPluginBlueprintConfigField[];
  onAdd: () => void;
  onChange: (id: string, patch: Partial<MaiBotPluginBlueprintConfigField>) => void;
  onRemove: (id: string) => void;
}): React.JSX.Element {
  return (
    <section className="grid gap-3">
      <SectionTitle
        icon={<Settings2 />}
        title="配置字段"
        trailing={
          <Button onClick={onAdd} size="icon-sm" type="button" variant="secondary">
            <Plus className="size-3.5" />
          </Button>
        }
      />
      <div className="grid gap-3">
        {fields.map((field) => (
          <div className="grid gap-2 rounded-lg border border-border bg-background p-3" key={field.id}>
            <div className="grid grid-cols-[1fr_1fr_32px] gap-2">
              <Input monospace onChange={(event) => onChange(field.id, { section: event.target.value })} value={field.section} />
              <Input monospace onChange={(event) => onChange(field.id, { name: event.target.value })} value={field.name} />
              <Button aria-label="移除配置字段" onClick={() => onRemove(field.id)} size="icon-sm" type="button" variant="ghost">
                <Trash2 className="size-3.5" />
              </Button>
            </div>
            <div className="grid grid-cols-[1fr_92px] gap-2">
              <Input onChange={(event) => onChange(field.id, { label: event.target.value })} value={field.label} />
              <TypeSelect onChange={(type) => onChange(field.id, { type })} value={field.type} />
            </div>
            <Input onChange={(event) => onChange(field.id, { description: event.target.value })} value={field.description} />
            <Input monospace onChange={(event) => onChange(field.id, { defaultValue: event.target.value })} value={field.defaultValue} />
          </div>
        ))}
      </div>
    </section>
  );
}

type BlueprintCanvasNodeKind = "manifest" | "lifecycle" | "config" | "component";

type BlueprintCanvasNode = {
  id: string;
  kind: BlueprintCanvasNodeKind;
  title: string;
  subtitle: string;
  component?: MaiBotPluginBlueprintComponent;
};

type BlueprintNodePosition = {
  x: number;
  y: number;
};

type BlueprintCanvasEdge = {
  id: string;
  fromNodeId: string;
  toNodeId: string;
};

const BLUEPRINT_CANVAS_WIDTH = 1600;
const BLUEPRINT_CANVAS_HEIGHT = 1080;
const BLUEPRINT_CANVAS_MIN_SCALE = 0.45;
const BLUEPRINT_CANVAS_MAX_SCALE = 1.8;
const BLUEPRINT_CANVAS_SCALE_STEP = 0.0015;

function FreeBlueprintCanvas({
  activeComponentId,
  blueprint,
  focusedFlowNodeId,
  onAddComponent,
  onAddConfigField,
  onAddFlowNode,
  onAddParameter,
  onComponentChange,
  onComponentRemove,
  onConfigFieldChange,
  onConfigFieldRemove,
  onConnectFlowNode,
  onFlowNodeChange,
  onFlowNodeFocused,
  onFlowNodeRemove,
  onOpenComponent,
  onParameterChange,
  onParameterRemove,
  onReturnToPlugin,
}: {
  activeComponentId: string | null;
  blueprint: MaiBotPluginBlueprint;
  focusedFlowNodeId: string | null;
  onAddComponent: (kind: MaiBotPluginBlueprintComponentKind) => void;
  onAddConfigField: () => void;
  onAddFlowNode: (componentId: string, kind: MaiBotPluginBlueprintFlowNodeKind) => void;
  onAddParameter: (componentId: string) => void;
  onComponentChange: (id: string, patch: Partial<MaiBotPluginBlueprintComponent>) => void;
  onComponentRemove: (id: string) => void;
  onConfigFieldChange: (id: string, patch: Partial<MaiBotPluginBlueprintConfigField>) => void;
  onConfigFieldRemove: (id: string) => void;
  onConnectFlowNode: (componentId: string, fromNodeId: string, toNodeId: string) => void;
  onFlowNodeChange: (componentId: string, nodeId: string, patch: Partial<MaiBotPluginBlueprintFlowNode>) => void;
  onFlowNodeFocused: () => void;
  onFlowNodeRemove: (componentId: string, nodeId: string) => void;
  onOpenComponent: (componentId: string) => void;
  onParameterChange: (componentId: string, parameterId: string, patch: Partial<MaiBotPluginBlueprintParameter>) => void;
  onParameterRemove: (componentId: string, parameterId: string) => void;
  onReturnToPlugin: () => void;
}): React.JSX.Element {
  const toolCount = blueprint.components.filter((component) => component.kind === "tool").length;
  const commandCount = blueprint.components.filter((component) => component.kind === "command").length;
  const hookCount = blueprint.components.filter((component) => component.kind === "hook").length;
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const dragStateRef = useRef<{ id: string; offsetX: number; offsetY: number } | null>(null);
  const panStateRef = useRef<{ x: number; y: number; scrollLeft: number; scrollTop: number } | null>(null);
  const pendingDropPositionRef = useRef<BlueprintNodePosition | null>(null);
  const [positions, setPositions] = useState<Record<string, BlueprintNodePosition>>({});
  const [selectedNodeId, setSelectedNodeId] = useState("manifest");
  const [canvasEdges, setCanvasEdges] = useState<BlueprintCanvasEdge[]>([]);
  const [isCanvasDropTarget, setIsCanvasDropTarget] = useState(false);
  const [linkingNodeId, setLinkingNodeId] = useState<string | null>(null);
  const [viewportScale, setViewportScale] = useState(1);
  const [propertyPanelOpen, setPropertyPanelOpen] = useState(true);
  const [libraryPanelOpen, setLibraryPanelOpen] = useState(true);

  const nodes = useMemo<BlueprintCanvasNode[]>(() => [
    {
      id: "manifest",
      kind: "manifest",
      title: blueprint.manifest.name || "Manifest",
      subtitle: blueprint.manifest.pluginId,
    },
    {
      id: "lifecycle",
      kind: "lifecycle",
      title: "Lifecycle",
      subtitle: "on_load / on_unload / on_config_update",
    },
    {
      id: "config",
      kind: "config",
      title: "Config",
      subtitle: `${blueprint.configFields.length} fields`,
    },
    ...blueprint.components.map((component) => ({
      id: component.id,
      kind: "component" as const,
      title: component.name,
      subtitle: component.description,
      component,
    })),
  ], [blueprint.components, blueprint.configFields.length, blueprint.manifest.name, blueprint.manifest.pluginId]);

  const defaultPositions = useMemo<Record<string, BlueprintNodePosition>>(() => {
    const next: Record<string, BlueprintNodePosition> = {
      manifest: { x: 32, y: 42 },
      lifecycle: { x: 328, y: 42 },
      config: { x: 328, y: 210 },
    };
    blueprint.components.forEach((component, index) => {
      next[component.id] = {
        x: 32 + (index % 2) * 296,
        y: 384 + Math.floor(index / 2) * 168,
      };
    });
    return next;
  }, [blueprint.components]);

  useEffect(() => {
    setPositions((current) => {
      const next: Record<string, BlueprintNodePosition> = {};
      nodes.forEach((node) => {
        if (current[node.id]) {
          next[node.id] = current[node.id];
        } else if (pendingDropPositionRef.current && node.kind === "component") {
          next[node.id] = pendingDropPositionRef.current;
          pendingDropPositionRef.current = null;
        } else {
          next[node.id] = defaultPositions[node.id] ?? { x: 32, y: 42 };
        }
      });
      return next;
    });
  }, [defaultPositions, nodes]);

  const nodeIds = useMemo(() => new Set(nodes.map((node) => node.id)), [nodes]);
  const visibleEdges = useMemo<BlueprintCanvasEdge[]>(() => {
    const defaults: BlueprintCanvasEdge[] = [
      { id: "manifest-lifecycle", fromNodeId: "manifest", toNodeId: "lifecycle" },
      { id: "manifest-config", fromNodeId: "manifest", toNodeId: "config" },
      ...blueprint.components.map((component) => ({
        id: `lifecycle-${component.id}`,
        fromNodeId: "lifecycle",
        toNodeId: component.id,
      })),
    ];
    const edgeKeys = new Set(defaults.map((edge) => `${edge.fromNodeId}:${edge.toNodeId}`));
    const custom = canvasEdges.filter((edge) => {
      const key = `${edge.fromNodeId}:${edge.toNodeId}`;
      if (!nodeIds.has(edge.fromNodeId) || !nodeIds.has(edge.toNodeId) || edgeKeys.has(key)) {
        return false;
      }
      edgeKeys.add(key);
      return true;
    });
    return [...defaults, ...custom];
  }, [blueprint.components, canvasEdges, nodeIds]);

  const pointerToCanvasPoint = useCallback((event: React.PointerEvent<HTMLElement>): BlueprintNodePosition | null => {
    const canvas = canvasRef.current;
    const rect = canvas?.getBoundingClientRect();
    if (!canvas || !rect) {
      return null;
    }
    return {
      x: (event.clientX - rect.left + canvas.scrollLeft) / viewportScale,
      y: (event.clientY - rect.top + canvas.scrollTop) / viewportScale,
    };
  }, [viewportScale]);

  const dragEventToCanvasPoint = useCallback((event: React.DragEvent<HTMLElement>): BlueprintNodePosition | null => {
    const canvas = canvasRef.current;
    const rect = canvas?.getBoundingClientRect();
    if (!canvas || !rect) {
      return null;
    }
    return {
      x: (event.clientX - rect.left + canvas.scrollLeft) / viewportScale,
      y: (event.clientY - rect.top + canvas.scrollTop) / viewportScale,
    };
  }, [viewportScale]);

  const startMove = useCallback((event: React.PointerEvent<HTMLDivElement>, nodeId: string) => {
    const position = positions[nodeId];
    const point = pointerToCanvasPoint(event);
    if (event.button !== 0 || !point || !position) {
      return;
    }
    dragStateRef.current = {
      id: nodeId,
      offsetX: point.x - position.x,
      offsetY: point.y - position.y,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }, [pointerToCanvasPoint, positions]);

  const moveNode = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const panState = panStateRef.current;
    if (panState && canvasRef.current) {
      canvasRef.current.scrollLeft = panState.scrollLeft - (event.clientX - panState.x);
      canvasRef.current.scrollTop = panState.scrollTop - (event.clientY - panState.y);
      return;
    }

    const dragState = dragStateRef.current;
    const point = pointerToCanvasPoint(event);
    if (!dragState || !point) {
      return;
    }
    const nextX = Math.max(12, Math.min(BLUEPRINT_CANVAS_WIDTH - 260, point.x - dragState.offsetX));
    const nextY = Math.max(12, Math.min(BLUEPRINT_CANVAS_HEIGHT - 140, point.y - dragState.offsetY));
    setPositions((current) => ({
      ...current,
      [dragState.id]: { x: nextX, y: nextY },
    }));
  }, [pointerToCanvasPoint]);

  const stopMove = useCallback(() => {
    dragStateRef.current = null;
    panStateRef.current = null;
  }, []);

  const startPan = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 1 || !canvasRef.current) {
      return;
    }
    event.preventDefault();
    panStateRef.current = {
      x: event.clientX,
      y: event.clientY,
      scrollLeft: canvasRef.current.scrollLeft,
      scrollTop: canvasRef.current.scrollTop,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }, []);

  const zoomCanvasAt = useCallback((clientX: number, clientY: number, deltaY: number) => {
    const canvas = canvasRef.current;
    const rect = canvas?.getBoundingClientRect();
    if (!canvas || !rect) {
      return;
    }
    const nextScale = Math.max(
      BLUEPRINT_CANVAS_MIN_SCALE,
      Math.min(BLUEPRINT_CANVAS_MAX_SCALE, viewportScale * (1 - deltaY * BLUEPRINT_CANVAS_SCALE_STEP)),
    );
    if (Math.abs(nextScale - viewportScale) < 0.001) {
      return;
    }

    const viewportX = clientX - rect.left;
    const viewportY = clientY - rect.top;
    const logicalX = (canvas.scrollLeft + viewportX) / viewportScale;
    const logicalY = (canvas.scrollTop + viewportY) / viewportScale;
    setViewportScale(nextScale);
    requestAnimationFrame(() => {
      canvas.scrollLeft = logicalX * nextScale - viewportX;
      canvas.scrollTop = logicalY * nextScale - viewportY;
    });
  }, [viewportScale]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return undefined;
    }
    const handleWheel = (event: WheelEvent): void => {
      event.preventDefault();
      event.stopPropagation();
      zoomCanvasAt(event.clientX, event.clientY, event.deltaY);
    };
    canvas.addEventListener("wheel", handleWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", handleWheel);
  }, [zoomCanvasAt]);

  const startLink = useCallback((event: React.DragEvent<HTMLButtonElement>, nodeId: string) => {
    setLinkingNodeId(nodeId);
    event.dataTransfer.effectAllowed = "link";
    event.dataTransfer.setData("application/x-maibot-blueprint-node", nodeId);
  }, []);

  const dropLink = useCallback((event: React.DragEvent<HTMLElement>, nodeId: string) => {
    event.preventDefault();
    const fromNodeId = event.dataTransfer.getData("application/x-maibot-blueprint-node") || linkingNodeId;
    setLinkingNodeId(null);
    if (!fromNodeId || fromNodeId === nodeId) {
      return;
    }
    setCanvasEdges((current) => {
      if (current.some((edge) => edge.fromNodeId === fromNodeId && edge.toNodeId === nodeId)) {
        return current;
      }
      return [...current, { id: nextId("canvas-edge"), fromNodeId, toNodeId: nodeId }];
    });
  }, [linkingNodeId]);

  const dropComponentOnCanvas = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    const componentKind = event.dataTransfer.getData(COMPONENT_DRAG_MIME) as MaiBotPluginBlueprintComponentKind;
    if (componentKind !== "tool" && componentKind !== "command" && componentKind !== "hook") {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    setIsCanvasDropTarget(false);
    const point = dragEventToCanvasPoint(event);
    if (point) {
      pendingDropPositionRef.current = {
        x: Math.max(12, Math.min(BLUEPRINT_CANVAS_WIDTH - 260, point.x - 120)),
        y: Math.max(12, Math.min(BLUEPRINT_CANVAS_HEIGHT - 140, point.y - 58)),
      };
    }
    onAddComponent(componentKind);
  }, [dragEventToCanvasPoint, onAddComponent]);

  const selectedNode = nodes.find((node) => node.id === selectedNodeId) ?? nodes[0];
  const activeComponent = activeComponentId
    ? blueprint.components.find((component) => component.id === activeComponentId) ?? null
    : null;

  if (activeComponent) {
    return (
      <ComponentSubBlueprintCanvas
        component={activeComponent}
        focusedFlowNodeId={focusedFlowNodeId}
        onAddFlowNode={(kind) => onAddFlowNode(activeComponent.id, kind)}
        onChangeFlowNode={(nodeId, patch) => onFlowNodeChange(activeComponent.id, nodeId, patch)}
        onConnectFlowNode={(fromNodeId, toNodeId) => onConnectFlowNode(activeComponent.id, fromNodeId, toNodeId)}
        onFlowNodeFocused={onFlowNodeFocused}
        onRemoveFlowNode={(nodeId) => onFlowNodeRemove(activeComponent.id, nodeId)}
        onReturnToPlugin={onReturnToPlugin}
      />
    );
  }

  return (
    <div
      className={cn(
        "grid h-full min-h-0",
        propertyPanelOpen && libraryPanelOpen && "grid-cols-[minmax(420px,1fr)_320px_320px]",
        propertyPanelOpen && !libraryPanelOpen && "grid-cols-[minmax(420px,1fr)_320px_48px]",
        !propertyPanelOpen && libraryPanelOpen && "grid-cols-[minmax(420px,1fr)_48px_320px]",
        !propertyPanelOpen && !libraryPanelOpen && "grid-cols-[minmax(420px,1fr)_48px_48px]",
      )}
    >
      <div className="flex min-h-0 flex-col">
        <div className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-4">
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold">Blueprint</h3>
            <p className="truncate text-xs text-muted-foreground">
              {toolCount} Tool / {commandCount} Command / {hookCount} Hook / {blueprint.configFields.length} Config
            </p>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <Badge variant="secondary">{Math.round(viewportScale * 100)}%</Badge>
            <Button onClick={() => onAddComponent("tool")} size="sm" type="button" variant="secondary">
              <Wrench />
              Tool
            </Button>
            <Button onClick={() => onAddComponent("command")} size="sm" type="button" variant="secondary">
              <TerminalSquare />
              Command
            </Button>
            <Button onClick={() => onAddComponent("hook")} size="sm" type="button" variant="secondary">
              <MessageSquare />
              Hook
            </Button>
          </div>
        </div>

        <div
          className={cn(
            "relative min-h-0 flex-1 cursor-default overflow-auto bg-[radial-gradient(circle_at_1px_1px,hsl(var(--border))_1px,transparent_0)] bg-[length:24px_24px] transition-colors",
            isCanvasDropTarget && "bg-primary/5 outline outline-2 outline-primary/30",
          )}
          onDragLeave={(event) => {
            if (event.currentTarget === event.target) {
              setIsCanvasDropTarget(false);
            }
          }}
          onPointerLeave={stopMove}
          onPointerMove={moveNode}
          onPointerDown={startPan}
          onPointerUp={stopMove}
          onDragOver={(event) => {
            if (Array.from(event.dataTransfer.types).includes(COMPONENT_DRAG_MIME)) {
              event.preventDefault();
              event.dataTransfer.dropEffect = "copy";
              setIsCanvasDropTarget(true);
            }
          }}
          onDrop={dropComponentOnCanvas}
          ref={canvasRef}
        >
          <div
            className="relative"
            style={{
              height: BLUEPRINT_CANVAS_HEIGHT * viewportScale,
              width: BLUEPRINT_CANVAS_WIDTH * viewportScale,
            }}
          >
            <div
              className="absolute left-0 top-0"
              style={{
                height: BLUEPRINT_CANVAS_HEIGHT,
                transform: `scale(${viewportScale})`,
                transformOrigin: "0 0",
                width: BLUEPRINT_CANVAS_WIDTH,
              }}
            >
            <svg className="pointer-events-none absolute inset-0 size-full">
              <defs>
                <marker id="plugin-blueprint-arrow" markerHeight="8" markerWidth="8" orient="auto" refX="7" refY="4">
                  <path className="fill-primary/55" d="M 0 0 L 8 4 L 0 8 z" />
                </marker>
              </defs>
              {visibleEdges.map((edge) => {
                const from = positions[edge.fromNodeId];
                const to = positions[edge.toNodeId];
                if (!from || !to) {
                  return null;
                }
                const x1 = from.x + 240;
                const y1 = from.y + 58;
                const x2 = to.x;
                const y2 = to.y + 58;
                const mid = Math.max(x1 + 48, (x1 + x2) / 2);
                const fromNode = nodes.find((node) => node.id === edge.fromNodeId);
                return (
                  <g key={edge.id}>
                  <path
                    className="stroke-primary/45"
                    d={`M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`}
                    fill="none"
                    markerEnd="url(#plugin-blueprint-arrow)"
                    strokeWidth="2"
                  />
                    <text className="fill-muted-foreground text-[10px]" x={mid - 22} y={(y1 + y2) / 2 - 6}>
                      {blueprintEdgeLabel(fromNode)}
                    </text>
                  </g>
                );
              })}
            </svg>

            {nodes.map((node) => {
              const position = positions[node.id] ?? defaultPositions[node.id] ?? { x: 32, y: 42 };
              const selected = selectedNode?.id === node.id;
              return (
                <div
                  className={cn(
                    "group absolute w-60 rounded-lg border bg-card shadow-sm transition-[border-color,box-shadow]",
                    selected ? "border-primary shadow-md shadow-primary/10" : "border-border",
                  )}
                  key={node.id}
                  onClick={() => setSelectedNodeId(node.id)}
                  onDoubleClick={() => {
                    if (node.component && (node.component.kind === "tool" || node.component.kind === "command")) {
                      onOpenComponent(node.component.id);
                    }
                  }}
                  onDragOver={(event) => {
                    const hasBlueprintNode = Array.from(event.dataTransfer.types).includes("application/x-maibot-blueprint-node");
                    if ((linkingNodeId || hasBlueprintNode) && linkingNodeId !== node.id) {
                      event.preventDefault();
                    }
                  }}
                  onDrop={(event) => dropLink(event, node.id)}
                  style={{ transform: `translate(${position.x}px, ${position.y}px)` }}
                >
                  <span className="pointer-events-none absolute left-2 right-2 top-full z-30 mt-1 hidden rounded-md border border-border bg-popover px-2 py-1.5 text-[11px] leading-relaxed text-popover-foreground shadow-md group-hover:block">
                    {node.subtitle || node.title}
                  </span>
                  <button
                    aria-label="Connect into blueprint node"
                    className="absolute -left-1.5 top-[52px] z-10 size-3 rounded-full border border-primary bg-background shadow-sm ring-2 ring-background"
                    onDragOver={(event) => {
                      const hasBlueprintNode = Array.from(event.dataTransfer.types).includes("application/x-maibot-blueprint-node");
                      if ((linkingNodeId || hasBlueprintNode) && linkingNodeId !== node.id) {
                        event.preventDefault();
                      }
                    }}
                    onDrop={(event) => dropLink(event, node.id)}
                    onPointerDown={(event) => event.stopPropagation()}
                    type="button"
                  />
                  <div
                    className="flex cursor-grab items-start gap-3 p-3 active:cursor-grabbing"
                    onPointerDown={(event) => startMove(event, node.id)}
                  >
                    <span className={cn("grid size-9 shrink-0 place-items-center rounded-md", canvasNodeToneClass(node))}>
                      {canvasNodeIcon(node)}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold">{node.title || node.id}</p>
                      <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground">{node.subtitle}</p>
                    </div>
                    <button
                      aria-label="Connect blueprint node"
                      className="absolute -right-1.5 top-[52px] z-10 size-3 cursor-grab rounded-full border border-primary bg-primary shadow-sm ring-2 ring-background active:cursor-grabbing"
                      draggable
                      onDragEnd={() => setLinkingNodeId(null)}
                      onDragStart={(event) => startLink(event, node.id)}
                      onPointerDown={(event) => event.stopPropagation()}
                      type="button"
                    />
                  </div>
                  <div className="flex flex-wrap gap-1 border-t border-border px-3 py-2">
                    {node.kind === "component" && node.component ? (
                      <>
                        <Badge variant="secondary">{componentKindLabel(node.component.kind)}</Badge>
                        <Badge variant="secondary">{node.component.flowNodes?.length ?? 0} blocks</Badge>
                      </>
                    ) : node.kind === "config" ? (
                      <Badge variant="secondary">{blueprint.configFields.length} config</Badge>
                    ) : node.kind === "manifest" ? (
                      <Badge variant="secondary">v{blueprint.manifest.version}</Badge>
                    ) : (
                      <Badge variant="secondary">auto</Badge>
                    )}
                  </div>
                </div>
              );
            })}
            </div>
          </div>
        </div>
      </div>

      <aside className="min-h-0 overflow-auto border-l border-border bg-card">
        <div className={cn("sticky top-0 z-10 flex h-12 items-center border-b border-border bg-card", propertyPanelOpen ? "gap-2 px-3" : "justify-center px-1")}>
          {propertyPanelOpen ? <Settings2 className="size-4 shrink-0 text-muted-foreground" /> : null}
          {propertyPanelOpen ? (
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">属性</p>
              <p className="truncate text-xs text-muted-foreground">当前节点</p>
            </div>
          ) : null}
          <Button
            aria-label={propertyPanelOpen ? "Collapse properties" : "Expand properties"}
            className={propertyPanelOpen ? "ml-auto" : ""}
            onClick={() => setPropertyPanelOpen((value) => !value)}
            size="icon-sm"
            type="button"
            variant="ghost"
          >
            {propertyPanelOpen ? <PanelRightClose /> : <PanelRightOpen />}
          </Button>
        </div>
        {propertyPanelOpen ? (
          <div className="p-4">
            <BlueprintNodePropertyWindow
              node={selectedNode}
              configFields={blueprint.configFields}
              onAddConfigField={onAddConfigField}
              onConfigFieldChange={onConfigFieldChange}
              onConfigFieldRemove={onConfigFieldRemove}
              onOpenComponent={onOpenComponent}
              onRemoveComponent={onComponentRemove}
            />
          </div>
        ) : null}
      </aside>

      <aside className="min-h-0 overflow-auto border-l border-border bg-card">
        <div className={cn("sticky top-0 z-10 flex h-12 items-center border-b border-border bg-card", libraryPanelOpen ? "gap-2 px-3" : "justify-center px-1")}>
          {libraryPanelOpen ? <Boxes className="size-4 shrink-0 text-muted-foreground" /> : null}
          {libraryPanelOpen ? (
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">组件</p>
              <p className="truncate text-xs text-muted-foreground">点击或拖拽添加</p>
            </div>
          ) : null}
          <Button
            aria-label={libraryPanelOpen ? "Collapse library" : "Expand library"}
            className={libraryPanelOpen ? "ml-auto" : ""}
            onClick={() => setLibraryPanelOpen((value) => !value)}
            size="icon-sm"
            type="button"
            variant="ghost"
          >
            {libraryPanelOpen ? <PanelRightClose /> : <PanelRightOpen />}
          </Button>
        </div>
        {libraryPanelOpen ? (
          <div className="grid gap-4 p-4">
            <ComponentEditor onAdd={onAddComponent} />
          </div>
        ) : null}
      </aside>
    </div>
  );
}

function BlueprintNodePropertyWindow({
  configFields,
  node,
  onAddConfigField,
  onConfigFieldChange,
  onConfigFieldRemove,
  onOpenComponent,
  onRemoveComponent,
}: {
  configFields: MaiBotPluginBlueprintConfigField[];
  node: BlueprintCanvasNode | undefined;
  onAddConfigField: () => void;
  onConfigFieldChange: (id: string, patch: Partial<MaiBotPluginBlueprintConfigField>) => void;
  onConfigFieldRemove: (id: string) => void;
  onOpenComponent: (componentId: string) => void;
  onRemoveComponent: (id: string) => void;
}): React.JSX.Element {
  if (!node) {
    return <></>;
  }

  return (
    <div className="grid gap-3 rounded-lg border border-border bg-background p-3">
      <div className="flex items-start gap-2">
        <span className={cn("grid size-8 shrink-0 place-items-center rounded-md", canvasNodeToneClass(node))}>
          {canvasNodeIcon(node)}
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">属</p>
          <p className="truncate text-xs text-muted-foreground">{node.title || node.id}</p>
        </div>
      </div>

      {node.kind === "config" ? (
        <ConfigFieldEditor
          fields={configFields}
          onAdd={onAddConfigField}
          onChange={onConfigFieldChange}
          onRemove={onConfigFieldRemove}
        />
      ) : node.kind === "component" && node.component ? (
        <div className="grid gap-2">
          <div className="grid grid-cols-2 gap-2 text-[11px]">
            <span className="rounded-md bg-muted px-2 py-1 text-muted-foreground">类型</span>
            <span className="rounded-md bg-muted px-2 py-1 text-right">{componentKindLabel(node.component.kind)}</span>
            <span className="rounded-md bg-muted px-2 py-1 text-muted-foreground">积木</span>
            <span className="rounded-md bg-muted px-2 py-1 text-right">{node.component.flowNodes?.length ?? 0}</span>
          </div>
          {(node.component.kind === "tool" || node.component.kind === "command") ? (
            <Button onClick={() => onOpenComponent(node.component!.id)} size="sm" type="button">
              <Workflow className="size-4" />
              打开子蓝图
            </Button>
          ) : null}
          <Button onClick={() => onRemoveComponent(node.component!.id)} size="sm" type="button" variant="destructive">
            <Trash2 className="size-4" />
            删除组件
          </Button>
        </div>
      ) : node.kind === "manifest" ? (
        <p className="rounded-md bg-muted/55 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
          Manifest 元信息在左侧面板编辑，能力也在左侧下拉添加。
        </p>
      ) : (
        <p className="rounded-md bg-muted/55 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
          生命周期节点由编写器自动生成，用来把插件入口和组件连接起来。
        </p>
      )}
    </div>
  );
}

function ComponentSubBlueprintCanvas({
  component,
  focusedFlowNodeId,
  onAddFlowNode,
  onChangeFlowNode,
  onConnectFlowNode,
  onFlowNodeFocused,
  onRemoveFlowNode,
  onReturnToPlugin,
}: {
  component: MaiBotPluginBlueprintComponent;
  focusedFlowNodeId: string | null;
  onAddFlowNode: (kind: MaiBotPluginBlueprintFlowNodeKind) => void;
  onChangeFlowNode: (nodeId: string, patch: Partial<MaiBotPluginBlueprintFlowNode>) => void;
  onConnectFlowNode: (fromNodeId: string, toNodeId: string) => void;
  onFlowNodeFocused: () => void;
  onRemoveFlowNode: (nodeId: string) => void;
  onReturnToPlugin: () => void;
}): React.JSX.Element {
  const nodes = component.flowNodes ?? [];
  const [positions, setPositions] = useState<Record<string, BlueprintNodePosition>>({});
  const [draggingNodeId, setDraggingNodeId] = useState<string | null>(null);
  const [isCanvasDropTarget, setIsCanvasDropTarget] = useState(false);
  const [selectedFlowNodeId, setSelectedFlowNodeId] = useState<string | null>(nodes[0]?.id ?? null);
  const [viewportScale, setViewportScale] = useState(1);
  const [propertyPanelOpen, setPropertyPanelOpen] = useState(true);
  const [libraryPanelOpen, setLibraryPanelOpen] = useState(true);
  const dragStateRef = useRef<{ id: string; offsetX: number; offsetY: number } | null>(null);
  const panStateRef = useRef<{ x: number; y: number; scrollLeft: number; scrollTop: number } | null>(null);
  const pendingDropPositionRef = useRef<BlueprintNodePosition | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const selectedFlowNode = nodes.find((node) => node.id === selectedFlowNodeId) ?? nodes[0] ?? null;

  useEffect(() => {
    setPositions((current) => {
      const next: Record<string, BlueprintNodePosition> = {};
      nodes.forEach((node, index) => {
        if (current[node.id]) {
          next[node.id] = current[node.id];
        } else if (pendingDropPositionRef.current) {
          next[node.id] = pendingDropPositionRef.current;
          pendingDropPositionRef.current = null;
        } else {
          next[node.id] = {
            x: 36 + (index % 2) * 280,
            y: 44 + Math.floor(index / 2) * 150,
          };
        }
      });
      return next;
    });
  }, [nodes]);

  useEffect(() => {
    setSelectedFlowNodeId((current) => {
      if (current && nodes.some((node) => node.id === current)) {
        return current;
      }
      return nodes[0]?.id ?? null;
    });
  }, [nodes]);

  useEffect(() => {
    if (focusedFlowNodeId && nodes.some((node) => node.id === focusedFlowNodeId)) {
      setSelectedFlowNodeId(focusedFlowNodeId);
      onFlowNodeFocused();
    }
  }, [focusedFlowNodeId, nodes, onFlowNodeFocused]);

  const pointerToCanvasPoint = useCallback((event: React.PointerEvent<HTMLElement>): BlueprintNodePosition | null => {
    const canvas = canvasRef.current;
    const rect = canvas?.getBoundingClientRect();
    if (!canvas || !rect) {
      return null;
    }
    return {
      x: (event.clientX - rect.left + canvas.scrollLeft) / viewportScale,
      y: (event.clientY - rect.top + canvas.scrollTop) / viewportScale,
    };
  }, [viewportScale]);

  const dragEventToCanvasPoint = useCallback((event: React.DragEvent<HTMLElement>): BlueprintNodePosition | null => {
    const canvas = canvasRef.current;
    const rect = canvas?.getBoundingClientRect();
    if (!canvas || !rect) {
      return null;
    }
    return {
      x: (event.clientX - rect.left + canvas.scrollLeft) / viewportScale,
      y: (event.clientY - rect.top + canvas.scrollTop) / viewportScale,
    };
  }, [viewportScale]);

  const startMove = useCallback((event: React.PointerEvent<HTMLDivElement>, nodeId: string) => {
    const point = pointerToCanvasPoint(event);
    const position = positions[nodeId];
    if (event.button !== 0 || !point || !position) {
      return;
    }
    dragStateRef.current = {
      id: nodeId,
      offsetX: point.x - position.x,
      offsetY: point.y - position.y,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }, [pointerToCanvasPoint, positions]);

  const moveNode = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const panState = panStateRef.current;
    if (panState && canvasRef.current) {
      canvasRef.current.scrollLeft = panState.scrollLeft - (event.clientX - panState.x);
      canvasRef.current.scrollTop = panState.scrollTop - (event.clientY - panState.y);
      return;
    }

    const dragState = dragStateRef.current;
    const point = pointerToCanvasPoint(event);
    if (!dragState || !point) {
      return;
    }
    setPositions((current) => ({
      ...current,
      [dragState.id]: {
        x: Math.max(12, Math.min(BLUEPRINT_CANVAS_WIDTH - 240, point.x - dragState.offsetX)),
        y: Math.max(12, Math.min(BLUEPRINT_CANVAS_HEIGHT - 120, point.y - dragState.offsetY)),
      },
    }));
  }, [pointerToCanvasPoint]);

  const stopMove = useCallback(() => {
    dragStateRef.current = null;
    panStateRef.current = null;
  }, []);

  const startPan = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 1 || !canvasRef.current) {
      return;
    }
    event.preventDefault();
    panStateRef.current = {
      x: event.clientX,
      y: event.clientY,
      scrollLeft: canvasRef.current.scrollLeft,
      scrollTop: canvasRef.current.scrollTop,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }, []);

  const zoomCanvasAt = useCallback((clientX: number, clientY: number, deltaY: number) => {
    const canvas = canvasRef.current;
    const rect = canvas?.getBoundingClientRect();
    if (!canvas || !rect) {
      return;
    }
    const nextScale = Math.max(
      BLUEPRINT_CANVAS_MIN_SCALE,
      Math.min(BLUEPRINT_CANVAS_MAX_SCALE, viewportScale * (1 - deltaY * BLUEPRINT_CANVAS_SCALE_STEP)),
    );
    if (Math.abs(nextScale - viewportScale) < 0.001) {
      return;
    }

    const viewportX = clientX - rect.left;
    const viewportY = clientY - rect.top;
    const logicalX = (canvas.scrollLeft + viewportX) / viewportScale;
    const logicalY = (canvas.scrollTop + viewportY) / viewportScale;
    setViewportScale(nextScale);
    requestAnimationFrame(() => {
      canvas.scrollLeft = logicalX * nextScale - viewportX;
      canvas.scrollTop = logicalY * nextScale - viewportY;
    });
  }, [viewportScale]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return undefined;
    }
    const handleWheel = (event: WheelEvent): void => {
      event.preventDefault();
      event.stopPropagation();
      zoomCanvasAt(event.clientX, event.clientY, event.deltaY);
    };
    canvas.addEventListener("wheel", handleWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", handleWheel);
  }, [zoomCanvasAt]);

  const startLink = useCallback((event: React.DragEvent<HTMLButtonElement>, nodeId: string) => {
    setDraggingNodeId(nodeId);
    event.dataTransfer.effectAllowed = "link";
    event.dataTransfer.setData("application/x-maibot-flow-node", nodeId);
  }, []);

  const dropOnNode = useCallback((event: React.DragEvent<HTMLElement>, nodeId: string) => {
    event.preventDefault();
    const fromNodeId = event.dataTransfer.getData("application/x-maibot-flow-node") || draggingNodeId;
    setDraggingNodeId(null);
    if (fromNodeId && fromNodeId !== nodeId) {
      onConnectFlowNode(fromNodeId, nodeId);
    }
  }, [draggingNodeId, onConnectFlowNode]);

  const dropFlowNodeOnCanvas = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    const kind = event.dataTransfer.getData(FLOW_NODE_DRAG_MIME) as MaiBotPluginBlueprintFlowNodeKind;
    if (!flowNodeTypes.some((type) => type.value === kind)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    setIsCanvasDropTarget(false);
    const point = dragEventToCanvasPoint(event);
    if (point) {
      pendingDropPositionRef.current = {
        x: Math.max(12, Math.min(BLUEPRINT_CANVAS_WIDTH - 240, point.x - 112)),
        y: Math.max(12, Math.min(BLUEPRINT_CANVAS_HEIGHT - 120, point.y - 48)),
      };
    }
    onAddFlowNode(kind);
  }, [dragEventToCanvasPoint, onAddFlowNode]);

  return (
    <div
      className={cn(
        "grid h-full min-h-0",
        propertyPanelOpen && libraryPanelOpen && "grid-cols-[minmax(420px,1fr)_320px_320px]",
        propertyPanelOpen && !libraryPanelOpen && "grid-cols-[minmax(420px,1fr)_320px_48px]",
        !propertyPanelOpen && libraryPanelOpen && "grid-cols-[minmax(420px,1fr)_48px_320px]",
        !propertyPanelOpen && !libraryPanelOpen && "grid-cols-[minmax(420px,1fr)_48px_48px]",
      )}
    >
      <div className="flex min-h-0 flex-col">
        <div className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-4">
          <Button onClick={onReturnToPlugin} size="sm" type="button" variant="secondary">
            返回插件蓝图
          </Button>
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold">{component.name}</h3>
            <p className="truncate text-xs text-muted-foreground">{componentKindLabel(component.kind)} 子蓝</p>
          </div>
          <Badge className="ml-auto" variant="secondary">{Math.round(viewportScale * 100)}%</Badge>
        </div>
        <div
          className={cn(
            "relative min-h-0 flex-1 overflow-auto bg-[radial-gradient(circle_at_1px_1px,hsl(var(--border))_1px,transparent_0)] bg-[length:24px_24px] transition-colors",
            isCanvasDropTarget && "bg-primary/5 outline outline-2 outline-primary/30",
          )}
          onDragLeave={(event) => {
            if (event.currentTarget === event.target) {
              setIsCanvasDropTarget(false);
            }
          }}
          onPointerLeave={stopMove}
          onPointerMove={moveNode}
          onPointerDown={startPan}
          onPointerUp={stopMove}
          onDragOver={(event) => {
            if (Array.from(event.dataTransfer.types).includes(FLOW_NODE_DRAG_MIME)) {
              event.preventDefault();
              event.dataTransfer.dropEffect = "copy";
              setIsCanvasDropTarget(true);
            }
          }}
          onDrop={dropFlowNodeOnCanvas}
          ref={canvasRef}
        >
          <div
            className="relative"
            style={{
              height: BLUEPRINT_CANVAS_HEIGHT * viewportScale,
              width: BLUEPRINT_CANVAS_WIDTH * viewportScale,
            }}
          >
            <div
              className="absolute left-0 top-0"
              style={{
                height: BLUEPRINT_CANVAS_HEIGHT,
                transform: `scale(${viewportScale})`,
                transformOrigin: "0 0",
                width: BLUEPRINT_CANVAS_WIDTH,
              }}
            >
            <svg className="pointer-events-none absolute inset-0 size-full">
              <defs>
                <marker id="flow-blueprint-arrow" markerHeight="8" markerWidth="8" orient="auto" refX="7" refY="4">
                  <path className="fill-primary/55" d="M 0 0 L 8 4 L 0 8 z" />
                </marker>
              </defs>
              {(component.flowEdges ?? []).map((edge) => {
                const from = positions[edge.fromNodeId];
                const to = positions[edge.toNodeId];
                if (!from || !to) return null;
                const x1 = from.x + 224;
                const y1 = from.y + 54;
                const x2 = to.x;
                const y2 = to.y + 54;
                const mid = Math.max(x1 + 44, (x1 + x2) / 2);
                const fromNode = nodes.find((node) => node.id === edge.fromNodeId);
                return (
                  <g key={edge.id}>
                  <path
                    className="stroke-primary/45"
                    d={`M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`}
                    fill="none"
                    markerEnd="url(#flow-blueprint-arrow)"
                    strokeWidth="2"
                  />
                    <text className="fill-muted-foreground text-[10px]" x={mid - 24} y={(y1 + y2) / 2 - 6}>
                      {flowEdgeLabel(fromNode)}
                    </text>
                  </g>
                );
              })}
            </svg>
            {nodes.map((node) => {
              const position = positions[node.id] ?? { x: 36, y: 44 };
              const selected = selectedFlowNode?.id === node.id;
              return (
                <div
                  className={cn(
                    "group absolute w-56 rounded-lg border bg-card shadow-sm transition-[border-color,box-shadow]",
                    selected ? "border-primary shadow-md shadow-primary/10" : "border-border",
                  )}
                  key={node.id}
                  onClick={() => setSelectedFlowNodeId(node.id)}
                  style={{ transform: `translate(${position.x}px, ${position.y}px)` }}
                  title={`${flowNodeLabel(node.kind)}\n${flowNodePlainDescription(node.kind)}\n${flowNodeFriendlySummary(node)}`}
                >
                  <span className="pointer-events-none absolute left-2 right-2 top-full z-30 mt-1 hidden rounded-md border border-border bg-popover px-2 py-1.5 text-[11px] leading-relaxed text-popover-foreground shadow-md group-hover:block">
                    <span className="block font-semibold">{flowNodeLabel(node.kind)}</span>
                    <span className="block text-muted-foreground">{flowNodePlainDescription(node.kind)}</span>
                  </span>
                  <button
                    aria-label="拖拽连接积木"
                    className="absolute -left-1.5 top-[48px] z-10 size-3 rounded-full border border-primary bg-background shadow-sm ring-2 ring-background"
                    onDragOver={(event) => {
                      if (draggingNodeId && draggingNodeId !== node.id) {
                        event.preventDefault();
                      }
                    }}
                    onDrop={(event) => dropOnNode(event, node.id)}
                    onPointerDown={(event) => event.stopPropagation()}
                    type="button"
                  />
                  <div className="flex cursor-grab items-start gap-2 p-3 active:cursor-grabbing" onPointerDown={(event) => startMove(event, node.id)}>
                    <span className="grid size-8 shrink-0 place-items-center rounded-md bg-secondary text-secondary-foreground">
                      <Link2 className="size-3.5" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-1.5">
                        <p className="truncate text-xs font-semibold">{node.label || flowNodeLabel(node.kind)}</p>
                        <Badge className="shrink-0 px-1.5 py-0 text-[10px]" variant="secondary">
                          {flowNodeLabel(node.kind)}
                        </Badge>
                      </div>
                      <p className="mt-1 line-clamp-2 text-[11px] leading-snug text-muted-foreground">
                        {flowNodeFriendlySummary(node)}
                      </p>
                    </div>
                    <button
                      aria-label="连接积木"
                      className="absolute -right-1.5 top-[48px] z-10 size-3 cursor-grab rounded-full border border-primary bg-primary shadow-sm ring-2 ring-background active:cursor-grabbing"
                      draggable
                      onDragEnd={() => setDraggingNodeId(null)}
                      onDragStart={(event) => startLink(event, node.id)}
                      onPointerDown={(event) => event.stopPropagation()}
                      type="button"
                    />
                  </div>
                </div>
              );
            })}
            </div>
          </div>
        </div>
      </div>

      <aside className="min-h-0 overflow-auto border-l border-border bg-card">
        <div className={cn("sticky top-0 z-10 flex h-12 items-center border-b border-border bg-card", propertyPanelOpen ? "gap-2 px-3" : "justify-center px-1")}>
          {propertyPanelOpen ? <Settings2 className="size-4 shrink-0 text-muted-foreground" /> : null}
          {propertyPanelOpen ? (
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">属性</p>
              <p className="truncate text-xs text-muted-foreground">当前积木</p>
            </div>
          ) : null}
          <Button
            aria-label={propertyPanelOpen ? "Collapse properties" : "Expand properties"}
            className={propertyPanelOpen ? "ml-auto" : ""}
            onClick={() => setPropertyPanelOpen((value) => !value)}
            size="icon-sm"
            type="button"
            variant="ghost"
          >
            {propertyPanelOpen ? <PanelRightClose /> : <PanelRightOpen />}
          </Button>
        </div>
        {propertyPanelOpen ? (
          <div className="p-4">
            <FlowNodePropertyWindow
              component={component}
              node={selectedFlowNode}
              nodes={nodes}
              edges={component.flowEdges ?? []}
              onChange={onChangeFlowNode}
              onConnect={onConnectFlowNode}
              onRemove={(nodeId) => {
                onRemoveFlowNode(nodeId);
                setSelectedFlowNodeId((current) => (current === nodeId ? null : current));
              }}
            />
          </div>
        ) : null}
      </aside>

      <aside className="min-h-0 overflow-auto border-l border-border bg-card">
        <div className={cn("sticky top-0 z-10 flex h-12 items-center border-b border-border bg-card", libraryPanelOpen ? "gap-2 px-3" : "justify-center px-1")}>
          {libraryPanelOpen ? <Boxes className="size-4 shrink-0 text-muted-foreground" /> : null}
          {libraryPanelOpen ? (
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">积木</p>
              <p className="truncate text-xs text-muted-foreground">点击或拖拽添加</p>
            </div>
          ) : null}
          <Button
            aria-label={libraryPanelOpen ? "Collapse library" : "Expand library"}
            className={libraryPanelOpen ? "ml-auto" : ""}
            onClick={() => setLibraryPanelOpen((value) => !value)}
            size="icon-sm"
            type="button"
            variant="ghost"
          >
            {libraryPanelOpen ? <PanelRightClose /> : <PanelRightOpen />}
          </Button>
        </div>
        {libraryPanelOpen ? (
          <div className="grid gap-4 p-4">
            <ComponentLibrarySection title="Blocks">
              {flowNodeLibraryGroups.map((group) => (
                <div className="grid gap-1" key={group.title}>
                  <p className="px-1 text-[11px] font-medium text-muted-foreground">{group.title}</p>
                  {group.items.map((item) => (
                    <ComponentLibraryButton
                      description={item.description}
                      dragData={{ mime: FLOW_NODE_DRAG_MIME, value: item.value }}
                      icon={<Link2 className="size-3.5" />}
                      key={item.value}
                      label={item.label}
                      onClick={() => onAddFlowNode(item.value)}
                    />
                  ))}
                </div>
              ))}
            </ComponentLibrarySection>
          </div>
        ) : null}
      </aside>
    </div>
  );
}

function FlowNodePropertyWindow({
  component,
  edges,
  node,
  nodes,
  onChange,
  onConnect,
  onRemove,
}: {
  component: MaiBotPluginBlueprintComponent;
  edges: MaiBotPluginBlueprintFlowEdge[];
  node: MaiBotPluginBlueprintFlowNode | null;
  nodes: MaiBotPluginBlueprintFlowNode[];
  onChange: (nodeId: string, patch: Partial<MaiBotPluginBlueprintFlowNode>) => void;
  onConnect: (fromNodeId: string, toNodeId: string) => void;
  onRemove: (nodeId: string) => void;
}): React.JSX.Element {
  const nextById = useMemo(() => new Map(edges.map((edge) => [edge.fromNodeId, edge.toNodeId])), [edges]);
  const variables = useMemo(() => collectComponentVariables(component), [component]);

  if (!node) {
    return (
      <div className="grid gap-3">
        <div className="rounded-lg border border-border bg-background p-3 text-xs leading-relaxed text-muted-foreground">
          选择一个积木后，可以在这里编辑日志、变量、赋值、循环等属性。
        </div>
        <VariablePanel variables={variables} />
      </div>
    );
  }

  return (
    <div className="grid gap-3">
    <div className="grid gap-3 rounded-lg border border-border bg-background p-3">
      <div className="flex items-start gap-2" title={`${flowNodePlainDescription(node.kind)}\n${flowNodeBeginnerTip(node.kind)}`}>
        <span className="grid size-8 shrink-0 place-items-center rounded-md bg-secondary text-secondary-foreground">
          <Link2 className="size-3.5" />
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{flowNodeLabel(node.kind)}</p>
          <p className="truncate text-xs text-muted-foreground">{flowNodePlainDescription(node.kind)}</p>
        </div>
        <Button aria-label="删除节点" className="ml-auto" onClick={() => onRemove(node.id)} size="icon-sm" type="button" variant="ghost">
          <Trash2 className="size-3.5" />
        </Button>
      </div>

      <div className="grid gap-1 rounded-md border border-border bg-muted/45 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
        <p>{flowNodeBeginnerTip(node.kind)}</p>
        <p className="font-medium text-foreground/80">{flowNodeExample(node.kind)}</p>
      </div>

      <div className="grid gap-2">
        <Field label="积木类型">
          <select
            className="h-9 rounded-md border border-input bg-card px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            onChange={(event) => onChange(node.id, { kind: event.target.value as MaiBotPluginBlueprintFlowNodeKind })}
            value={node.kind}
          >
            {flowNodeLibraryGroups.map((group) => (
              <optgroup key={group.title} label={group.title}>
                {group.items.map((type) => (
                  <option key={type.value} value={type.value}>{type.label}</option>
                ))}
              </optgroup>
            ))}
          </select>
        </Field>
        <Field label="给这个积木起名">
          <Input className="h-8 text-xs" onChange={(event) => onChange(node.id, { label: event.target.value })} value={node.label} />
        </Field>

        {node.kind === "send_text" || node.kind === "log_info" || node.kind === "comment" ? (
          <Field label={node.kind === "log_info" ? "要写进日志的内容" : node.kind === "comment" ? "给自己看的说明" : "机器人要回复的话"}>
            <Input className="h-8 text-xs" onChange={(event) => onChange(node.id, { value: event.target.value })} value={node.value ?? ""} />
          </Field>
        ) : node.kind === "read_config" ? (
          <Field label="要读取哪个设置">
            <Input
              className="h-8 text-xs"
              monospace
              onChange={(event) => onChange(node.id, { configPath: event.target.value })}
              placeholder="greeting.message"
              value={node.configPath ?? ""}
            />
          </Field>
        ) : node.kind === "if_condition" ? (
          <div className="grid gap-2">
            <Field label="满足什么条件才继续">
              <Input
                className="h-8 text-xs"
                monospace
                onChange={(event) => onChange(node.id, { value: event.target.value })}
                placeholder="message == 'hello'"
                value={node.value ?? ""}
              />
            </Field>
            <Field label="不满足时显示什么">
              <Input
                className="h-8 text-xs"
                onChange={(event) => onChange(node.id, { rightValue: event.target.value })}
                placeholder="条件不满足"
                value={node.rightValue ?? ""}
              />
            </Field>
          </div>
        ) : node.kind === "compare" ? (
          <div className="grid gap-2">
            <div className="grid grid-cols-[1fr_72px_1fr] gap-2">
              <Field label="第一个值">
                <Input className="h-8 text-xs" monospace onChange={(event) => onChange(node.id, { leftValue: event.target.value })} value={node.leftValue ?? ""} />
              </Field>
              <Field label="关系">
                <OperatorSelect
                  onChange={(operator) => onChange(node.id, { operator })}
                  options={["==", "!=", ">", ">=", "<", "<="]}
                  value={node.operator ?? "=="}
                />
              </Field>
              <Field label="第二个值">
                <Input className="h-8 text-xs" monospace onChange={(event) => onChange(node.id, { rightValue: event.target.value })} value={node.rightValue ?? ""} />
              </Field>
            </div>
            <Field label="把判断结果命名为">
              <Input className="h-8 text-xs" monospace onChange={(event) => onChange(node.id, { targetName: event.target.value })} value={node.targetName ?? ""} />
            </Field>
          </div>
        ) : node.kind === "boolean_logic" ? (
          <div className="grid gap-2">
            <div className="grid grid-cols-[1fr_72px_1fr] gap-2">
              <Field label="第一个条件">
                <Input className="h-8 text-xs" monospace onChange={(event) => onChange(node.id, { leftValue: event.target.value })} value={node.leftValue ?? ""} />
              </Field>
              <Field label="组合方式">
                <OperatorSelect
                  onChange={(operator) => onChange(node.id, { operator })}
                  options={["and", "or", "not"]}
                  value={node.operator ?? "and"}
                />
              </Field>
              <Field label="第二个条件">
                <Input
                  className="h-8 text-xs"
                  disabled={(node.operator ?? "and") === "not"}
                  monospace
                  onChange={(event) => onChange(node.id, { rightValue: event.target.value })}
                  value={node.rightValue ?? ""}
                />
              </Field>
            </div>
            <Field label="把组合结果命名为">
              <Input className="h-8 text-xs" monospace onChange={(event) => onChange(node.id, { targetName: event.target.value })} value={node.targetName ?? ""} />
            </Field>
          </div>
        ) : node.kind === "math_operation" ? (
          <div className="grid gap-2">
            <div className="grid grid-cols-[1fr_72px_1fr] gap-2">
              <Field label="第一个数字">
                <Input className="h-8 text-xs" monospace onChange={(event) => onChange(node.id, { leftValue: event.target.value })} value={node.leftValue ?? ""} />
              </Field>
              <Field label="怎么算">
                <OperatorSelect
                  onChange={(operator) => onChange(node.id, { operator })}
                  options={["+", "-", "*", "/", "//", "%"]}
                  value={node.operator ?? "+"}
                />
              </Field>
              <Field label="第二个数字">
                <Input className="h-8 text-xs" monospace onChange={(event) => onChange(node.id, { rightValue: event.target.value })} value={node.rightValue ?? ""} />
              </Field>
            </div>
            <Field label="把计算结果命名为">
              <Input className="h-8 text-xs" monospace onChange={(event) => onChange(node.id, { targetName: event.target.value })} value={node.targetName ?? ""} />
            </Field>
          </div>
        ) : node.kind === "join_text" ? (
          <div className="grid gap-2">
            <div className="grid grid-cols-2 gap-2">
              <Field label="第一段文字">
                <Input className="h-8 text-xs" onChange={(event) => onChange(node.id, { leftValue: event.target.value })} value={node.leftValue ?? ""} />
              </Field>
              <Field label="第二段文字">
                <Input className="h-8 text-xs" onChange={(event) => onChange(node.id, { rightValue: event.target.value })} value={node.rightValue ?? ""} />
              </Field>
            </div>
            <Field label="把拼接结果命名为">
              <Input className="h-8 text-xs" monospace onChange={(event) => onChange(node.id, { targetName: event.target.value })} value={node.targetName ?? ""} />
            </Field>
          </div>
        ) : node.kind === "set_variable" || node.kind === "guard_config" ? (
          <div className="grid grid-cols-2 gap-2">
            <Field label={node.kind === "set_variable" ? "给这个值起名" : "检查哪个设置"}>
              <Input
                className="h-8 text-xs"
                monospace
                onChange={(event) => onChange(node.id, { configPath: event.target.value })}
                placeholder={node.kind === "set_variable" ? "result" : "plugin.enabled"}
                value={node.configPath ?? ""}
              />
            </Field>
            <Field label={node.kind === "set_variable" ? "要记住的值" : "应该等于"}>
              <Input
                className="h-8 text-xs"
                onChange={(event) => onChange(node.id, { value: event.target.value })}
                placeholder={node.kind === "set_variable" ? "ok" : "true"}
                value={node.value ?? ""}
              />
            </Field>
          </div>
        ) : node.kind === "loop" ? (
          <div className="grid grid-cols-2 gap-2">
            <Field label="每一次叫它什么">
              <Input
                className="h-8 text-xs"
                monospace
                onChange={(event) => onChange(node.id, { configPath: event.target.value })}
                placeholder="item"
                value={node.configPath ?? ""}
              />
            </Field>
            <Field label="重复范围">
              <Input
                className="h-8 text-xs"
                monospace
                onChange={(event) => onChange(node.id, { value: event.target.value })}
                placeholder="range(3)"
                value={node.value ?? ""}
              />
            </Field>
          </div>
        ) : node.kind === "wait" ? (
          <Field label="等几秒">
            <Input
              className="h-8 text-xs"
              monospace
              onChange={(event) => onChange(node.id, { value: event.target.value })}
              placeholder="1"
              value={node.value ?? ""}
            />
          </Field>
        ) : (
          <div className="rounded-md bg-muted/55 px-3 py-2 text-xs text-muted-foreground">
            这个节点会结束当前流程并返回成功结果。
          </div>
        )}

        <Field label="下一步">
          <select
            className="h-9 rounded-md border border-input bg-card px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            onChange={(event) => onConnect(node.id, event.target.value)}
            value={nextById.get(node.id) ?? ""}
          >
            <option value=""></option>
            {nodes.filter((item) => item.id !== node.id).map((item) => (
              <option key={item.id} value={item.id}>{item.label || flowNodeLabel(item.kind)}</option>
            ))}
          </select>
        </Field>
      </div>
    </div>
      <VariablePanel variables={variables} />
    </div>
  );
}

function OperatorSelect({
  onChange,
  options,
  value,
}: {
  onChange: (operator: string) => void;
  options: string[];
  value: string;
}): React.JSX.Element {
  return (
    <select
      className="h-8 rounded-md border border-input bg-card px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
      onChange={(event) => onChange(event.target.value)}
      value={value}
    >
      {options.map((option) => (
        <option key={option} value={option}>{option}</option>
      ))}
    </select>
  );
}

function VariablePanel({ variables }: { variables: Array<{ name: string; source: string }> }): React.JSX.Element {
  const copyVariableName = (name: string): void => {
    if (!navigator.clipboard) {
      toast.error("当前环境不支持复制");
      return;
    }
    void navigator.clipboard.writeText(name).then(
      () => toast.success(`已复制 ${name}`),
      () => toast.error("复制失败"),
    );
  };

  return (
    <div className="grid gap-2 rounded-lg border border-border bg-background p-3">
      <div className="flex items-center gap-2">
        <Braces className="size-4 text-muted-foreground" />
        <span className="text-xs font-semibold">可用变量</span>
        <Badge className="ml-auto" variant="secondary">{variables.length}</Badge>
      </div>
      {variables.length === 0 ? (
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          这里会列出 Tool 参数、设置过的变量和读取配置的结果，方便填到后续积木里。
        </p>
      ) : (
        <div className="grid gap-1.5">
          {variables.map((variable) => (
            <button
              className="grid grid-cols-[1fr_auto] items-center gap-2 rounded-md border border-border bg-card px-2 py-1.5 text-left transition-colors hover:border-primary/45 hover:bg-accent"
              key={`${variable.source}-${variable.name}`}
              onClick={() => copyVariableName(variable.name)}
              title="复制变量名"
              type="button"
            >
              <span className="truncate font-mono text-[11px] text-foreground">{variable.name}</span>
              <span className="truncate text-[10px] text-muted-foreground">{variable.source}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function collectComponentVariables(component: MaiBotPluginBlueprintComponent): Array<{ name: string; source: string }> {
  const variables = new Map<string, string>();
  if (component.kind === "tool") {
    for (const parameter of component.parameters ?? []) {
      if (parameter.name.trim()) {
        variables.set(parameter.name.trim(), "Tool 参数");
      }
    }
  }
  variables.set("message", "默认消息文本");
  variables.set("stream_id", "当前聊天 ID");
  for (const node of component.flowNodes ?? []) {
    const target = (node.targetName || (node.kind === "set_variable" ? node.configPath : "") || "").trim();
    if (target) {
      variables.set(target, flowNodeLabel(node.kind));
    }
    if (node.kind === "read_config") {
      variables.set("config_value", node.configPath ? `读取设置 ${node.configPath}` : "读取设置");
    }
    if (node.kind === "loop") {
      variables.set(node.configPath || "item", "循环变量");
    }
  }
  return [...variables.entries()].map(([name, source]) => ({ name, source }));
}

function canvasNodeIcon(node: BlueprintCanvasNode): React.ReactNode {
  if (node.kind === "manifest") return <FileJson className="size-4" />;
  if (node.kind === "lifecycle") return <Hammer className="size-4" />;
  if (node.kind === "config") return <Settings2 className="size-4" />;
  if (node.component?.kind === "tool") return <Wrench className="size-4" />;
  if (node.component?.kind === "command") return <TerminalSquare className="size-4" />;
  return <MessageSquare className="size-4" />;
}

function canvasNodeToneClass(node: BlueprintCanvasNode): string {
  if (node.kind === "manifest") return "bg-primary/15 text-primary";
  if (node.kind === "lifecycle") return "bg-success/15 text-success";
  if (node.kind === "config") return "bg-warning/20 text-warning-foreground";
  if (node.component?.kind === "tool") return "bg-blue-500/12 text-blue-500";
  if (node.component?.kind === "hook") return "bg-success/15 text-success";
  return "bg-secondary text-secondary-foreground";
}

function blueprintEdgeLabel(node: BlueprintCanvasNode | undefined): string {
  if (!node) return "连接";
  if (node.kind === "manifest") return "声明";
  if (node.kind === "lifecycle") return "加载";
  if (node.kind === "config") return "设置";
  if (node.component?.kind === "tool") return "工具";
  if (node.component?.kind === "command") return "命令";
  if (node.component?.kind === "hook") return "事件";
  return "下一步";
}

function flowEdgeLabel(node: MaiBotPluginBlueprintFlowNode | undefined): string {
  if (!node) return "下一步";
  if (node.kind === "if_condition" || node.kind === "guard_config") return "通过后";
  if (node.kind === "loop") return "循环后";
  if (node.kind === "wait") return "等待后";
  if (node.kind === "return_success") return "结束";
  return "下一步";
}

function BlueprintCanvas({ blueprint }: { blueprint: MaiBotPluginBlueprint }): React.JSX.Element {
  const toolCount = blueprint.components.filter((component) => component.kind === "tool").length;
  const commandCount = blueprint.components.filter((component) => component.kind === "command").length;
  const hookCount = blueprint.components.filter((component) => component.kind === "hook").length;
  return (
    <div className="mx-auto grid max-w-4xl gap-5 p-5">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold">节点</h3>
          <p className="truncate text-xs text-muted-foreground">{toolCount} Tool / {commandCount} Command / {hookCount} Hook / {blueprint.configFields.length} Config</p>
        </div>
        <Badge variant="secondary">{blueprint.manifest.version}</Badge>
      </div>

      <div className="grid gap-5">
        <CanvasNode icon={<FileJson />} title={blueprint.manifest.name} tone="primary" subtitle={blueprint.manifest.pluginId}>
          <div className="grid grid-cols-2 gap-2 text-[11px] text-muted-foreground">
            <span>Manifest v2</span>
            <span className="truncate text-right">{blueprint.manifest.license}</span>
          </div>
        </CanvasNode>

        <Connector />

        <div className="grid gap-4 md:grid-cols-2">
          <CanvasNode icon={<Hammer />} title="生命周期" tone="success" subtitle="on_load / on_unload / on_config_update">
            <Badge variant="secondary">自动生成</Badge>
          </CanvasNode>
          <CanvasNode icon={<Settings2 />} title="配置模型" tone="warning" subtitle="PluginConfigBase + config.toml">
            <div className="flex flex-wrap gap-1">
              {blueprint.configFields.slice(0, 4).map((field) => (
                <Badge key={field.id} variant="secondary">{field.section}.{field.name}</Badge>
              ))}
              {blueprint.configFields.length > 4 ? <Badge variant="secondary">+{blueprint.configFields.length - 4}</Badge> : null}
            </div>
          </CanvasNode>
        </div>

        <Connector />

        <div className="grid gap-3 md:grid-cols-2">
          {blueprint.components.map((component) => (
            <CanvasNode
              icon={component.kind === "tool" ? <Wrench /> : component.kind === "command" ? <TerminalSquare /> : <MessageSquare />}
              key={component.id}
              subtitle={component.description}
              title={component.name}
              tone={component.kind === "tool" ? "info" : component.kind === "hook" ? "success" : "neutral"}
            >
              <div className="flex flex-wrap gap-1">
                <Badge variant="secondary">{componentKindLabel(component.kind)}</Badge>
                {component.kind === "command" ? <Badge variant="secondary">{component.trigger || "^/command$"}</Badge> : null}
                {component.kind === "hook" ? <Badge variant="secondary">{component.eventType || "ON_MESSAGE"}</Badge> : null}
                {component.kind === "tool" ? <Badge variant="secondary">{component.parameters?.length ?? 0} 参数</Badge> : null}
                <Badge variant="secondary">{component.flowNodes?.length ?? 0} 积木</Badge>
              </div>
            </CanvasNode>
          ))}
        </div>
      </div>
    </div>
  );
}

function FilePreviewPanel({
  activeFile,
  blueprint,
  files,
  onCollapse,
  onSelect,
}: {
  activeFile: MaiBotPluginBlueprintFile | undefined;
  blueprint: MaiBotPluginBlueprint;
  files: MaiBotPluginBlueprintFile[];
  onCollapse: () => void;
  onSelect: (file: string) => void;
}): React.JSX.Element {
  const explanation = useMemo(
    () => explainPreviewFile(blueprint, activeFile?.relativePath ?? ""),
    [activeFile?.relativePath, blueprint],
  );
  const explanationSteps = useMemo(
    () => buildPreviewSteps(blueprint, activeFile?.relativePath ?? ""),
    [activeFile?.relativePath, blueprint],
  );
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
        <Code2 className="size-4 text-muted-foreground" />
        <span className="text-sm font-semibold">文件预览</span>
        <Badge className="ml-auto" variant="secondary">{files.length}</Badge>
        <Button aria-label={"\u6536\u8d77\u6587\u4ef6\u9884\u89c8"} onClick={onCollapse} size="icon-sm" variant="ghost">
          <PanelRightClose />
        </Button>
      </div>
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border px-2">
        {files.map((file) => (
          <button
            className={cn(
              "inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium transition-colors",
              activeFile?.relativePath === file.relativePath
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
            )}
            key={file.relativePath}
            onClick={() => onSelect(file.relativePath)}
            type="button"
          >
            {file.relativePath.endsWith(".json") ? <FileJson className="size-3.5" /> : <Code2 className="size-3.5" />}
            {file.relativePath}
          </button>
        ))}
      </div>
      <div className="grid gap-1 border-b border-border bg-muted/35 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
        <p className="font-semibold text-foreground/80">{explanation.title}</p>
        <p>{explanation.detail}</p>
        {explanationSteps.length > 0 ? (
          <ol className="mt-1 grid gap-0.5 pl-4">
            {explanationSteps.map((step, index) => (
              <li className="list-decimal" key={`${activeFile?.relativePath ?? "file"}-${index}`}>{step}</li>
            ))}
          </ol>
        ) : null}
      </div>
      <pre className="min-h-0 flex-1 overflow-auto bg-background p-4 font-mono text-[12px] leading-relaxed text-foreground">
        <code>{activeFile?.content ?? ""}</code>
      </pre>
    </div>
  );
}

function CanvasNode({
  icon,
  title,
  subtitle,
  tone,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle?: string;
  tone: "primary" | "success" | "warning" | "info" | "neutral";
  children?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div
      className={cn(
        "rounded-lg border bg-card p-4 shadow-sm",
        tone === "primary" && "border-primary/35",
        tone === "success" && "border-success/35",
        tone === "warning" && "border-warning/45",
        tone === "info" && "border-blue-400/35",
        tone === "neutral" && "border-border",
      )}
    >
      <div className="flex items-start gap-3">
        <span
          className={cn(
            "grid size-9 shrink-0 place-items-center rounded-md",
            tone === "primary" && "bg-primary/15 text-primary",
            tone === "success" && "bg-success/15 text-success",
            tone === "warning" && "bg-warning/20 text-warning-foreground",
            tone === "info" && "bg-blue-500/12 text-blue-500",
            tone === "neutral" && "bg-secondary text-secondary-foreground",
          )}
        >
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{title}</p>
          {subtitle ? <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground">{subtitle}</p> : null}
          {children ? <div className="mt-3">{children}</div> : null}
        </div>
      </div>
    </div>
  );
}

function Connector(): React.JSX.Element {
  return (
    <div aria-hidden className="grid h-6 place-items-center">
      <div className="h-6 w-px bg-border" />
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <label className="grid min-w-0 gap-1.5 text-xs font-medium">
      <span className="truncate text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

function SectionTitle({
  icon,
  title,
  trailing,
}: {
  icon: React.ReactNode;
  title: string;
  trailing?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-2">
      <span className="text-muted-foreground [&_svg]:size-4">{icon}</span>
      <h3 className="text-sm font-semibold">{title}</h3>
      <div className="ml-auto">{trailing}</div>
    </div>
  );
}

function TypeSelect({
  value,
  onChange,
}: {
  value: MaiBotPluginBlueprintScalarType;
  onChange: (value: MaiBotPluginBlueprintScalarType) => void;
}): React.JSX.Element {
  return (
    <select
      className="h-9 rounded-md border border-input bg-card px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
      onChange={(event) => onChange(event.target.value as MaiBotPluginBlueprintScalarType)}
      value={value}
    >
      {scalarTypes.map((type) => (
        <option key={type.value} value={type.value}>{type.label}</option>
      ))}
    </select>
  );
}

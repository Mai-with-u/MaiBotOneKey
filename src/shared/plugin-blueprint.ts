import type {
  MaiBotPluginBlueprint,
  MaiBotPluginBlueprintComponent,
  MaiBotPluginBlueprintConfigField,
  MaiBotPluginBlueprintFlowNode,
  MaiBotPluginBlueprintFile,
  MaiBotPluginBlueprintManifest,
  MaiBotPluginBlueprintParameter,
  MaiBotPluginBlueprintScalarType,
} from "./contracts";

interface NormalizedBlueprint {
  manifest: Required<MaiBotPluginBlueprintManifest>;
  components: MaiBotPluginBlueprintComponent[];
  configFields: MaiBotPluginBlueprintConfigField[];
}

interface ConfigSection {
  name: string;
  title: string;
  className: string;
  fields: MaiBotPluginBlueprintConfigField[];
}

const DEFAULT_AUTHOR_URL = "https://example.com";
const DEFAULT_REPOSITORY_URL = "https://example.com/maibot-plugin";
const DEFAULT_LICENSE = "MIT";
const DEFAULT_HOST_MIN_VERSION = "1.0.0";
const DEFAULT_HOST_MAX_VERSION = "1.99.99";
const DEFAULT_SDK_MIN_VERSION = "2.0.0";
const DEFAULT_SDK_MAX_VERSION = "2.99.99";
const STRICT_VERSION_PATTERN = /^\d+\.\d+\.\d+$/u;

const RESERVED_PYTHON_IDENTIFIERS = new Set([
  "False",
  "None",
  "True",
  "and",
  "as",
  "assert",
  "async",
  "await",
  "break",
  "class",
  "continue",
  "def",
  "del",
  "elif",
  "else",
  "except",
  "finally",
  "for",
  "from",
  "global",
  "if",
  "import",
  "in",
  "is",
  "lambda",
  "nonlocal",
  "not",
  "or",
  "pass",
  "raise",
  "return",
  "try",
  "while",
  "with",
  "yield",
]);

export function buildMaiBotPluginBlueprintFiles(
  blueprint: MaiBotPluginBlueprint,
): MaiBotPluginBlueprintFile[] {
  const normalized = normalizeBlueprint(blueprint);
  const manifest = buildManifestJson(normalized);
  const pluginPy = buildPluginPython(normalized);
  const configToml = buildConfigToml(normalized);

  return [
    { relativePath: "_manifest.json", content: `${JSON.stringify(manifest, null, 2)}\n` },
    { relativePath: "plugin.py", content: pluginPy },
    { relativePath: "config.toml", content: configToml },
  ];
}

export function defaultMaiBotPluginFolderName(pluginId: string): string {
  const normalizedId = normalizePluginId(pluginId);
  return normalizedId.replace(/\./gu, "_");
}

export function sanitizeMaiBotPluginFolderName(value: string, pluginId: string): string {
  const fallback = defaultMaiBotPluginFolderName(pluginId);
  const folderName = value
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/gu, "_")
    .replace(/\s+/gu, "_")
    .replace(/[. ]+$/u, "")
    .replace(/^\.+/u, "");
  return folderName || fallback;
}

export function isValidMaiBotPluginVersion(version: unknown): version is string {
  return typeof version === "string" && STRICT_VERSION_PATTERN.test(version.trim());
}

export function validateMaiBotPluginBlueprint(blueprint: MaiBotPluginBlueprint): string[] {
  const errors: string[] = [];
  const manifest = blueprint.manifest;
  const pluginId = manifest.pluginId.trim();
  if (!isValidPluginId(pluginId)) {
    errors.push("插件 ID 需要使用小写字母、数字、点号或横线，并且不能以点号开头或结尾。");
  }
  if (!manifest.name.trim()) {
    errors.push("插件名称不能为空。");
  }
  const versionFields = [
    { label: "插件版本", value: manifest.version, example: "1.0.0" },
    { label: "MaiBot 最低版本", value: manifest.minHostVersion, example: "1.0.0" },
    { label: "MaiBot 最高版本", value: manifest.maxHostVersion, example: "1.99.99" },
    { label: "SDK 最低版本", value: manifest.minSdkVersion, example: "2.0.0" },
    { label: "SDK 最高版本", value: manifest.maxSdkVersion, example: "2.99.99" },
  ];
  for (const field of versionFields) {
    if (!isValidMaiBotPluginVersion(field.value)) {
      errors.push(`${field.label}需要是三段式语义版本，例如 ${field.example}。`);
    }
  }
  if (!isHttpUrl(manifest.authorUrl || DEFAULT_AUTHOR_URL)) {
    errors.push("作者 URL 需要是 http 或 https 地址。");
  }
  if (!isHttpUrl(manifest.repositoryUrl || DEFAULT_REPOSITORY_URL)) {
    errors.push("仓库地址需要是 http 或 https 地址。");
  }

  const componentNames = new Set<string>();
  for (const component of blueprint.components) {
    const name = component.name.trim();
    if (!name) {
      errors.push("组件节点名称不能为空。");
      continue;
    }
    if (componentNames.has(name)) {
      errors.push(`组件节点名称重复：${name}`);
    }
    componentNames.add(name);
    for (const parameter of component.parameters ?? []) {
      if (!parameter.name.trim()) {
        errors.push(`组件 ${name} 存在空参数名。`);
      }
    }
  }

  for (const field of blueprint.configFields) {
    if (!field.section.trim() || !field.name.trim()) {
      errors.push("配置字段需要同时填写分组和字段名。");
    }
  }

  return errors;
}

function normalizeBlueprint(blueprint: MaiBotPluginBlueprint): NormalizedBlueprint {
  const pluginId = normalizePluginId(blueprint.manifest.pluginId);
  const folderName = sanitizeMaiBotPluginFolderName(blueprint.manifest.folderName ?? "", pluginId);
  const manifest: Required<MaiBotPluginBlueprintManifest> = {
    pluginId,
    folderName,
    name: blueprint.manifest.name.trim() || "MaiBot 插件",
    version: normalizeVersion(blueprint.manifest.version),
    description: blueprint.manifest.description.trim() || "由 MaiBot OneKey 插件编写器生成的插件",
    authorName: blueprint.manifest.authorName.trim() || "MaiBot Developer",
    authorUrl: ensureHttpUrl(blueprint.manifest.authorUrl, DEFAULT_AUTHOR_URL),
    license: blueprint.manifest.license.trim() || DEFAULT_LICENSE,
    repositoryUrl: ensureHttpUrl(blueprint.manifest.repositoryUrl, DEFAULT_REPOSITORY_URL),
    minHostVersion: normalizeVersion(blueprint.manifest.minHostVersion || DEFAULT_HOST_MIN_VERSION),
    maxHostVersion: normalizeVersion(blueprint.manifest.maxHostVersion || DEFAULT_HOST_MAX_VERSION),
    minSdkVersion: normalizeVersion(blueprint.manifest.minSdkVersion || DEFAULT_SDK_MIN_VERSION),
    maxSdkVersion: normalizeVersion(blueprint.manifest.maxSdkVersion || DEFAULT_SDK_MAX_VERSION),
    capabilities: normalizeCapabilities(blueprint.manifest.capabilities),
  };

  const components = blueprint.components
    .map(normalizeComponent)
    .filter((component) => component.name.length > 0);
  const configFields = [
    createConfigField("builtin-enabled", "plugin", "enabled", "boolean", "启用插件", "是否启用插件", "true"),
    createConfigField("builtin-config-version", "plugin", "config_version", "string", "配置版本", "配置文件版本", manifest.version),
    ...blueprint.configFields.map(normalizeConfigField).filter((field) => field.name.length > 0),
  ];

  return { manifest, components, configFields: dedupeConfigFields(configFields) };
}

function buildManifestJson(blueprint: NormalizedBlueprint): Record<string, unknown> {
  return {
    manifest_version: 2,
    id: blueprint.manifest.pluginId,
    version: blueprint.manifest.version,
    name: blueprint.manifest.name,
    description: blueprint.manifest.description,
    author: {
      name: blueprint.manifest.authorName,
      url: blueprint.manifest.authorUrl,
    },
    license: blueprint.manifest.license,
    urls: {
      repository: blueprint.manifest.repositoryUrl,
      homepage: blueprint.manifest.repositoryUrl,
      documentation: blueprint.manifest.repositoryUrl,
      issues: blueprint.manifest.repositoryUrl,
    },
    host_application: {
      min_version: blueprint.manifest.minHostVersion,
      max_version: blueprint.manifest.maxHostVersion,
    },
    sdk: {
      min_version: blueprint.manifest.minSdkVersion,
      max_version: blueprint.manifest.maxSdkVersion,
    },
    dependencies: [],
    capabilities: blueprint.manifest.capabilities,
    i18n: {
      default_locale: "zh-CN",
      supported_locales: ["zh-CN"],
    },
  };
}

function buildPluginPython(blueprint: NormalizedBlueprint): string {
  const className = toPascalCase(blueprint.manifest.name || blueprint.manifest.pluginId, "GeneratedPlugin");
  const pluginClassName = className.endsWith("Plugin") ? className : `${className}Plugin`;
  const configClassName = `${pluginClassName}Config`;
  const configSections = buildConfigSections(blueprint.configFields);
  const imports = new Set(["Command", "Field", "MaiBotPlugin", "PluginConfigBase"]);
  if (blueprint.components.some((component) => component.kind === "tool")) {
    imports.add("Tool");
  }
  const lines: string[] = [
    `"""${blueprint.manifest.name}`,
    "",
    "This plugin was generated by MaiBot OneKey Plugin Builder.",
    `Plugin id: ${blueprint.manifest.pluginId}`,
    '"""',
    "",
    "import asyncio",
    "",
    "from typing import Any",
    "",
    `from maibot_sdk import ${[...imports].sort().join(", ")}`,
  ];

  const typeImports = new Set<string>();
  if (blueprint.components.some((component) => component.kind === "tool")) {
    typeImports.add("ToolParameterInfo");
    typeImports.add("ToolParamType");
  }
  if (typeImports.size > 0) {
    lines.push(`from maibot_sdk.types import ${[...typeImports].sort().join(", ")}`);
  }

  lines.push("", "");
  for (const section of configSections) {
    lines.push(...buildConfigSectionClass(section), "");
  }

  lines.push(`class ${configClassName}(PluginConfigBase):`);
  lines.push(`    """${blueprint.manifest.name} 配置。"""`);
  lines.push("");
  for (const section of configSections) {
    lines.push(`    ${toPythonIdentifier(section.name)}: ${section.className} = Field(default_factory=${section.className})`);
  }
  lines.push("", "");

  lines.push(`class ${pluginClassName}(MaiBotPlugin):`);
  lines.push(`    """${blueprint.manifest.description}"""`);
  lines.push("");
  lines.push(`    config_model = ${configClassName}`);
  lines.push("");
  lines.push("    async def on_load(self) -> None:");
  lines.push(`        self.ctx.logger.info("${escapePythonString(blueprint.manifest.name)} 已加载")`);
  lines.push("");
  lines.push("    async def on_unload(self) -> None:");
  lines.push(`        self.ctx.logger.info("${escapePythonString(blueprint.manifest.name)} 已卸载")`);
  lines.push("");
  lines.push("    async def on_config_update(self, scope: str, config_data: dict, version: str) -> None:");
  lines.push("        del config_data");
  lines.push('        if scope == "self":');
  lines.push('            self.ctx.logger.info("插件配置已更新: version=%s", version)');
  lines.push("");

  if (blueprint.components.length === 0) {
    lines.push("    # 在编写器里添加 Tool 或 Command 节点后会生成对应组件。");
    lines.push("    pass");
  } else {
    for (const component of blueprint.components) {
      if (component.kind === "command") {
        lines.push(...buildCommandMethod(component));
      } else {
        lines.push(...buildToolMethod(component));
      }
      lines.push("");
    }
  }

  lines.push("");
  lines.push(`def create_plugin() -> ${pluginClassName}:`);
  lines.push(`    return ${pluginClassName}()`);
  lines.push("");

  return `${lines.join("\n")}\n`;
}

function buildConfigSectionClass(section: ConfigSection): string[] {
  const lines = [
    `class ${section.className}(PluginConfigBase):`,
    `    """${section.title} 配置。"""`,
    "",
    `    __ui_label__ = "${escapePythonString(section.title)}"`,
    "",
  ];

  for (const field of section.fields) {
    const identifier = toPythonIdentifier(field.name);
    const pythonType = pythonTypeForScalar(field.type);
    const defaultValue = pythonLiteralForScalar(field.defaultValue, field.type);
    const description = field.description.trim() || field.label.trim() || field.name;
    lines.push(
      `    ${identifier}: ${pythonType} = Field(default=${defaultValue}, description="${escapePythonString(description)}")`,
    );
  }

  return lines;
}

function buildToolMethod(component: MaiBotPluginBlueprintComponent): string[] {
  const name = toComponentName(component.name);
  const handlerName = toPythonIdentifier(`handle_${name}`);
  const parameters = normalizeParameters(component.parameters ?? []);
  const lines = [
    "    @Tool(",
    `        "${escapePythonString(name)}",`,
    `        description="${escapePythonString(component.description || name)}",`,
  ];

  if (parameters.length > 0) {
    lines.push("        parameters=[");
    for (const parameter of parameters) {
      lines.push(
        `            ToolParameterInfo(name="${escapePythonString(parameter.name)}", param_type=ToolParamType.${toolParamType(parameter.type)}, description="${escapePythonString(parameter.description || parameter.name)}", required=${parameter.required ? "True" : "False"}),`,
      );
    }
    lines.push("        ],");
  }

  lines.push("    )");
  const signatureParameters = parameters.map((parameter) => (
    `${toPythonIdentifier(parameter.name)}: ${pythonTypeForScalar(parameter.type)} = ${pythonLiteralForScalar(parameter.defaultValue, parameter.type)}`
  ));
  const hasStreamIdParameter = parameters.some((parameter) => toPythonIdentifier(parameter.name) === "stream_id");
  const toolSignatureParameters = hasStreamIdParameter
    ? signatureParameters
    : [...signatureParameters, 'stream_id: str = ""'];
  lines.push(`    async def ${handlerName}(self, ${[...toolSignatureParameters, "**kwargs: Any"].join(", ")}) -> dict[str, Any]:`);
  lines.push("        del kwargs");
  lines.push(...buildFlowBody(component, "tool", name, component.responseText || "工具已执行", parameters));
  return lines;
}

function buildCommandMethod(component: MaiBotPluginBlueprintComponent): string[] {
  const name = toComponentName(component.name);
  const handlerName = toPythonIdentifier(`handle_${name}`);
  const pattern = component.trigger?.trim() || `^/${escapeRegExp(name)}$`;
  const lines = [
    `    @Command("${escapePythonString(name)}", description="${escapePythonString(component.description || name)}", pattern=r"${escapePythonRawString(pattern)}")`,
    `    async def ${handlerName}(self, stream_id: str = "", **kwargs: Any):`,
    "        del kwargs",
  ];
  lines.push(...buildFlowBody(component, "command", name, component.responseText || "命令已执行", []));
  return lines;
}

function buildFlowBody(
  component: MaiBotPluginBlueprintComponent,
  mode: "tool" | "command",
  componentName: string,
  defaultMessage: string,
  parameters: MaiBotPluginBlueprintParameter[],
): string[] {
  const nodes = orderedFlowNodes(component);
  if (nodes.length === 0) {
    return buildDefaultFlowBody(mode, componentName, defaultMessage);
  }

  const lines: string[] = [`        message = "${escapePythonString(defaultMessage)}"`];
  const availableVariables = collectAvailablePythonVariables(component, parameters);
  let returned = false;
  for (const node of nodes) {
    if (node.kind === "comment") {
      const comment = sanitizePythonComment(node.value || node.label || "flow note");
      if (comment) {
        lines.push(`        # ${comment}`);
      }
    } else if (node.kind === "log_info") {
      const text = node.value?.trim() || node.label || "插件流程执行中";
      lines.push(`        self.ctx.logger.info("${escapePythonString(text)}")`);
    } else if (node.kind === "set_variable") {
      const variableName = toPythonIdentifier(node.targetName || node.configPath || node.label || "value");
      const value = node.value?.trim() || "";
      lines.push(`        ${variableName} = "${escapePythonString(value)}"`);
      lines.push(`        message = str(${variableName})`);
      availableVariables.add(variableName);
    } else if (node.kind === "if_condition") {
      const condition = sanitizePythonExpression(node.value || "True", "True");
      const failureMessage = node.rightValue?.trim() || node.configPath?.trim() || "条件不满足";
      lines.push(`        if not (${condition}):`);
      lines.push(`            message = "${escapePythonString(failureMessage)}"`);
      lines.push(...buildFailureReturnLines(mode, componentName, "            "));
    } else if (node.kind === "compare") {
      const left = sanitizePythonExpression(node.leftValue || "0", "0");
      const operator = sanitizePythonOperator(node.operator, ["==", "!=", ">", ">=", "<", "<="], "==");
      const right = sanitizePythonExpression(node.rightValue || "0", "0");
      const targetName = toPythonIdentifier(node.targetName || node.configPath || "compare_result");
      lines.push(`        ${targetName} = (${left}) ${operator} (${right})`);
      lines.push(`        message = str(${targetName})`);
      availableVariables.add(targetName);
    } else if (node.kind === "boolean_logic") {
      const operator = sanitizePythonOperator(node.operator, ["and", "or", "not"], "and");
      const left = sanitizePythonExpression(node.leftValue || "True", "True");
      const right = sanitizePythonExpression(node.rightValue || "False", "False");
      const targetName = toPythonIdentifier(node.targetName || node.configPath || "logic_result");
      if (operator === "not") {
        lines.push(`        ${targetName} = not (${left})`);
      } else {
        lines.push(`        ${targetName} = (${left}) ${operator} (${right})`);
      }
      lines.push(`        message = str(${targetName})`);
      availableVariables.add(targetName);
    } else if (node.kind === "math_operation") {
      const left = sanitizePythonExpression(node.leftValue || "0", "0");
      const operator = sanitizePythonOperator(node.operator, ["+", "-", "*", "/", "//", "%"], "+");
      const right = sanitizePythonExpression(node.rightValue || "0", "0");
      const targetName = toPythonIdentifier(node.targetName || node.configPath || "math_result");
      lines.push(`        ${targetName} = (${left}) ${operator} (${right})`);
      lines.push(`        message = str(${targetName})`);
      availableVariables.add(targetName);
    } else if (node.kind === "join_text") {
      const left = escapePythonString(node.leftValue ?? "");
      const right = escapePythonString(node.rightValue ?? "");
      const targetName = toPythonIdentifier(node.targetName || node.configPath || "joined_text");
      lines.push(`        ${targetName} = "${left}" + "${right}"`);
      lines.push(`        message = str(${targetName})`);
      availableVariables.add(targetName);
    } else if (node.kind === "guard_config") {
      const configPath = normalizeConfigPath(node.configPath || "");
      if (configPath.length > 0) {
        const expectedValue = (node.value?.trim() || "true").toLowerCase();
        lines.push(`        guard_value = self.config.${configPath.join(".")}`);
        lines.push(`        if str(guard_value).lower() != "${escapePythonString(expectedValue)}":`);
        lines.push(`            message = "配置条件未满足: ${escapePythonString(configPath.join("."))}"`);
        lines.push(...buildFailureReturnLines(mode, componentName, "            "));
      }
    } else if (node.kind === "loop") {
      const variableName = toPythonIdentifier(node.configPath || node.label || "item");
      const iterable = sanitizePythonExpression(node.value || "range(3)", "range(3)");
      lines.push(`        for ${variableName} in ${iterable}:`);
      lines.push(`            self.ctx.logger.info(f"${escapePythonString(variableName)}={${variableName}}")`);
      availableVariables.add(variableName);
    } else if (node.kind === "wait") {
      const seconds = sanitizePythonExpression(node.value || "1", "1");
      lines.push(`        await asyncio.sleep(float(${seconds}))`);
    } else if (node.kind === "read_config") {
      const configPath = normalizeConfigPath(node.configPath || node.value || "");
      if (configPath.length > 0) {
        lines.push(`        config_value = self.config.${configPath.join(".")}`);
        lines.push("        message = str(config_value)");
        availableVariables.add("config_value");
      }
    } else if (node.kind === "send_text") {
      const text = node.value?.trim() || defaultMessage;
      lines.push(`        message = ${pythonTextExpression(text, availableVariables)}`);
      lines.push("        if stream_id:");
      lines.push("            await self.ctx.send.text(message, stream_id)");
    } else if (node.kind === "return_success") {
      lines.push(...buildReturnLines(mode, componentName));
      returned = true;
    }
  }
  if (!returned) {
    lines.push(...buildReturnLines(mode, componentName));
  }
  return lines;
}

function buildDefaultFlowBody(
  mode: "tool" | "command",
  componentName: string,
  defaultMessage: string,
): string[] {
  const lines = [`        message = "${escapePythonString(defaultMessage)}"`];
  if (mode !== "tool" || componentName.includes("send") || componentName.includes("greeting")) {
    lines.push("        if stream_id:");
    lines.push("            await self.ctx.send.text(message, stream_id)");
  }
  lines.push(...buildReturnLines(mode, componentName));
  return lines;
}

function buildReturnLines(mode: "tool" | "command", componentName: string): string[] {
  if (mode === "tool") {
    return [`        return {"success": True, "name": "${escapePythonString(componentName)}", "message": message}`];
  }
  return ["        return True, message, True"];
}

function buildFailureReturnLines(
  mode: "tool" | "command",
  componentName: string,
  indent = "        ",
): string[] {
  if (mode === "tool") {
    return [`${indent}return {"success": False, "name": "${escapePythonString(componentName)}", "message": message}`];
  }
  return [`${indent}return False, message, True`];
}

function collectAvailablePythonVariables(
  component: MaiBotPluginBlueprintComponent,
  parameters: MaiBotPluginBlueprintParameter[],
): Set<string> {
  const variables = new Set(["message", "stream_id", "config_value"]);
  for (const parameter of parameters) {
    variables.add(toPythonIdentifier(parameter.name));
  }
  return variables;
}

function pythonTextExpression(value: string, availableVariables: Set<string>): string {
  const trimmed = value.trim();
  if (isPythonIdentifier(trimmed) && availableVariables.has(trimmed)) {
    return `str(${trimmed})`;
  }
  if (/\{\{[^}]+\}\}/u.test(value)) {
    return pythonTemplateExpression(value, availableVariables);
  }
  return `"${escapePythonString(value)}"`;
}

function pythonTemplateExpression(value: string, availableVariables: Set<string>): string {
  let output = "";
  let cursor = 0;
  const pattern = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/gu;
  for (const match of value.matchAll(pattern)) {
    const index = match.index ?? 0;
    output += escapePythonFStringText(value.slice(cursor, index));
    const variableName = match[1];
    output += availableVariables.has(variableName)
      ? `{${variableName}}`
      : escapePythonFStringText(match[0]);
    cursor = index + match[0].length;
  }
  output += escapePythonFStringText(value.slice(cursor));
  return `f"${output}"`;
}

function isPythonIdentifier(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/u.test(value) && !RESERVED_PYTHON_IDENTIFIERS.has(value);
}

function sanitizePythonComment(value: string): string {
  return value
    .replace(/[\r\n]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function sanitizePythonExpression(value: string, fallback: string): string {
  const expression = value.replace(/[\r\n:;]/gu, " ").trim();
  return expression || fallback;
}

function sanitizePythonOperator(value: string | undefined, allowed: string[], fallback: string): string {
  const operator = value?.trim() || fallback;
  return allowed.includes(operator) ? operator : fallback;
}

function orderedFlowNodes(component: MaiBotPluginBlueprintComponent): MaiBotPluginBlueprintFlowNode[] {
  const nodes = component.flowNodes ?? [];
  if (nodes.length <= 1) {
    return nodes;
  }
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const incoming = new Set((component.flowEdges ?? []).map((edge) => edge.toNodeId));
  const nextById = new Map((component.flowEdges ?? []).map((edge) => [edge.fromNodeId, edge.toNodeId]));
  const first = nodes.find((node) => !incoming.has(node.id)) ?? nodes[0];
  const ordered: MaiBotPluginBlueprintFlowNode[] = [];
  const seen = new Set<string>();
  let cursor: MaiBotPluginBlueprintFlowNode | undefined = first;
  while (cursor && !seen.has(cursor.id)) {
    ordered.push(cursor);
    seen.add(cursor.id);
    const nextId = nextById.get(cursor.id);
    cursor = nextId ? byId.get(nextId) : undefined;
  }
  for (const node of nodes) {
    if (!seen.has(node.id)) {
      ordered.push(node);
    }
  }
  return ordered;
}

function normalizeConfigPath(value: string): string[] {
  return value
    .split(".")
    .map((part) => toPythonIdentifier(part))
    .filter(Boolean);
}

function buildConfigToml(blueprint: NormalizedBlueprint): string {
  const sections = buildConfigSections(blueprint.configFields);
  const lines: string[] = [];
  for (const section of sections) {
    lines.push(`[${section.name}]`);
    for (const field of section.fields) {
      lines.push(`${toTomlKey(field.name)} = ${tomlLiteralForScalar(field.defaultValue, field.type)}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function buildConfigSections(fields: MaiBotPluginBlueprintConfigField[]): ConfigSection[] {
  const sectionMap = new Map<string, ConfigSection>();
  for (const field of fields) {
    const sectionName = toPythonIdentifier(field.section || "plugin");
    const existing = sectionMap.get(sectionName);
    if (existing) {
      existing.fields.push(field);
      continue;
    }
    sectionMap.set(sectionName, {
      name: sectionName,
      title: titleFromIdentifier(sectionName),
      className: `${toPascalCase(sectionName, "Plugin")}SectionConfig`,
      fields: [field],
    });
  }
  return [...sectionMap.values()];
}

function normalizeComponent(component: MaiBotPluginBlueprintComponent): MaiBotPluginBlueprintComponent {
  return {
    ...component,
    kind: component.kind === "command" ? component.kind : "tool",
    name: toComponentName(component.name),
    description: component.description.trim(),
    trigger: component.trigger?.trim(),
    eventType: component.eventType?.trim(),
    responseText: component.responseText?.trim(),
    parameters: normalizeParameters(component.parameters ?? []),
    flowNodes: component.flowNodes ?? [],
    flowEdges: component.flowEdges ?? [],
  };
}

function normalizeParameters(parameters: MaiBotPluginBlueprintParameter[]): MaiBotPluginBlueprintParameter[] {
  const seen = new Set<string>();
  return parameters
    .map((parameter) => ({
      ...parameter,
      name: toPythonIdentifier(parameter.name),
      description: parameter.description.trim(),
      defaultValue: parameter.defaultValue,
    }))
    .filter((parameter) => {
      if (!parameter.name || seen.has(parameter.name)) {
        return false;
      }
      seen.add(parameter.name);
      return true;
    });
}

function normalizeConfigField(field: MaiBotPluginBlueprintConfigField): MaiBotPluginBlueprintConfigField {
  return {
    ...field,
    section: toPythonIdentifier(field.section || "plugin"),
    name: toPythonIdentifier(field.name),
    label: field.label.trim(),
    description: field.description.trim(),
    defaultValue: field.defaultValue,
  };
}

function dedupeConfigFields(fields: MaiBotPluginBlueprintConfigField[]): MaiBotPluginBlueprintConfigField[] {
  const seen = new Set<string>();
  return fields.filter((field) => {
    const key = `${field.section}.${field.name}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function createConfigField(
  id: string,
  section: string,
  name: string,
  type: MaiBotPluginBlueprintScalarType,
  label: string,
  description: string,
  defaultValue: string,
): MaiBotPluginBlueprintConfigField {
  return { id, section, name, type, label, description, defaultValue };
}

function normalizeCapabilities(capabilities: string[]): string[] {
  const values = capabilities
    .flatMap((capability) => capability.split(/[,;\n]/u))
    .map((capability) => capability.trim())
    .filter(Boolean);
  const normalized = values.length > 0 ? values : ["send.text", "config.get"];
  return [...new Set(normalized)];
}

function normalizePluginId(pluginId: string): string {
  const normalized = pluginId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/gu, "-")
    .replace(/\.{2,}/gu, ".")
    .replace(/-+/gu, "-")
    .replace(/^[.-]+|[.-]+$/gu, "");
  return normalized || "com.example.maibot-plugin";
}

function normalizeVersion(version: string): string {
  const match = version.trim().match(/^(\d+)\.(\d+)\.(\d+)/u);
  return match ? `${match[1]}.${match[2]}.${match[3]}` : "1.0.0";
}

function isValidPluginId(pluginId: string): boolean {
  return /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(pluginId) && !pluginId.includes("..");
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function ensureHttpUrl(value: string, fallback: string): string {
  const trimmed = value.trim();
  return isHttpUrl(trimmed) ? trimmed : fallback;
}

function toComponentName(value: string): string {
  const name = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/gu, "_")
    .replace(/^_+|_+$/gu, "");
  return toPythonIdentifier(name || "generated_component");
}

function toPythonIdentifier(value: string): string {
  const identifier = value
    .trim()
    .replace(/[^A-Za-z0-9_]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    || "value";
  const withPrefix = /^[A-Za-z_]/u.test(identifier) ? identifier : `value_${identifier}`;
  return RESERVED_PYTHON_IDENTIFIERS.has(withPrefix) ? `${withPrefix}_value` : withPrefix;
}

function toPascalCase(value: string, fallback: string): string {
  const words = value
    .replace(/[^A-Za-z0-9]+/gu, " ")
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
  const name = words.map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`).join("");
  const normalized = name || fallback;
  return /^[A-Za-z]/u.test(normalized) ? normalized : `${fallback}${normalized}`;
}

function titleFromIdentifier(value: string): string {
  if (value === "plugin") {
    return "插件";
  }
  return value
    .split(/[_-]+/u)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function pythonTypeForScalar(type: MaiBotPluginBlueprintScalarType): string {
  switch (type) {
    case "boolean":
      return "bool";
    case "float":
      return "float";
    case "integer":
      return "int";
    default:
      return "str";
  }
}

function toolParamType(type: MaiBotPluginBlueprintScalarType): string {
  switch (type) {
    case "boolean":
      return "BOOLEAN";
    case "float":
      return "FLOAT";
    case "integer":
      return "INTEGER";
    default:
      return "STRING";
  }
}

function pythonLiteralForScalar(value: string | boolean, type: MaiBotPluginBlueprintScalarType): string {
  switch (type) {
    case "boolean":
      return parseBoolean(value) ? "True" : "False";
    case "float":
      return String(parseNumber(value, 0));
    case "integer":
      return String(Math.trunc(parseNumber(value, 0)));
    default:
      return `"${escapePythonString(String(value ?? ""))}"`;
  }
}

function tomlLiteralForScalar(value: string | boolean, type: MaiBotPluginBlueprintScalarType): string {
  switch (type) {
    case "boolean":
      return parseBoolean(value) ? "true" : "false";
    case "float":
      return String(parseNumber(value, 0));
    case "integer":
      return String(Math.trunc(parseNumber(value, 0)));
    default:
      return `"${escapeTomlString(String(value ?? ""))}"`;
  }
}

function parseBoolean(value: string | boolean): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  return ["1", "true", "yes", "on", "enabled"].includes(value.trim().toLowerCase());
}

function parseNumber(value: string | boolean, fallback: number): number {
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toTomlKey(value: string): string {
  return /^[A-Za-z0-9_-]+$/u.test(value) ? value : `"${escapeTomlString(value)}"`;
}

function escapePythonString(value: string): string {
  return value.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"').replace(/\r/gu, "\\r").replace(/\n/gu, "\\n");
}

function escapePythonFStringText(value: string): string {
  return escapePythonString(value).replace(/\{/gu, "{{").replace(/\}/gu, "}}");
}

function escapePythonRawString(value: string): string {
  return value.replace(/"/gu, '\\"');
}

function escapeTomlString(value: string): string {
  return value.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"').replace(/\r/gu, "\\r").replace(/\n/gu, "\\n");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

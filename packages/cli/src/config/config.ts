/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { homedir } from 'node:os';
import yargs from 'yargs/yargs';
import { hideBin } from 'yargs/helpers';
import process from 'node:process';
import { mcpCommand } from '../commands/mcp.js';
import type {
  MCPServerConfig,
  OutputFormat,
  GeminiCLIExtension,
} from '@google/gemini-cli-core';
import { extensionsCommand } from '../commands/extensions.js';
import {
  Config,
  setGeminiMdFilename as setServerGeminiMdFilename,
  getCurrentGeminiMdFilename,
  ApprovalMode,
  DEFAULT_GEMINI_MODEL,
  DEFAULT_GEMINI_MODEL_AUTO,
  DEFAULT_GEMINI_EMBEDDING_MODEL,
  FileDiscoveryService,
  ShellTool,
  EditTool,
  WRITE_FILE_TOOL_NAME,
  SHELL_TOOL_NAMES,
  resolveTelemetrySettings,
  FatalConfigError,
} from '@google/gemini-cli-core';
import type { Settings } from './settings.js';

import { getCliVersion } from '../utils/version.js';
import { loadSandboxConfig } from './sandboxConfig.js';
import { resolvePath } from '../utils/resolvePath.js';
import { appEvents } from '../utils/events.js';

import { isWorkspaceTrusted } from './trustedFolders.js';
import { createPolicyEngineConfig } from './policy.js';

// Simple console logger for now - replace with actual logger if available
const logger = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  debug: (...args: any[]) => console.debug('[DEBUG]', ...args),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  warn: (...args: any[]) => console.warn('[WARN]', ...args),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  error: (...args: any[]) => console.error('[ERROR]', ...args),
};

export interface CliArgs {
  query: string | undefined;
  model: string | undefined;
  sandbox: boolean | string | undefined;
  sandboxImage: string | undefined;
  debug: boolean | undefined;
  prompt: string | undefined;
  promptInteractive: string | undefined;
  allFiles: boolean | undefined;
  showMemoryUsage: boolean | undefined;
  yolo: boolean | undefined;
  approvalMode: string | undefined;
  telemetry: boolean | undefined;
  checkpointing: boolean | undefined;
  telemetryTarget: string | undefined;
  telemetryOtlpEndpoint: string | undefined;
  telemetryOtlpProtocol: string | undefined;
  telemetryLogPrompts: boolean | undefined;
  telemetryOutfile: string | undefined;
  allowedMcpServerNames: string[] | undefined;
  allowedTools: string[] | undefined;
  experimentalAcp: boolean | undefined;
  extensions: string[] | undefined;
  listExtensions: boolean | undefined;
  proxy: string | undefined;
  includeDirectories: string[] | undefined;
  screenReader: boolean | undefined;
  useSmartEdit: boolean | undefined;
  useWriteTodos: boolean | undefined;
  outputFormat: string | undefined;
}

export async function parseArguments(settings: Settings): Promise<CliArgs> {
  const rawArgv = hideBin(process.argv);
  const yargsInstance = yargs(rawArgv)
    .locale('en')
    .scriptName('gemini')
    .usage(
      'Usage: gemini [options] [command]\n\nGemini CLI - Launch an interactive CLI, use -p/--prompt for non-interactive mode',
    )
    .option('telemetry', {
      type: 'boolean',
      description:
        'Enable telemetry? This flag specifically controls if telemetry is sent. Other --telemetry-* flags set specific values but do not enable telemetry on their own.',
    })
    .option('telemetry-target', {
      type: 'string',
      nargs: 1,
      choices: ['local', 'gcp'],
      description:
        'Set the telemetry target (local or gcp). Overrides settings files.',
    })
    .option('telemetry-otlp-endpoint', {
      type: 'string',
      nargs: 1,
      description:
        'Set the OTLP endpoint for telemetry. Overrides environment variables and settings files.',
    })
    .option('telemetry-otlp-protocol', {
      type: 'string',
      nargs: 1,
      choices: ['grpc', 'http'],
      description:
        'Set the OTLP protocol for telemetry (grpc or http). Overrides settings files.',
    })
    .option('telemetry-log-prompts', {
      type: 'boolean',
      description:
        'Enable or disable logging of user prompts for telemetry. Overrides settings files.',
    })
    .option('telemetry-outfile', {
      type: 'string',
      nargs: 1,
      description: 'Redirect all telemetry output to the specified file.',
    })
    .deprecateOption(
      'telemetry',
      'Use the "telemetry.enabled" setting in settings.json instead. This flag will be removed in a future version.',
    )
    .deprecateOption(
      'telemetry-target',
      'Use the "telemetry.target" setting in settings.json instead. This flag will be removed in a future version.',
    )
    .deprecateOption(
      'telemetry-otlp-endpoint',
      'Use the "telemetry.otlpEndpoint" setting in settings.json instead. This flag will be removed in a future version.',
    )
    .deprecateOption(
      'telemetry-otlp-protocol',
      'Use the "telemetry.otlpProtocol" setting in settings.json instead. This flag will be removed in a future version.',
    )
    .deprecateOption(
      'telemetry-log-prompts',
      'Use the "telemetry.logPrompts" setting in settings.json instead. This flag will be removed in a future version.',
    )
    .deprecateOption(
      'telemetry-outfile',
      'Use the "telemetry.outfile" setting in settings.json instead. This flag will be removed in a future version.',
    )
    .option('debug', {
      alias: 'd',
      type: 'boolean',
      description: 'Run in debug mode?',
      default: false,
    })
    .option('proxy', {
      type: 'string',
      nargs: 1,
      description:
        'Proxy for gemini client, like schema://user:password@host:port',
    })
    .deprecateOption(
      'proxy',
      'Use the "proxy" setting in settings.json instead. This flag will be removed in a future version.',
    )
    .command('$0 [query..]', 'Launch Gemini CLI', (yargsInstance) =>
      yargsInstance
        .positional('query', {
          description:
            'Positional prompt. Defaults to one-shot; use -i/--prompt-interactive for interactive.',
        })
        .option('model', {
          alias: 'm',
          type: 'string',
          nargs: 1,
          description: `Model`,
        })
        .option('prompt', {
          alias: 'p',
          type: 'string',
          nargs: 1,
          description: 'Prompt. Appended to input on stdin (if any).',
        })
        .option('prompt-interactive', {
          alias: 'i',
          type: 'string',
          nargs: 1,
          description:
            'Execute the provided prompt and continue in interactive mode',
        })
        .option('sandbox', {
          alias: 's',
          type: 'boolean',
          description: 'Run in sandbox?',
        })
        .option('sandbox-image', {
          type: 'string',
          nargs: 1,
          description: 'Sandbox image URI.',
        })
        .option('all-files', {
          alias: ['a'],
          type: 'boolean',
          description: 'Include ALL files in context?',
          default: false,
        })
        .option('show-memory-usage', {
          type: 'boolean',
          description: 'Show memory usage in status bar',
          default: false,
        })
        .option('yolo', {
          alias: 'y',
          type: 'boolean',
          description:
            'Automatically accept all actions (aka YOLO mode, see https://www.youtube.com/watch?v=xvFZjo5PgG0 for more details)?',
          default: false,
        })
        .option('approval-mode', {
          type: 'string',
          nargs: 1,
          choices: ['default', 'auto_edit', 'yolo'],
          description:
            'Set the approval mode: default (prompt for approval), auto_edit (auto-approve edit tools), yolo (auto-approve all tools)',
        })
        .option('checkpointing', {
          alias: 'c',
          type: 'boolean',
          description: 'Enables checkpointing of file edits',
          default: false,
        })
        .option('experimental-acp', {
          type: 'boolean',
          description: 'Starts the agent in ACP mode',
        })
        .option('allowed-mcp-server-names', {
          type: 'array',
          string: true,
          nargs: 1,
          description: 'Allowed MCP server names',
          coerce: (mcpServerNames: string[]) =>
            // Handle comma-separated values
            mcpServerNames.flatMap((mcpServerName) =>
              mcpServerName.split(',').map((m) => m.trim()),
            ),
        })
        .option('allowed-tools', {
          type: 'array',
          string: true,
          nargs: 1,
          description: 'Tools that are allowed to run without confirmation',
          coerce: (tools: string[]) =>
            // Handle comma-separated values
            tools.flatMap((tool) => tool.split(',').map((t) => t.trim())),
        })
        .option('extensions', {
          alias: 'e',
          type: 'array',
          string: true,
          nargs: 1,
          description:
            'A list of extensions to use. If not provided, all extensions are used.',
          coerce: (extensions: string[]) =>
            // Handle comma-separated values
            extensions.flatMap((extension) =>
              extension.split(',').map((e) => e.trim()),
            ),
        })
        .option('list-extensions', {
          alias: 'l',
          type: 'boolean',
          description: 'List all available extensions and exit.',
        })
        .option('include-directories', {
          type: 'array',
          string: true,
          nargs: 1,
          description:
            'Additional directories to include in the workspace (comma-separated or multiple --include-directories)',
          coerce: (dirs: string[]) =>
            // Handle comma-separated values
            dirs.flatMap((dir) => dir.split(',').map((d) => d.trim())),
        })
        .option('screen-reader', {
          type: 'boolean',
          description: 'Enable screen reader mode for accessibility.',
        })
        .option('output-format', {
          alias: 'o',
          type: 'string',
          nargs: 1,
          description: 'The format of the CLI output.',
          choices: ['text', 'json', 'stream-json'],
        })
        .deprecateOption(
          'show-memory-usage',
          'Use the "ui.showMemoryUsage" setting in settings.json instead. This flag will be removed in a future version.',
        )
        .deprecateOption(
          'sandbox-image',
          'Use the "tools.sandbox" setting in settings.json instead. This flag will be removed in a future version.',
        )
        .deprecateOption(
          'checkpointing',
          'Use the "general.checkpointing.enabled" setting in settings.json instead. This flag will be removed in a future version.',
        )
        .deprecateOption(
          'all-files',
          'Use @ includes in the application instead. This flag will be removed in a future version.',
        )
        .deprecateOption(
          'prompt',
          'Use the positional prompt instead. This flag will be removed in a future version.',
        )
        // Ensure validation flows through .fail() for clean UX
        .fail((msg, err, yargs) => {
          console.error(msg || err?.message || 'Unknown error');
          yargs.showHelp();
          process.exit(1);
        })
        .check((argv) => {
          // The 'query' positional can be a string (for one arg) or string[] (for multiple).
          // This guard safely checks if any positional argument was provided.
          const query = argv['query'] as string | string[] | undefined;
          const hasPositionalQuery = Array.isArray(query)
            ? query.length > 0
            : !!query;

          if (argv['prompt'] && hasPositionalQuery) {
            return 'Cannot use both a positional prompt and the --prompt (-p) flag together';
          }
          if (argv['prompt'] && argv['promptInteractive']) {
            return 'Cannot use both --prompt (-p) and --prompt-interactive (-i) together';
          }
          if (argv.yolo && argv['approvalMode']) {
            return 'Cannot use both --yolo (-y) and --approval-mode together. Use --approval-mode=yolo instead.';
          }
          return true;
        }),
    )
    // Register MCP subcommands
    .command(mcpCommand);

  if (settings?.experimental?.extensionManagement ?? true) {
    yargsInstance.command(extensionsCommand);
  }

  yargsInstance
    .version(await getCliVersion()) // This will enable the --version flag based on package.json
    .alias('v', 'version')
    .help()
    .alias('h', 'help')
    .strict()
    .demandCommand(0, 0); // Allow base command to run with no subcommands

  yargsInstance.wrap(yargsInstance.terminalWidth());
  const result = await yargsInstance.parse();

  // If yargs handled --help/--version it will have exited; nothing to do here.

  // Handle case where MCP subcommands are executed - they should exit the process
  // and not return to main CLI logic
  if (
    result._.length > 0 &&
    (result._[0] === 'mcp' || result._[0] === 'extensions')
  ) {
    // MCP commands handle their own execution and process exit
    process.exit(0);
  }

  // Normalize query args: handle both quoted "@path file" and unquoted @path file
  const queryArg = (result as { query?: string | string[] | undefined }).query;
  const q: string | undefined = Array.isArray(queryArg)
    ? queryArg.join(' ')
    : queryArg;

  // Route positional args: explicit -i flag -> interactive; else -> one-shot (even for @commands)
  if (q && !result['prompt']) {
    const hasExplicitInteractive =
      result['promptInteractive'] === '' || !!result['promptInteractive'];
    if (hasExplicitInteractive) {
      result['promptInteractive'] = q;
    } else {
      result['prompt'] = q;
    }
  }

  // Keep CliArgs.query as a string for downstream typing
  (result as Record<string, unknown>)['query'] = q || undefined;

  // The import format is now only controlled by settings.memoryImportFormat
  // We no longer accept it as a CLI argument
  return result as unknown as CliArgs;
}

async function checkIsCurrentWorkingDirectoryHomeDirectory(
  currentWorkingDirectory: string,
): Promise<boolean> {
  // FIX: Use real, canonical paths for a reliable comparison to handle symlinks.
  const realCwd = fs.realpathSync(path.resolve(currentWorkingDirectory));
  const realHome = fs.realpathSync(path.resolve(homedir()));
  return realCwd === realHome;
}

/**
 * Creates a filter function to determine if a tool should be excluded.
 *
 * In non-interactive mode, we want to disable tools that require user
 * interaction to prevent the CLI from hanging. This function creates a predicate
 * that returns `true` if a tool should be excluded.
 *
 * A tool is excluded if it's not in the `allowedToolsSet`. The shell tool
 * has a special case: it's not excluded if any of its subcommands
 * are in the `allowedTools` list.
 *
 * @param allowedTools A list of explicitly allowed tool names.
 * @param allowedToolsSet A set of explicitly allowed tool names for quick lookups.
 * @returns A function that takes a tool name and returns `true` if it should be excluded.
 */
function createToolExclusionFilter(
  allowedTools: string[],
  allowedToolsSet: Set<string>,
) {
  return (tool: string): boolean => {
    if (tool === ShellTool.Name) {
      // If any of the allowed tools is ShellTool (even with subcommands), don't exclude it.
      return !allowedTools.some((allowed) =>
        SHELL_TOOL_NAMES.some((shellName) => allowed.startsWith(shellName)),
      );
    }
    return !allowedToolsSet.has(tool);
  };
}

export function isDebugMode(argv: CliArgs): boolean {
  return (
    argv.debug ||
    [process.env['DEBUG'], process.env['DEBUG_MODE']].some(
      (v) => v === 'true' || v === '1',
    )
  );
}

export async function loadCliConfig(
  settings: Settings,
  allExtensions: GeminiCLIExtension[],
  sessionId: string,
  argv: CliArgs,
  cwd: string = process.cwd(),
): Promise<Config> {
  const debugMode = isDebugMode(argv);

  const memoryImportFormat = settings.context?.importFormat || 'tree';

  const ideMode = settings.ide?.enabled ?? false;

  const folderTrust = settings.security?.folderTrust?.enabled ?? false;
  const trustedFolder = isWorkspaceTrusted(settings)?.isTrusted ?? true;

  // Set the context filename in the server's memoryTool module BEFORE loading memory
  // TODO(b/343434939): This is a bit of a hack. The contextFileName should ideally be passed
  // directly to the Config constructor in core, and have core handle setGeminiMdFilename.
  // However, loadHierarchicalGeminiMemory is called *before* createServerConfig.
  if (settings.context?.fileName) {
    setServerGeminiMdFilename(settings.context.fileName);
  } else {
    // Reset to default if not provided in settings.
    setServerGeminiMdFilename(getCurrentGeminiMdFilename());
  }

  const fileService = new FileDiscoveryService(cwd);

  const currentWorkingDirectoryIsHomeDir =
    await checkIsCurrentWorkingDirectoryHomeDirectory(cwd);

  const includeDirectories = (settings.context?.includeDirectories || [])
    .map(resolvePath)
    .concat((argv.includeDirectories || []).map(resolvePath));

  let mcpServers = mergeMcpServers(settings, allExtensions);
  const question = argv.promptInteractive || argv.prompt || '';

  // Determine approval mode with backward compatibility
  let approvalMode: ApprovalMode;
  if (argv.approvalMode) {
    // New --approval-mode flag takes precedence
    switch (argv.approvalMode) {
      case 'yolo':
        approvalMode = ApprovalMode.YOLO;
        break;
      case 'auto_edit':
        approvalMode = ApprovalMode.AUTO_EDIT;
        break;
      case 'default':
        approvalMode = ApprovalMode.DEFAULT;
        break;
      default:
        throw new Error(
          `Invalid approval mode: ${argv.approvalMode}. Valid values are: yolo, auto_edit, default`,
        );
    }
  } else {
    // Fallback to legacy --yolo flag behavior
    approvalMode =
      argv.yolo || false ? ApprovalMode.YOLO : ApprovalMode.DEFAULT;
  }

  // Force approval mode to default if the folder is not trusted.
  if (!trustedFolder && approvalMode !== ApprovalMode.DEFAULT) {
    logger.warn(
      `Approval mode overridden to "default" because the current folder is not trusted.`,
    );
    approvalMode = ApprovalMode.DEFAULT;
  }

  let telemetrySettings;
  try {
    telemetrySettings = await resolveTelemetrySettings({
      argv,
      env: process.env as unknown as Record<string, string | undefined>,
      settings: settings.telemetry,
    });
  } catch (err) {
    if (err instanceof FatalConfigError) {
      throw new FatalConfigError(
        `Invalid telemetry configuration: ${err.message}.`,
      );
    }
    throw err;
  }

  const policyEngineConfig = createPolicyEngineConfig(settings, approvalMode);

  const allowedTools = argv.allowedTools || settings.tools?.allowed || [];
  const allowedToolsSet = new Set(allowedTools);

  // Interactive mode: explicit -i flag or (TTY + no args + no -p flag)
  const hasQuery = !!argv.query;
  const interactive =
    !!argv.promptInteractive ||
    (process.stdin.isTTY && !hasQuery && !argv.prompt);
  // In non-interactive mode, exclude tools that require a prompt.
  const extraExcludes: string[] = [];
  if (!interactive && !argv.experimentalAcp) {
    const defaultExcludes = [
      ShellTool.Name,
      EditTool.Name,
      WRITE_FILE_TOOL_NAME,
    ];
    const autoEditExcludes = [ShellTool.Name];

    const toolExclusionFilter = createToolExclusionFilter(
      allowedTools,
      allowedToolsSet,
    );

    switch (approvalMode) {
      case ApprovalMode.DEFAULT:
        // In default non-interactive mode, all tools that require approval are excluded.
        extraExcludes.push(...defaultExcludes.filter(toolExclusionFilter));
        break;
      case ApprovalMode.AUTO_EDIT:
        // In auto-edit non-interactive mode, only tools that still require a prompt are excluded.
        extraExcludes.push(...autoEditExcludes.filter(toolExclusionFilter));
        break;
      case ApprovalMode.YOLO:
        // No extra excludes for YOLO mode.
        break;
      default:
        // This should never happen due to validation earlier, but satisfies the linter
        break;
    }
  }

  const excludeTools = mergeExcludeTools(
    settings,
    allExtensions,
    extraExcludes.length > 0 ? extraExcludes : undefined,
  );
  const blockedMcpServers: Array<{ name: string; extensionName: string }> = [];

  if (!argv.allowedMcpServerNames) {
    if (settings.mcp?.allowed) {
      mcpServers = allowedMcpServers(
        mcpServers,
        settings.mcp.allowed,
        blockedMcpServers,
      );
    }

    if (settings.mcp?.excluded) {
      const excludedNames = new Set(settings.mcp.excluded.filter(Boolean));
      if (excludedNames.size > 0) {
        mcpServers = Object.fromEntries(
          Object.entries(mcpServers).filter(([key]) => !excludedNames.has(key)),
        );
      }
    }
  }

  if (argv.allowedMcpServerNames) {
    mcpServers = allowedMcpServers(
      mcpServers,
      argv.allowedMcpServerNames,
      blockedMcpServers,
    );
  }

  const useModelRouter = settings.experimental?.useModelRouter ?? true;
  const defaultModel = useModelRouter
    ? DEFAULT_GEMINI_MODEL_AUTO
    : DEFAULT_GEMINI_MODEL;
  const resolvedModel: string =
    argv.model ||
    process.env['GEMINI_MODEL'] ||
    settings.model?.name ||
    defaultModel;

  const sandboxConfig = await loadSandboxConfig(settings, argv);
  const screenReader =
    argv.screenReader !== undefined
      ? argv.screenReader
      : (settings.ui?.accessibility?.screenReader ?? false);
  return new Config({
    sessionId,
    embeddingModel: DEFAULT_GEMINI_EMBEDDING_MODEL,
    sandbox: sandboxConfig,
    targetDir: cwd,
    includeDirectories,
    loadMemoryFromIncludeDirectories:
      settings.context?.loadMemoryFromIncludeDirectories || false,
    debugMode,
    question,
    fullContext: argv.allFiles || false,
    coreTools: settings.tools?.core || undefined,
    allowedTools: allowedTools.length > 0 ? allowedTools : undefined,
    policyEngineConfig,
    excludeTools,
    toolDiscoveryCommand: settings.tools?.discoveryCommand,
    toolCallCommand: settings.tools?.callCommand,
    mcpServerCommand: settings.mcp?.serverCommand,
    mcpServers,
    // Explicitly NOT setting userMemory, geminiMdFilePaths, or geminiMdFileCount, these will be calculated in the initialize method.
    approvalMode,
    showMemoryUsage:
      argv.showMemoryUsage || settings.ui?.showMemoryUsage || false,
    accessibility: {
      ...settings.ui?.accessibility,
      screenReader,
    },
    telemetry: telemetrySettings,
    usageStatisticsEnabled: settings.privacy?.usageStatisticsEnabled ?? true,
    fileFiltering,
    checkpointing:
      argv.checkpointing || settings.general?.checkpointing?.enabled,
    proxy:
      argv.proxy ||
      process.env['HTTPS_PROXY'] ||
      process.env['https_proxy'] ||
      process.env['HTTP_PROXY'] ||
      process.env['http_proxy'],
    cwd,
    fileDiscoveryService: fileService,
    bugCommand: settings.advanced?.bugCommand,
    model: resolvedModel,
    maxSessionTurns: settings.model?.maxSessionTurns ?? -1,
    experimentalZedIntegration: argv.experimentalAcp || false,
    listExtensions: argv.listExtensions || false,
    extensions: allExtensions,
    blockedMcpServers,
    noBrowser: !!process.env['NO_BROWSER'],
    summarizeToolOutput: settings.model?.summarizeToolOutput,
    ideMode,
    chatCompression: settings.model?.chatCompression,
    folderTrust,
    interactive,
    trustedFolder,
    useRipgrep: settings.tools?.useRipgrep,
    enableInteractiveShell:
      settings.tools?.shell?.enableInteractiveShell ?? true,
    skipNextSpeakerCheck: settings.model?.skipNextSpeakerCheck,
    enablePromptCompletion: settings.general?.enablePromptCompletion ?? false,
    truncateToolOutputThreshold: settings.tools?.truncateToolOutputThreshold,
    truncateToolOutputLines: settings.tools?.truncateToolOutputLines,
    enableToolOutputTruncation: settings.tools?.enableToolOutputTruncation,
    eventEmitter: appEvents,
    useSmartEdit: argv.useSmartEdit ?? settings.useSmartEdit,
    useWriteTodos: argv.useWriteTodos ?? settings.useWriteTodos,
    output: {
      format: (argv.outputFormat ?? settings.output?.format) as OutputFormat,
    },
    useModelRouter,
    enableMessageBusIntegration:
      settings.tools?.enableMessageBusIntegration ?? false,
    codebaseInvestigatorSettings:
      settings.experimental?.codebaseInvestigatorSettings,
    retryFetchErrors: settings.general?.retryFetchErrors ?? false,
    enableSubagents: settings.experimental?.enableSubagents ?? false,
    loadMemoryConfig: {
      importFormat: memoryImportFormat,
      currentWorkingDirectoryIsHomeDir,
      discoveryMaxDirs: settings.context?.discoveryMaxDirs,
    },
  });
}

function allowedMcpServers(
  mcpServers: { [x: string]: MCPServerConfig },
  allowMCPServers: string[],
  blockedMcpServers: Array<{ name: string; extensionName: string }>,
) {
  const allowedNames = new Set(allowMCPServers.filter(Boolean));
  if (allowedNames.size > 0) {
    mcpServers = Object.fromEntries(
      Object.entries(mcpServers).filter(([key, server]) => {
        const isAllowed = allowedNames.has(key);
        if (!isAllowed) {
          blockedMcpServers.push({
            name: key,
            extensionName: server.extension?.name || '',
          });
        }
        return isAllowed;
      }),
    );
  } else {
    blockedMcpServers.push(
      ...Object.entries(mcpServers).map(([key, server]) => ({
        name: key,
        extensionName: server.extension?.name || '',
      })),
    );
    mcpServers = {};
  }
  return mcpServers;
}

function mergeMcpServers(settings: Settings, extensions: GeminiCLIExtension[]) {
  const mcpServers = { ...(settings.mcpServers || {}) };
  for (const extension of extensions) {
    if (!extension.isActive) {
      continue;
    }
    Object.entries(extension.mcpServers || {}).forEach(([key, server]) => {
      if (mcpServers[key]) {
        logger.warn(
          `Skipping extension MCP config for server with key "${key}" as it already exists.`,
        );
        return;
      }
      mcpServers[key] = {
        ...server,
        extension,
      };
    });
  }
  return mcpServers;
}

function mergeExcludeTools(
  settings: Settings,
  extensions: GeminiCLIExtension[],
  extraExcludes?: string[] | undefined,
): string[] {
  const allExcludeTools = new Set([
    ...(settings.tools?.exclude || []),
    ...(extraExcludes || []),
  ]);
  for (const extension of extensions) {
    if (!extension.isActive) {
      continue;
    }
    for (const tool of extension.excludeTools || []) {
      allExcludeTools.add(tool);
    }
  }
  return [...allExcludeTools];
}

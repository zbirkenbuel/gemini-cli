/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ExtensionUpdateInfo } from '../../config/extension.js';
import { getErrorMessage } from '../../utils/errors.js';
import { MessageType } from '../types.js';
import {
  type CommandContext,
  type SlashCommand,
  CommandKind,
} from './types.js';

async function listAction(context: CommandContext) {
  context.ui.addItem(
    {
      type: MessageType.EXTENSIONS_LIST,
    },
    Date.now(),
  );
}

async function setExtensionEnablement(
  context: CommandContext,
  args: string,
  enabledState: boolean,
) {
  const enableArgs = args.split(' ').filter((value) => value.length > 0);
  const all = enableArgs.length === 1 && enableArgs[0] === '--all';
  const names = all ? undefined : enableArgs;

  if (!all && names?.length === 0) {
    context.ui.addItem(
      {
        type: MessageType.ERROR,
        text: `Usage: /extensions ${enabledState ? 'enable' : 'disable'} <extension-names>|--all`,
      },
      Date.now(),
    );
    return;
  }

  try {
    context.ui.setPendingItem({
      type: MessageType.EXTENSIONS_LIST,
    });

    const extensions = context.services
      .config!.getExtensions()
      .filter((ext) => all || (names || []).includes(ext.name));
    extensions.forEach((extension) => {
      extension.isActive = enabledState;
      context.ui.addItem(
        {
          type: MessageType.INFO,
          text: `Extension ${extension.name} ${enabledState ? 'enabled' : 'disabled'}`,
        },
        Date.now(),
      );
    });
    // Now we need to do all of those things...
    await context.services
      .config!.getGeminiClient()
      ?.refreshConfigAfterExtensionActivationChange();
  } catch (error) {
    context.ui.addItem(
      {
        type: MessageType.ERROR,
        text: getErrorMessage(error),
      },
      Date.now(),
    );
  } finally {
    context.ui.addItem(
      {
        type: MessageType.EXTENSIONS_LIST,
      },
      Date.now(),
    );
    context.ui.setPendingItem(null);
  }
}

function updateAction(context: CommandContext, args: string): Promise<void> {
  const updateArgs = args.split(' ').filter((value) => value.length > 0);
  const all = updateArgs.length === 1 && updateArgs[0] === '--all';
  const names = all ? null : updateArgs;

  if (!all && names?.length === 0) {
    context.ui.addItem(
      {
        type: MessageType.ERROR,
        text: 'Usage: /extensions update <extension-names>|--all',
      },
      Date.now(),
    );
    return Promise.resolve();
  }

  let resolveUpdateComplete: (updateInfo: ExtensionUpdateInfo[]) => void;
  const updateComplete = new Promise<ExtensionUpdateInfo[]>(
    (resolve) => (resolveUpdateComplete = resolve),
  );
  updateComplete.then((updateInfos) => {
    if (updateInfos.length === 0) {
      context.ui.addItem(
        {
          type: MessageType.INFO,
          text: 'No extensions to update.',
        },
        Date.now(),
      );
    }
    context.ui.addItem(
      {
        type: MessageType.EXTENSIONS_LIST,
      },
      Date.now(),
    );
    context.ui.setPendingItem(null);
  });

  try {
    context.ui.setPendingItem({
      type: MessageType.EXTENSIONS_LIST,
    });

    context.ui.dispatchExtensionStateUpdate({
      type: 'SCHEDULE_UPDATE',
      payload: {
        all,
        names,
        onComplete: (updateInfos) => {
          resolveUpdateComplete(updateInfos);
        },
      },
    });
    if (names?.length) {
      const extensions = context.services.config!.getExtensions();
      for (const name of names) {
        const extension = extensions.find(
          (extension) => extension.name === name,
        );
        if (!extension) {
          context.ui.addItem(
            {
              type: MessageType.ERROR,
              text: `Extension ${name} not found.`,
            },
            Date.now(),
          );
          continue;
        }
      }
    }
  } catch (error) {
    resolveUpdateComplete!([]);
    context.ui.addItem(
      {
        type: MessageType.ERROR,
        text: getErrorMessage(error),
      },
      Date.now(),
    );
  }
  return updateComplete.then((_) => {});
}

const listExtensionsCommand: SlashCommand = {
  name: 'list',
  description: 'List active extensions',
  kind: CommandKind.BUILT_IN,
  action: listAction,
};

const enableExtensionsCommand: SlashCommand = {
  name: 'enable',
  description: 'Enable extensions. Usage: enable <extension-names>|--all',
  kind: CommandKind.BUILT_IN,
  action: async (context, args) => {
    await setExtensionEnablement(context, args, true);
  },
};
const disableExtensionsCommand: SlashCommand = {
  name: 'disable',
  description: 'Disable extensions. Usage: disable <extension-names>|--all',
  kind: CommandKind.BUILT_IN,
  action: async (context, args) => {
    await setExtensionEnablement(context, args, false);
  },
};

const updateExtensionsCommand: SlashCommand = {
  name: 'update',
  description: 'Update extensions. Usage: update <extension-names>|--all',
  kind: CommandKind.BUILT_IN,
  action: updateAction,
  completion: async (context, partialArg) => {
    const extensions = context.services.config?.getExtensions() ?? [];
    const extensionNames = extensions.map((ext) => ext.name);
    const suggestions = extensionNames.filter((name) =>
      name.startsWith(partialArg),
    );

    if ('--all'.startsWith(partialArg) || 'all'.startsWith(partialArg)) {
      suggestions.unshift('--all');
    }

    return suggestions;
  },
};

export const extensionsCommand: SlashCommand = {
  name: 'extensions',
  description: 'Manage extensions',
  kind: CommandKind.BUILT_IN,
  subCommands: [
    listExtensionsCommand,
    updateExtensionsCommand,
    enableExtensionsCommand,
    disableExtensionsCommand,
  ],
  action: (context, args) =>
    // Default to list if no subcommand is provided
    listExtensionsCommand.action!(context, args),
};

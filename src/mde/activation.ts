/*!
 * Copyright 2019 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode'
import { ExtContext } from '../shared/extensions'
import { MdeDevfileCodeLensProvider } from './devfileCodeLensProvider'
import { DevfileRegistry, DEVFILE_GLOB_PATTERN } from '../shared/fs/devfileRegistry'
import { mdeConnectCommand, mdeDeleteCommand, tagMde, resumeEnvironments, UPDATE_DEVFILE_COMMAND } from './mdeCommands'
import { MdeInstanceNode } from './mdeInstanceNode'
import { MdeRootNode } from './mdeRootNode'
import { activateUriHandlers } from './mdeUriHandlers'
import { getLogger } from '../shared/logger'
import { GitExtension } from '../shared/extensions/git'
import { createTagMapFromRepo } from './mdeModel'
import { createMdeConfigureWebview } from './vue/configure/backend'
import { MDE_RESTART_KEY } from './constants'
import { initStatusBar } from './mdeStatusBarItem'
import { getMdeEnvArn } from '../shared/vscode/env'
import { createMdeWebview } from './vue/create/backend'

/**
 * Activates MDE functionality.
 */
export async function activate(ctx: ExtContext): Promise<void> {
    registerCommands(ctx)

    const devfileRegistry = new DevfileRegistry()
    devfileRegistry.addWatchPattern(DEVFILE_GLOB_PATTERN)

    const arn = getMdeEnvArn()
    if (arn) {
        const git = GitExtension.instance
        const repos = await git.getRepositories()
        // assume that only 1 repository is open for now
        if (repos.length > 0) {
            // need to pull from the repo (and ignore branch) in order to get a remote url
            repos[0].onDidChangeBranch(async branch => {
                const tags = await createTagMapFromRepo(repos[0])
                await tagMde(arn, tags)
            })
        }
        initStatusBar()
    }

    ctx.extensionContext.subscriptions.push(
        vscode.languages.registerCodeLensProvider(
            {
                language: 'yaml',
                scheme: 'file',
                pattern: DEVFILE_GLOB_PATTERN,
            },
            new MdeDevfileCodeLensProvider(devfileRegistry)
        )
    )

    activateUriHandlers(ctx, ctx.uriHandler)

    // Namespacing the clause context since I believe they are shared across extensions
    vscode.commands.executeCommand('setContext', 'aws.isMde', !!arn)

    handleRestart(ctx, arn)
}

function handleRestart(ctx: ExtContext, arn: string | undefined) {
    if (arn !== undefined) {
        // Remove this environment
        const memento = ctx.extensionContext.globalState
        const pendingRestarts = memento.get<Record<string, boolean>>(MDE_RESTART_KEY, {})
        delete pendingRestarts[arn.split('/').pop() ?? '']
        memento.update(MDE_RESTART_KEY, pendingRestarts)
    } else {
        // Resume environments (if coming from a restart)
        resumeEnvironments(ctx).catch(err => {
            getLogger().error(`Error while resuming environments: ${err}`)
        })
    }
}

function registerCommands(ctx: ExtContext): void {
    ctx.extensionContext.subscriptions.push(
        vscode.commands.registerCommand('aws.mde.connect', async (treenode: MdeInstanceNode) => {
            mdeConnectCommand(treenode.env, treenode.parent.regionCode)
        })
    )
    ctx.extensionContext.subscriptions.push(
        vscode.commands.registerCommand('aws.mde.create', async (treenode?: MdeRootNode) => {
            getLogger().debug('MDE: mdeCreateCommand called on node: %O', treenode)

            try {
                const env = await createMdeWebview(ctx)

                if (!env) {
                    getLogger().error('MDE: user cancelled create environment')
                    return
                }

                await vscode.commands.executeCommand('aws.refreshAwsExplorerNode', treenode)

                // TODO: MDE telemetry
            } catch (e) {
                getLogger().error('MDE: create failed: %O', e)
                // TODO: MDE telemetry
            } finally {
                // TODO: MDE telemetry
            }
        })
    )
    ctx.extensionContext.subscriptions.push(
        vscode.commands.registerCommand('aws.mde.delete', async (treenode: MdeInstanceNode) => {
            if (!treenode) {
                getLogger().warn('aws.mde.delete: got null treenode')
                return
            }
            // TODO: refresh explorer and poll
            mdeDeleteCommand(treenode.env, treenode.parent)
        })
    )
    ctx.extensionContext.subscriptions.push(
        vscode.commands.registerCommand('aws.mde.configure', async (treenode: MdeInstanceNode) => {
            createMdeConfigureWebview(ctx, treenode.env.id)
        })
    )
    // TODO: may be better to pass an explicit variable saying this is the MDE we're connected to
    ctx.extensionContext.subscriptions.push(
        vscode.commands.registerCommand('aws.mde.configure.current', async () => {
            createMdeConfigureWebview(ctx)
        }),
        vscode.commands.registerCommand(UPDATE_DEVFILE_COMMAND[0], UPDATE_DEVFILE_COMMAND[1])
    )
}
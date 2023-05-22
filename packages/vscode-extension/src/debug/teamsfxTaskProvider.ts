// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as vscode from "vscode";

import { ProductName, Stage, ok } from "@microsoft/teamsfx-api";
import { isV3Enabled } from "@microsoft/teamsfx-core";
import { Correlator } from "@microsoft/teamsfx-core/build/common/correlator";
import { ITaskDefinition, TaskCommand } from "@microsoft/teamsfx-core/build/common/local";
import { isValidProjectV3 } from "@microsoft/teamsfx-core/build/common/projectSettingsHelper";

import { TelemetryEvent } from "../telemetry/extTelemetryEvents";
import * as commonUtils from "./commonUtils";
import { localTelemetryReporter } from "./localTelemetryReporter";
import { LifecycleTaskTerminal } from "./taskTerminal/lifecycleTaskTerminal";
import { PrerequisiteTaskTerminal } from "./taskTerminal/prerequisiteTaskTerminal";
import * as globalVariables from "../globalVariables";
import { DevTunnelTaskTerminal } from "./taskTerminal/devTunnelTaskTerminal";
import { LaunchTeamsClientTerminal } from "./taskTerminal/launchTeamsClientTerminal";
import { MigrateTaskTerminal } from "./taskTerminal/migrateTaskTerminal";

const deprecatedTasks = [
  "frontend start",
  "backend start",
  "backend watch",
  "auth start",
  "bot start",
  "bot watch",
  "ngrok start",
  "launch Teams web client",
  TaskCommand.npmInstall,
  TaskCommand.setUpTab,
  TaskCommand.setUpBot,
  TaskCommand.setUpSSO,
  TaskCommand.prepareManifest,
];

const customTasks = Object.freeze({
  [TaskCommand.migrate]: {
    createTerminal: async (d: vscode.TaskDefinition) => new MigrateTaskTerminal(d),
    presentationReveal: vscode.TaskRevealKind.Never,
    presentationEcho: false,
    presentationshowReuseMessage: false,
  },
  [TaskCommand.checkPrerequisites]: {
    createTerminal: async (d: vscode.TaskDefinition) => new PrerequisiteTaskTerminal(d),
    presentationReveal: vscode.TaskRevealKind.Never,
    presentationEcho: false,
    presentationshowReuseMessage: false,
  },
  [TaskCommand.startLocalTunnel]: {
    createTerminal: async (d: vscode.TaskDefinition) => {
      return new DevTunnelTaskTerminal(d);
    },
    presentationReveal: vscode.TaskRevealKind.Silent,
    presentationEcho: true,
    presentationshowReuseMessage: true,
  },
  [TaskCommand.launchWebClient]: {
    createTerminal: async (d: vscode.TaskDefinition) => new LaunchTeamsClientTerminal(d),
    presentationReveal: vscode.TaskRevealKind.Never,
    presentationEcho: false,
    presentationshowReuseMessage: false,
  },
  [TaskCommand.provision]: {
    createTerminal: async (d: vscode.TaskDefinition) =>
      new LifecycleTaskTerminal(d, Stage.provision),
    presentationReveal: vscode.TaskRevealKind.Never,
    presentationEcho: false,
    presentationshowReuseMessage: false,
  },
  [TaskCommand.deploy]: {
    createTerminal: async (d: vscode.TaskDefinition) => new LifecycleTaskTerminal(d, Stage.deploy),
    presentationReveal: vscode.TaskRevealKind.Never,
    presentationEcho: false,
    presentationshowReuseMessage: false,
  },
});

export class TeamsfxTaskProvider implements vscode.TaskProvider {
  public static readonly type: string = ProductName;

  public async provideTasks(
    token?: vscode.CancellationToken | undefined
  ): Promise<vscode.Task[] | undefined> {
    return undefined;
  }

  public async resolveTask(
    task: vscode.Task,
    token?: vscode.CancellationToken | undefined
  ): Promise<vscode.Task | undefined> {
    return Correlator.runWithId(
      commonUtils.getLocalDebugSessionId(),
      async (): Promise<vscode.Task | undefined> => {
        let resolvedTask: vscode.Task | undefined = undefined;
        if (commonUtils.getLocalDebugSessionId() === commonUtils.DebugNoSessionId) {
          resolvedTask = await this._resolveTask(task, token);
        } else {
          // Only send telemetry within a local debug session.
          await localTelemetryReporter.runWithTelemetry(
            TelemetryEvent.DebugTaskProvider,
            async () => {
              resolvedTask = await this._resolveTask(task, token);
              return ok(resolvedTask);
            }
          );
        }
        return resolvedTask;
      }
    );
  }

  private async _resolveTask(
    task: vscode.Task,
    token?: vscode.CancellationToken | undefined
  ): Promise<vscode.Task | undefined> {
    if (task.definition.type !== TeamsfxTaskProvider.type || !task.definition.command) {
      return undefined;
    }

    if (isV3Enabled()) {
      let needsMigration = false;
      if (deprecatedTasks.includes(task.definition.command)) {
        needsMigration = true;
      } else if (
        task.definition.command === TaskCommand.checkPrerequisites &&
        !isValidProjectV3(globalVariables.workspaceUri!.fsPath)
      ) {
        needsMigration = true;
      }
      if (needsMigration) {
        // migrate to v3
        const newTask = new vscode.Task(
          task.definition,
          vscode.TaskScope.Workspace,
          TaskCommand.migrate,
          TeamsfxTaskProvider.type,
          new vscode.CustomExecution(customTasks[TaskCommand.migrate].createTerminal)
        );
        newTask.presentationOptions.reveal = customTasks[TaskCommand.migrate].presentationReveal;
        newTask.presentationOptions.echo = customTasks[TaskCommand.migrate].presentationEcho;
        newTask.presentationOptions.showReuseMessage =
          customTasks[TaskCommand.migrate].presentationshowReuseMessage;
        return newTask;
      }
    }

    const customTask = Object.entries(customTasks).find(
      ([k]) => k === task.definition.command
    )?.[1];
    if (!customTask) {
      return undefined;
    }

    const newTask = new vscode.Task(
      task.definition,
      vscode.TaskScope.Workspace,
      task.name,
      TeamsfxTaskProvider.type,
      new vscode.CustomExecution(customTask.createTerminal)
    );

    newTask.presentationOptions.reveal = customTask.presentationReveal;
    newTask.presentationOptions.echo = customTask.presentationEcho;
    newTask.presentationOptions.showReuseMessage = customTask.presentationshowReuseMessage;
    return newTask;
  }
}

export async function createTask(
  taskDefinition: ITaskDefinition,
  workspaceFolder: vscode.WorkspaceFolder,
  env?: { [key: string]: string } | undefined,
  definition?: vscode.TaskDefinition,
  problemMatchers?: string | string[],
  isSilent?: boolean
): Promise<vscode.Task> {
  definition = definition || {
    type: TeamsfxTaskProvider.type,
    command: taskDefinition.name,
  };

  const options: vscode.ShellExecutionOptions = {
    cwd: taskDefinition.cwd,
    env: env ?? taskDefinition.env,
    // avoid powershell execution policy issue
    executable: taskDefinition.execOptions.needCmd ? "cmd.exe" : undefined,
    shellArgs: taskDefinition.execOptions.needCmd ? ["/c"] : undefined,
  };

  const execution = taskDefinition.execOptions.needShell
    ? new vscode.ShellExecution(taskDefinition.command, options)
    : new vscode.ProcessExecution(taskDefinition.command, taskDefinition.args ?? [], options);

  const task = new vscode.Task(
    definition,
    workspaceFolder,
    taskDefinition.name,
    TeamsfxTaskProvider.type,
    execution,
    problemMatchers
  );
  task.isBackground = taskDefinition.isBackground;
  if (isSilent) {
    task.presentationOptions.reveal = vscode.TaskRevealKind.Silent;
  }
  return task;
}

// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.
"use strict";

import {
  err,
  FxError,
  Inputs,
  InputsWithProjectPath,
  Json,
  ok,
  Platform,
  Result,
  v2,
  v3,
  Void,
  VsCodeEnv,
} from "@microsoft/teamsfx-api";
import { ProjectSettingsHelper } from "../../../../common/local/projectSettingsHelper";
import { TelemetryEventName, TelemetryUtils } from "./util/telemetry";
import {
  InvalidLocalBotEndpointFormat,
  LocalBotEndpointNotConfigured,
  SetupLocalDebugSettingsError,
  NgrokTunnelNotConnected,
  ConfigLocalDebugSettingsError,
} from "./error";
import { getCodespaceName, getCodespaceUrl } from "./util/codespace";
import { getNgrokHttpUrl } from "./util/ngrok";
import {
  EnvKeysBackend,
  EnvKeysBot,
  EnvKeysFrontend,
  LocalEnvProvider,
} from "../../../../common/local/localEnvProvider";
import { prepareLocalAuthService } from "./util/localService";
import { getAllowedAppIds } from "../../../../common/tools";
import { LocalCertificateManager } from "../../../../common/local/localCertificateManager";
import { BotHostTypes } from "../../../../common/local/constants";
import {
  configLocalEnvironmentCommon,
  LocalEnvConfig,
  setupLocalEnvironmentCommon,
} from "../../../../component/debug";

export async function setupLocalDebugSettings(
  ctx: v2.Context,
  inputs: Inputs,
  localSettings: Json
): Promise<Result<Void, FxError>> {
  const vscEnv = inputs.vscodeEnv;
  const includeFrontend = ProjectSettingsHelper.includeFrontend(ctx.projectSetting);
  const includeBackend = ProjectSettingsHelper.includeBackend(ctx.projectSetting);
  const includeBot = ProjectSettingsHelper.includeBot(ctx.projectSetting);
  const includeAAD = ProjectSettingsHelper.includeAAD(ctx.projectSetting);
  const includeSimpleAuth = ProjectSettingsHelper.includeSimpleAuth(ctx.projectSetting);
  const skipNgrok = inputs.checkerInfo?.skipNgrok as boolean;
  const includeFuncHostedBot = ProjectSettingsHelper.includeFuncHostedBot(ctx.projectSetting);
  const botCapabilities = ProjectSettingsHelper.getBotCapabilities(ctx.projectSetting);

  const telemetryProperties = {
    platform: inputs.platform as string,
    vscenv: vscEnv as string,
    frontend: includeFrontend ? "true" : "false",
    function: includeBackend ? "true" : "false",
    bot: includeBot ? "true" : "false",
    auth: includeAAD && includeSimpleAuth ? "true" : "false",
    "skip-ngrok": skipNgrok ? "true" : "false",
    "bot-host-type": includeFuncHostedBot ? BotHostTypes.AzureFunctions : BotHostTypes.AppService,
    "bot-capabilities": JSON.stringify(botCapabilities),
  };
  TelemetryUtils.init(ctx.telemetryReporter);
  TelemetryUtils.sendStartEvent(TelemetryEventName.setupLocalDebugSettings, telemetryProperties);

  try {
    // setup configs used by other plugins
    // TODO: dynamicly determine local ports
    if (inputs.platform === Platform.VSCode || inputs.platform === Platform.CLI) {
      const frontendPort = 53000;
      const authPort = 55000;
      let localTabEndpoint: string;
      let localTabDomain: string;
      let localAuthEndpoint: string;
      let localFuncEndpoint: string;

      if (vscEnv === VsCodeEnv.codespaceBrowser || vscEnv === VsCodeEnv.codespaceVsCode) {
        const codespaceName = await getCodespaceName();

        localTabEndpoint = getCodespaceUrl(codespaceName, frontendPort);
        localTabDomain = new URL(localTabEndpoint).host;
        localAuthEndpoint = getCodespaceUrl(codespaceName, authPort);
        localFuncEndpoint = getCodespaceUrl(codespaceName, 7071);
      } else {
        localTabDomain = "localhost";
        localTabEndpoint = `https://localhost:${frontendPort}`;
        localAuthEndpoint = `http://localhost:${authPort}`;
        localFuncEndpoint = "http://localhost:7071";
      }

      if (includeAAD) {
        if (!localSettings.auth) {
          localSettings.auth = {};
        }

        if (includeSimpleAuth) {
          localSettings.auth.AuthServiceEndpoint = localAuthEndpoint;
        }
      }

      if (includeFrontend) {
        if (!localSettings.frontend) {
          localSettings.frontend = {};
        }
        localSettings.frontend.tabEndpoint = localTabEndpoint;
        localSettings.frontend.tabDomain = localTabDomain;
      }

      if (includeBackend) {
        if (!localSettings.backend) {
          localSettings.backend = {};
        }
        localSettings.backend.functionEndpoint = localFuncEndpoint;
      }

      if (includeBot) {
        if (!localSettings.bot) {
          localSettings.bot = {};
        }

        if (skipNgrok) {
          const localBotEndpoint = localSettings.bot.botEndpoint as string;
          if (localBotEndpoint === undefined) {
            const error = LocalBotEndpointNotConfigured();
            TelemetryUtils.sendErrorEvent(TelemetryEventName.setupLocalDebugSettings, error);
            return err(error);
          }

          const botEndpointRegex = /https:\/\/.*(:\d+)?/g;
          if (!botEndpointRegex.test(localBotEndpoint)) {
            const error = InvalidLocalBotEndpointFormat(localBotEndpoint);
            TelemetryUtils.sendErrorEvent(TelemetryEventName.setupLocalDebugSettings, error);
            return err(error);
          }

          localSettings.bot.botEndpoint = localBotEndpoint;
          localSettings.bot.botDomain = localBotEndpoint.slice(8);
        } else {
          const ngrokHttpUrl = await getNgrokHttpUrl(3978);
          if (!ngrokHttpUrl) {
            const error = NgrokTunnelNotConnected();
            TelemetryUtils.sendErrorEvent(TelemetryEventName.setupLocalDebugSettings, error);
            return err(error);
          } else {
            localSettings.bot.botEndpoint = ngrokHttpUrl;
            localSettings.bot.botDomain = ngrokHttpUrl.slice(8);
          }
        }
      }
    } else if (inputs.platform === Platform.VS) {
      if (includeFrontend) {
        localSettings.frontend ??= {};
        localSettings.frontend.tabEndpoint = "https://localhost:44302";
        localSettings.frontend.tabDomain = "localhost";
      }

      if (includeBot) {
        localSettings.bot ??= {};
        const ngrokHttpUrl = await getNgrokHttpUrl(5130);
        if (!ngrokHttpUrl) {
          const error = NgrokTunnelNotConnected();
          TelemetryUtils.sendErrorEvent(TelemetryEventName.setupLocalDebugSettings, error);
          return err(error);
        }
        localSettings.bot.botEndpoint = ngrokHttpUrl;
        localSettings.bot.botDomain = ngrokHttpUrl.slice(8);
      }
    }
  } catch (error: any) {
    const systemError = SetupLocalDebugSettingsError(error);
    TelemetryUtils.sendErrorEvent(TelemetryEventName.setupLocalDebugSettings, systemError);
    return err(systemError);
  }
  TelemetryUtils.sendSuccessEvent(TelemetryEventName.setupLocalDebugSettings, telemetryProperties);
  return ok(Void);
}

export async function setupLocalEnvironment(
  ctx: v2.Context,
  inputs: Inputs,
  envInfo: v2.EnvInfoV2
): Promise<Result<Void, FxError>> {
  const vscEnv = inputs.vscodeEnv;
  const includeFrontend = ProjectSettingsHelper.includeFrontend(ctx.projectSetting);
  const includeBackend = ProjectSettingsHelper.includeBackend(ctx.projectSetting);
  const includeBot = ProjectSettingsHelper.includeBot(ctx.projectSetting);
  const includeAAD = ProjectSettingsHelper.includeAAD(ctx.projectSetting);
  const includeSimpleAuth = ProjectSettingsHelper.includeSimpleAuth(ctx.projectSetting);
  const includeFuncHostedBot = ProjectSettingsHelper.includeFuncHostedBot(ctx.projectSetting);
  const botCapabilities = ProjectSettingsHelper.getBotCapabilities(ctx.projectSetting);

  const config: LocalEnvConfig = {
    hasAzureTab: includeFrontend,
    hasApi: includeBackend,
    hasBot: includeBot,
    hasAAD: includeAAD,
    hasSimpleAuth: includeSimpleAuth,
    hasFunctionBot: includeFuncHostedBot,
    botCapabilities: botCapabilities,
    defaultFunctionName: ctx.projectSetting.defaultFunctionName!,
    programmingLanguage: ctx.projectSetting.programmingLanguage || "",
    isM365: ctx.projectSetting.isM365,
    skipNgrok: inputs.checkerInfo?.skipNgrok as boolean,
    vscodeEnv: vscEnv,
    trustDevCert: inputs.checkerInfo?.trustDevCert as boolean | undefined,
  };
  const res = await setupLocalEnvironmentCommon(
    inputs as InputsWithProjectPath,
    config,
    envInfo as v3.EnvInfoV3
  );
  if (res.isErr()) {
    return err(res.error);
  }
  return ok(Void);
}

export async function configLocalDebugSettings(
  ctx: v2.Context,
  inputs: Inputs,
  localSettings: Json
): Promise<Result<Void, FxError>> {
  const includeFrontend = ProjectSettingsHelper.includeFrontend(ctx.projectSetting);
  const includeBackend = ProjectSettingsHelper.includeBackend(ctx.projectSetting);
  const includeBot = ProjectSettingsHelper.includeBot(ctx.projectSetting);
  const includeAAD = ProjectSettingsHelper.includeAAD(ctx.projectSetting);
  const includeSimpleAuth = ProjectSettingsHelper.includeSimpleAuth(ctx.projectSetting);
  const includeFuncHostedBot = ProjectSettingsHelper.includeFuncHostedBot(ctx.projectSetting);
  const botCapabilities = ProjectSettingsHelper.getBotCapabilities(ctx.projectSetting);
  let trustDevCert = inputs.checkerInfo?.trustDevCert as boolean | undefined;

  const telemetryProperties = {
    platform: inputs.platform as string,
    frontend: includeFrontend ? "true" : "false",
    function: includeBackend ? "true" : "false",
    bot: includeBot ? "true" : "false",
    auth: includeAAD && includeSimpleAuth ? "true" : "false",
    "trust-development-certificate": trustDevCert + "",
    "bot-host-type": includeFuncHostedBot ? BotHostTypes.AzureFunctions : BotHostTypes.AppService,
    "bot-capabilities": JSON.stringify(botCapabilities),
  };
  TelemetryUtils.init(ctx.telemetryReporter);
  TelemetryUtils.sendStartEvent(TelemetryEventName.configLocalDebugSettings, telemetryProperties);

  try {
    if (inputs.platform === Platform.VSCode || inputs.platform === Platform.CLI) {
      const localEnvProvider = new LocalEnvProvider(inputs.projectPath!);
      const frontendEnvs = includeFrontend
        ? await localEnvProvider.loadFrontendLocalEnvs(includeBackend, includeAAD)
        : undefined;
      const backendEnvs = includeBackend
        ? await localEnvProvider.loadBackendLocalEnvs()
        : undefined;
      const botEnvs = includeBot ? await localEnvProvider.loadBotLocalEnvs() : undefined;

      // get config for local debug
      const clientId = localSettings?.auth?.clientId as string;
      const clientSecret = localSettings?.auth?.clientSecret as string;
      const applicationIdUri = localSettings?.auth?.applicationIdUris as string;
      const teamsAppTenantId = localSettings?.teamsApp?.tenantId as string;
      const localAuthEndpoint = localSettings?.auth?.AuthServiceEndpoint as string;
      const localTabEndpoint = localSettings?.frontend?.tabEndpoint as string;
      const localFuncEndpoint = localSettings?.backend?.functionEndpoint as string;

      const localAuthPackagePath = localSettings?.auth?.simpleAuthFilePath as string;

      if (includeFrontend) {
        frontendEnvs!.teamsfxLocalEnvs[EnvKeysFrontend.Port] = "53000";

        if (includeAAD) {
          frontendEnvs!.teamsfxLocalEnvs[
            EnvKeysFrontend.LoginUrl
          ] = `${localTabEndpoint}/auth-start.html`;
          frontendEnvs!.teamsfxLocalEnvs[EnvKeysFrontend.ClientId] = clientId;
        }

        if (includeSimpleAuth) {
          frontendEnvs!.teamsfxLocalEnvs[EnvKeysFrontend.TeamsFxEndpoint] = localAuthEndpoint;
          await prepareLocalAuthService(localAuthPackagePath);
        }

        if (includeBackend) {
          frontendEnvs!.teamsfxLocalEnvs[EnvKeysFrontend.FuncEndpoint] = localFuncEndpoint;
          frontendEnvs!.teamsfxLocalEnvs[EnvKeysFrontend.FuncName] = ctx.projectSetting
            .defaultFunctionName as string;

          backendEnvs!.teamsfxLocalEnvs[EnvKeysBackend.FuncWorkerRuntime] = "node";
          backendEnvs!.teamsfxLocalEnvs[EnvKeysBackend.ClientId] = clientId;
          backendEnvs!.teamsfxLocalEnvs[EnvKeysBackend.ClientSecret] = clientSecret;
          backendEnvs!.teamsfxLocalEnvs[EnvKeysBackend.AuthorityHost] =
            "https://login.microsoftonline.com";
          backendEnvs!.teamsfxLocalEnvs[EnvKeysBackend.TenantId] = teamsAppTenantId;
          backendEnvs!.teamsfxLocalEnvs[EnvKeysBackend.ApiEndpoint] = localFuncEndpoint;
          backendEnvs!.teamsfxLocalEnvs[EnvKeysBackend.ApplicationIdUri] = applicationIdUri;
          backendEnvs!.teamsfxLocalEnvs[EnvKeysBackend.AllowedAppIds] =
            getAllowedAppIds().join(";");
        }

        // setup local certificate
        try {
          if (trustDevCert === undefined) {
            trustDevCert = true;
          }

          const certManager = new LocalCertificateManager(ctx.userInteraction, ctx.logProvider);

          const localCert = await certManager.setupCertificate(trustDevCert);
          if (localCert) {
            localSettings.frontend.sslCertFile = localCert.certPath;
            localSettings.frontend.sslKeyFile = localCert.keyPath;
            frontendEnvs!.teamsfxLocalEnvs[EnvKeysFrontend.SslCrtFile] = localCert.certPath;
            frontendEnvs!.teamsfxLocalEnvs[EnvKeysFrontend.SslKeyFile] = localCert.keyPath;
          }
        } catch (error) {
          // do not break if cert error
        }
      }

      if (includeBot) {
        const botId = localSettings?.bot?.botId as string;
        const botPassword = localSettings?.bot?.botPassword as string;
        botEnvs!.teamsfxLocalEnvs[EnvKeysBot.BotId] = botId;
        botEnvs!.teamsfxLocalEnvs[EnvKeysBot.BotPassword] = botPassword;

        if (includeAAD) {
          botEnvs!.teamsfxLocalEnvs[EnvKeysBot.ClientId] = clientId;
          botEnvs!.teamsfxLocalEnvs[EnvKeysBot.ClientSecret] = clientSecret;
          botEnvs!.teamsfxLocalEnvs[EnvKeysBot.TenantID] = teamsAppTenantId;
          botEnvs!.teamsfxLocalEnvs[EnvKeysBot.OauthAuthority] =
            "https://login.microsoftonline.com";
          botEnvs!.teamsfxLocalEnvs[EnvKeysBot.LoginEndpoint] = `${
            localSettings?.bot?.botEndpoint as string
          }/auth-start.html`;
          botEnvs!.teamsfxLocalEnvs[EnvKeysBot.ApplicationIdUri] = applicationIdUri;
        }

        if (includeBackend) {
          backendEnvs!.teamsfxLocalEnvs[EnvKeysBackend.ApiEndpoint] = localFuncEndpoint;
          botEnvs!.teamsfxLocalEnvs[EnvKeysBot.ApiEndpoint] = localFuncEndpoint;
        }
      }

      // save .env.teamsfx.local
      await localEnvProvider.saveLocalEnvs(frontendEnvs, backendEnvs, botEnvs);
    }
  } catch (error: any) {
    const systemError = ConfigLocalDebugSettingsError(error);
    TelemetryUtils.sendErrorEvent(TelemetryEventName.configLocalDebugSettings, systemError);
    return err(systemError);
  }
  TelemetryUtils.sendSuccessEvent(TelemetryEventName.configLocalDebugSettings, telemetryProperties);
  return ok(Void);
}

export async function configLocalEnvironment(
  ctx: v2.Context,
  inputs: Inputs,
  envInfo: v2.EnvInfoV2
): Promise<Result<Void, FxError>> {
  const includeFrontend = ProjectSettingsHelper.includeFrontend(ctx.projectSetting);
  const includeBackend = ProjectSettingsHelper.includeBackend(ctx.projectSetting);
  const includeBot = ProjectSettingsHelper.includeBot(ctx.projectSetting);
  const includeAAD = ProjectSettingsHelper.includeAAD(ctx.projectSetting);
  const includeSimpleAuth = ProjectSettingsHelper.includeSimpleAuth(ctx.projectSetting);
  const includeFuncHostedBot = ProjectSettingsHelper.includeFuncHostedBot(ctx.projectSetting);
  const botCapabilities = ProjectSettingsHelper.getBotCapabilities(ctx.projectSetting);
  const config: LocalEnvConfig = {
    hasAzureTab: includeFrontend,
    hasApi: includeBackend,
    hasBot: includeBot,
    hasAAD: includeAAD,
    hasSimpleAuth: includeSimpleAuth,
    hasFunctionBot: includeFuncHostedBot,
    botCapabilities: botCapabilities,
    defaultFunctionName: ctx.projectSetting.defaultFunctionName!,
    programmingLanguage: ctx.projectSetting.programmingLanguage || "",
    isM365: ctx.projectSetting.isM365,
    skipNgrok: inputs.checkerInfo?.skipNgrok as boolean,
    trustDevCert: inputs.checkerInfo?.trustDevCert as boolean | undefined,
  };
  const res = await configLocalEnvironmentCommon(
    inputs as InputsWithProjectPath,
    config,
    envInfo as v3.EnvInfoV3
  );
  if (res.isErr()) {
    return err(res.error);
  }
  return ok(Void);
}
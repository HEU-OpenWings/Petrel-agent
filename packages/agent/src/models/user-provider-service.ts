import type {
  Api,
  AssistantMessage,
  AuthContext,
  Context,
  Model,
  Models,
  ModelsSimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { env } from "@petrel/config";
import {
  createPreferencesRepository,
  createProviderCredentialRepository,
  type Database,
  deleteProviderCredentialAndNormalizeDefaultModel,
  type ProviderCredentialMetadataRow,
  ProviderCredentialRevisionConflictError,
} from "@petrel/database";
import {
  createDbCredentialStore,
  normalizeProviderApiKey,
  ProviderCredentialStoreError,
  withProviderCredentialMutex,
} from "./db-credential-store.ts";
import {
  findModelFor,
  models as globalModels,
  listConfiguredModelsFor,
  listProviderModelsFor,
  listProviderStatusesFor,
  type ModelSummary,
  type ProviderModelsResponse,
  type ProviderStatus,
} from "./index.ts";
import type { ProviderCredentialCipher } from "./provider-credential-crypto.ts";
import { PROVIDER_CREDENTIAL_HINTS } from "./providers.ts";
import { createUserModels, getProviderCredentialCipher } from "./user-models.ts";

const PROBE_TIMEOUT_MS = 10_000;
const PROBE_MAX_TOKENS = 8;
const LOCAL_PROVIDER_IDS = new Set(["ollama", "vllm"]);

export interface ProviderCapabilities {
  storedCredentialsEnabled: boolean;
  credentialManagementEnabled: boolean;
}

export type PersonalCredentialState = "stored" | "not_stored" | "unknown" | "disabled";

export interface PersonalCredentialStatus {
  status: PersonalCredentialState;
  keyHint: string | null;
  updatedAt: string | null;
}

export type RuntimeCredentialSource = "personal" | "ambient" | "none" | "unknown";

export interface UserProviderStatus extends ProviderStatus {
  personalCredential: PersonalCredentialStatus;
  runtimeCredentialSource: RuntimeCredentialSource;
}

export interface UserProviderListResponse {
  defaultProviderId: string;
  defaultModelId: string;
  capabilities: ProviderCapabilities;
  providers: UserProviderStatus[];
}

export interface StoredCredentialResponse {
  providerId: string;
  credential: {
    status: "stored";
    keyHint: string;
    updatedAt: string;
  };
}

export interface DeletedCredentialResponse {
  providerId: string;
  credential: {
    status: "not_stored";
    keyHint: null;
    updatedAt: null;
  };
  defaultModelReset: boolean;
}

export type ProviderCredentialTestSource = "candidate" | "personal" | "ambient";

export interface ProviderCredentialTestResponse {
  ok: true;
  providerId: string;
  modelId: string;
  source: ProviderCredentialTestSource;
}

export type UserProviderServiceErrorKind =
  | "provider_not_found"
  | "management_disabled"
  | "invalid_api_key"
  | "credential_conflict"
  | "credential_not_configured"
  | "credential_rejected"
  | "credential_store_unavailable"
  | "credential_test_timeout"
  | "credential_test_failed"
  | "local_service_unavailable";

/** 固定安全分类；不得把 provider/DB/crypto 原始错误挂到 cause 或 message。 */
export class UserProviderServiceError extends Error {
  constructor(
    public readonly kind: UserProviderServiceErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "UserProviderServiceError";
  }
}

type ProbeExecutor = (
  registry: Models,
  model: Model<Api>,
  context: Context,
  options: ModelsSimpleStreamOptions,
) => Promise<AssistantMessage>;

export interface CreateUserProviderServiceOptions {
  capabilities?: ProviderCapabilities;
  /** 测试注入；生产默认使用 R0 global Models（ambient/env only）。 */
  ambientModels?: Models;
  /** 测试注入；生产按 userId 构造 DB-backed Models。 */
  userModels?: Models;
  cipher?: ProviderCredentialCipher;
  authContext?: AuthContext;
  probeTimeoutMs?: number;
  probeExecutor?: ProbeExecutor;
}

function metadataToStatus(meta: ProviderCredentialMetadataRow): PersonalCredentialStatus {
  return {
    status: "stored",
    keyHint: meta.keyHint,
    updatedAt: meta.updatedAt.toISOString(),
  };
}

function emptyPersonalCredential(status: "not_stored" | "unknown" | "disabled"): PersonalCredentialStatus {
  return { status, keyHint: null, updatedAt: null };
}

function runtimeSource(
  configured: boolean | null,
  personal: PersonalCredentialStatus,
  capabilities: ProviderCapabilities,
): RuntimeCredentialSource {
  if (configured === null) return "unknown";

  // runtime kill switch 关闭时，个人行即使已经预灌也绝不会用于对话。
  if (!capabilities.storedCredentialsEnabled) {
    return configured ? "ambient" : "none";
  }

  if (personal.status === "unknown") return "unknown";
  if (personal.status === "stored") return configured ? "personal" : "unknown";
  return configured ? "ambient" : "none";
}

function mapStoreError(error: ProviderCredentialStoreError): UserProviderServiceError {
  if (error.kind === "not_api_key" || error.kind === "env_not_supported") {
    return new UserProviderServiceError("invalid_api_key", error.message);
  }
  if (error.kind === "conflict") {
    return new UserProviderServiceError("credential_conflict", "凭据并发更新冲突，请重试");
  }
  return new UserProviderServiceError("credential_store_unavailable", "凭据存储暂时不可用");
}

function safeProbeFailure(providerId: string): UserProviderServiceError {
  if (LOCAL_PROVIDER_IDS.has(providerId)) {
    return new UserProviderServiceError("local_service_unavailable", "本地服务或连接测试模型不可用");
  }
  return new UserProviderServiceError("credential_test_failed", "连接测试失败，请稍后重试");
}

export function createUserProviderService(
  db: Database,
  userId: string,
  options: CreateUserProviderServiceOptions = {},
) {
  const capabilities = options.capabilities ?? {
    storedCredentialsEnabled: env.providerCredentials.storedEnabled,
    credentialManagementEnabled: env.providerCredentials.managementEnabled,
  };
  const ambientModels = options.ambientModels ?? globalModels;
  const featuresEnabled = capabilities.storedCredentialsEnabled || capabilities.credentialManagementEnabled;

  let cipher = options.cipher;
  function requireCipher(): ProviderCredentialCipher {
    if (!cipher) cipher = getProviderCredentialCipher();
    return cipher;
  }

  const userModels =
    options.userModels ??
    (featuresEnabled
      ? createUserModels(db, userId, {
          cipher: requireCipher(),
          ...(options.authContext ? { authContext: options.authContext } : {}),
        })
      : undefined);
  const runtimeModels = capabilities.storedCredentialsEnabled ? (userModels as Models) : ambientModels;
  const credentialRepo = createProviderCredentialRepository(db);
  const preferencesRepo = createPreferencesRepository(db);
  const probeExecutor: ProbeExecutor =
    options.probeExecutor ??
    ((registry, model, context, probeOptions) => registry.completeSimple(model, context, probeOptions));
  const probeTimeoutMs = options.probeTimeoutMs ?? PROBE_TIMEOUT_MS;

  function assertProvider(providerId: string): void {
    if (!ambientModels.getProvider(providerId)) {
      throw new UserProviderServiceError("provider_not_found", "模型服务不存在");
    }
  }

  function assertManagementEnabled(): void {
    if (!capabilities.credentialManagementEnabled) {
      throw new UserProviderServiceError("management_disabled", "凭据管理功能未启用");
    }
  }

  function requireUserModels(): Models {
    if (!userModels) {
      throw new UserProviderServiceError("credential_store_unavailable", "凭据存储暂时不可用");
    }
    return userModels;
  }

  async function listPersonalCredentials(): Promise<
    | { kind: "disabled" }
    | { kind: "ready"; metadata: Map<string, ProviderCredentialMetadataRow> }
    | { kind: "unknown" }
  > {
    if (!featuresEnabled) return { kind: "disabled" };
    try {
      const metadata = await credentialRepo.listMetadataByUser(userId);
      return { kind: "ready", metadata: new Map(metadata.map((item) => [item.providerId, item])) };
    } catch {
      return { kind: "unknown" };
    }
  }

  async function listProviders(): Promise<UserProviderListResponse> {
    const [base, personal] = await Promise.all([
      listProviderStatusesFor(runtimeModels),
      listPersonalCredentials(),
    ]);

    return {
      defaultProviderId: base.defaultProviderId,
      defaultModelId: base.defaultModelId,
      capabilities,
      providers: base.providers.map((provider): UserProviderStatus => {
        let personalCredential: PersonalCredentialStatus;
        if (personal.kind === "disabled") {
          personalCredential = emptyPersonalCredential("disabled");
        } else if (personal.kind === "unknown") {
          personalCredential = emptyPersonalCredential("unknown");
        } else {
          const meta = personal.metadata.get(provider.id);
          personalCredential = meta ? metadataToStatus(meta) : emptyPersonalCredential("not_stored");
        }
        return {
          ...provider,
          personalCredential,
          runtimeCredentialSource: runtimeSource(provider.configured, personalCredential, capabilities),
        };
      }),
    };
  }

  async function listProviderModels(providerId: string): Promise<ProviderModelsResponse | undefined> {
    return listProviderModelsFor(runtimeModels, providerId);
  }

  async function listConfiguredModels(): Promise<ModelSummary[]> {
    return listConfiguredModelsFor(runtimeModels);
  }

  async function saveCredential(providerId: string, apiKey: string): Promise<StoredCredentialResponse> {
    assertManagementEnabled();
    assertProvider(providerId);

    const store = createDbCredentialStore(db, userId, requireCipher());
    try {
      await store.modify(providerId, async () => ({ type: "api_key", key: apiKey }));
      const metadata = await credentialRepo.findMetadataByUserAndProvider(userId, providerId);
      if (!metadata) {
        throw new UserProviderServiceError("credential_store_unavailable", "凭据保存后状态暂时无法读取");
      }
      return {
        providerId,
        credential: {
          status: "stored",
          keyHint: metadata.keyHint,
          updatedAt: metadata.updatedAt.toISOString(),
        },
      };
    } catch (error) {
      if (error instanceof UserProviderServiceError) throw error;
      if (error instanceof ProviderCredentialStoreError) throw mapStoreError(error);
      throw new UserProviderServiceError("credential_store_unavailable", "凭据保存暂时不可用");
    }
  }

  async function ambientKeepsModelAvailable(providerId: string, modelId: string): Promise<boolean> {
    try {
      const auth = await ambientModels.checkAuth(providerId);
      if (!auth) return false;
      const available = await ambientModels.getAvailable(providerId);
      return available.some((model) => model.id === modelId);
    } catch {
      // 删除后的可用性未知时采用安全回退：允许条件清空默认模型，避免下一轮直接失败。
      return false;
    }
  }

  async function deleteCredentialAndNormalizeDefaultModel(
    providerId: string,
  ): Promise<DeletedCredentialResponse> {
    assertManagementEnabled();
    assertProvider(providerId);

    try {
      const result = await withProviderCredentialMutex(userId, providerId, async () => {
        let expectedDefaultModel: string | undefined;
        if (capabilities.storedCredentialsEnabled) {
          let preferences: Awaited<ReturnType<typeof preferencesRepo.findByUserId>>;
          try {
            preferences = await preferencesRepo.findByUserId(userId);
          } catch {
            throw new UserProviderServiceError("credential_store_unavailable", "用户偏好暂时无法读取");
          }
          if (preferences.defaultModel) {
            const selected = findModelFor(runtimeModels, preferences.defaultModel);
            if (
              selected?.provider === providerId &&
              !(await ambientKeepsModelAvailable(providerId, selected.id))
            ) {
              expectedDefaultModel = preferences.defaultModel;
            }
          }
        }

        return deleteProviderCredentialAndNormalizeDefaultModel(db, {
          userId,
          providerId,
          ...(expectedDefaultModel !== undefined ? { expectedDefaultModel } : {}),
        });
      });
      return {
        providerId,
        credential: { status: "not_stored", keyHint: null, updatedAt: null },
        defaultModelReset: result.defaultModelReset,
      };
    } catch (error) {
      if (error instanceof UserProviderServiceError) throw error;
      if (error instanceof ProviderCredentialRevisionConflictError) {
        throw new UserProviderServiceError("credential_conflict", "凭据并发更新冲突，请重试");
      }
      throw new UserProviderServiceError("credential_store_unavailable", "凭据删除暂时不可用");
    }
  }

  async function testCredential(
    providerId: string,
    input: { apiKey?: string } = {},
  ): Promise<ProviderCredentialTestResponse> {
    assertManagementEnabled();
    assertProvider(providerId);

    const hasCandidate = Object.hasOwn(input, "apiKey");
    let source: ProviderCredentialTestSource;
    let candidateKey: string | undefined;
    const probeModels = requireUserModels();

    if (hasCandidate) {
      source = "candidate";
      try {
        candidateKey = normalizeProviderApiKey(input.apiKey);
      } catch (error) {
        if (error instanceof ProviderCredentialStoreError) throw mapStoreError(error);
        throw new UserProviderServiceError("invalid_api_key", "API key 格式不合法");
      }
    } else {
      let metadata: ProviderCredentialMetadataRow | undefined;
      try {
        metadata = await credentialRepo.findMetadataByUserAndProvider(userId, providerId);
      } catch {
        throw new UserProviderServiceError("credential_store_unavailable", "凭据读取暂时不可用");
      }
      source = metadata ? "personal" : "ambient";
      try {
        if (!(await probeModels.checkAuth(providerId))) {
          throw new UserProviderServiceError("credential_not_configured", "没有可用于连接测试的凭据");
        }
      } catch (error) {
        if (error instanceof UserProviderServiceError) throw error;
        throw new UserProviderServiceError("credential_store_unavailable", "凭据读取暂时不可用");
      }
    }

    const hint = PROVIDER_CREDENTIAL_HINTS.get(providerId);
    const model = hint ? probeModels.getModel(providerId, hint.probeModelId) : undefined;
    if (!hint || !model) {
      throw new UserProviderServiceError("credential_test_failed", "连接测试模型未配置");
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), probeTimeoutMs);
    let responseStatus: number | undefined;
    try {
      const message = await probeExecutor(
        probeModels,
        model,
        {
          systemPrompt: "This is a credential connectivity check.",
          messages: [{ role: "user", content: "Reply OK.", timestamp: Date.now() }],
        },
        {
          ...(candidateKey !== undefined ? { apiKey: candidateKey } : {}),
          maxTokens: PROBE_MAX_TOKENS,
          maxRetries: 0,
          maxRetryDelayMs: 0,
          timeoutMs: probeTimeoutMs,
          signal: controller.signal,
          onResponse(response) {
            responseStatus = response.status;
          },
        },
      );

      if (responseStatus === 401 || responseStatus === 403) {
        throw new UserProviderServiceError("credential_rejected", "API key 被模型服务拒绝");
      }
      if (
        message.stopReason === "error" ||
        message.stopReason === "aborted" ||
        message.stopReason === "pending"
      ) {
        throw safeProbeFailure(providerId);
      }
      return { ok: true, providerId, modelId: model.id, source };
    } catch (error) {
      if (error instanceof UserProviderServiceError) throw error;
      if (controller.signal.aborted) {
        throw new UserProviderServiceError("credential_test_timeout", "连接测试超时");
      }
      if (responseStatus === 401 || responseStatus === 403) {
        throw new UserProviderServiceError("credential_rejected", "API key 被模型服务拒绝");
      }
      throw safeProbeFailure(providerId);
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    capabilities,
    listProviders,
    listProviderModels,
    listConfiguredModels,
    saveCredential,
    deleteCredentialAndNormalizeDefaultModel,
    testCredential,
  };
}

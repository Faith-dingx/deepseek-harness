/** Host HTTP bridge for browser-client RPC. */
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-credentials'
// Activates the webServer Context merge used below.
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { API_PATH } from './api-path.ts'
import { CONNECT_PATH } from './connect-protocol.ts'
import { bridge, DEFAULT_MAX_REQUEST_BODY_BYTES } from './http-bridge.ts'
import { assertTrustedAuthority, isTrustedApiRequest } from './api-request-trust.ts'
import { BrowserAuth } from './browser-auth.ts'
import { HostConnectionService } from './rpc-host.ts'
import { ConnectionRecoveryConfigSchema, resolveConnectionConfig, type ConnectionRecoveryConfig } from './recovery-config.ts'

export type {
  PeerAdmission,
  ConnectionAdmission,
  ConnectionFetchMethod,
  ConnectionFetchHandler,
  ConnectionFetchRoute,
  ConnectionIndexRequest,
  ConnectionIndexResponse,
  ConnectionRpcEndpointMatcher,
  ConnectionRpcAttachment,
  ConnectionRpcFailure,
  ConnectionRpcHandler,
  ConnectionRpcHandlerResult,
  ConnectionRequestRejection,
  ConnectionRpcResult,
  ConnectionRequestBodyMode,
  ConnectionTrustRequest,
  ClientRequest,
  HostConnectionHandle,
  HostConnectionFetch,
  HostConnectionRpc,
  RpcMessage,
  ServerResponse,
} from './rpc.ts'
export type { PeerId, PeerScope, Principal, RemoteInvocation } from '@deepseek-ai/dsh-typert-protocol'
export { RpcId, transportError } from './rpc.ts'
export { Peer } from './peer.ts'
export type { PeerOptions } from './peer.ts'
export { CONNECT_PATH, type ConnectionInteractions } from './connect-protocol.ts'
export {
  clientRequestSchema,
  rpcErrorSchema,
  rpcIdSchema,
  rpcMessageSchema,
  rpcResultSchema,
  serverResponseSchema,
} from './rpc-schema.ts'
export { HostConnectionService } from './rpc-host.ts'

export { API_PATH } from './api-path.ts'

/** Stable Cordis plugin name. */
export const name = 'client-connection'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Admit or wrap an authenticated shared API request, including body transfer.
     * Existing requests continue when a listener refuses subsequent requests.
     * @param request - Authenticated incoming HTTP request.
     * @param response - Response owned until the delegated bridge settles.
     * @param next - Delegate to the next listener or the shared API bridge.
     * @mode waterfall
     */
    'connection/request'(request: IncomingMessage, response: ServerResponse, next: () => Promise<void>): Promise<void>
  }
}

/** Headroom for RPC JSON fields around aggregate base64 image payloads. */
const REQUEST_ENVELOPE_HEADROOM_BYTES = 1024 * 1024

function assertImageBodyCapacity(ctx: Context, maxRequestBodyBytes: number): void {
  const attachments = ctx.get('attachments')
  if (attachments === undefined) return
  const requiredImageBodyBytes = Math.ceil(
    attachments.imageLimits.maxMessageImageBytes * 4 / 3,
  ) + REQUEST_ENVELOPE_HEADROOM_BYTES
  if (maxRequestBodyBytes < requiredImageBodyBytes) {
    throw new Error(
      `client-connection maxRequestBodyBytes (${String(maxRequestBodyBytes)}) must be at least `
      + `${String(requiredImageBodyBytes)} for the configured aggregate image limit`,
    )
  }
}

/** Services required before providing Connection. */
export const inject = ['credentials']

/** Browser authentication, request limits, and connection recovery configuration. */
export interface ConnectionConfig {
  /** Browser recovery timing, injected into each served page. */
  recovery?: ConnectionRecoveryConfig
  /**
   * Authorities this deployment serves beyond loopback: exact `host:port`, or
   * port-less `host` matching any port. The fence accepts loopback and the
   * listener's own bind IP independently; other remote authorities require
   * an entry here. A non-canonical or non-bare authority fails plugin load.
   */
  trustedHosts?: string[]
  /** Absolute browser and API cookie lifetime in days. Default: 30. */
  cookieMaxAgeDays?: number
  /** Maximum buffered JSON body for every `/api` request. Default: 300 MiB. */
  maxRequestBodyBytes?: number
}

export const Config: z<ConnectionConfig> = z.object({
  recovery: ConnectionRecoveryConfigSchema.default({}),
  trustedHosts: z.array(String).default([]),
  cookieMaxAgeDays: z.natural().min(1).default(30),
  maxRequestBodyBytes: z.natural().min(1).default(DEFAULT_MAX_REQUEST_BODY_BYTES),
})

/**
 * Methods gated to loopback by default; a deployment that expressly lists
 * non-loopback authorities in `trustedHosts` opens them to those clients.
 * Endpoint strings are the live wire form `<namespace>/<method>` — the same
 * slash form the gateway dispatches (client `endpointOf` builds
 * `${namespace}/${method}`). Any other spelling can never match and silently
 * de-fences the method, as the 0.1.5 drift proved twice: the wire switched
 * from the apiProxy-era dot form, and `settings.openDocument` renamed to
 * `settings.openSettingsDocument`.
 *
 * The pinned plane is configuration, host desktop/filesystem, deployment
 * introspection, and live-runtime management: the settings and credential
 * domains mutate the user's configuration and secret store, and READING them
 * is equally privileged — `settings/describe` returns every exposed
 * namespace's configuration and `credentials/describe` reports whether an
 * arbitrary environment-variable name is configured and where from, which is
 * reconnaissance no anonymous caller should have. Native dialogs, document
 * openers, and the directory picker act on the host machine or reveal host
 * paths. `pluginInventory/list` and `dynamicCordisRunner/inventory` read the
 * deployment's plugin roster and preset compositions; the dynamic runner
 * additionally starts, stops, and invokes plugin host halves — an arbitrary
 * method-invocation primitive that must not bypass this fence. Reading the
 * preset roster (`agentPresets/read`) is reconnaissance for the same reason.
 * `trustedHosts` is a DNS-rebinding fence, explicitly not authentication, so
 * the whole plane stays loopback-same-origin by default until a real
 * authentication layer exists. `llm/discoverModels` belongs to that plane on
 * both counts: it carries a draft credential, and it makes the HOST issue a
 * GET to a URL the caller chose and reports back the status or the parsed
 * body — an anonymous LAN caller would have a probe for whatever the host can
 * reach and the browser cannot.
 *
 * Deliberately NOT here: the interaction plane a LAN client's GUI legitimately
 * needs — session chat/queue control, workspace roster edits, file uploads,
 * subagent/goal/feedback/commands calls, `agentPresets/list` and
 * `agentPresets/select` (choosing a preset is not pinned; `session/create`
 * already takes an `agentPreset`, and any caller that may start a session at
 * all can already run commands as this process, so pinning the switch would be
 * a fence beside an open gate), and the dynamic runner's client-glue methods
 * (`getClientCode`, `resolveRequestRun`, `settleUserRun`, `resolveInspectQuery`,
 * `reportRenderFailure`, `reportClientGuardFailure`) that ship authored code
 * and relay panel interaction. The model catalog (`llm/providers`,
 * `llm/models`, `llm/listProviders`, `llm/listConfigurableProviders`) carries
 * provider ids, display names, and model lists — no endpoints, keys, or key
 * state — and a LAN client's model picker legitimately needs it.
 */
const PRIVILEGED_METHODS = new Set([
  // Settings and credentials: redacted reads and every write of the user's
  // configuration and secret store.
  'settings/describe',
  'settings/canOpenAgentPresetDirectory',
  'settings/openSettingsDocument',
  'settings/openAgentPresetDirectory',
  'settings/update',
  'settings/replace',
  'settings/mutate',
  'credentials/describe',
  'credentials/set',
  'credentials/unset',
  // Host desktop and filesystem: native dialogs, document openers, and the
  // directory picker (list/create touch the host filesystem directly).
  'directoryPicker/pick',
  'directoryPicker/list',
  'directoryPicker/createDirectory',
  'session/canOpenWorkspacePath',
  'session/openWorkspacePath',
  // Preset roster: read/copy/remove rearrange or reveal what the deployment
  // offers. list and select stay open — see the choice reasoning above.
  'agentPresets/read',
  'agentPresets/copy',
  'agentPresets/deletePreset',
  'llm/discoverModels',
  // Deployment introspection and live-runtime management.
  'pluginInventory/list',
  'dynamicCordisRunner/inventory',
  'dynamicCordisRunner/invoke',
  'dynamicCordisRunner/runHostHalf',
  'dynamicCordisRunner/syncInspectManifest',
  'dynamicCordisRunner/undefineFromPanel',
  'dynamicCordisRunner/stopFromPanel',
])

/**
 * Provides carrier-neutral RPC and Fetch registries. When `webServer` is
 * present, the plugin also mounts the `/api` browser transport with Host/Origin
 * checks, persistent browser authentication, and a privileged-method fence:
 * methods in `PRIVILEGED_METHODS` additionally pass the `trustedHosts` fence,
 * so they stay loopback-same-origin by default and open to explicitly trusted
 * non-loopback authorities on a LAN deployment.
 * @param ctx - Host plugin context.
 * @param config - resolved plugin config (schema defaults applied).
 */
export async function apply(ctx: Context, config?: ConnectionConfig): Promise<void> {
  const recovery = resolveConnectionConfig(config?.recovery)
  // The Loader resolves schema defaults; hand-built test contexts may pass none.
  const trustedHosts = config?.trustedHosts ?? []
  const cookieMaxAgeDays = config?.cookieMaxAgeDays ?? 30
  const maxRequestBodyBytes = config?.maxRequestBodyBytes ?? DEFAULT_MAX_REQUEST_BODY_BYTES
  // Config boundary: a malformed entry fails the load loudly here rather than
  // silently authorizing its hostname prefix at request time.
  for (const entry of trustedHosts) assertTrustedAuthority(entry)
  assertImageBodyCapacity(ctx, maxRequestBodyBytes)
  const connection = new HostConnectionService(
    ctx,
    trustedHosts,
    await BrowserAuth.create(ctx.root, ctx.credentials, cookieMaxAgeDays),
  )
  ctx.inject(['webServer'], (webCtx) => {
    assertImageBodyCapacity(webCtx, maxRequestBodyBytes)
    webCtx.on('webserver/index-inject', (table) => {
      table.push({ kind: 'global', name: '__DSH_CONNECTION_RECOVERY__', value: recovery })
    })
    const fetchHandler = connection.createSharedFetchHandler(API_PATH)
    const route: WebRoute = {
      kind: 'prefix',
      path: API_PATH,
      handler: async (req, res) => {
        const admission = connection.admit(req)
        if ('rejection' in admission) {
          res.writeHead(admission.rejection)
          res.end(admission.rejection === 401 ? 'unauthorized' : 'forbidden')
          return
        }
        // Privileged-method fence: loopback-same-origin by default, open to
        // explicitly trusted non-loopback authorities via `trustedHosts`.
        const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
        const method = pathname.startsWith(`${API_PATH}/`)
          ? pathname.slice(API_PATH.length + 1)
          : undefined
        if (method !== undefined && PRIVILEGED_METHODS.has(method) && !isTrustedApiRequest(req, trustedHosts)) {
          res.writeHead(403)
          res.end('forbidden')
          return
        }
        await webCtx.waterfall('connection/request', req, res, () => bridge(req, res, fetchHandler, admission.peer, maxRequestBodyBytes))
      },
    }
    webCtx.effect(() => webCtx.webServer.register(route), 'client-connection: /api route')
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact', path: CONNECT_PATH,
      handler: (req, res) => { connection.authorizeConnect(req, res) },
    }), 'client-connection: /connect route')
  })
  ctx.inject(['attachments'], (attachmentCtx) => {
    assertImageBodyCapacity(attachmentCtx, maxRequestBodyBytes)
  })
}

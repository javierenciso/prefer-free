import type { Plugin } from "@opencode-ai/plugin"
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs"
import { join } from "path"

// ── Persistent state ──────────────────────────────────────────
const STATE_PATH = join(
  process.env.HOME || process.env.USERPROFILE || "~",
  ".config/opencode/.prefer-free-state.json",
)

type State = {
  enabled: boolean
  pickIndex: Record<string, number> // source model → last candidate index used
  failover?: boolean // mid-session failover on rate-limit / hang (default true)
}

function readState(): State {
  try {
    if (!existsSync(STATE_PATH)) return { enabled: true, pickIndex: {}, failover: true }
    return JSON.parse(readFileSync(STATE_PATH, "utf8"))
  } catch {
    return { enabled: true, pickIndex: {}, failover: true }
  }
}

function writeState(state: State) {
  try {
    mkdirSync(join(process.env.HOME || "~", ".config/opencode"), { recursive: true })
    writeFileSync(STATE_PATH, JSON.stringify(state, null, 2))
  } catch {}
}

// ── Logging (auto-evict at 100MB) ─────────────────────────────
const LOG_PATH = join(
  process.env.HOME || process.env.USERPROFILE || "~",
  ".config/opencode/.prefer-free-log",
)
const LOG_MAX_BYTES = 100 * 1024 * 1024

function logSwap(from: string, to: string) {
  try {
    const line = `[${new Date().toISOString()}] ${from} → ${to}\n`
    const dir = join(process.env.HOME || "~", ".config/opencode")
    mkdirSync(dir, { recursive: true })
    // Truncate if over limit
    if (existsSync(LOG_PATH) && readFileSync(LOG_PATH).length > LOG_MAX_BYTES) {
      const tail = readFileSync(LOG_PATH, "utf8").split("\n").slice(-100).join("\n") + "\n"
      writeFileSync(LOG_PATH, tail)
    }
    writeFileSync(LOG_PATH, line, { flag: "a" })
  } catch {}
}

function readLog(): string {
  try {
    if (existsSync(LOG_PATH)) return readFileSync(LOG_PATH, "utf8")
    return ""
  } catch {
    return ""
  }
}

// ── Catalog cache (TTL 6h, stale-while-revalidate) ────────────
// Live lists of free models per source, refreshed in background.
type Catalog = {
  fetchedAt: number
  nim: string[]          // NVIDIA NIM model ids (without "nvidia/" prefix)
  openrouter: string[]   // OpenRouter :free model ids
  zen: string[]          // OpenCode Zen free model ids (with "opencode/" prefix)
}

const CATALOG_PATH = join(
  process.env.HOME || process.env.USERPROFILE || "~",
  ".config/opencode/.prefer-free-catalog.json",
)
const CATALOG_TTL_MS = 6 * 60 * 60 * 1000 // 6h

// ── Failover / watchdog ───────────────────────────────────────
// When a free model rate-limits, errors, or silently hangs mid-session, fail
// over to the NEXT free candidate in the same FREE_EQUIVALENTS chain — same
// task, similar free model — instead of leaving the session stuck.
const SILENT_STUCK_MS = 180_000        // busy + no activity this long → considered hung
const RETRY_ATTEMPTS_THRESHOLD = 3     // session.status "retry" attempts before failing over
const FAILOVER_COOLDOWN_MS = 60_000    // min gap between failovers on the same session
const WATCHDOG_INTERVAL_MS = 30_000    // how often the hang watchdog sweeps sessions

function readCatalog(): Catalog | null {
  try {
    if (!existsSync(CATALOG_PATH)) return null
    return JSON.parse(readFileSync(CATALOG_PATH, "utf8"))
  } catch {
    return null
  }
}

function writeCatalog(cat: Catalog) {
  try {
    writeFileSync(CATALOG_PATH, JSON.stringify(cat, null, 2))
  } catch {}
}

async function fetchNimModels(apiKey: string): Promise<string[]> {
  try {
    const res = await fetch("https://integrate.api.nvidia.com/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) return []
    const { data } = (await res.json()) as { data: Array<{ id: string }> }
    return data.map((m) => m.id).sort()
  } catch {
    return []
  }
}

async function fetchZenFreeModels(): Promise<string[]> {
  try {
    const res = await fetch("https://models.dev/api.json", {
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) return []
    const d = (await res.json()) as Record<string, any>
    const zen = d.opencode?.models ?? {}
    return Object.entries(zen)
      .filter(([, m]: any) => m?.cost?.input === 0 && m?.cost?.output === 0)
      .map(([id]) => `opencode/${id}`)
      .sort()
  } catch {
    return []
  }
}

async function refreshCatalog(): Promise<Catalog> {
  const [nim, or, zen] = await Promise.all([
    process.env.NVIDIA_API_KEY
      ? fetchNimModels(process.env.NVIDIA_API_KEY)
      : Promise.resolve([] as string[]),
    fetchOpenRouterFree().then((s) => [...s].sort()),
    fetchZenFreeModels(),
  ])
  const cat: Catalog = { fetchedAt: Date.now(), nim, openrouter: or, zen }

  // Diff vs previous: log added/removed per source so user notices new models / EOLs
  const prev = readCatalog()
  if (prev) {
    for (const k of ["nim", "openrouter", "zen"] as const) {
      const before = new Set(prev[k] ?? [])
      const after = new Set(cat[k] ?? [])
      const added = [...after].filter((x) => !before.has(x))
      const removed = [...before].filter((x) => !after.has(x))
      if (added.length || removed.length) {
        logSwap(
          `catalog:${k}`,
          `+${added.length}/-${removed.length}` +
            (added.length ? ` new=[${added.slice(0, 5).join(",")}${added.length > 5 ? ",..." : ""}]` : "") +
            (removed.length ? ` gone=[${removed.slice(0, 5).join(",")}${removed.length > 5 ? ",..." : ""}]` : ""),
        )
      }
    }
  }

  writeCatalog(cat)
  return cat
}

// ── Model mapping ──────────────────────────────────────────────
// opencode-go model → free equivalents (ordered by preference)
// NIM serves several IDENTICAL models to opencode-go free with rate limits — so
// the top candidate is usually "literally the same model on NIM".
const FREE_EQUIVALENTS: Record<string, string[]> = {
  "opencode-go/deepseek-v4-flash": [
    "nvidia/deepseek-ai/deepseek-v4-flash",
    "nvidia/qwen/qwen3-coder-480b-a35b-instruct",
    "opencode/deepseek-v4-flash-free",
    "opencode/mimo-v2.5-free",
    "nvidia/meta/llama-3.3-70b-instruct",
    "opencode/nemotron-3-super-free",
  ],
  "opencode-go/qwen3.5-plus": [
    "nvidia/qwen/qwen3.5-122b-a10b",
    "nvidia/qwen/qwen3.5-397b-a17b",
    "nvidia/qwen/qwen3-coder-480b-a35b-instruct",
    "opencode/deepseek-v4-flash-free",
    "opencode/mimo-v2.5-free",
    "nvidia/meta/llama-3.3-70b-instruct",
  ],
  "opencode-go/kimi-k2.6": [
    "nvidia/moonshotai/kimi-k2.6",
    "nvidia/qwen/qwen3-coder-480b-a35b-instruct",
    "nvidia/deepseek-ai/deepseek-v4-flash",
    "opencode/mimo-v2.5-free",
    "opencode/deepseek-v4-flash-free",
    "nvidia/meta/llama-3.3-70b-instruct",
  ],
  "opencode-go/deepseek-v4-pro": [
    "nvidia/deepseek-ai/deepseek-v4-pro",
    "nvidia/nvidia/llama-3.1-nemotron-ultra-253b-v1",
    "nvidia/nvidia/nemotron-3-super-120b-a12b",
    "nvidia/nvidia/llama-3.3-nemotron-super-49b-v1.5",
    "opencode/nemotron-3-super-free",
    "nvidia/meta/llama-3.3-70b-instruct",
  ],
}

// OpenRouter alternatives — only used if the openrouter provider is configured
const OPENROUTER_EQUIVALENTS: Record<string, string[]> = {
  "opencode-go/deepseek-v4-flash": [
    "deepseek/deepseek-v4-flash:free",
  ],
  "opencode-go/qwen3.5-plus": [
    "qwen/qwen3-coder:free",
  ],
  "opencode-go/kimi-k2.6": [
    "moonshotai/kimi-k2.6:free",
  ],
  "opencode-go/deepseek-v4-pro": [
    "nvidia/nemotron-3-super-120b-a12b:free",
  ],
}

// ── Known free models (always available, no provider config needed) ──
// OpenCode Zen free models (built-in, always available)
const ZEN_FREE = new Set([
  "opencode/deepseek-v4-flash-free",
  "opencode/mimo-v2.5-free",
  "opencode/nemotron-3-super-free",
  "opencode/big-pickle",
])

// ── Free detection ─────────────────────────────────────────────
async function fetchOpenRouterFree(): Promise<Set<string>> {
  try {
    const res = await fetch("https://openrouter.ai/api/v1/models", {
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) return new Set()
    const { data } = (await res.json()) as {
      data: Array<{
        id: string
        pricing?: { prompt?: string; completion?: string }
      }>
    }
    return new Set(
      data
        .filter(
          (m) =>
            m.pricing?.prompt === "0" &&
            m.pricing?.completion === "0",
        )
        .map((m) => m.id),
    )
  } catch {
    return new Set()
  }
}

// ── Failover state & helpers ──────────────────────────────────
// Reverse index: free candidate string → which chain it belongs to and at what
// position, so given the model a stuck session is running we can pick the NEXT
// free candidate in the same chain ("similar free model, continue the task").
const CANDIDATE_CHAIN: Record<string, { source: string; index: number }> = {}
for (const [source, cands] of Object.entries(FREE_EQUIVALENTS)) {
  cands.forEach((c, index) => {
    if (!(c in CANDIDATE_CHAIN)) CANDIDATE_CHAIN[c] = { source, index }
  })
}

// Per-session runtime: activity timestamp + busy flag (for the hang watchdog) +
// cooldown + in-flight guard (so we never fire two failovers at once).
type SessionRt = { lastActivity: number; busy: boolean; cooldownUntil: number; failingOver: boolean }
const sessionRt = new Map<string, SessionRt>()
function rt(id: string): SessionRt {
  let s = sessionRt.get(id)
  if (!s) {
    s = { lastActivity: Date.now(), busy: false, cooldownUntil: 0, failingOver: false }
    sessionRt.set(id, s)
  }
  return s
}

// Computed once per session in the config hook; read by the event/watchdog hooks
// which don't receive config. Persists for the plugin's lifetime in-process.
let cachedAllFree = new Set<string>()
let watchdogStarted = false

// Build the union of currently-free model ids from a catalog + provider config.
function computeAllFree(catalog: Catalog, providerConfig: any): { allFree: Set<string>; nvidiaCount: number } {
  const allFree = new Set<string>([
    ...catalog.openrouter,
    ...(catalog.zen.length ? catalog.zen : ZEN_FREE),
  ])
  let nvidiaCount = 0
  if (process.env.NVIDIA_API_KEY && providerConfig?.nvidia) {
    for (const id of catalog.nim) {
      allFree.add(`nvidia/${id}`)
      nvidiaCount++
    }
  }
  for (const [, pConfig] of Object.entries(providerConfig ?? {})) {
    for (const [modelId, model] of Object.entries((pConfig as any).models ?? {})) {
      const name = (model as any).name ?? modelId
      if (
        /(^|[-_:/\s])free($|[-_:\s])/i.test(name) ||
        /(^|[-_:/\s])free($|[-_:\s])/i.test(modelId)
      ) {
        allFree.add(modelId)
      }
    }
  }
  return { allFree, nvidiaCount }
}

// Next free candidate after `current` in its chain. null = not a model we manage
// OR the chain is exhausted (caller distinguishes via isManagedModel).
function nextFreeCandidate(current: string, allFree: Set<string>): string | null {
  let source: string | undefined
  let startIdx = 0
  if (CANDIDATE_CHAIN[current]) {
    source = CANDIDATE_CHAIN[current].source
    startIdx = CANDIDATE_CHAIN[current].index + 1
  } else if (FREE_EQUIVALENTS[current]) {
    source = current // still on the original opencode-go model — start at the top
    startIdx = 0
  } else {
    return null
  }
  const cands = FREE_EQUIVALENTS[source] ?? []
  for (let i = startIdx; i < cands.length; i++) {
    if (allFree.has(cands[i])) return cands[i]
  }
  return null
}

function isManagedModel(current: string): boolean {
  return current in CANDIDATE_CHAIN || current in FREE_EQUIVALENTS
}

// Rebuild prompt-input parts from a stored user message's parts (drop synthetic
// / non-resendable bits).
function partsToInput(parts: any[]): any[] {
  const out: any[] = []
  for (const p of parts ?? []) {
    if (p?.type === "text" && p.text && !p.synthetic) {
      out.push({ type: "text", text: p.text })
    } else if (p?.type === "file" && p.url) {
      out.push({ type: "file", mime: p.mime, url: p.url, filename: p.filename })
    }
  }
  return out
}

function shortName(model: string): string {
  const segs = model.split("/")
  return segs.slice(Math.max(0, segs.length - 2)).join("/")
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ── Plugin ─────────────────────────────────────────────────────
export const PreferFree: Plugin = async ({ client }) => {
  // Fail a stuck/rate-limited session over to the next free candidate in the
  // same chain: abort → revert to last user turn → re-prompt with a new model.
  const failover = async (sessionID: string, reason: string) => {
    const s = rt(sessionID)
    const now = Date.now()
    if (s.failingOver || now < s.cooldownUntil) return
    s.failingOver = true
    s.cooldownUntil = now + FAILOVER_COOLDOWN_MS // claim window up front (dedupe)
    try {
      const res: any = await client.session.messages({ path: { id: sessionID } })
      const msgs: any[] = res?.data ?? (Array.isArray(res) ? res : [])
      let lastUser: any = null
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i]?.info?.role === "user") { lastUser = msgs[i]; break }
      }
      if (!lastUser?.info?.model) return
      const current = `${lastUser.info.model.providerID}/${lastUser.info.model.modelID}`
      if (!isManagedModel(current)) return // not a prefer-free model — don't touch

      const next = nextFreeCandidate(current, cachedAllFree)
      if (!next) {
        // Chain exhausted: per config, stay free and notify rather than pay.
        await client.tui
          .showToast({
            body: {
              title: "prefer-free",
              message: `Se acabaron los modelos free para ${shortName(current)} — sesión en pausa, elegí un modelo a mano`,
              variant: "warning",
              duration: 9000,
            },
          })
          .catch(() => {})
        logSwap(`failover-exhausted:${current} (${reason})`, "(no free left)")
        client.app.log({
          service: "prefer-free",
          level: "warn",
          message: `failover exhausted for ${current} (${reason})`,
        })
        return
      }

      const parts = partsToInput(lastUser.parts)
      if (!parts.length) return

      // Abort the stuck turn, roll back the partial attempt, re-send the task.
      // Delays mirror the proven rate-limit-fallback plugin (avoid races).
      await client.session.abort({ path: { id: sessionID } }).catch(() => {})
      await sleep(200)
      await client.session
        .revert({ path: { id: sessionID }, body: { messageID: lastUser.info.id } })
        .catch(() => {})
      await sleep(500)

      const slash = next.indexOf("/")
      const providerID = next.slice(0, slash)
      const modelID = next.slice(slash + 1)
      await client.session.prompt({
        path: { id: sessionID },
        body: {
          model: { providerID, modelID },
          agent: lastUser.info.agent,
          parts,
        },
      })

      s.lastActivity = Date.now()
      s.cooldownUntil = Date.now() + FAILOVER_COOLDOWN_MS
      logSwap(`failover:${current} (${reason})`, next)
      client.app.log({
        service: "prefer-free",
        level: "info",
        message: `FAILOVER ${current} → ${next} (${reason})`,
      })
      await client.tui
        .showToast({
          body: {
            title: "prefer-free",
            message: `${reason}: ${shortName(current)} → ${shortName(next)}`,
            variant: "info",
            duration: 6000,
          },
        })
        .catch(() => {})
    } catch (e: any) {
      client.app.log({
        service: "prefer-free",
        level: "error",
        message: `failover error on ${sessionID}: ${e?.message ?? e}`,
      })
    } finally {
      s.failingOver = false
    }
  }

  // Watchdog: catches the SILENT hang (model stops producing, emits no error/
  // event). Sweeps busy sessions and fails over any with no activity for too long.
  const startWatchdog = () => {
    if (watchdogStarted) return
    watchdogStarted = true
    const h = setInterval(() => {
      try {
        const st = readState()
        if (!st.enabled || st.failover === false) return
        const now = Date.now()
        for (const [sid, s] of sessionRt) {
          if (
            s.busy &&
            !s.failingOver &&
            now - s.lastActivity > SILENT_STUCK_MS &&
            now >= s.cooldownUntil
          ) {
            failover(sid, "cuelgue silencioso (sin actividad 180s)").catch(() => {})
          }
        }
      } catch {}
    }, WATCHDOG_INTERVAL_MS)
    ;(h as any)?.unref?.() // don't keep the process alive on our account
  }

  return {
    // Detect stuck/rate-limited sessions and track activity for the watchdog.
    event: async ({ event }) => {
      try {
        const st = readState()
        if (!st.enabled || st.failover === false) return

        const type = (event as any)?.type as string
        const props: any = (event as any)?.properties ?? {}
        const sid: string | undefined =
          props.sessionID ?? props.part?.sessionID ?? props.info?.sessionID

        // Streaming output / message updates = the model is alive → reset timer.
        if (type === "message.part.updated" || type === "message.updated") {
          if (sid) rt(sid).lastActivity = Date.now()
          return
        }

        if (type === "session.deleted") {
          const id = props.info?.id
          if (id) sessionRt.delete(id)
          return
        }

        if (type === "session.idle") {
          if (sid) rt(sid).busy = false
          return
        }

        if (type === "session.status") {
          if (!sid) return
          const s = rt(sid)
          s.lastActivity = Date.now()
          const status = props.status
          if (status?.type === "busy") {
            s.busy = true
          } else if (status?.type === "idle") {
            s.busy = false
          } else if (status?.type === "retry") {
            // OpenCode is auto-retrying (rate-limit/transient). Let it try a few
            // times; if it keeps failing, the free tier is wedged → fail over.
            s.busy = true
            if ((status.attempt ?? 0) >= RETRY_ATTEMPTS_THRESHOLD) {
              await failover(sid, `rate-limit (retry ${status.attempt})`)
            }
          }
          return
        }

        if (type === "session.error") {
          if (!sid) return
          const err = props.error
          const code = err?.data?.statusCode
          const msg = err?.data?.message ?? ""
          const isRateLimit =
            code === 429 ||
            /rate.?limit|quota|too many|overload|capacity/i.test(msg) ||
            (err?.name === "APIError" && err?.data?.isRetryable)
          if (isRateLimit) {
            await failover(sid, code === 429 ? "rate-limit (429)" : "error del modelo")
          }
          return
        }
      } catch {}
    },

    // A running tool (build/test/etc.) counts as activity — don't let the hang
    // watchdog mistake a long-but-healthy tool call for a silent model hang.
    "tool.execute.before": async (input) => {
      if (input?.sessionID) rt(input.sessionID).lastActivity = Date.now()
    },
    "tool.execute.after": async (input) => {
      if (input?.sessionID) rt(input.sessionID).lastActivity = Date.now()
    },

    "command.execute.before": async (input, output) => {
      if (input.command !== "prefer-free") return

      const arg = input.arguments.trim().toLowerCase()
      const state = readState()

      if (arg === "on") {
        writeState({ ...readState(), enabled: true })
        output.parts = [{
          type: "text",
          text: "✅ PreferFree ON — se usarán modelos free cuando sea posible",
        }]
        return
      }

      if (arg === "off") {
        writeState({ ...readState(), enabled: false })
        output.parts = [{
          type: "text",
          text: "❌ PreferFree OFF — se usarán los modelos originales (opencode-go)",
        }]
        return
      }

      if (arg === "failover on") {
        writeState({ ...readState(), failover: true })
        output.parts = [{
          type: "text",
          text: "🔁 Failover ON — si un modelo free se tranca (rate-limit/cuelgue) reintenta la task con el siguiente free de la cadena",
        }]
        return
      }

      if (arg === "failover off") {
        writeState({ ...readState(), failover: false })
        output.parts = [{
          type: "text",
          text: "⏹️  Failover OFF — no se reintenta automáticamente; si un free se tranca queda como está",
        }]
        return
      }

      if (arg === "failover") {
        output.parts = [{
          type: "text",
          text: `Failover está ${state.failover === false ? "⏹️ OFF" : "🔁 ON"}\n  /prefer-free failover on|off`,
        }]
        return
      }

      if (arg === "log") {
        const log = readLog()
        output.parts = [{
          type: "text",
          text: log
            ? log.split("\n").filter(Boolean).slice(-30).join("\n")
            : "(sin swaps registrados aún)",
        }]
        return
      }

      if (arg === "clear") {
        try { writeFileSync(LOG_PATH, "") } catch {}
        output.parts = [{
          type: "text",
          text: "🧹 Log limpiado",
        }]
        return
      }

      if (arg === "refresh") {
        const cat = await refreshCatalog()
        output.parts = [{
          type: "text",
          text: [
            `🔄 Catalog refresheado ${new Date(cat.fetchedAt).toISOString()}`,
            `  NIM:        ${cat.nim.length} modelos${process.env.NVIDIA_API_KEY ? "" : " (NVIDIA_API_KEY no seteada — no se usan)"}`,
            `  OpenRouter: ${cat.openrouter.length} :free`,
            `  Zen:        ${cat.zen.length} free`,
            ``,
            `Diff vs anterior queda en /prefer-free log`,
          ].join("\n"),
        }]
        return
      }

      if (arg === "catalog") {
        const cat = readCatalog()
        if (!cat) {
          output.parts = [{
            type: "text",
            text: "(sin catalog cacheado — corré /prefer-free refresh)",
          }]
          return
        }
        const ageH = Math.round(((Date.now() - cat.fetchedAt) / 36e5) * 10) / 10
        const lines = [
          `Catalog (age ${ageH}h, TTL ${CATALOG_TTL_MS / 36e5}h)`,
          ``,
          `NIM (${cat.nim.length}):`,
          ...cat.nim.slice(0, 40).map((m) => `  nvidia/${m}`),
          cat.nim.length > 40 ? `  ... +${cat.nim.length - 40}` : "",
          ``,
          `OpenRouter :free (${cat.openrouter.length}):`,
          ...cat.openrouter.slice(0, 20).map((m) => `  ${m}`),
          cat.openrouter.length > 20 ? `  ... +${cat.openrouter.length - 20}` : "",
          ``,
          `Zen (${cat.zen.length}):`,
          ...cat.zen.map((m) => `  ${m}`),
        ].filter(Boolean)
        output.parts = [{ type: "text", text: lines.join("\n") }]
        return
      }

      if (arg === "help" || arg === "") {
        output.parts = [{
          type: "text",
          text: [
            `PreferFree está ${state.enabled ? "✅ ON" : "❌ OFF"} · Failover ${state.failover === false ? "⏹️ OFF" : "🔁 ON"}`,
            "",
            "Comandos:",
            "  /prefer-free            → estado actual",
            "  /prefer-free help       → esta ayuda",
            "  /prefer-free on         → activar swap a modelos free",
            "  /prefer-free off        → desactivar (usa opencode-go)",
            "  /prefer-free failover on/off → reintento automático ante rate-limit/cuelgue",
            "  /prefer-free log        → últimos 30 swaps/failovers + diffs de catalog",
            "  /prefer-free clear      → limpiar log",
            "  /prefer-free refresh    → forzar refetch del catálogo NIM/OR/Zen",
            "  /prefer-free catalog    → ver catálogo cacheado + edad",
            "",
            "¿Cómo funciona?",
            "  En cada session start, swappea opencode-go/X por el mismo modelo en",
            "  NVIDIA NIM (free tier) si está disponible. Fallback: Qwen3 Coder 480B,",
            "  zen free models, Llama 3.3 70B.",
            "  Catalog (NIM + OpenRouter :free + Zen) se cachea 6h, refresh en bg.",
            "",
            "Failover (mid-session):",
            "  Si el free se tranca por rate-limit/429, error o cuelgue silencioso",
            "  (180s sin actividad), aborta, vuelve al último prompt y reintenta la",
            "  task con el SIGUIENTE free de la misma cadena. Si se acaban los free,",
            "  avisa por toast y deja la sesión (nunca cae al modelo pago).",
            "",
            "NVIDIA NIM: requiere export NVIDIA_API_KEY=nvapi-...",
          ].join("\n"),
        }]
        return
      }

      output.parts = [{
        type: "text",
        text: `PreferFree está ${state.enabled ? "✅ ON" : "❌ OFF"}\n/prefer-free help  → ayuda completa`,
      }]
    },

    config: async (config) => {
      if (!readState().enabled) return

      // Load catalog. Stale-while-revalidate: use cached lists for THIS session,
      // fire background refresh if older than TTL. First-ever run blocks on a
      // single fetch so we have something to work with.
      let catalog = readCatalog()
      if (!catalog) {
        catalog = await refreshCatalog()
      } else if (Date.now() - catalog.fetchedAt > CATALOG_TTL_MS) {
        refreshCatalog().catch(() => {})
      }

      // Union of free model ids from all sources (Zen falls back to the hardcoded
      // set if the catalog fetch failed, e.g. offline). NIM is only treated as
      // free when the provider is declared AND NVIDIA_API_KEY is set, else 401.
      const { allFree, nvidiaCount } = computeAllFree(catalog, config.provider ?? {})

      // Cache for the event/watchdog hooks (no config there) and arm the watchdog.
      cachedAllFree = allFree
      startWatchdog()

      const ageH = Math.round(((Date.now() - catalog.fetchedAt) / 36e5) * 10) / 10
      client.app.log({
        service: "prefer-free",
        level: "info",
        message: `free=${allFree.size} (NIM ${nvidiaCount} · OR ${catalog.openrouter.length} · Zen ${catalog.zen.length || ZEN_FREE.size}) cat=${ageH}h`,
      })

      // Swap a single model reference — rotates among free candidates
      const state = readState()
      const swapped = new Set<string>()
      const swap = (ref: string): string => {
        const candidates = FREE_EQUIVALENTS[ref]
        if (!candidates || candidates.length === 0) return ref
        const start = state.pickIndex[ref] ?? 0
        for (let i = 0; i < candidates.length; i++) {
          const idx = (start + i) % candidates.length
          const candidate = candidates[idx]
          if (allFree.has(candidate)) {
            swapped.add(ref)
            client.app.log({
              service: "prefer-free",
              level: "info",
              message: `SWAP ${ref} → ${candidate}`,
            })
            logSwap(ref, candidate)
            return candidate
          }
        }
        return ref
      }

      // Swap top-level model + small_model
      if (config.model) config.model = swap(config.model)
      if (config.small_model) config.small_model = swap(config.small_model)

      // Swap each agent's model
      for (const [name, agent] of Object.entries(config.agent ?? {})) {
        const before = (agent as any).model
        if (before) {
          const after = swap(before)
          if (after !== before) {
            ;(agent as any).model = after
            client.app.log({
              service: "prefer-free",
              level: "info",
              message: `Agent "${name}": ${before} → ${after}`,
            })
          }
        }
      }

      // Advance pick index once per model for next session
      for (const ref of swapped) {
        const count = (FREE_EQUIVALENTS[ref] ?? []).length
        if (count > 0) state.pickIndex[ref] = ((state.pickIndex[ref] ?? 0) + 1) % count
      }
      writeState(state)
    },
  }
}

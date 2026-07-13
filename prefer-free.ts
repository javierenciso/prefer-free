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
    "opencode/deepseek-v4-flash-free",
    "opencode/mimo-v2.5-free",
    "nvidia/meta/llama-3.3-70b-instruct",
    "opencode/nemotron-3-ultra-free",
  ],
  "opencode-go/qwen3.5-plus": [
    "nvidia/qwen/qwen3.5-122b-a10b",
    "nvidia/qwen/qwen3.5-397b-a17b",
    "opencode/deepseek-v4-flash-free",
    "opencode/mimo-v2.5-free",
    "nvidia/meta/llama-3.3-70b-instruct",
  ],
  "opencode-go/kimi-k2.6": [
    "nvidia/moonshotai/kimi-k2.6",
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
    "opencode/nemotron-3-ultra-free",
    "nvidia/meta/llama-3.3-70b-instruct",
  ],
  "opencode-go/glm-5.2": [
    "nvidia/z-ai/glm-5.2",
    "opencode/deepseek-v4-flash-free",
    "opencode/mimo-v2.5-free",
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

// ── Zen free preferences (offline / catalog fallback) ──────────
// models.dev often lists more Zen free IDs than OpenCode registers at runtime.
// Treat these as ordered preferences — always intersect with the runtime
// registry before prompting (see refreshRuntimeModels / computeAllFree).
const ZEN_FREE = new Set([
  "opencode/big-pickle",
  "opencode/deepseek-v4-flash-free",
  "opencode/hy3-free",
  "opencode/mimo-v2.5-free",
  "opencode/nemotron-3-ultra-free",
  "opencode/north-mini-code-free",
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
// Models actually registered by OpenCode (`providerID/modelID`). Catalog sources
// (esp. models.dev Zen) can list IDs the runtime does not expose — intersect
// before swap / /code-review-free so we never prompt a ghost model.
let cachedRuntimeModels = new Set<string>()
let watchdogStarted = false

async function refreshRuntimeModels(client: any, shell?: any): Promise<Set<string>> {
  const out = new Set<string>()
  // 1) SDK: client.v2.model.list() — la vía barata cuando existe/responde.
  try {
    const listFn = client?.v2?.model?.list ?? client?.model?.list
    if (listFn) {
      const res: any = await listFn.call(client.v2?.model ?? client.model, {})
      const models: any[] = res?.data?.data ?? res?.data ?? []
      for (const m of models) {
        const pid = m.providerID ?? m.provider
        const id = m.id ?? m.modelID
        if (pid && id) out.add(`${pid}/${id}`)
      }
    }
  } catch {}
  // 2) Fallback: `opencode models` por shell. En algunas versiones/entornos
  // el endpoint SDK devuelve vacío aunque el CLI lista todo — el CLI es la
  // fuente de verdad de lo que realmente está registrado en runtime.
  //
  // CRÍTICO: `opencode models` bootea otra instancia de OpenCode que vuelve a
  // cargar este plugin y correr su hook `config`. Si el fallback se dispara ahí,
  // hay recursión infinita (TUI en negro). Por eso:
  //   - el hook `config` NUNCA pasa shell (SDK-only en el arranque)
  //   - marcamos un env guard para que el hijo no re-spawnee jamás
  if (!out.size && shell && !process.env.PREFER_FREE_NO_RUNTIME_SHELL) {
    try {
      const txt: string = await shell`opencode models`
        .env({ ...process.env, PREFER_FREE_NO_RUNTIME_SHELL: "1" })
        .nothrow()
        .quiet()
        .text()
      for (const line of (txt || "").split("\n")) {
        const t = line.trim()
        if (t && t.includes("/") && !t.includes(" ")) out.add(t)
      }
    } catch {
      // BunShell puede no soportar .env(...) en toda versión — reintento simple.
      try {
        const txt: string = await shell`opencode models`.nothrow().quiet().text()
        for (const line of (txt || "").split("\n")) {
          const t = line.trim()
          if (t && t.includes("/") && !t.includes(" ")) out.add(t)
        }
      } catch {}
    }
  }
  return out
}

// Build the union of currently-free model ids from a catalog + provider config.
// When `runtime` is non-empty, Zen/NIM (and config-declared free) IDs must also
// appear there. OpenRouter catalog entries stay unprefixed (`org/model:free`)
// for compatibility with existing FREE_EQUIVALENTS / OPENROUTER_EQUIVALENTS.
function computeAllFree(
  catalog: Catalog,
  providerConfig: any,
  runtime?: Set<string>,
): { allFree: Set<string>; nvidiaCount: number } {
  const zenFromCatalog = catalog.zen.length ? catalog.zen : [...ZEN_FREE]
  // When runtime is known, keep only Zen ids actually registered. When it's NOT
  // known (SDK returned empty and no shell fallback here — see the config hook,
  // kept SDK-only to avoid the black-TUI deadlock), do NOT trust the models.dev
  // catalog blindly: it lists Zen ids OpenCode doesn't register (e.g. the old
  // `nemotron-3-super-free` / `glm-5-free` ghosts) which would then get swapped
  // in and throw ProviderModelNotFoundError. Fall back to the curated ZEN_FREE
  // set, which only contains ids we know OpenCode registers.
  const zen = runtime?.size
    ? zenFromCatalog.filter((m) => runtime.has(m))
    : zenFromCatalog.filter((m) => ZEN_FREE.has(m))
  const allFree = new Set<string>([
    ...catalog.openrouter,
    ...zen,
  ])
  let nvidiaCount = 0
  if (process.env.NVIDIA_API_KEY && providerConfig?.nvidia) {
    for (const id of catalog.nim) {
      const ref = `nvidia/${id}`
      if (!runtime?.size || runtime.has(ref)) {
        allFree.add(ref)
        nvidiaCount++
      }
    }
  }
  for (const [provider, pConfig] of Object.entries(providerConfig ?? {})) {
    for (const [modelId, model] of Object.entries((pConfig as any).models ?? {})) {
      const name = (model as any).name ?? modelId
      if (
        /(^|[-_:/\s])free($|[-_:\s])/i.test(name) ||
        /(^|[-_:/\s])free($|[-_:\s])/i.test(modelId)
      ) {
        const ref = modelId.includes("/") ? modelId : `${provider}/${modelId}`
        if (!runtime?.size || runtime.has(ref)) allFree.add(ref)
      }
    }
  }
  if (runtime?.size) {
    for (const m of runtime) {
      if (m.startsWith("openrouter/") && m.endsWith(":free")) {
        allFree.add(m.slice("openrouter/".length))
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

// ── /code-review-free: swarm de code review con 3 modelos free ────
//
// Recibe un PR (URL de GitHub o número del repo actual), saca el diff, hace
// que 3 modelos free distintos lo revisen EN PARALELO (cada uno en su propia
// sub-session, con tools de lectura), y consolida los hallazgos en un único
// review. Por defecto lo muestra en la TUI; con --post lo sube como comentario
// al PR usando gh.
//
// Cómo elige los 3 modelos: solo opencode/* de 2 segmentos en sub-sessions.
// NIM de 3 segmentos (nvidia/org/model) falla en session.promptAsync porque
// OpenCode parte el id en el primer "/" — y muchos ids del catálogo NIM no
// están registrados en runtime aunque models.dev / .prefer-free-catalog los liste.
const PREFERRED_REVIEW_MODELS: string[] = [
  "opencode/hy3-free",
  "opencode/deepseek-v4-flash-free",
  "opencode/mimo-v2.5-free",
]

// NVIDIA NIM free tier. When NVIDIA_API_KEY is set AND the nvidia provider is
// configured, these are PREFERRED over the opencode Zen free models for review:
// the Zen free tier is aggressively rate-limited and tends to stall mid-stream
// (→ timeouts), while NIM free is a separate, more reliable tier. Ordered for
// coding strength + family diversity across the 3-model swarm (top 3 span
// distinct families: deepseek, glm, qwen). Always gated by the runtime registry
// (pickReviewModels), so unregistered ids are skipped.
//
// NOTE: this is a curated preference list, NOT refreshed by `/prefer-free
// refresh` (that only refreshes which models EXIST / are free / are registered).
// Endpoints that return HTTP 410 (AI_APICallError: Gone) still show as
// registered, so dead ones must be dropped here by hand. Dropped 2026-07-13:
// `nvidia/qwen/qwen3-coder-480b-a35b-instruct` (NIM returned Gone).
const PREFERRED_REVIEW_MODELS_NIM: string[] = [
  "nvidia/deepseek-ai/deepseek-v4-pro",
  "nvidia/z-ai/glm-5.2",
  "nvidia/qwen/qwen3.5-397b-a17b",
  "nvidia/deepseek-ai/deepseek-v4-flash",
  "nvidia/meta/llama-3.3-70b-instruct",
]

const OTHER_REVIEW_FREE: string[] = [
  "opencode/nemotron-3-ultra-free",
  "opencode/north-mini-code-free",
  "opencode/big-pickle",
  "nvidia/z-ai/glm-5.2",
  "nvidia/deepseek-ai/deepseek-v4-flash",
  "nvidia/deepseek-ai/deepseek-v4-pro",
  "nvidia/meta/llama-3.3-70b-instruct",
]

const REVIEW_TIMEOUT_MS = 5 * 60 * 1000 // cada modelo tiene 5 min para terminar (por ronda)
const REVIEW_POLL_MS = 2_500
// Rondas de debate entre reviewers antes de consolidar. Con modelos free (Zen)
// una sola ronda es lo más confiable: las rondas extra duplican el riesgo de
// timeout (cada modelo tiene REVIEW_TIMEOUT_MS por ronda) y rara vez convergen
// distinto. Se puede subir con REVIEW_MAX_ROUNDS=N en el entorno.
const REVIEW_MAX_ROUNDS = (() => {
  const n = parseInt(process.env.REVIEW_MAX_ROUNDS || "1", 10)
  // NaN → 1 (env no numérico); Math.max → floor at 1 (env negativo o 0).
  return Math.max(1, Number.isFinite(n) ? n : 1)
})()
const REVIEW_FALLBACK_BUDGET = 6 // reemplazos por timeout/error en todo el run antes de rendirse

type ReviewResult = {
  model: string // "nvidia/..."
  ok: boolean // true solo si la sesión llegó a idle con output
  partial?: boolean // true si rescatamos texto útil pero no terminó (timeout/error)
  text: string // review del modelo (sin sufijos de metadata)
  error?: string
  elapsed: number
}

function hasUsableReview(r: ReviewResult): boolean {
  return !!(r.ok || r.partial) && !!r.text.trim()
}

function formatReviewerStatus(r: ReviewResult): string {
  const secs = (r.elapsed / 1000).toFixed(1)
  if (r.ok) return `✓ ${secs}s`
  if (r.partial) return `⏱ parcial (${r.error ?? "incompleto"}, ${secs}s)`
  return `✗ ${r.error ?? "falló"} (${secs}s)`
}

// Helper para construir parts del output sin pelear con el SDK que a partir
// de v1.17 pide ids en TextPart aún para outputs (en runtime cualquier objeto
// con type+text funciona).
const tp = (text: string): any => ({ type: "text", text })


// OpenCode keeps its own `parts` array reference after command.execute.before
// (issue #1). Reassigning output.parts to a new array is a no-op for the caller —
// mutate in place with splice, and prepend a short ACK so the unavoidable LLM
// turn just confirms instead of re-interpreting the command template.
const ACK_PART: any = {
  type: "text",
  text: "[prefer-free plugin] El siguiente bloque es output del plugin y el usuario ya lo tiene en pantalla. Tu única respuesta debe ser: ✅ — un solo carácter, sin repetir el bloque, sin agregar nada, sin ejecutar herramientas.",
}
function setCommandParts(output: { parts: any[] }, ...parts: any[]) {
  output.parts.splice(0, output.parts.length, ACK_PART, ...parts)
}


function splitModel(ref: string): { providerID: string; modelID: string } {
  const slash = ref.indexOf("/")
  return { providerID: ref.slice(0, slash), modelID: ref.slice(slash + 1) }
}

// Sub-sessions de /code-review-free: preferimos modelos registrados en runtime.
// Si NO pudimos leer el runtime (SDK vacío + shell falló), caemos a un set
// CURADO y seguro (opencode/* de 2 segmentos que suelen estar registrados),
// nunca al catálogo completo — eso reintroduciría ids fantasma (issue #2).
//
// `preferNim`: cuando hay NVIDIA_API_KEY y al menos un NIM está en runtime,
// los NIM free van PRIMERO. Sin runtime conocido no se eligen NIM (ghost risk).
// rankReviewModels devuelve el pool completo (sin cap) para fallback de slots.
function rankReviewModels(
  runtime: Set<string>,
  cachedFree: Set<string>,
  preferNim = false,
): string[] {
  const runtimeKnown = runtime.size > 0
  const safeFallback = new Set<string>([...PREFERRED_REVIEW_MODELS, ...ZEN_FREE])
  const gate = runtimeKnown
    ? (m: string) => runtime.has(m)
    : (m: string) => safeFallback.has(m)
  const candidates = [
    ...(preferNim && runtimeKnown ? PREFERRED_REVIEW_MODELS_NIM : []),
    ...PREFERRED_REVIEW_MODELS,
    ...OTHER_REVIEW_FREE,
    ...(cachedFree.size ? [...cachedFree] : []),
    ...ZEN_FREE,
  ]
  const seen = new Set<string>()
  const out: string[] = []
  for (const m of candidates) {
    if (seen.has(m)) continue
    seen.add(m)
    if (!gate(m)) continue
    out.push(m)
  }
  return out
}

function pickReviewModels(
  runtime: Set<string>,
  cachedFree: Set<string>,
  count = 3,
  preferNim = false,
): string[] {
  return rankReviewModels(runtime, cachedFree, preferNim).slice(0, count)
}

// Parsea "URL o número" y devuelve { repo: "owner/repo" | null, pr: number }
function parsePrArg(arg: string): { repo: string | null; pr: number; error?: string } {
  const trimmed = arg.trim()
  // https://github.com/owner/repo/pull/123
  const m = trimmed.match(/github\.com\/([^\/]+\/[^\/]+)\/pull\/(\d+)/i)
  if (m) return { repo: m[1], pr: parseInt(m[2], 10) }
  // 123
  if (/^\d+$/.test(trimmed)) return { repo: null, pr: parseInt(trimmed, 10) }
  return { repo: null, pr: 0, error: "argumento inválido — pasá una URL o un número de PR" }
}

// Llamada blocking a gh para sacar metadata + diff del PR.
async function fetchPr(
  $: any,
  pr: number,
  repo: string | null,
): Promise<{ title: string; body: string; base: string; head: string; diff: string; repo: string | null }> {
  // BunShell interpolates arrays as separate argv entries; a single
  // `--repo owner/repo` string would be passed as one arg and break gh.
  const repoArgs: string[] = repo ? ["--repo", repo] : []
  const metaJson = await $`gh pr view ${pr} ${repoArgs} --json title,body,baseRefName,headRefName,headRepository`
    .nothrow().quiet().text()
  let meta: any = {}
  try { meta = JSON.parse(metaJson || "{}") } catch {}
  const diff = await $`gh pr diff ${pr} ${repoArgs}`.nothrow().quiet().text().catch(() => "") as string
  const head = meta?.headRepository?.name
    ? `${meta.headRepository.name}:${meta.headRefName}`
    : (meta?.headRefName ?? "")
  return {
    title: meta?.title ?? `PR #${pr}`,
    body: (meta?.body ?? "").toString(),
    base: meta?.baseRefName ?? "",
    head,
    diff: diff || "",
    repo,
  }
}

// Corre 1 modelo free contra el mismo prompt en una sub-session hija. Devuelve
// el texto final del assistant (mass result) o el error. Nunca toca estado
// global del PreferFree. `peerContext` (si hay) es lo que dijeron los otros
// reviewers en la ronda previa — el modelo puede defenderse o cambiar de idea.
async function runReviewer(
  client: any,
  parentSessionID: string,
  modelRef: string,
  prompt: string,
  allowBash: boolean,
  peerContext?: string,
): Promise<ReviewResult> {
  const startedAt = Date.now()
  // Tools OFF by default: the full PR diff is already inlined in the prompt, so
  // the reviewer doesn't need to explore. Free (Zen) models are rate-limited and
  // tend to stall mid tool-call loop, blowing past REVIEW_TIMEOUT_MS before they
  // ever write the review. `--bash` opts back into read-only exploration (+bash)
  // for the rare case the inline diff isn't enough, accepting the timeout risk.
  const tools: Record<string, boolean> = allowBash
    ? {
        read: true,
        glob: true,
        grep: true,
        task: false,
        edit: false,
        write: false,
        bash: true,
        webfetch: false,
        websearch: false,
      }
    : {
        read: false,
        glob: false,
        grep: false,
        task: false,
        edit: false,
        write: false,
        bash: false,
        webfetch: false,
        websearch: false,
      }
  const fullPrompt = peerContext
    ? prompt + "\n\n" + peerContext
    : prompt
  try {
    const { providerID, modelID } = splitModel(modelRef)
    const created: any = await client.session.create({
      body: { parentID: parentSessionID, title: `review:${shortName(modelRef)}` },
    })
    const sid: string = created?.data?.id ?? created?.id
    if (!sid) throw new Error("session.create devolvió sin id")

    await client.session.promptAsync({
      path: { id: sid },
      body: {
        model: { providerID, modelID },
        agent: "explore",
        tools,
        parts: [{ type: "text", text: fullPrompt }],
      },
    })

    // Poll status hasta idle o timeout. Sin usar el event bus para no pisar
    // el handler global del PreferFree; cheap & robust.
    const deadline = Date.now() + REVIEW_TIMEOUT_MS
    let lastStatus = "busy"
    let statusErrored = false
    while (Date.now() < deadline) {
      await sleep(REVIEW_POLL_MS)
      const st: any = await client.session.status({ path: { id: sid } })
      const status = st?.data?.type ?? st?.data?.status ?? st?.status
      lastStatus = status ?? lastStatus
      if (lastStatus === "idle") break
      if (lastStatus === "error") { statusErrored = true; break }
    }
    if (lastStatus !== "idle") {
      // No llegó a idle (timeout o error): abortamos, pero igual leemos los
      // mensajes — el modelo puede haber escrito un review parcial antes de
      // frenarse. Descartarlo (como se hacía antes) tiraba trabajo útil.
      await client.session.abort({ path: { id: sid } }).catch(() => {})
    }

    const msgsRes: any = await client.session.messages({ path: { id: sid } })
    const msgs: any[] = msgsRes?.data ?? (Array.isArray(msgsRes) ? msgsRes : [])
    let text = ""
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i]?.info?.role === "assistant") {
        for (const p of msgs[i].parts ?? []) {
          if (p?.type === "text" && p.text) text += p.text + "\n"
        }
        break
      }
    }
    const clean = text.trim()
    if (lastStatus !== "idle") {
      // Rescate de parcial: texto útil pero ok:false — no mezclar con éxito
      // completo; downstream usa hasUsableReview() / partial para consolidar.
      if (clean) {
        return {
          model: modelRef,
          ok: false,
          partial: true,
          text: clean,
          error: statusErrored ? "error-partial" : "timeout-partial",
          elapsed: Date.now() - startedAt,
        }
      }
      return {
        model: modelRef,
        ok: false,
        text: "",
        error: statusErrored ? "error" : "timeout",
        elapsed: Date.now() - startedAt,
      }
    }
    return {
      model: modelRef,
      ok: !!clean,
      text: clean || "(sin output del modelo)",
      elapsed: Date.now() - startedAt,
    }
  } catch (e: any) {
    return {
      model: modelRef,
      ok: false,
      text: "",
      error: e?.message ?? String(e),
      elapsed: Date.now() - startedAt,
    }
  }
}

// Consolida los N reviews en un único review final con un modelo "mergeer".
async function mergeReviews(
  client: any,
  sessionID: string,
  mergerModel: string,
  prInfo: { title: string; pr: number; repo: string | null },
  results: ReviewResult[],
): Promise<string> {
  const summaries = results
    .map((r, i) => {
      const tag = r.ok ? "" : r.partial ? " (PARCIAL: " + (r.error ?? "?") + ")" : " (FALLÓ: " + (r.error ?? "?") + ")"
      const head = `### Reviewer ${i + 1} — ${shortName(r.model)}${tag}`
      return `${head}\n\n${hasUsableReview(r) ? r.text : "—"}`
    })
    .join("\n\n---\n\n")

  const prompt = [
    `PR #${prInfo.pr}${prInfo.repo ? ` (${prInfo.repo})` : ""}: ${prInfo.title}`,
    "",
    "Reuní los ${N} reviews estos en UN solo review final.",
    "Reglas:",
    "- Duplicá cada issue en una sola línea. No inventes issues que no aparezcan abajo.",
    "- Ordená por severidad: Bloqueante > Importante > Menor > Pregunta.",
    "- Si los reviewers se contradicen entre sí, dejá una sola recomendación con _(conflicto: X vs Y)_ notado.",
    "- Clarito y en español. M arbe.",
    "- Fuera del texto del review no agregues nada (sin proemio, sin colofón) — el code reviewer lo va a pegar directamente.",
    "",
    "Empezá el review con: ## Review consolidado (PR #" + prInfo.pr + ")",
    "",
    "Reviews:",
    summaries,
  ].join("\n")

  try {
    const { providerID, modelID } = splitModel(mergerModel)
    const created: any = await client.session.create({
      body: { parentID: sessionID, title: "review:consolidador" },
    })
    const sid = created?.data?.id ?? created?.id
    await client.session.promptAsync({
      path: { id: sid },
      body: {
        model: { providerID, modelID },
        agent: "explore",
        tools: { read: false, glob: false, grep: false, task: false, edit: false, write: false, bash: false },
        parts: [{ type: "text", text: prompt }],
      },
    })
    const deadline = Date.now() + REVIEW_TIMEOUT_MS
    let status = "busy"
    while (Date.now() < deadline) {
      await sleep(REVIEW_POLL_MS)
      const st: any = await client.session.status({ path: { id: sid } })
      status = st?.data?.type ?? st?.data?.status ?? status
      if (status === "idle") break
      if (status === "error") break
    }
    await client.session.abort({ path: { id: sid } }).catch(() => {})
    const msgsRes: any = await client.session.messages({ path: { id: sid } })
    const msgs: any[] = msgsRes?.data ?? (Array.isArray(msgsRes) ? msgsRes : [])
    let text = ""
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i]?.info?.role === "assistant") {
        for (const p of msgs[i].parts ?? []) {
          if (p?.type === "text" && p.text) text += p.text + "\n"
        }
        break
      }
    }
    return text.trim() || "(el consolidador no devolvió texto)"
  } catch {
    return summaries || "(sin reviews para consolidar)"
  }
}

// Construye el bloque "lo que dijeron los otros" que se le pasa a cada reviewer
// en la ronda N>0. Cada reviewer ve TODAS las opiniones (con su propio nombre
// marcado), para que pueda defender o ajustar su postura.
function buildPeerContext(round: number, results: ReviewResult[], selfIdx?: number): string {
  const lines = [
    `---`,
    `RONDA ${round} — opiniones de los reviewers (ronda anterior):`,
    ``,
  ]
  results.forEach((r, i) => {
    const tag = i === selfIdx ? " → VOS" : ""
    const failTag = r.ok ? "" : r.partial ? " (PARCIAL: " + (r.error ?? "?") + ")" : " (FALLÓ: " + (r.error ?? "?") + ")"
    lines.push(`### Reviewer ${i + 1} — ${shortName(r.model)}${tag}${failTag}`)
    lines.push("")
    lines.push(hasUsableReview(r) ? r.text : "—")
    lines.push("")
  })
  lines.push(`---`)
  return lines.join("\n")
}

// Ratio de "cuánto cambió" entre dos textos. 0 = idéntico, 1 = completamente
// distinto. Aproximación barata: #tokens borrados+insertados / (a+b)/2.
// Suficiente para detectar convergencia en el swarm.
function editDistanceRatio(a: string, b: string): number {
  if (!a && !b) return 0
  if (!a || !b) return 1
  const ta = a.split(/\s+/).filter(Boolean)
  const tb = b.split(/\s+/).filter(Boolean)
  const setA = new Set(ta)
  const setB = new Set(tb)
  let common = 0
  for (const w of setA) if (setB.has(w)) common++
  const union = setA.size + setB.size - common
  if (union === 0) return 0
  return 1 - common / union
}

// Construye el prompt base de code review en español, con el diff recortado y
// metadatos del PR. Es lo que se le manda a cada modelo reviewer en la ronda 1.
function buildReviewPrompt(
  pr: { title: string; body: string; head: string },
  diff: string,
  truncatedNote: string,
): string {
  return [
    `Estás revisando un Pull Request. Basate en el diff y los metadatos.`,
    "Reglas:",
    "- Sé concreto y corto.",
    "- Para cada issue: `### severidad\nArchivos: paths:lines\nProblema:\n  …\nSugerencia:\n  …`",
    "- Si no hay nada crítico, decí 1 palabra en la 1era línea; no inventes.",
    "- No propongas cambios que no estén relacionados al diff. Sé estricto.",
    "- Si usás tools, leé nada más que los archivos del diff para ficharse del contexto.",
    "",
    `PR: ${pr.title}${pr.head ? ` (head: ${pr.head})` : ""}`,
    "Descripción:",
    (pr.body || "(sin descripción)").slice(0, 4000),
    "",
    "Diff:",
    "```diff",
    diff,
    "```",
    truncatedNote,
  ].join("\n")
}

// Publica texto en la sesión como un mensaje visible SIN trigger el LLM.
// Usa noReply:true (ver issue anomalyco/opencode#9306 y recipe en
// github.com/malhashemi/opencode-skills). Si noReply no está soportado por
// la versión de opencode, falla silenciosamente (el toast ya muestra el
// resultado).
async function publishToSession(cli: any, sessionID: string, part: any): Promise<void> {
  try {
    await cli.session.prompt({
      path: { id: sessionID },
      body: {
        noReply: true,
        parts: [part],
      },
    })
  } catch {
    // noReply puede no estar soportado en todas las versiones. Fallback:
    // próbally no llegó pero al menos el toast le avisó al usuario.
  }
}

// ── Plugin ─────────────────────────────────────────────────────
export const PreferFree: Plugin = async ({ client, $ }) => {
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

  // ── /code-review-free handler ─────────────────────────────
  // Swarm de code review: 3 modelos free en paralelo + consolidador.
  //
  // IMPORTANT: command.execute.before's output.parts becomes the prompt that
  // the LLM processes —ocation the hook always triggers an LLM turn. This is
  // documented as a limitation (issue anomalyco/opencode#9306 asked for a
  // `noReply` field; not yet available in 1.17.x). So this handler is
  // intentionally NON-blocking:
  //   1. Parse + validate (fast, sync).
  //   2. Set output.parts to a neutral "swarm started, coming soon" preamble
  //      so the LLM has nothing interesting to act on.
  //   3. Fire the heavy work as a detached Promise (fire-and-forget).
  //   4. Post progress via client.tui.showToast (toasts don't block the TUI).
  //   5. When done, deliver the consolidated review as a new message in the
  //      session using client.session.prompt with noReply:true — this
  //      inserts visible text without triggering another LLM turn.
  //      (Workaround for #4475: explicitly pass the session's current model
  //      so noReply doesn't trigger an agent-default model switch.)
  const runCodeReviewFree = async (
    input: { command: string; sessionID: string; arguments: string },
    output: { parts: any[] },
    cli: any,
    shell: any,
  ) => {
    const rawArg = (input.arguments || "").trim()
    const wantsPost = /\s--post\b/.test(rawArg)
    const wantsBash = /\s--bash\b/.test(rawArg)
    const cleanArg = rawArg.replace(/\s--(?:post|bash)\b/g, "").trim()

    if (!cleanArg) {
      setCommandParts(output, tp([
        "📖 /code-review-free — code review del PR con 3 modelos free en paralelo",
        "",
        "USO:",
        "  /code-review-free <url>          → ej: https://github.com/owner/repo/pull/123",
        "  /code-review-free <número>        → ej: 123 (usa el repo del cwd)",
        "",
        "FLAGS:",
        "  --post    → sube el review como comentario en el PR (vía gh)",
        "  --bash    → habilita tools (read/grep/glob + bash) para explorar el",
        "              repo. Default: sin tools, el diff va inline en el prompt",
        "              (más rápido y confiable con modelos free).",
        "",
        `HOW IT WORKS:`,
        `  Los 3 modelos corren en paralelo sobre el diff del PR y un 4° modelo`,
        "  consolida todo en un único review.",
        `  Rondas de debate: ${REVIEW_MAX_ROUNDS} (default 1; subí con REVIEW_MAX_ROUNDS=N).`,
        "  En >1 ronda cada modelo ve lo que dijeron los otros y ajusta; corta",
        "  antes si convergen (ningún texto cambia >5%).",
        "  Si un modelo no termina a tiempo se rescata su review parcial.",
        "",
        "NUNCA usa paid. Si un free falla salta al siguiente de la lista.",
      ].join("\n")))
      return
    }

    const parsed = parsePrArg(cleanArg)
    if (parsed.error) {
      setCommandParts(output, tp("❌ " + parsed.error))
      return
    }

    // Parse arg OK. Fire the swarm in the background; show a neutral
    // preamble in `output.parts` so the LLM turn ends quickly and the TUI
    // comes back. Per the swarm spec from brave search (issue #9306), we
    // cannot prevent the LLM from receiving this — but a neutral preamble
    // encourages the model to just acknowledge and stop.
    setCommandParts(output, tp(
      `🔄 **code-review-free** — PR #${parsed.pr}${parsed.repo ? ` (${parsed.repo})` : ""}\n` +
      `Swarm iniciado en background. Vas a ver toasts de progreso y cuando` +
      ` termine el review consolidado aparece acá mismo.\n` +
      `_(este mensaje no necesita respuesta — podés seguir trabajando)_`,
    ))

    // Detached: does NOT block the hook return. Errors are logged + toasted,
    // never thrown into the hook's promise chain.
    Promise.resolve().then(async () => {
      const sessionID = input.sessionID
      try {
        // ── Etapa 1: fetch diff ──
        await cli.tui.showToast({ body: {
          title: "code-review-free",
          message: `Tirando diff del PR #${parsed.pr}${parsed.repo ? ` (${parsed.repo})` : ""}…`,
          variant: "info",
          duration: 4000,
        } }).catch(() => {})

        const pr = await fetchPr(shell, parsed.pr, parsed.repo)
        if (!pr.diff) {
          await cli.tui.showToast({ body: {
            title: "code-review-free",
            message: `❌ No pude sacar el diff del PR #${parsed.pr}. ¿gh auth y PR existe?`,
            variant: "error",
            duration: 8000,
          } }).catch(() => {})
          await publishToSession(cli, sessionID, tp(`❌ No pude sacar el diff del PR #${parsed.pr}. ¿gh está autenticado y el PR existe?`))
          return
        }

        const MAX_DIFF_CHARS = 60_000
        let diff = pr.diff
        let truncatedNote = ""
        if (diff.length > MAX_DIFF_CHARS) {
          diff = diff.slice(0, MAX_DIFF_CHARS)
          truncatedNote = `\n\n>[diff recortado a ${MAX_DIFF_CHARS} chars (${pr.diff.length} reales)]\n\n`
        }

        // ── Etapa 2: build ranked pool + initial 3 models ──
        let runtime = cachedRuntimeModels.size
          ? cachedRuntimeModels
          : await refreshRuntimeModels(cli, shell)
        if (!runtime.size) runtime = await refreshRuntimeModels(cli, shell)
        if (runtime.size) cachedRuntimeModels = runtime

        const preferNim =
          !!process.env.NVIDIA_API_KEY &&
          runtime.size > 0 &&
          PREFERRED_REVIEW_MODELS_NIM.some((m) => runtime.has(m))
        const pool = rankReviewModels(runtime, cachedAllFree, preferNim)
        const used = new Set<string>()
        let budget = REVIEW_FALLBACK_BUDGET
        const nextUnused = (): string | null => {
          for (const m of pool) { if (!used.has(m)) { used.add(m); return m } }
          return null
        }
        const models: string[] = []
        while (models.length < 3) {
          const m = nextUnused()
          if (!m) break
          models.push(m)
        }
        if (models.length === 0) {
          const hint = runtime.size
            ? "Ningún modelo free del catálogo está registrado en OpenCode."
            : "No pude leer el registro de modelos de OpenCode (SDK + `opencode models` fallaron)."
          await cli.tui.showToast({ body: {
            title: "code-review-free",
            message: `❌ ${hint}`,
            variant: "error",
            duration: 8000,
          } }).catch(() => {})
          await publishToSession(cli, sessionID, tp(`❌ No encontré modelos free para code review. ${hint}`))
          return
        }

        const reviewPrompt = buildReviewPrompt(pr, diff, truncatedNote)

        await cli.tui.showToast({ body: {
          title: "code-review-free",
          message: `Swarm ${models.length} modelos · max ${REVIEW_MAX_ROUNDS} rondas: ${models.map(shortName).join(", ")}…`,
          variant: "info",
          duration: 6000,
        } }).catch(() => {})

        cli.app.log({ body: {
          service: "prefer-free",
          level: "info",
          message: `code-review-free: swarm ${models.length} modelos, PR #${parsed.pr}`,
          extra: { models: models.map(shortName).join(", ") },
        } }).catch(() => {})

        // ── Etapa 3: debate rounds ──
        const t0 = Date.now()
        let lastResults: ReviewResult[] = []
        let roundIndex = 0
        for (; roundIndex < REVIEW_MAX_ROUNDS; roundIndex++) {
          await cli.tui.showToast({ body: {
            title: "code-review-free",
            message: `Ronda ${roundIndex + 1}/${REVIEW_MAX_ROUNDS} — ${models.length} modelos en paralelo…`,
            variant: "info",
            duration: 5000,
          } }).catch(() => {})

          const debateHeader =
            roundIndex === 0
              ? ""
              : `\n\n## Ronda ${roundIndex + 1}/${REVIEW_MAX_ROUNDS} — debaté con los otros reviewers\n` +
                `Debajo te paso lo que dijeron todos en la ronda anterior; **vos sos el reviewer marcado como "→ VOS"**.` +
                ` Podés defender tu postura, aceptar puntos de otros o ajustar.` +
                ` Devolvé TU review ACTUALIZADO y completo. No repostees lo que dijeron los otros.\n`

          let roundResults = await Promise.all(
            models.map((m, idx) => {
              const peerContext = roundIndex === 0 ? undefined : buildPeerContext(roundIndex, lastResults, idx)
              const prompt = reviewPrompt + debateHeader + (peerContext ? "\n" + peerContext : "")
              return runReviewer(cli, sessionID, m, prompt, wantsBash)
            }),
          )

          // Fallback: any reviewer that timed out / errored gets replaced by the
          // next free candidate from the pool — so one stuck model doesn't sink
          // the whole review. Bounded by REVIEW_FALLBACK_BUDGET across the run.
          const failed = roundResults.map((r, i) => hasUsableReview(r) ? -1 : i).filter((i) => i >= 0)
          if (failed.length && budget > 0) {
            const slots: number[] = []
            const jobs: Promise<ReviewResult>[] = []
            for (const i of failed) {
              if (budget <= 0) break
              const repl = nextUnused()
              if (!repl) break
              budget--
              slots.push(i)
              const peerContext = roundIndex === 0 ? undefined : buildPeerContext(roundIndex, roundResults, i)
              const prompt = reviewPrompt + debateHeader + (peerContext ? "\n" + peerContext : "")
              jobs.push(runReviewer(cli, sessionID, repl, prompt, wantsBash))
            }
            if (jobs.length) {
              await cli.tui.showToast({ body: {
                title: "code-review-free",
                message: `↻ ${jobs.length} reviewer(s) cayeron — probando free alternativo…`,
                variant: "info",
                duration: 5000,
              } }).catch(() => {})
              const repls = await Promise.all(jobs)
              slots.forEach((slot, k) => { roundResults[slot] = repls[k] })
            }
          }

          let changedSignificantly = roundIndex === 0
          if (roundIndex > 0) {
            for (let i = 0; i < roundResults.length; i++) {
              // Convergencia solo entre reviews completos; parciales no disparan
              // otra ronda de debate (suelen ser timeout, no cambio de opinión).
              const prev = lastResults[i]
              const curr = roundResults[i]
              if (!prev?.ok || !curr?.ok) continue
              const delta = editDistanceRatio(prev.text, curr.text)
              if (delta > 0.05) { changedSignificantly = true; break }
            }
          }
          lastResults = roundResults
          if (!changedSignificantly) break
        }

        // ── Etapa 4: consolidación ──
        const anyComplete = lastResults.some((r) => r.ok)
        const anyUsable = lastResults.some(hasUsableReview)
        await cli.tui.showToast({ body: {
          title: "code-review-free",
          message: anyUsable
            ? `Consolidando review (${lastResults.filter(hasUsableReview).length} opiniones${anyComplete ? "" : ", todas parciales"})…`
            : `Todos los reviewers fallaron — no hay nada que consolidar`,
          variant: anyUsable ? "info" : "warning",
          duration: 5000,
        } }).catch(() => {})

        const merger =
          lastResults.find((r) => r.ok)?.model ??
          lastResults.find((r) => r.partial)?.model ??
          models[0]
        const consolidated = anyUsable
          ? await mergeReviews(
              cli, sessionID, merger,
              { title: pr.title, pr: parsed.pr, repo: parsed.repo },
              lastResults,
            )
          : "\n\n> ⚠️ Ningún reviewer free completó a tiempo (todos timeout/error). " +
            "No hay review para consolidar. Reintentá más tarde — el free tier suele estar cargado — " +
            "o usá `--post` para dejar el intento registrado en el PR."

        const elapsedS = ((Date.now() - t0) / 1000).toFixed(1)
        const header = [
          `## ${pr.title}`,
          ` PR #${parsed.pr}${parsed.repo ? ` · ${parsed.repo}` : ""} · ${models.length} modelos · ${roundIndex + 1} rondas · ${elapsedS}s`,
          ``,
          `Modelos usados:`,
          ...lastResults.map((r, i) =>
            `  ${i + 1}. ${shortName(r.model)} — ${formatReviewerStatus(r)}`,
          ),
          ``,
          `_Consolidado con ${shortName(merger)} · ${roundIndex + 1} rondas de debate_`,
          ``,
        ].join("\n")
        const finalText = header + consolidated

        // ── Etapa 5: postear / entregar ──
        if (wantsPost) {
          try {
            const repoArgs: string[] = parsed.repo ? ["--repo", parsed.repo] : []
            const tmpPath = join(process.env.HOME || "~", ".config/opencode/.prefer-free-review.md")
            writeFileSync(tmpPath, finalText)
            await shell`gh pr comment ${parsed.pr} ${repoArgs} --body-file ${tmpPath}`.quiet()
            try { await shell`rm -f ${tmpPath}`.quiet() } catch {}
            await cli.tui.showToast({ body: {
              title: "code-review-free",
              message: `✅ Review posteado en PR #${parsed.pr}`,
              variant: "success",
              duration: 6000,
            } }).catch(() => {})
          } catch (e: any) {
            await cli.tui.showToast({ body: {
              title: "code-review-free",
              message: `❌ No pude postear el comentario: ${e?.message ?? e}`,
              variant: "error",
              duration: 8000,
            } }).catch(() => {})
          }
        }

        // Publish the review text in the session (visible to user) via
        // noReply to avoid triggering another LLM turn.
        await publishToSession(cli, sessionID, tp(finalText))

        cli.app.log({ body: {
          service: "prefer-free",
          level: "info",
          message: `code-review-free: done ${roundIndex + 1} rondas, ${elapsedS}s`,
        } }).catch(() => {})
      } catch (e: any) {
        try {
          await cli.tui.showToast({ body: {
            title: "code-review-free",
            message: `❌ Error inesperado: ${e?.message ?? e}`,
            variant: "error",
            duration: 10000,
          } }).catch(() => {})
          await publishToSession(cli, input.sessionID, tp(`❌ code-review-free falló: ${e?.message ?? e}`))
        } catch {}
      }
    }).catch(() => {})
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
            /rate.?limit|quota|too many|overload|capacity|resourc?e.?exhausted|request limit|exhausted/i.test(msg) ||
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
      if (input.command === "code-review-free") {
        try {
          await runCodeReviewFree(input, output, client, $)
        } catch (e: any) {
          setCommandParts(output, {
            type: "text",
            text: `❌ code-review-free falló: ${e?.message ?? e}`,
          } as any)
        }
        return
      }
      if (input.command !== "prefer-free") return

      const arg = input.arguments.trim().toLowerCase()
      const state = readState()

      if (arg === "on") {
        writeState({ ...readState(), enabled: true })
        setCommandParts(output, {
          type: "text",
          text: "✅ PreferFree ON — se usarán modelos free cuando sea posible",
        } as any)
        return
      }

      if (arg === "off") {
        writeState({ ...readState(), enabled: false })
        setCommandParts(output, {
          type: "text",
          text: "❌ PreferFree OFF — se usarán los modelos originales (opencode-go)",
        } as any)
        return
      }

      if (arg === "failover on") {
        writeState({ ...readState(), failover: true })
        setCommandParts(output, {
          type: "text",
          text: "🔁 Failover ON — si un modelo free se tranca (rate-limit/cuelgue) reintenta la task con el siguiente free de la cadena",
        } as any)
        return
      }

      if (arg === "failover off") {
        writeState({ ...readState(), failover: false })
        setCommandParts(output, {
          type: "text",
          text: "⏹️  Failover OFF — no se reintenta automáticamente; si un free se tranca queda como está",
        } as any)
        return
      }

      if (arg === "failover") {
        setCommandParts(output, {
          type: "text",
          text: `Failover está ${state.failover === false ? "⏹️ OFF" : "🔁 ON"}\n  /prefer-free failover on|off`,
        } as any)
        return
      }

      if (arg === "log") {
        const log = readLog()
        setCommandParts(output, {
          type: "text",
          text: log
            ? log.split("\n").filter(Boolean).slice(-30).join("\n")
            : "(sin swaps registrados aún)",
        } as any)
        return
      }

      if (arg === "clear") {
        try { writeFileSync(LOG_PATH, "") } catch {}
        setCommandParts(output, {
          type: "text",
          text: "🧹 Log limpiado",
        } as any)
        return
      }

      if (arg === "refresh") {
        const cat = await refreshCatalog()
        setCommandParts(output, {
          type: "text",
          text: [
            `🔄 Catalog refresheado ${new Date(cat.fetchedAt).toISOString()}`,
            `  NIM:        ${cat.nim.length} modelos${process.env.NVIDIA_API_KEY ? "" : " (NVIDIA_API_KEY no seteada — no se usan)"}`,
            `  OpenRouter: ${cat.openrouter.length} :free`,
            `  Zen:        ${cat.zen.length} free`,
            ``,
            `Diff vs anterior queda en /prefer-free log`,
          ].join("\n"),
        } as any)
        return
      }

      if (arg === "catalog") {
        const cat = readCatalog()
        if (!cat) {
          setCommandParts(output, {
            type: "text",
            text: "(sin catalog cacheado — corré /prefer-free refresh)",
          } as any)
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
        setCommandParts(output, { type: "text", text: lines.join("\n") } as any)
        return
      }

      if (arg === "help" || arg === "") {
        setCommandParts(output, {
          type: "text",
          text: [
            `PreferFree está ${state.enabled ? "✅ ON" : "❌ OFF"} · Failover ${state.failover === false ? "⏹️ OFF" : "🔁 ON"}`,
            "",
            "Comandos:",
            "  /prefer-free            → estado actual",
            "  /prefer-free help       → esta ayuda",
            "  /prefer-free on         → activar swap a modelos free",
            "  /prefer-free off        → desactivar swap (usa opencode-go); /code-review-free sigue activo",
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
            "  Antes de swappear o de /code-review-free, se intersecta con los modelos",
            "  que OpenCode registra en runtime (models.dev puede listar más).",
            "",
            "Failover (mid-session):",
            "  Si el free se tranca por rate-limit/429, error o cuelgue silencioso",
            "  (180s sin actividad), aborta, vuelve al último prompt y reintenta la",
            "  task con el SIGUIENTE free de la misma cadena. Si se acaban los free,",
            "  avisa por toast y deja la sesión (nunca cae al modelo pago).",
            "",
            "NVIDIA NIM: requiere export NVIDIA_API_KEY=nvapi-...",
          ].join("\n"),
        } as any)
        return
      }

      setCommandParts(output, {
        type: "text",
        text: `PreferFree está ${state.enabled ? "✅ ON" : "❌ OFF"}\n/prefer-free help  → ayuda completa`,
      } as any)
    },

    config: async (config) => {
      // Always refresh catalog + runtime free set — even when PreferFree swap is
      // OFF — so /code-review-free still has a validated model list (issue #2).
      let catalog = readCatalog()
      if (!catalog) {
        catalog = await refreshCatalog()
      } else if (Date.now() - catalog.fetchedAt > CATALOG_TTL_MS) {
        refreshCatalog().catch(() => {})
      }

      // SDK-only en el arranque: NUNCA pasar shell acá. `opencode models`
      // bootearía otra instancia que recarga este hook → recursión infinita
      // (TUI en negro). El fallback por shell queda solo en /code-review-free.
      const runtime = await refreshRuntimeModels(client)
      if (runtime.size) cachedRuntimeModels = runtime

      // Union of free model ids, intersected with OpenCode's runtime registry
      // when available. NIM only when provider is declared AND NVIDIA_API_KEY set.
      const { allFree, nvidiaCount } = computeAllFree(
        catalog,
        config.provider ?? {},
        runtime,
      )

      cachedAllFree = allFree
      startWatchdog()

      const ageH = Math.round(((Date.now() - catalog.fetchedAt) / 36e5) * 10) / 10
      client.app.log({
        service: "prefer-free",
        level: "info",
        message: `free=${allFree.size} (runtime ${runtime.size} · NIM ${nvidiaCount} · OR ${catalog.openrouter.length} · Zen ${catalog.zen.length || ZEN_FREE.size}) cat=${ageH}h`,
      })

      if (!readState().enabled) return

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

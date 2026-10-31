import { timingSafeEqual } from "node:crypto"
import { Actor, Persisted } from "durable-actors"
import pg from "pg"

type Scalar = string | number | boolean

export type TemporaryApiConfig = {
    plan: {
        version: number
        resource: string
        fields: string[]
        filters: { field: string; op: string; value: Scalar }[]
        limit: number
        inputs: string[] // Always empty in version 1; the harness schema enforces it.
        purpose: string
    }
    planHash: string
    tokenHash: string
    credential: { role: string; view: string }
    expiresAt: string
}

type Row = Record<string, Scalar | null>
export type InvokeResult = { outcome: "ok"; rows: Row[] } | { outcome: "unauthorized" } | { outcome: "expired" }

const ROLE = /^lild_api_[a-f0-9]{32}$/
const NUMERIC_OID = 1700

function sameHash(a: string, b: string): boolean {
    const left = Buffer.from(a)
    const right = Buffer.from(b)
    return left.length === right.length && timingSafeEqual(left, right)
}

/** Holds one approved plan and executes only that plan. */
export class TemporaryApi extends Actor {
    @Persisted private config: TemporaryApiConfig | null = null
    @Persisted private expired = false

    /** Idempotent for the same plan. An actor can never be repointed at a different plan. */
    async configure(config: TemporaryApiConfig): Promise<{ configured: boolean }> {
        if (this.config) {
            if (this.config.planHash !== config.planHash) throw new Error("actor already holds another plan")
            return { configured: false }
        }
        this.config = config
        this.alarm.set(Date.parse(config.expiresAt))
        return { configured: true }
    }

    /** Never returns the token hash. */
    async getStatus(): Promise<{ state: "unconfigured" | "active" | "expired"; expiresAt: string | null }> {
        if (!this.config) return { state: this.expired ? "expired" : "unconfigured", expiresAt: null }
        const expired = this.expired || Date.now() >= Date.parse(this.config.expiresAt)
        return { state: expired ? "expired" : "active", expiresAt: this.config.expiresAt }
    }

    /** Checks the token before expiry, so an unknown caller learns nothing about the API. */
    async invoke(tokenHash: string): Promise<InvokeResult> {
        if (this.expired && !this.config) return { outcome: "expired" }
        if (!this.config || !sameHash(this.config.tokenHash, tokenHash)) return { outcome: "unauthorized" }
        // Checked here even if the alarm is late. The view's guard checks again in Postgres.
        if (Date.now() >= Date.parse(this.config.expiresAt)) return { outcome: "expired" }
        const { role, view } = this.config.credential
        if (!ROLE.test(role) || view !== `lild_api.${role}`) throw new Error("invalid stored scope")
        return { outcome: "ok", rows: await readView(role, view) }
    }

    /** A late alarm only delays this cleanup: every read checks the clock itself. */
    async onAlarm() {
        this.expired = true
        this.config = null
    }
}

/** A failed read throws. It must never look like a successful empty result. */
async function readView(role: string, view: string): Promise<Row[]> {
    const url = new URL(requireEnv("LILD_EXECUTOR_URL"))
    const client = new pg.Client({
        host: url.hostname,
        port: Number(url.port),
        user: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password),
        database: url.pathname.slice(1),
        connectionTimeoutMillis: 8_000,
        statement_timeout: 5_000,
        ssl: { rejectUnauthorized: true, ca: requireEnv("LILD_DB_CA").replaceAll("\\n", "\n"), servername: url.hostname },
        types: {
            getTypeParser: (oid: number, format?: "text" | "binary") =>
                oid === NUMERIC_OID ? Number : pg.types.getTypeParser(oid, format as "text"),
        },
    })
    await client.connect()
    try {
        await client.query("begin")
        await client.query(`set local role ${client.escapeIdentifier(role)}`)
        const [schema, name] = view.split(".") as [string, string]
        const { rows } = await client.query<Row>(
            `select * from ${client.escapeIdentifier(schema)}.${client.escapeIdentifier(name)}`,
        )
        await client.query("commit")
        return rows
    } finally {
        await client.end()
    }
}

function requireEnv(name: string): string {
    const value = process.env[name]
    if (!value) throw new Error(`${name} is not set`)
    return value
}

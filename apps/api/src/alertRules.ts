// Alert rules (Phase 4-D). Per-org, DB-backed rules that decide which triggers
// fire and to which of the globally-configured channels they route. "Global
// channels" model: a rule names channel identifiers (transport names like
// "slack"/"webhook"/"email"), never secrets -- destinations stay in env.
//
// Self-contained seam (mirrors actionEvents.ts / deadLetters.ts): Mem + Pg
// implementations, with the SQL living here so the migration runner imports it.

export const ALERT_RULES_SQL = `create table if not exists alert_rules (
    id           text primary key,
    org_id       text not null references orgs(id) on delete cascade,
    name         text not null,
    rule_trigger text not null,
    scope        text,
    channels     jsonb not null default '[]',
    enabled      boolean not null default true,
    created_at   timestamptz not null default now()
);
create index if not exists alert_rules_org_idx on alert_rules (org_id, created_at desc);`

export type AlertTrigger = "awaiting_approval" | "denied" | "failed"

export const ALERT_TRIGGERS: AlertTrigger[] = ["awaiting_approval", "denied", "failed"]

export interface AlertRuleRecord {
    id: string
    orgId: string
    name: string
    trigger: AlertTrigger
    scope: string | null
    channels: string[]
    enabled: boolean
    createdAt: string
}

export interface CreateAlertRuleInput {
    name: string
    trigger: AlertTrigger
    scope?: string | null
    channels: string[]
    enabled?: boolean
}

export interface UpdateAlertRuleInput {
    name?: string
    trigger?: AlertTrigger
    scope?: string | null
    channels?: string[]
    enabled?: boolean
}

export interface AlertRuleStore {
    list(orgId: string): Promise<AlertRuleRecord[]>
    create(orgId: string, id: string, input: CreateAlertRuleInput): Promise<AlertRuleRecord>
    update(orgId: string, id: string, patch: UpdateAlertRuleInput): Promise<AlertRuleRecord | undefined>
    remove(orgId: string, id: string): Promise<boolean>
    matching(orgId: string, trigger: AlertTrigger, scope: string | null): Promise<AlertRuleRecord[]>
}

export interface AlertRuleQueryable {
    query(text: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>
}

function toIso(v: unknown): string {
    if (v instanceof Date) return v.toISOString()
    if (typeof v === "string") return v
    return new Date(String(v)).toISOString()
}

export class MemAlertRuleStore implements AlertRuleStore {
    private rules: AlertRuleRecord[] = []

    async list(orgId: string): Promise<AlertRuleRecord[]> {
        return this.rules.filter((r) => r.orgId === orgId).reverse()
    }

    async create(orgId: string, id: string, input: CreateAlertRuleInput): Promise<AlertRuleRecord> {
        const rec: AlertRuleRecord = {
            id,
            orgId,
            name: input.name,
            trigger: input.trigger,
            scope: input.scope ?? null,
            channels: [...input.channels],
            enabled: input.enabled ?? true,
            createdAt: new Date().toISOString(),
        }
        this.rules.push(rec)
        return rec
    }

    async update(orgId: string, id: string, patch: UpdateAlertRuleInput): Promise<AlertRuleRecord | undefined> {
        const r = this.rules.find((x) => x.orgId === orgId && x.id === id)
        if (!r) return undefined
        if (patch.name !== undefined) r.name = patch.name
        if (patch.trigger !== undefined) r.trigger = patch.trigger
        if (patch.scope !== undefined) r.scope = patch.scope ?? null
        if (patch.channels !== undefined) r.channels = [...patch.channels]
        if (patch.enabled !== undefined) r.enabled = patch.enabled
        return r
    }

    async remove(orgId: string, id: string): Promise<boolean> {
        const before = this.rules.length
        this.rules = this.rules.filter((x) => !(x.orgId === orgId && x.id === id))
        return this.rules.length < before
    }

    async matching(orgId: string, trigger: AlertTrigger, scope: string | null): Promise<AlertRuleRecord[]> {
        return this.rules.filter(
            (r) => r.orgId === orgId && r.enabled && r.trigger === trigger && (r.scope === null || r.scope === scope),
        )
    }
}

function mapRule(row: Record<string, unknown>): AlertRuleRecord {
    const rawChannels = row.channels
    const channels = Array.isArray(rawChannels)
        ? (rawChannels as string[])
        : typeof rawChannels === "string"
            ? (JSON.parse(rawChannels) as string[])
            : []
    return {
        id: String(row.id),
        orgId: String(row.org_id),
        name: String(row.name),
        trigger: String(row.rule_trigger) as AlertTrigger,
        scope: row.scope === null || row.scope === undefined ? null : String(row.scope),
        channels,
        enabled: row.enabled === true || row.enabled === "t" || row.enabled === "true",
        createdAt: toIso(row.created_at),
    }
}

export class PgAlertRuleStore implements AlertRuleStore {
    constructor(private readonly pool: AlertRuleQueryable) {}

    async list(orgId: string): Promise<AlertRuleRecord[]> {
        const { rows } = await this.pool.query(
            "select * from alert_rules where org_id=$1 order by created_at desc",
            [orgId],
        )
        return rows.map(mapRule)
    }

    async create(orgId: string, id: string, input: CreateAlertRuleInput): Promise<AlertRuleRecord> {
        const { rows } = await this.pool.query(
            "insert into alert_rules (id, org_id, name, rule_trigger, scope, channels, enabled) " +
                "values ($1,$2,$3,$4,$5,$6::jsonb,$7) returning *",
            [id, orgId, input.name, input.trigger, input.scope ?? null, JSON.stringify(input.channels), input.enabled ?? true],
        )
        const row = rows[0]
        if (!row) throw new Error("alert_rules insert returned no row")
        return mapRule(row)
    }

    async update(orgId: string, id: string, patch: UpdateAlertRuleInput): Promise<AlertRuleRecord | undefined> {
        const sets: string[] = []
        const params: unknown[] = []
        const push = (v: unknown): string => {
            params.push(v)
            return "$" + params.length
        }
        if (patch.name !== undefined) sets.push("name=" + push(patch.name))
        if (patch.trigger !== undefined) sets.push("rule_trigger=" + push(patch.trigger))
        if (patch.scope !== undefined) sets.push("scope=" + push(patch.scope ?? null))
        if (patch.channels !== undefined) sets.push("channels=" + push(JSON.stringify(patch.channels)) + "::jsonb")
        if (patch.enabled !== undefined) sets.push("enabled=" + push(patch.enabled))

        if (sets.length === 0) {
            const { rows } = await this.pool.query(
                "select * from alert_rules where org_id=$1 and id=$2",
                [orgId, id],
            )
            return rows[0] ? mapRule(rows[0]) : undefined
        }

        const sql =
            "update alert_rules set " +
            sets.join(", ") +
            " where org_id=" + push(orgId) +
            " and id=" + push(id) +
            " returning *"
        const { rows } = await this.pool.query(sql, params)
        return rows[0] ? mapRule(rows[0]) : undefined
    }

    async remove(orgId: string, id: string): Promise<boolean> {
        const { rows } = await this.pool.query(
            "delete from alert_rules where org_id=$1 and id=$2 returning id",
            [orgId, id],
        )
        return rows.length > 0
    }

    async matching(orgId: string, trigger: AlertTrigger, scope: string | null): Promise<AlertRuleRecord[]> {
        const { rows } = await this.pool.query(
            "select * from alert_rules where org_id=$1 and enabled=true and rule_trigger=$2 and (scope is null or scope=$3) order by created_at desc",
            [orgId, trigger, scope],
        )
        return rows.map(mapRule)
    }
}
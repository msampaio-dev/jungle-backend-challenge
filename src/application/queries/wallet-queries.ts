import { Logger } from "@nestjs/common";
import type { MikroORM } from "@mikro-orm/postgresql";
import type { MoneyProps } from "../../domain/shared/money";
import { InvalidRequestError, TransactionNotFoundError, WalletNotFoundError } from "../errors";

/*
 * Lado de leitura. Consultas em SQL direto, sem passar pelo domínio:
 * só leem, então não há regra de negócio para proteger aqui.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_LIMIT = 200;

export interface WalletView {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

export interface LedgerPage {
  items: Array<{
    id: string;
    transactionId: string;
    direction: string;
    money: MoneyProps;
    balanceBefore: MoneyProps;
    balanceAfter: MoneyProps;
    createdAt: string;
  }>;
  nextCursor: string | null;
}

export interface TransactionView {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string | null;
  gameId: string | null;
  kind: string;
  money: MoneyProps;
  status: string;
  failureCode: string | null;
  referenceExternalTransactionId: string | null;
  referenceTransactionId: string | null;
  resultBalance: MoneyProps | null;
  createdAt: string;
  processedAt: string | null;
}

export interface ReconciliationResult {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

type Row = Record<string, unknown>;

export class WalletQueries {
  private readonly logger = new Logger(WalletQueries.name);

  constructor(
    private readonly orm: MikroORM,
    /** chamado quando a reconciliação encontra divergência (métrica) */
    private readonly onDivergence: (walletId: string) => void = () => {},
  ) {}

  async getWallet(walletId: string): Promise<WalletView> {
    assertUuid(walletId, "walletId");
    const [row] = await this.sql(
      "select id, player_id, currency, balance::text as balance, version from wallets where id = ?",
      [walletId],
    );
    if (!row) throw new WalletNotFoundError(`wallet ${walletId} not found`);
    return {
      id: String(row.id),
      playerId: String(row.player_id),
      balance: money(row.balance, row.currency),
      version: Number(row.version),
    };
  }

  /** Cursor opaco = base64url da posição (seq). Estável mesmo com novos lançamentos. */
  async getLedger(walletId: string, cursor: string | undefined, limitParam: string | undefined): Promise<LedgerPage> {
    await this.getWallet(walletId); // 404 se não existe
    const limit = parseLimit(limitParam);
    const after = cursor ? decodeCursor(cursor) : "0";

    const rows = await this.sql(
      `select id, seq::text as seq, transaction_id, direction, currency,
              amount::text as amount, balance_before::text as balance_before,
              balance_after::text as balance_after, created_at
         from wallet_ledger_entries
        where wallet_id = ? and seq > ?
        order by seq
        limit ?`,
      [walletId, after, limit + 1],
    );

    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map((r) => ({
        id: String(r.id),
        transactionId: String(r.transaction_id),
        direction: String(r.direction),
        money: money(r.amount, r.currency),
        balanceBefore: money(r.balance_before, r.currency),
        balanceAfter: money(r.balance_after, r.currency),
        createdAt: new Date(r.created_at as string).toISOString(),
      })),
      nextCursor: rows.length > limit && last ? encodeCursor(String(last.seq)) : null,
    };
  }

  async getTransaction(transactionId: string): Promise<TransactionView> {
    assertUuid(transactionId, "transactionId");
    return this.findTransaction("id = ?", [transactionId]);
  }

  async getTransactionByExternalId(providerId: string, externalTransactionId: string): Promise<TransactionView> {
    return this.findTransaction("provider_id = ? and external_transaction_id = ?", [providerId, externalTransactionId]);
  }

  /**
   * Compara o saldo gravado com o saldo reconstruído pelo ledger numa única
   * query (mesma foto do banco). Divergência é logada e sinalizada, nunca corrigida.
   */
  async reconcile(walletId: string): Promise<ReconciliationResult> {
    assertUuid(walletId, "walletId");
    const [row] = await this.sql(
      `select w.currency,
              w.balance::text as stored,
              coalesce(sum(case l.direction when 'CREDIT' then l.amount else -l.amount end), 0)::numeric(18,2)::text as calculated,
              (w.balance - coalesce(sum(case l.direction when 'CREDIT' then l.amount else -l.amount end), 0))::numeric(18,2)::text as difference,
              count(l.id)::int as entries
         from wallets w
         left join wallet_ledger_entries l on l.wallet_id = w.id
        where w.id = ?
        group by w.id`,
      [walletId],
    );
    if (!row) throw new WalletNotFoundError(`wallet ${walletId} not found`);

    const result: ReconciliationResult = {
      walletId,
      storedBalance: money(row.stored, row.currency),
      calculatedBalance: money(row.calculated, row.currency),
      difference: money(row.difference, row.currency),
      consistent: row.stored === row.calculated,
      checkedEntries: Number(row.entries),
    };
    if (!result.consistent) {
      this.logger.error({ msg: "wallet balance diverges from ledger", walletId, difference: result.difference });
      this.onDivergence(walletId);
    }
    return result;
  }

  private async findTransaction(where: string, params: unknown[]): Promise<TransactionView> {
    const [r] = await this.sql(
      `select id, provider_id, external_transaction_id, wallet_id, player_id, round_id, game_id, kind,
              amount::text as amount, currency, status, failure_code, reference_external_transaction_id,
              reference_transaction_id, result_balance::text as result_balance, created_at, processed_at
         from wager_transactions where ${where}`,
      params,
    );
    if (!r) throw new TransactionNotFoundError("transaction not found");
    return {
      transactionId: String(r.id),
      providerId: String(r.provider_id),
      externalTransactionId: String(r.external_transaction_id),
      walletId: String(r.wallet_id),
      playerId: String(r.player_id),
      roundId: (r.round_id as string | null) ?? null,
      gameId: (r.game_id as string | null) ?? null,
      kind: String(r.kind),
      money: money(r.amount, r.currency),
      status: String(r.status),
      failureCode: (r.failure_code as string | null) ?? null,
      referenceExternalTransactionId: (r.reference_external_transaction_id as string | null) ?? null,
      referenceTransactionId: (r.reference_transaction_id as string | null) ?? null,
      resultBalance: r.result_balance == null ? null : money(r.result_balance, r.currency),
      createdAt: new Date(r.created_at as string).toISOString(),
      processedAt: r.processed_at ? new Date(r.processed_at as string).toISOString() : null,
    };
  }

  private sql(query: string, params: unknown[]): Promise<Row[]> {
    return this.orm.em.getConnection().execute(query, params);
  }
}

function money(amount: unknown, currency: unknown): MoneyProps {
  return { amount: String(amount), currency: String(currency) };
}

function assertUuid(value: string, name: string): void {
  if (!UUID.test(value)) throw new InvalidRequestError(`${name} must be a UUID`);
}

function parseLimit(value: string | undefined): number {
  if (value === undefined) return 50;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new InvalidRequestError(`limit must be an integer between 1 and ${MAX_LIMIT}`);
  }
  return limit;
}

function encodeCursor(seq: string): string {
  return Buffer.from(JSON.stringify({ seq }), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): string {
  try {
    const { seq } = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { seq?: unknown };
    if (typeof seq === "string" && /^\d+$/.test(seq)) return seq;
  } catch {
    // cai no erro abaixo
  }
  throw new InvalidRequestError("invalid cursor");
}

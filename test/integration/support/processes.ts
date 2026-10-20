import type { Subprocess } from "bun";

/**
 * A app de verdade rodando como processo separado do sistema operacional
 * (pool de conexões, consumidor, relay e worker próprios), como uma réplica.
 */
export interface AppProcess {
  url: string;
  proc: Subprocess;
  /** kill -9: morre sem shutdown, no meio do que estiver fazendo */
  kill(): Promise<void>;
}

async function freePort(): Promise<number> {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const { port } = listener;
  listener.stop(true);
  return port;
}

export async function startAppProcess(env: Record<string, string>): Promise<AppProcess> {
  const port = await freePort();
  const proc = Bun.spawn([process.execPath, "run", "src/main.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      // outros testes desligam estes componentes gravando no process.env do
      // runner; a réplica precisa deles ligados, como em produção
      OUTBOX_RELAY_ENABLED: "true",
      SQS_CONSUMER_ENABLED: "true",
      PENDING_REFERENCE_WORKER_ENABLED: "true",
      ...env,
      PORT: String(port),
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  const url = `http://127.0.0.1:${port}`;

  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      if ((await fetch(`${url}/health/ready`)).ok) break;
    } catch {
      // ainda subindo
    }
    if (proc.exitCode !== null) throw new Error(`app process exited with ${proc.exitCode}`);
    if (Date.now() > deadline) {
      proc.kill("SIGKILL");
      throw new Error("app process did not become ready in 30s");
    }
    await Bun.sleep(100);
  }

  return {
    url,
    proc,
    async kill() {
      proc.kill("SIGKILL");
      await proc.exited;
    },
  };
}

export interface ApiResult {
  status: number;
  body: any;
  attempts: number;
}

/**
 * Cliente como um provedor de verdade: se a conexão cai ou a instância
 * responde 502/503, reenvia a MESMA requisição (mesma Idempotency-Key) para
 * outra instância, até conseguir uma resposta definitiva.
 */
export async function callWithRetry(
  targets: () => string[],
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
  timeoutMs = 30_000,
): Promise<ApiResult> {
  const deadline = Date.now() + timeoutMs;
  // cada chamada começa numa instância aleatória: a carga se espalha por todas
  const start = Math.floor(Math.random() * 1_000);
  for (let attempt = 1; ; attempt++) {
    const urls = targets();
    const url = urls[(start + attempt - 1) % urls.length]!;
    try {
      const res = await fetch(`${url}${path}`, {
        method,
        headers: { "content-type": "application/json", ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (res.status !== 502 && res.status !== 503) {
        const text = await res.text();
        return { status: res.status, body: text ? JSON.parse(text) : undefined, attempts: attempt };
      }
    } catch {
      // conexão recusada ou cortada: a instância morreu; tenta outra
    }
    if (Date.now() > deadline) throw new Error(`${method} ${path} did not succeed in ${timeoutMs}ms`);
    await Bun.sleep(50);
  }
}

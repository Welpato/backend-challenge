import type { Socket, TCPSocketListener } from 'bun';

interface ClientData {
  upstream: Socket<UpstreamData> | undefined;
  pending: Uint8Array[];
}

interface UpstreamData {
  client: Socket<ClientData>;
}

/**
 * Proxy TCP de teste entre a aplicação e uma dependência real (aqui, o SQS da infra de teste). `cut()` fecha
 * as conexões e para de escutar — quem conecta recebe "connection refused", exatamente como com o container
 * parado; `restore()` volta a escutar na **mesma porta**. Simula a queda sem parar a infra compartilhada por
 * outros testes e sem mockar o cliente (as requisições chegam ao emulador de verdade).
 */
export class TcpProxy {
  private listener: TCPSocketListener<ClientData> | undefined;
  private readonly sockets = new Set<Socket<ClientData> | Socket<UpstreamData>>();
  private port = 0;

  constructor(
    private readonly targetHost: string,
    private readonly targetPort: number,
  ) {}

  /** Começa a escutar numa porta livre (ou na anterior, depois de um `cut`). */
  start(): string {
    const proxy = this;
    this.listener = Bun.listen<ClientData>({
      hostname: '127.0.0.1',
      port: this.port,
      socket: {
        open(client) {
          proxy.sockets.add(client);
          client.data = { upstream: undefined, pending: [] };
          Bun.connect<UpstreamData>({
            hostname: proxy.targetHost,
            port: proxy.targetPort,
            socket: {
              open(upstream) {
                proxy.sockets.add(upstream);
                upstream.data = { client };
                client.data.upstream = upstream;
                for (const chunk of client.data.pending) {
                  upstream.write(chunk);
                }
                client.data.pending = [];
              },
              data(upstream, chunk) {
                upstream.data.client.write(chunk);
              },
              close(upstream) {
                proxy.sockets.delete(upstream);
                upstream.data?.client.end();
              },
              error(upstream) {
                upstream.data?.client.end();
              },
            },
          }).catch(() => client.end());
        },
        data(client, chunk) {
          if (client.data.upstream === undefined) {
            client.data.pending.push(new Uint8Array(chunk));
          } else {
            client.data.upstream.write(chunk);
          }
        },
        close(client) {
          proxy.sockets.delete(client);
          client.data.upstream?.end();
        },
      },
    });
    this.port = this.listener.port;
    return `http://127.0.0.1:${this.port}`;
  }

  /** Derruba as conexões abertas e para de aceitar novas. */
  cut(): void {
    this.listener?.stop(true);
    this.listener = undefined;
    for (const socket of this.sockets) {
      socket.end();
    }
    this.sockets.clear();
  }

  restore(): void {
    this.start();
  }

  stop(): void {
    this.cut();
  }
}

/** `http://host:port` → partes. */
export function hostPortOf(url: string): { host: string; port: number } {
  const parsed = new URL(url);
  return { host: parsed.hostname, port: Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80)) };
}
